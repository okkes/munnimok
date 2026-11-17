#pragma warning disable S107 // the runner is composed from its collaborators; the count is the number of them
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Networking;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Connector.Kit.Tracing;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Execution;

// a leased job ALWAYS reaches a terminal state (result, failure, or a lease taken back): abandoning one leaves it running
// the budget measures WORK: waiting on the account owner does not count; the challenge's expiry bounds it (JobBudget)
public sealed class JobRunner
{
    private static readonly TimeSpan TerminalPostTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ArtifactTimeout = TimeSpan.FromSeconds(10);

    // bounded because the job is already terminal: a page that never answers would pin an agent slot
    // 30s, raised from 15: ASN's sign-out is in a collapsed menu, each miss costs 10s; at 15 it was cancelled mid-hunt
    private static readonly TimeSpan LogoutTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan MinimumRenewInterval = TimeSpan.FromSeconds(5);

    private readonly IProviderRegistry _registry;
    private readonly ControlPlaneClient _control;
    private readonly PolitenessGate _gate;
    private readonly ProfileStore _profiles;
    private readonly AgentIdentity _identity;
    private readonly ConnectorAgentOptions _options;
    private readonly ILoggerFactory _loggers;
    private readonly ILogger<JobRunner> _logger;
    private readonly TimeProvider _time;

    public JobRunner(
        IProviderRegistry registry,
        ControlPlaneClient control,
        PolitenessGate gate,
        ProfileStore profiles,
        AgentIdentity identity,
        ConnectorAgentOptions options,
        ILoggerFactory loggers,
        TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(control);
        ArgumentNullException.ThrowIfNull(gate);
        ArgumentNullException.ThrowIfNull(profiles);
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(loggers);
        ArgumentNullException.ThrowIfNull(time);

        _registry = registry;
        _control = control;
        _gate = gate;
        _profiles = profiles;
        _identity = identity;
        _options = options;
        _loggers = loggers;
        _logger = loggers.CreateLogger<JobRunner>();
        _time = time;
    }

    // cancelled when the drain window has elapsed on shutdown; fails the job cleanly upstream instead of dropping it
    public async Task RunAsync(LeasedJob job, TimeSpan leaseTtl, CancellationToken abort)
    {
        ArgumentNullException.ThrowIfNull(job);

        if (!_registry.TryGetManifest(job.Provider, out var manifest) ||
            !_registry.TryGetAdapter(job.Provider, out var adapter))
        {
            // routed to the wrong agent: non-retriable, retrying cannot conjure an adapter this image lacks
            await PostFailureAsync(job, ErrorCode.UnsupportedResource,
                $"this agent has no adapter for provider '{job.Provider}'", artifacts: null).ConfigureAwait(false);
            return;
        }

        string? profileId;
        try
        {
            profileId = ResolveProfile(job, manifest);
        }
        catch (ConnectorException ex)
        {
            await PostFailureAsync(job, ex.Code, ex.Detail, artifacts: null).ConfigureAwait(false);
            return;
        }

        using var budget = new JobBudget(TimeSpan.FromSeconds(Math.Max(1, job.Limits.TimeoutSeconds)), _time);

        AgentJobContext prepared;
        try
        {
            prepared = new AgentJobContext(
                new JobContextOptions
                {
                    Job = job,
                    Manifest = manifest,
                    WorkRootDirectory = _options.WorkRootDirectory,
                    Browser = BrowserOptionsFor(job, manifest, profileId),
                    AnswerPollInterval = _options.AnswerPollInterval,
                    HttpTimeout = _options.ProviderHttpTimeout,
                    Budget = budget,
                },
                _control,
                _gate,
                _loggers,
                _time);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "job {JobId}: the run could not be set up", job.JobId);
            await PostFailureAsync(job, ErrorCode.Internal,
                $"job setup failed: {ex.GetType().Name}", artifacts: null).ConfigureAwait(false);
            return;
        }

        using var lease = CancellationTokenSource.CreateLinkedTokenSource(abort, budget.Token);
        var leaseLost = false;

        // one stop signal for lease renewal and the budget watchdog, neither tied to job cancellation:
        // a job parked on a human must keep its lease or the control plane takes it back mid-wait
        using var finished = new CancellationTokenSource();
        var renewing = RenewWhileRunningAsync(job, leaseTtl, () => leaseLost = true, lease, finished.Token);
        var watching = budget.WatchAsync(finished.Token);

        await using var context = prepared;

        try
        {
            context.Progress(JobStep.AgentAssigned);

            var run = await RunAdapterAsync(
                adapter, manifest, job, context, profileId,
                mayPostTrace: () => !leaseLost && !abort.IsCancellationRequested,
                lease.Token).ConfigureAwait(false);

            // attached here, not per ExecuteAsync branch, so a job kind added later carries them; collected after the adapter finished
            var result = run with { Notes = context.Notes };

            context.Progress(JobStep.Finalizing);
            await context.FlushProgressAsync().ConfigureAwait(false);

            await LandResultAsync(job, result, profileId).ConfigureAwait(false);
        }
        catch (ConnectorException ex)
        {
            MarkProfile(profileId, job.Provider, ex.Code);
            await FailAsync(job, context, ex.Code, ex.Detail ?? ErrorCatalog.Wire(ex.Code), adapter, manifest)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException ex) when (leaseLost)
        {
            // The control plane already took this job back and has decided what
            // happens to it. Posting anything now would race its own bookkeeping.
            _logger.LogWarning(ex, "job {JobId}: the lease was lost mid-run; stopping without a terminal post", job.JobId);
        }
        catch (OperationCanceledException) when (abort.IsCancellationRequested)
        {
            await FailAsync(job, context, ErrorCode.AgentUnavailable, "the agent shut down while this job was running")
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (budget.Expired)
        {
            // not `internal`: that code is retriable and pages an operator over a run nobody can fix
            // work that never finishes is the far end not answering: provider_unavailable, as the inline runner reports
            await FailAsync(job, context, ErrorCode.ProviderUnavailable,
                    $"the adapter used its whole {job.Limits.TimeoutSeconds}s working budget; " +
                    $"{budget.HumanWait.TotalSeconds:F0}s spent waiting on a human did not count against it")
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // not the budget, the lease or a shutdown: something inside the run cancelled a token it was handed; ours by elimination
            await FailAsync(job, context, ErrorCode.Internal, "the run was cancelled without a reason",
                    adapter, manifest)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // logged as scrubbed TEXT, not an exception object: a provider library may echo its request body into a message,
            // and a password in a log aggregator is as leaked as on the wire
#pragma warning disable S6667 // the exception is logged as scrubbed text on purpose
            _logger.LogError("job {JobId}: the adapter threw{NewLine}{Error}",
                job.JobId, Environment.NewLine, SecretScrubber.Scrub(ex.ToString(), context.SecretValues));
#pragma warning restore S6667

            await FailAsync(job, context, ErrorCode.Internal, $"{ex.GetType().Name}: {ex.Message}",
                    adapter, manifest)
                .ConfigureAwait(false);
        }
        finally
        {
            await finished.CancelAsync().ConfigureAwait(false);
            try
            {
                await Task.WhenAll(renewing, watching).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected: both background loops are stopped by cancellation.
            }
        }
    }

    private async Task<JobResultRequest> ExecuteAsync(
        IProviderAdapter adapter,
        ProviderManifest manifest,
        LeasedJob job,
        AgentJobContext context,
        string? profileId,
        CancellationToken ct)
    {
        switch (job.Kind)
        {
            case JobKind.Login:
            case JobKind.Refresh:
            {
                // a refresh is a login from existing material and no inputs; the adapter tells them apart by ctx.Material and ctx.Inputs
                context.Progress(JobStep.OpeningProvider);
                var login = await adapter.LoginAsync(context, ct).ConfigureAwait(false);

                return new JobResultRequest
                {
                    SessionMaterial = MaterialFor(login.Material, manifest, profileId),
                    ProviderAccount = login.Account,
                    Reachable = login.Reachable,
                    ExpiresAt = login.ExpiresAt,
                    Complete = true,
                };
            }

            case JobKind.Fetch:
            {
                if (job.Request is not { } request)
                {
                    throw ConnectorException.InvalidRequest("a fetch job arrived with no resource request");
                }

                context.Progress(JobStep.OpeningProvider);
                var fetch = await adapter.FetchAsync(context, request, ct).ConfigureAwait(false);

                return new JobResultRequest
                {
                    Accounts = fetch.Accounts,
                    Transactions = fetch.Transactions,
                    Receipts = fetch.Receipts,
                    Registrations = fetch.Registrations,
                    Debts = fetch.Debts,
                    SessionMaterial = fetch.RefreshedMaterial is null
                        ? null
                        : MaterialFor(fetch.RefreshedMaterial, manifest, profileId),
                    Complete = fetch.Complete,
                    Via = fetch.Via,
                    Raw = fetch.Raw,
                };
            }

            case JobKind.Logout:
            {
                context.Progress(JobStep.LoggingOut);
                try
                {
                    await adapter.LogoutAsync(context, ct).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // A user disconnecting must always succeed locally, so an
                    // upstream logout that fails is logged and nothing more.
#pragma warning disable S6667 // the exception is logged as scrubbed text on purpose
                    _logger.LogWarning("job {JobId}: upstream logout failed; disconnecting anyway{NewLine}{Error}",
                        job.JobId, Environment.NewLine, SecretScrubber.Scrub(ex.ToString(), context.SecretValues));
#pragma warning restore S6667
                }

                return new JobResultRequest { Complete = true };
            }

            default:
                throw ConnectorException.InvalidRequest($"unknown job kind '{job.Kind}'");
        }
    }

    // a persistent-profile material is a pointer only the agent understands; stamping it here keeps a T4 adapter unaware of BYO
    private SessionMaterial MaterialFor(SessionMaterial material, ProviderManifest manifest, string? profileId)
    {
        if (manifest.Runtime != ProviderRuntime.BrowserPersistent || profileId is null) return material;

        return material with { AgentId = _identity.AgentId, ProfileId = profileId };
    }

    private string? ResolveProfile(LeasedJob job, ProviderManifest manifest)
    {
        // EVERY provider on somebody's own machine, not only T4: the browser keeps what browsers keep, so a second sign-in is rare
        // named per provider: a fault in one bank's cookie jar must not be a fault in all (MarkUnhealthy is per provider)
        if (IsOwnMachine && manifest.Runtime != ProviderRuntime.Http)
        {
            return job.ProfileId ?? job.Material?.ProfileId ?? Stable(manifest.Id);
        }

        if (manifest.Runtime != ProviderRuntime.BrowserPersistent) return null;

        var profileId = job.ProfileId ?? job.Material?.ProfileId;

        // a first connect has nothing to point at: the agent owns the profile, so it mints the id and returns it in the material
        if (profileId is null && job.Kind is JobKind.Login)
        {
            profileId = Ids.New(Ids.Profile);
        }

        if (profileId is null)
        {
            throw ConnectorException.InvalidRequest(
                $"a {job.Kind} job for browser_persistent provider '{job.Provider}' carries no profile id");
        }

        return profileId;
    }

    // the seam the offline suite asks "what kind of machine" through: a test restating BrowserOptionsFor would pass without it
    internal BrowserLeaseOptions BrowserOptionsForTest(LeasedJob job, ProviderManifest manifest) =>
        BrowserOptionsFor(job, manifest, ResolveProfile(job, manifest));

    private bool IsOwnMachine => _options.Class == AgentClass.Byo;

    // derived, not minted: that makes it persistent (a fresh id per job would be a fresh browser per job)
    // it carries the agent: "own-"+provider was identical on every machine, and a second household's heartbeat hit the key
    private string Stable(string providerId) => $"own-{_identity.AgentId}-{providerId}";

    private BrowserLeaseOptions BrowserOptionsFor(LeasedJob job, ProviderManifest manifest, string? profileId) => new()
    {
        Headless = _options.Headless,

        // only an own-machine browser can answer a passkey; a pooled container would wait for hardware that never exists
        HasAuthenticator = BrowserLeaseOptions.CanReachAuthenticator(_options.Class),

        // the configured device applies on the own machine too: a bank binds a registration to the browser that made it
        // (ASN: "Meld de Chrome browser aan op dit Android apparaat", Pixel emulated); never change it under a trusted profile
        DeviceName = manifest.Agent.DesktopBrowser ? null : _options.BrowserDevice,

        // their browser, not a build nobody ships; also saves the 150 MB Chromium download
        Channel = IsOwnMachine ? _options.BrowserChannel : null,

        Locale = _options.BrowserLocale,
        TimezoneId = _options.BrowserTimezoneId,
        StorageState = job.Material?.StorageState,
        ProfileDirectory = profileId is null ? null : _profiles.DirectoryFor(profileId, manifest.Id),

        // custody, not persistence: BYO runs client-custody providers in a persistent browser, cookies still go in the bundle
        KeepsCookiesHere = manifest.SecretCustody == SecretCustody.Agent,

        // the profile keeps the SESSION: login cookies are session cookies (DUO: four) that Chromium never reloads
        // own-machine only: a pooled agent's profiles are wiped by design; see KeptSessionStore
        KeepsSessionAcrossBrowsers = IsOwnMachine,
        KeptSessionLifetime = _options.KeptSessionLifetime,

        // which part of the session is worth keeping is the provider's to say (manifest): DigiD re-authenticates whatever is held
        // empty for a provider that says nothing: the whole session is kept
        DropsKeptSessionFor = manifest.Auth.DropsKeptSessionFor,
    };

    private void MarkProfile(string? profileId, string providerId, ErrorCode code)
    {
        if (profileId is null) return;

        if (code is ErrorCode.SessionExpired or ErrorCode.InvalidCredentials or ErrorCode.MfaFailed)
        {
            // The profile stopped authenticating; only a human can fix it, and
            // the heartbeat is how they find out.
            _profiles.MarkUnhealthy(profileId, providerId);
        }
    }

    private async Task FailAsync(
        LeasedJob job,
        AgentJobContext context,
        ErrorCode code,
        string? detail,
        IProviderAdapter? adapter = null,
        ProviderManifest? manifest = null)
    {
        await context.FlushProgressAsync().ConfigureAwait(false);

        // captured BEFORE the post and any sign-out: a screenshot taken after a logout shows the signed-out page
        using var artifactTimeout = new CancellationTokenSource(ArtifactTimeout);
        var artifacts = await context.CaptureArtifactsAsync(artifactTimeout.Token).ConfigureAwait(false);

        var recorded = await PostFailureAsync(
                job, code, SecretScrubber.Detail(detail, context.SecretValues), artifacts, context.Notes)
            .ConfigureAwait(false);

        if (adapter is not null && manifest is not null)
        {
            await SignOutAsync(job, context, code, recorded, adapter, manifest).ConfigureAwait(false);
        }
    }

    // host decides, agent acts: custody is the user's device, so the control plane cannot build a logout job
    // internal is retriable: signing out on attempt one would hand attempt two a dead jar, so only a recorded Failed authorises
    // gates: Internal only; no browser, no session; Refreshable sessions would have a token revoked
    private async Task SignOutAsync(
        LeasedJob job,
        AgentJobContext context,
        ErrorCode code,
        JobState? recorded,
        IProviderAdapter adapter,
        ProviderManifest manifest)
    {
        // never on a BYO machine: the signed-in browser is the asset they stood the container up for
        // only an explicit logout job ends it
        if (IsOwnMachine) return;

        if (code != ErrorCode.Internal) return;
        if (recorded != JobState.Failed) return;
        if (manifest.Logout == LogoutSupport.None) return;
        if (manifest.Auth.Session.Refreshable) return;
        if (!context.Browser.Started) return;

        // its own clock: the lease token is already cancelled in three arms that reach here, and the failure post clears the owner
        using var timeout = new CancellationTokenSource(LogoutTimeout);

        var before = context.Notes.Count;

        try
        {
            await adapter.LogoutAsync(context, timeout.Token).ConfigureAwait(false);

            // to the operator's log, not the job: the failure was posted with the earlier notes and the row is closed
            foreach (var note in context.Notes.Skip(before))
            {
                _logger.LogInformation("job {JobId}: {Note}",
                    job.JobId, SecretScrubber.Scrub(note, context.SecretValues));
            }
        }
        catch (Exception ex)
        {
#pragma warning disable S6667 // the exception is logged as scrubbed text on purpose
            _logger.LogWarning("job {JobId}: the session could not be signed out ({Error})",
                job.JobId, SecretScrubber.Scrub(ex.Message, context.SecretValues));
#pragma warning restore S6667
        }
    }

    // null = never heard or would not say, which is not Failed: a post that did not land authorises nothing
    private async Task<JobState?> PostFailureAsync(
        LeasedJob job,
        ErrorCode code,
        string? detail,
        FailureArtifacts? artifacts,
        IReadOnlyList<string>? notes = null)
    {
        _logger.LogWarning("job {JobId} ({Kind}/{Provider}) failed: {Code} {Detail}",
            job.JobId, job.Kind, job.Provider, ErrorCatalog.Wire(code), detail);

        var failure = new JobFailRequest
        {
            Code = ErrorCatalog.Wire(code),
            Detail = detail,
            Notes = notes ?? [],
            Artifacts = artifacts,
        };

        JobState? recorded = null;

        if (!await SendAsync(
                async ct => recorded = await _control.FailAsync(job.JobId, failure, ct).ConfigureAwait(false),
                $"failure for {job.JobId}")
            .ConfigureAwait(false))
        {
            _logger.LogError("job {JobId}: the failure report did not reach the control plane", job.JobId);
            return null;
        }

        return recorded;
    }

    // terminal posts use their own timeout so they survive the job ending, a shutdown abort included
    // the recording is posted BEFORE result or failure (#441 L3), while leased and the cookie jar lives; not on lost lease
    // the result post is outside the failure mapping: the run succeeded, a delivery problem must not discard the data
    private async Task LandResultAsync(LeasedJob job, JobResultRequest result, string? profileId)
    {
        if (await SendAsync(ct => _control.ResultAsync(job.JobId, result, ct), $"result for {job.JobId}")
                .ConfigureAwait(false))
        {
            if (profileId is not null) _profiles.MarkOk(profileId, job.Provider, _time.GetUtcNow());
            _logger.LogInformation("job {JobId} ({Kind}/{Provider}) succeeded", job.JobId, job.Kind, job.Provider);
            return;
        }

        // the lease TTL is the backstop for a silent agent and returns the job to the queue exactly once
        _logger.LogError("job {JobId}: succeeded but the result did not land; leaving it to the lease TTL", job.JobId);
    }

    private async Task<JobResultRequest> RunAdapterAsync(
        IProviderAdapter adapter,
        ProviderManifest manifest,
        LeasedJob job,
        AgentJobContext context,
        string? profileId,
        Func<bool> mayPostTrace,
        CancellationToken ct)
    {
        try
        {
            return await ExecuteAsync(adapter, manifest, job, context, profileId, ct).ConfigureAwait(false);
        }
        finally
        {
            if (mayPostTrace()) await PostTraceAsync(job, context).ConfigureAwait(false);
        }
    }

    private async Task PostTraceAsync(LeasedJob job, AgentJobContext context)
    {
        if (!context.Records) return;

        JobTrace? trace;
        try
        {
            using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            trace = await context.TraceAsync(closing.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "job {JobId}: the recording could not be closed", job.JobId);
            return;
        }

        if (trace is null) return;

        var landed = await SendAsync(ct => _control.PostTraceAsync(job.JobId, trace, ct), $"trace for {job.JobId}")
            .ConfigureAwait(false);
        _logger.LogInformation(
            "job {JobId}: recording of {Entries} entries ({Dropped} dropped) {Landed}",
            job.JobId, trace.Entries.Count, trace.Dropped, landed ? "posted" : "did not land");
    }

    private async Task<bool> SendAsync(Func<CancellationToken, Task> post, string what)
    {
        const int Attempts = 3;

        for (var attempt = 1; attempt <= Attempts; attempt++)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TerminalPostTimeout);
                await post(timeout.Token).ConfigureAwait(false);
                return true;
            }
            catch (Exception ex) when (ex is ControlPlaneException or OperationCanceledException)
            {
                var transient = (ex as ControlPlaneException)?.IsTransient ?? true;
                if (!transient || attempt == Attempts)
                {
                    _logger.LogWarning(ex, "posting the {What} failed on attempt {Attempt}", what, attempt);
                    return false;
                }

                await Task.Delay(TimeSpan.FromSeconds(attempt), _time).ConfigureAwait(false);
            }
        }

        return false;
    }

    // two agents driving the same login is what renewal prevents; stop is the job's completion, never its budget or cancellation
    // an unrenewed parked job is swept by lease expiry and handed to a second agent
    private async Task RenewWhileRunningAsync(
        LeasedJob job, TimeSpan leaseTtl, Action onLost, CancellationTokenSource lease, CancellationToken stop)
    {
        var expiresAt = job.LeaseExpiresAt;

        try
        {
            while (!stop.IsCancellationRequested)
            {
                var remaining = expiresAt - _time.GetUtcNow();
                var delay = remaining / 2;
                if (delay < MinimumRenewInterval) delay = MinimumRenewInterval;

                await Task.Delay(delay, _time, stop).ConfigureAwait(false);

                bool held;
                try
                {
                    held = await _control.RenewAsync(job.JobId, stop).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // no verdict, so the lease may still be ours: retry next round rather than kill a healthy job
                    _logger.LogDebug(ex, "job {JobId}: renew failed transiently", job.JobId);
                    continue;
                }

                if (!held)
                {
                    _logger.LogWarning("job {JobId}: the control plane no longer holds our lease", job.JobId);
                    onLost();
                    await lease.CancelAsync().ConfigureAwait(false);
                    return;
                }

                expiresAt = _time.GetUtcNow() + leaseTtl;
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested)
        {
            // The job finished; renewal stops with it.
        }
        catch (OperationCanceledException ex)
        {
            // not our stop signal and the job still runs: nobody renews, a second agent takes it, onLost never fires
            // the client reports its own timeout as a transient ControlPlaneException so the loop retries; a renewer that dies says so
            _logger.LogWarning(ex,
                "job {JobId}: lease renewal stopped while the job was still running; the lease will lapse",
                job.JobId);
        }
    }
}
