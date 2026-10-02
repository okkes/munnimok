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

/// <summary>
/// The adapter's window onto an in-process run.
///
/// Every operation takes its own service scope. An adapter may report
/// progress from anywhere and await a challenge for minutes, and a shared
/// <c>DbContext</c> would be used concurrently the first time an adapter did
/// something reasonable.
/// </summary>
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

    /// <summary>One progress write: the step, and the count known when it was written.</summary>
    private readonly record struct ProgressTick(JobStep Step, int? Found);

    /// <summary>
    /// The adapter's own diagnostics, logged AND kept for the caller.
    /// </summary>
    /// <remarks>
    /// This used to inherit the interface's do-nothing default, which meant an
    /// adapter running inline - anything whose manifest does not require an
    /// agent - had its notes dropped before they reached even a log. Same
    /// bound and same order as the agent's; see
    /// <c>AgentJobContext.Note</c>.
    /// <para>
    /// Nothing is scrubbed here because nothing has to be: the inline runner
    /// is in-process with the control plane, the secret values never left it,
    /// and the notes are stored beside inputs that are already sealed. The
    /// agent scrubs because its notes cross a wire.
    /// </para>
    /// </remarks>
    public void Note(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return;

        _logger.LogInformation("job {JobId}: {Note}", JobId, message);

        lock (_notes)
        {
            if (_notes.Count < MaximumNotes) _notes.Add(message);
        }
    }

    /// <summary>What the adapter said, in the order it said it.</summary>
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

    // IJobContext.Attended is left at its false default on purpose, not by
    // omission. An inline run has no browser at all - see NoBrowserLease - so
    // there is no window for anyone to reach, whatever hardware the control
    // plane happens to be on. An adapter that meets an interactive widget here
    // has to fail with blocked_by_provider; there is nothing to hand over.

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

    /// <summary>
    /// Blocks until the latch is durable, and that is the point.
    ///
    /// An adapter calls this immediately around the moment a credential goes
    /// upstream. If the write were fire-and-forget and the process died in
    /// between, the job would look retryable and the retry would submit the
    /// same credential a second time - which is how accounts get locked. A
    /// few milliseconds on a thread is a cheap price for that not happening.
    /// </summary>
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

    /// <summary>
    /// The single call that implements the whole challenge protocol from an
    /// adapter's point of view: hand over a typed question, get back the
    /// human's answer, or a clean failure when nobody answered in time.
    /// </summary>
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

        // Named, so this waits for the answer to ITS question rather than to
        // whichever is newest.
        var window = challenge.ExpiresAt - DateTimeOffset.UtcNow;
        var answer = await challenges.AwaitAnswerAsync(JobId, window, ct, raised.Id);

        return answer ?? throw new ConnectorException(
            ErrorCode.MfaTimeout, $"nobody answered the {challenge.Type} challenge in time");
    }

    public IReadOnlyList<JobStep> StepsDone => Snapshot();

    /// <summary>
    /// Closes the progress channel and waits for every report already in it
    /// to reach the row. The runner calls this before it records the outcome:
    /// the queue discards a report that arrives after the job has gone
    /// terminal - rightly, a straggler must not resurrect a finished job - so
    /// an outcome recorded first erased the last steps of any run that
    /// finished faster than its own reports. Safe to call more than once; the
    /// agent runtime flushes the same way before it posts a result.
    /// </summary>
    public async Task FlushProgressAsync()
    {
        _progress.Writer.TryComplete();

        try
        {
            await _progressPump;
        }
        catch (OperationCanceledException)
        {
            // The run was cancelled; unreported progress is not worth a fuss.
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

    /// <summary>
    /// Drains progress on one writer, so an adapter that reports from a loop
    /// cannot turn typed progress into a write storm or a concurrent context.
    /// </summary>
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

/// <summary>
/// The browser an inline provider does not have.
///
/// Reaching for one is not a runtime accident to be recovered from - it means
/// a manifest declares <c>http</c> while its adapter drives a page, which the
/// validator would have caught if the manifest were honest. Failing loudly
/// here is how that gets found.
/// </summary>
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
