using System.Threading.Channels;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Hosting.Jobs;

// every operation takes its own service scope: a shared DbContext would be used concurrently by an adapter
internal sealed class InlineJobContext : IJobContext, IAsyncDisposable
{
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger _logger;
    private readonly Channel<ProgressTick> _progress =
        Channel.CreateUnbounded<ProgressTick>(new UnboundedChannelOptions { SingleReader = true });
    private readonly List<JobStep> _stepsDone = [];
    private readonly Task _progressPump;
    private readonly Lock _stepsLock = new();
    private readonly List<string> _notes = [];
    private bool _credentialSubmitted;
    private int _found = -1;
    private JobStep _lastStep = JobStep.AgentAssigned;

    private readonly record struct ProgressTick(JobStep Step, int? Found);

    // notes are logged and kept for the caller; nothing scrubbed because inline secrets never leave the process
    // (an agent scrubs: its notes cross a wire)
    public void Note(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return;

        _logger.LogInformation("job {JobId}: {Note}", JobId, message);

        lock (_notes)
        {
            if (_notes.Count < MaximumNotes) _notes.Add(message);
        }
    }

    public IReadOnlyList<string> Notes
    {
        get
        {
            lock (_notes) return [.. _notes];
        }
    }

    private const int MaximumNotes = 40;

    private readonly Providers.ProviderQuotaService _quotas;
    private readonly string _provider;

    public InlineJobContext(
        LeasedJob job,
        IServiceScopeFactory scopes,
        HttpClient http,
        Providers.ProviderQuotaService quotas,
        ILogger logger,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(job);

        _scopes = scopes;
        _logger = logger;
        _quotas = quotas;
        _provider = job.Provider;

        SessionId = job.SessionId;
        JobId = job.JobId;
        Inputs = job.Inputs;
        Config = job.Config;
        Material = job.Material;
        Http = http;
        Browser = new NoBrowserLease(job.Provider);

        WorkDirectory = Path.Combine(Path.GetTempPath(), "connector-inline", job.JobId);
        Directory.CreateDirectory(WorkDirectory);

        _progressPump = PumpProgressAsync(ct);
    }

    public string SessionId { get; }

    public string JobId { get; }

    public IReadOnlyDictionary<string, string> Inputs { get; }

    public IReadOnlyDictionary<string, string> Config { get; }

    public SessionMaterial? Material { get; }

    public HttpClient Http { get; }

    /// <summary>A fact about the provider, kept by the platform for the operator — never part of the job's outcome.</summary>
    public void ReportQuota(Connector.Kit.Adapters.ProviderQuota quota) => _quotas.Report(_provider, quota);

    public IBrowserLease Browser { get; }

    public string WorkDirectory { get; }

    // Attended stays false on purpose: an inline run has no browser, so an interactive widget must fail with blocked_by_provider

    public void Progress(JobStep step) => _progress.Writer.TryWrite(new ProgressTick(step, Counted()));

    /// <summary>The count rides the next progress write under the last step reported.</summary>
    public void Found(int records)
    {
        var count = Math.Max(0, records);
        Volatile.Write(ref _found, count);
        _progress.Writer.TryWrite(new ProgressTick(_lastStep, count));
    }

    private int? Counted()
    {
        var found = Volatile.Read(ref _found);
        return found < 0 ? null : found;
    }

    // blocks until the latch is durable: fire-and-forget plus a crash would leave the job retryable and resubmit the credential
    public void CredentialSubmitted()
    {
        if (_credentialSubmitted) return;
        _credentialSubmitted = true;

        using var scope = _scopes.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
        queue.ProgressAsync(JobId, InlineJobRunner.AgentId, new ProgressReport
        {
            Step = JobStep.Authenticating,
            StepsDone = Snapshot(),
            CredentialSubmitted = true,
        }, CancellationToken.None).GetAwaiter().GetResult();
    }

    public async Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(challenge);

        using var scope = _scopes.CreateScope();
        var challenges = scope.ServiceProvider.GetRequiredService<ChallengeService>();

        var raised = await challenges.RaiseAsync(JobId, new PendingChallenge
        {
            Type = challenge.Type,
            ExpiresAt = challenge.ExpiresAt,
            Payload = ChallengePayload.From(challenge),
            Image = challenge.Image,
        }, ct);

        // named, so it waits for the answer to ITS question, not the newest
        var window = challenge.ExpiresAt - DateTimeOffset.UtcNow;
        var answer = await challenges.AwaitAnswerAsync(JobId, window, ct, raised.Id);

        return answer ?? throw new ConnectorException(
            ErrorCode.MfaTimeout, $"nobody answered the {challenge.Type} challenge in time");
    }

    public IReadOnlyList<JobStep> StepsDone => Snapshot();

    // the runner calls this before recording the outcome: the queue discards progress arriving after terminal state,
    // which erased the last steps of fast runs
    public async Task FlushProgressAsync()
    {
        _progress.Writer.TryComplete();

        try
        {
            await _progressPump;
        }
        catch (OperationCanceledException)
        {
            // cancelled run: unreported progress is not worth a fuss
        }
    }

    public async ValueTask DisposeAsync()
    {
        await FlushProgressAsync();

        try
        {
            if (Directory.Exists(WorkDirectory)) Directory.Delete(WorkDirectory, recursive: true);
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "could not delete work directory for job {JobId}", JobId);
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogWarning(ex, "could not delete work directory for job {JobId}", JobId);
        }
    }

    private IReadOnlyList<JobStep> Snapshot()
    {
        lock (_stepsLock) return [.. _stepsDone];
    }

    // one writer, so an adapter reporting from a loop cannot cause a write storm or a concurrent context
    private async Task PumpProgressAsync(CancellationToken ct)
    {
        await foreach (var tick in _progress.Reader.ReadAllAsync(ct).ConfigureAwait(false))
        {
            var step = tick.Step;
            _lastStep = step;
            lock (_stepsLock)
            {
                if (!_stepsDone.Contains(step)) _stepsDone.Add(step);
            }

            try
            {
                using var scope = _scopes.CreateScope();
                var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
                await queue.ProgressAsync(JobId, InlineJobRunner.AgentId, new ProgressReport
                {
                    Step = step,
                    StepsDone = Snapshot(),
                    CredentialSubmitted = _credentialSubmitted,
                    Found = tick.Found,
                }, ct).ConfigureAwait(false);
            }
            catch (ConnectorException ex)
            {
                // Progress is a courtesy. Losing one must never fail a run.
                _logger.LogDebug(ex, "progress for job {JobId} dropped: {Detail}", JobId, ex.Detail);
            }
        }
    }
}

// reaching for a browser means a manifest declares http while its adapter drives a page; failing loudly is how that is found
internal sealed class NoBrowserLease(string providerId) : IBrowserLease
{
    public bool Started => false;

    public Task<IPage> PageAsync(CancellationToken ct) => throw Refuse();

    public Task<string> StorageStateAsync(CancellationToken ct) => throw Refuse();

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct) => throw Refuse();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private ConnectorException Refuse() => ConnectorException.Unsupported(
        $"provider '{providerId}' runs inline and has no browser; " +
        "declare a browser runtime and an agent if its adapter needs a page");
}
