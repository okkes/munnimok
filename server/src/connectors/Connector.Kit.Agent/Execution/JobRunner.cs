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

/// <summary>
/// Runs one leased job to a terminal state.
///
/// The invariant it exists to hold is that a leased job ALWAYS reaches one:
/// a result, a failure, or a lease the control plane has already taken back.
/// Silently abandoning one leaves a session stuck in <c>running</c> until a
/// TTL notices, and for a login that is a browser sitting open on a provider.
///
/// The second invariant is that the job's budget measures WORK. Waiting on the
/// human who owns the account is not work, is bounded by the challenge's own
/// expiry, and does not count - see <see cref="JobBudget"/>.
/// </summary>
public sealed class JobRunner
{
    private static readonly TimeSpan TerminalPostTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ArtifactTimeout = TimeSpan.FromSeconds(10);

    /// <summary>
    /// How long a courtesy sign-out may take before it is abandoned.
    /// </summary>
    /// <remarks>
    /// Bounded because the job it belongs to has already been reported
    /// terminal. A page that never answers would otherwise pin an agent slot
    /// indefinitely on work nobody is waiting for, which is the whole thing the
    /// job budget exists to prevent.
    /// <para>
    /// THIRTY, RAISED FROM FIFTEEN BY A SIGN-OUT THAT NEEDS TWO CLICKS. ASN's
    /// button is inside a collapsed menu, so a sign-out there is a navigation,
    /// a menu and a button - and each miss on this platform costs ten seconds
    /// of Playwright's own patience. At fifteen the courtesy sign-out was being
    /// cancelled mid-hunt and reporting nothing, which is indistinguishable
    /// from a provider that has no sign-out at all.
    /// </para>
    /// </remarks>
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

    /// <param name="abort">
    /// Cancelled when the agent is shutting down and the drain window has
    /// elapsed. Cancelling it fails the job cleanly upstream rather than
    /// dropping it.
    /// </param>
    public async Task RunAsync(LeasedJob job, TimeSpan leaseTtl, CancellationToken abort)
    {
        ArgumentNullException.ThrowIfNull(job);

        if (!_registry.TryGetManifest(job.Provider, out var manifest) ||
            !_registry.TryGetAdapter(job.Provider, out var adapter))
        {
            // Routed to the wrong agent. Non-retriable, because retrying will
            // not conjure an adapter this image does not contain.
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
            // An unusable scratch directory or profile path is still a leased
            // job, and a leased job always reaches a terminal state.
            _logger.LogError(ex, "job {JobId}: the run could not be set up", job.JobId);
            await PostFailureAsync(job, ErrorCode.Internal,
                $"job setup failed: {ex.GetType().Name}", artifacts: null).ConfigureAwait(false);
            return;
        }

        using var lease = CancellationTokenSource.CreateLinkedTokenSource(abort, budget.Token);
        var leaseLost = false;

        // One stop signal for both background loops: the lease renewal and the
        // budget watchdog live exactly as long as the job does. Neither is tied
        // to the job's own cancellation - a job parked on a human still has to
        // hold its lease, or the control plane takes it back mid-wait and the
        // patience above buys nothing.
        using var finished = new CancellationTokenSource();
        var renewing = RenewWhileRunningAsync(job, leaseTtl, () => leaseLost = true, lease, finished.Token);
        var watching = budget.WatchAsync(finished.Token);

        await using var context = prepared;

        try
        {
            context.Progress(JobStep.AgentAssigned);

            var run = await RunAdapterAsync(
                adapter, manifest, job, context, profileId, lease.Token,
                mayPostTrace: () => !leaseLost && !abort.IsCancellationRequested).ConfigureAwait(false);

            // Attached HERE rather than in each of ExecuteAsync's branches, so
            // that a job kind added later carries them without anybody
            // remembering to. They are also collected after the adapter has
            // finished, which is the only point at which they are all in.
            var result = run with { Notes = context.Notes };

            context.Progress(JobStep.Finalizing);
            await context.FlushProgressAsync().ConfigureAwait(false);

            // Deliberately not inside the failure mapping below. The run
            // succeeded; a post that will not land is a delivery problem, and
            // reporting it as a failed job would throw away real data the
            // adapter already went and got.
            if (await SendAsync(ct => _control.ResultAsync(job.JobId, result, ct), $"result for {job.JobId}")
                    .ConfigureAwait(false))
            {
                if (profileId is not null) _profiles.MarkOk(profileId, job.Provider, _time.GetUtcNow());
                _logger.LogInformation("job {JobId} ({Kind}/{Provider}) succeeded", job.JobId, job.Kind, job.Provider);
            }
            else
            {
                // The control plane's lease TTL is the documented backstop for
                // an agent that goes silent, and it returns the job to the
                // queue exactly once.
                _logger.LogError("job {JobId}: succeeded but the result did not land; leaving it to the lease TTL",
                    job.JobId);
            }
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
            // Deliberately not `internal`. That code means "ours, not theirs",
            // is retriable, and renders as "something went wrong" - it pages an
            // operator over a run nobody can fix and tells the user nothing.
            //
            // A budget that counts only WORK can now only run out ON work, and
            // work that never finishes is overwhelmingly the far end not
            // answering: a page that never loads, a call that never returns.
            // `provider_unavailable` says exactly that - 503, wait, and a retry
            // genuinely may help later, which is true here and is not true of a
            // malformed request or a rejected password. It is also what the
            // inline runner already reports for the same situation.
            await FailAsync(job, context, ErrorCode.ProviderUnavailable,
                    $"the adapter used its whole {job.Limits.TimeoutSeconds}s working budget; " +
                    $"{budget.HumanWait.TotalSeconds:F0}s spent waiting on a human did not count against it")
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Not the budget, not the lease, and not a shutdown: something
            // inside the run cancelled a token it was handed. Ours by
            // elimination.
            await FailAsync(job, context, ErrorCode.Internal, "the run was cancelled without a reason",
                    adapter, manifest)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Anything escaping an adapter that is not a ConnectorException is
            // ours by definition, and the caller sees a code rather than a
            // stack trace.
            //
            // Logged as scrubbed TEXT rather than as an exception object: a
            // provider library that echoes its request body into a message is
            // ordinary, and a password in an operator's log aggregator is just
            // as leaked as one on the wire.
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
                // A refresh is a login that starts from existing material and
                // no inputs. The adapter distinguishes the two by looking at
                // ctx.Material and ctx.Inputs, which is the only signal the
                // frozen adapter contract offers - and the right one, since a
                // refresh has no credential to submit.
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

    /// <summary>
    /// For a persistent-profile provider the material is a pointer and nothing
    /// else, and only the agent knows what it points at. Stamping it here means
    /// a T4 adapter never has to know it is on a BYO agent.
    /// </summary>
    private SessionMaterial MaterialFor(SessionMaterial material, ProviderManifest manifest, string? profileId)
    {
        if (manifest.Runtime != ProviderRuntime.BrowserPersistent || profileId is null) return material;

        return material with { AgentId = _identity.AgentId, ProfileId = profileId };
    }

    private string? ResolveProfile(LeasedJob job, ProviderManifest manifest)
    {
        // EVERY PROVIDER ON SOMEBODY'S OWN MACHINE, not only the T4 ones.
        //
        // The point of bringing your own agent is that it is your computer:
        // the browser keeps what browsers keep, so the second sign-in to a
        // provider is usually no sign-in at all. Wiping it between jobs would
        // make a BYO agent a slower pooled agent that happens to live in your
        // house - which is the shape this had, and is not what anybody asks
        // for one for.
        //
        // Named per provider rather than one profile for everything: a fault
        // in one bank's cookie jar should not be a fault in all of them, and
        // MarkUnhealthy already reports per provider.
        if (IsOwnMachine && manifest.Runtime != ProviderRuntime.Http)
        {
            return job.ProfileId ?? job.Material?.ProfileId ?? Stable(manifest.Id);
        }

        if (manifest.Runtime != ProviderRuntime.BrowserPersistent) return null;

        var profileId = job.ProfileId ?? job.Material?.ProfileId;

        // A first connect has nothing to point at yet. The agent owns the
        // profile, so the agent mints its id and returns it in the material.
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

    /// <summary>
    /// The browser this runner would open for a job, without opening one.
    /// </summary>
    /// <remarks>
    /// The seam the offline suite asks "what kind of machine is this" through.
    /// Every one of those answers - their Chrome or a bundled Chromium, a
    /// desktop or a phone, kept or wiped, cookies sealed or held here - is a
    /// decision made once in <see cref="BrowserOptionsFor"/>, and a test that
    /// restated it beside itself would pass with the decision deleted.
    /// </remarks>
    internal BrowserLeaseOptions BrowserOptionsForTest(LeasedJob job, ProviderManifest manifest) =>
        BrowserOptionsFor(job, manifest, ResolveProfile(job, manifest));

    /// <summary>Whether this agent is somebody's own machine.</summary>
    private bool IsOwnMachine => _options.Class == AgentClass.Byo;

    /// <summary>
    /// The same profile for the same provider, every run, on this machine.
    /// </summary>
    /// <remarks>
    /// DERIVED RATHER THAN MINTED, and that is what makes it persistent at
    /// all. A T4 connection carries its profile id in the bundle because the
    /// control plane knows about it; an ordinary provider's bundle has no such
    /// field, so a fresh id per job would create a fresh browser per job and
    /// quietly reproduce the wiped agent this is replacing.
    /// <para>
    /// <b>AND IT CARRIES THE AGENT, because deriving it broke an invariant
    /// nothing was left to hold.</b> Every other profile id is minted by
    /// <c>Ids.New</c> and is therefore unique everywhere; the control plane's
    /// <c>profiles</c> table is keyed on that alone. This one was
    /// <c>"own-" + providerId</c> - identical on every machine in the world
    /// that had run the same provider.
    /// </para>
    /// <para>
    /// What that cost is worth spelling out, because it is not "a duplicate
    /// row". The second household's heartbeat carried a profile the first
    /// household had already inserted, the insert violated the primary key,
    /// and the heartbeat it shared a transaction with died with it. Their
    /// agent went on running perfectly while the control plane recorded it as
    /// offline for ever: no fleet head-start, an offline badge in every
    /// consumer, and a Debug-level line on a machine nobody was reading. It is
    /// unreachable with one agent, which is why standing one up live did not
    /// find it.
    /// </para>
    /// <para>
    /// Still only a directory name on the owner's own disk. It identifies a
    /// folder and an agent, not a person, and it never leaves the machine
    /// except as the profile id the agent already reports for itself.
    /// </para>
    /// </remarks>
    private string Stable(string providerId) => $"own-{_identity.AgentId}-{providerId}";

    private BrowserLeaseOptions BrowserOptionsFor(LeasedJob job, ProviderManifest manifest, string? profileId) => new()
    {
        Headless = _options.Headless,

        // Only a browser on somebody's own machine can answer a passkey. A
        // pooled one is a container, and a page that asks it for one waits for
        // hardware that will never exist.
        HasAuthenticator = BrowserLeaseOptions.CanReachAuthenticator(_options.Class),

        // WHATEVER THIS AGENT IS CONFIGURED AS, ON ITS OWN MACHINE TOO - and
        // this was the opposite for two commits, on an argument that a live
        // run has now overruled.
        //
        // The argument was that a desktop should not claim to be a phone. The
        // evidence is a bank binding a registration to the browser that made
        // it: ASN's own trust screen reads "Meld de Chrome browser aan op dit
        // Android apparaat" - Android because the agent emulates a Pixel. A
        // profile registered as one browser and then driven as another is a
        // profile whose trust the bank has every reason to withdraw.
        //
        // So consistency beats plausibility here. The device is the agent's
        // configuration, it applies everywhere, and what must never happen is
        // that it changes underneath a profile somebody has already had
        // trusted.
        DeviceName = manifest.Agent.DesktopBrowser ? null : _options.BrowserDevice,

        // Their browser, not a build nobody ships. Also 150 MB of Chromium
        // this agent then never has to download.
        Channel = IsOwnMachine ? _options.BrowserChannel : null,

        Locale = _options.BrowserLocale,
        TimezoneId = _options.BrowserTimezoneId,
        StorageState = job.Material?.StorageState,
        ProfileDirectory = profileId is null ? null : _profiles.DirectoryFor(profileId, manifest.Id),

        // CUSTODY, NOT PERSISTENCE. A BYO agent runs client-custody providers
        // in a persistent browser now, and their cookies still belong in the
        // bundle - otherwise the connection works until the machine is off and
        // then asks for a sign-in nobody can explain.
        KeepsCookiesHere = manifest.SecretCustody == SecretCustody.Agent,

        // AND THE PROFILE KEEPS THE SESSION, not merely the directory.
        //
        // Every cookie that carries a provider's login is a SESSION cookie -
        // measured on DUO, whose whole session is four of them - and Chromium
        // writes those into a persistent profile without ever loading them
        // again. So a kept profile kept the analytics and the language
        // preference and threw the login away, and "sign in once on your own
        // machine and the next run is free" was never true for any provider.
        //
        // The same own-machine question as every other line here, and it has to
        // be: a pooled agent's profiles are wiped between jobs by design, and a
        // container that resurrected a bank session after the browser closed
        // would be the opposite of what that tier promises. See
        // KeptSessionStore for why this is not the custody question that
        // BrowserLease.StorageStateAsync answers.
        KeepsSessionAcrossBrowsers = IsOwnMachine,
        KeptSessionLifetime = _options.KeptSessionLifetime,

        // AND WHICH PART OF THE SESSION IS WORTH KEEPING IS THE PROVIDER'S TO
        // SAY, because it is the only one that can.
        //
        // Straight off the manifest with no agent-side opinion at all: an
        // adapter that has read its provider's SAML request knows that DigiD
        // re-authenticates whatever session anybody holds, and nothing on this
        // side of the seam could work that out from a hostname. Empty for every
        // provider that says nothing, which keeps the whole session exactly as
        // before.
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

        // Captured BEFORE the post and long before any sign-out. A screenshot
        // is what makes a broken adapter fixable, and one taken after a logout
        // is a picture of the signed-out page.
        using var artifactTimeout = new CancellationTokenSource(ArtifactTimeout);
        var artifacts = await context.CaptureArtifactsAsync(artifactTimeout.Token).ConfigureAwait(false);

        // The notes are usually where the reason is: an adapter that fails at
        // the end has spent the whole run saying what it found.
        var recorded = await PostFailureAsync(
                job, code, SecretScrubber.Detail(detail, context.SecretValues), artifacts, context.Notes)
            .ConfigureAwait(false);

        if (adapter is not null && manifest is not null)
        {
            await SignOutAsync(job, context, code, recorded, adapter, manifest).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Ends the provider session a failed job leaves behind, when leaving it
    /// would leave a real one alive.
    /// </summary>
    /// <remarks>
    /// THE HOST DECIDES AND THE AGENT ACTS, because neither side has both
    /// facts. Custody of a credential is the user's device, so the control
    /// plane holds nothing it could build a logout job from - which is why the
    /// two adapters that implement a logout had never once performed one - and
    /// by the time it knows a job is terminal the material is already cleared.
    /// The agent, meanwhile, must not decide alone: an <c>internal</c> failure
    /// is retriable, and signing out on attempt one would hand attempt two a
    /// dead cookie jar, turning our bug into an expired session and costing the
    /// account holder a sign-in for a reason we invented. So the recorded state
    /// comes back on the wire - it always did - and only <c>Failed</c>
    /// authorises this.
    /// <para>
    /// EVERY GATE HERE IS A CASE THAT WOULD DO HARM. <c>Internal</c> alone,
    /// because <c>session_expired</c>, <c>invalid_credentials</c> and
    /// <c>mfa_failed</c> mean the session is already gone and driving a bank's
    /// browser around a login it never passed is a second unexplained visit to
    /// an account whose fraud rules are watching. A browser that was never
    /// started is no session at all. And a provider whose session is
    /// REFRESHABLE is one where a long-lived token would be revoked over our
    /// own fault - the shops hold thirty-day jars and declare no logout, and
    /// they are excluded by both halves.
    /// </para>
    /// <para>
    /// It swallows everything. This is a courtesy performed after a job has
    /// already been reported terminal, and an exception escaping here would
    /// reach the outer catch and post a second terminal result for a job the
    /// queue has closed.
    /// </para>
    /// </remarks>
    private async Task SignOutAsync(
        LeasedJob job,
        AgentJobContext context,
        ErrorCode code,
        JobState? recorded,
        IProviderAdapter adapter,
        ProviderManifest manifest)
    {
        // NEVER ON A MACHINE SOMEBODY BROUGHT, whatever went wrong.
        //
        // The courtesy sign-out exists because a pooled agent leaves a session
        // alive in a datacenter that nobody will ever come back to. An agent
        // the account holder runs is the opposite case in every respect: the
        // signed-in browser is the ASSET, it is the reason they stood the
        // container up, and the profile is theirs. Signing it out to tidy up
        // after OUR bug would cost them the scan, the phone and the login they
        // did once precisely so they would not have to do it again.
        //
        // Only an explicit logout ends one of these, and that arrives as its
        // own job from the client that asked for it - not as a decision this
        // runner makes on a failure path.
        if (IsOwnMachine) return;

        if (code != ErrorCode.Internal) return;
        if (recorded != JobState.Failed) return;
        if (manifest.Logout == LogoutSupport.None) return;
        if (manifest.Auth.Session.Refreshable) return;
        if (!context.Browser.Started) return;

        // ITS OWN CLOCK, never the job's. The lease token is already cancelled
        // in three of the arms that reach here, and the failure post itself
        // clears the lease owner - so the next renewal, seconds away, cancels
        // it in the rest. A sign-out on that token would be killed mid-click
        // and report nothing.
        using var timeout = new CancellationTokenSource(LogoutTimeout);

        var before = context.Notes.Count;

        try
        {
            await adapter.LogoutAsync(context, timeout.Token).ConfigureAwait(false);

            // WHAT THE SIGN-OUT FOUND, to the operator's log rather than to the
            // job. The failure was posted with the notes as they stood and the
            // row is closed, so "signed out upstream" and "the sign-out was
            // clicked but the signed-out page never arrived" would otherwise go
            // on the floor - and those two sentences are the whole point of
            // having driven it.
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

    /// <returns>
    /// What the control plane recorded, or null if it never heard or would not
    /// say. Null is not <see cref="JobState.Failed"/>: a post that did not land
    /// authorises nothing.
    /// </returns>
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

    /// <summary>
    /// A terminal post, retried while the failure looks like the link rather
    /// than the request. Uses its own timeout rather than the job's tokens:
    /// telling the control plane how a job ended must survive the job ending,
    /// including a shutdown that aborted it.
    /// </summary>
    /// <summary>
    /// The adapter's run, with the recording posted when it is over - BEFORE
    /// the result or the failure (#441 L3), while the job is still leased and
    /// the browser still holds its cookie jar, and on a failure too, which is
    /// the run an adapter author most wants to read. Not on a lost lease or
    /// a shutdown: the control plane has already decided what happened.
    /// </summary>
    private async Task<JobResultRequest> RunAdapterAsync(
        IProviderAdapter adapter,
        ProviderManifest manifest,
        LeasedJob job,
        AgentJobContext context,
        string? profileId,
        CancellationToken ct,
        Func<bool> mayPostTrace)
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

    /// <summary>
    /// Keeps the lease alive for as long as the job runs, and cancels the job
    /// the moment the control plane says the lease is no longer ours. Two
    /// agents driving the same login is the failure this prevents.
    ///
    /// "As long as the job runs" includes the whole time it is parked on a
    /// human: <paramref name="stop"/> is the job's own completion, never its
    /// budget or its cancellation. An unrenewed parked job is swept up by the
    /// control plane's lease expiry and handed to a second agent, which would
    /// undo the patience the budget now allows.
    /// </summary>
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
                    // The call did not produce a verdict, so the lease may well
                    // still be ours. Let the next round try again rather than
                    // killing a healthy job over a dropped connection.
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
            // Not our stop signal, and the job is still running: from here on
            // nobody renews its lease, the control plane takes the job back on
            // expiry and hands it to a second agent while this one is still
            // driving it, and onLost never fires because nobody is left to
            // ask. Nothing on the path above should throw this any more - the
            // client names its own timeout as a transient ControlPlaneException
            // precisely so that the catch inside the loop retries it - but
            // that is exactly what used to arrive here, and the arm above
            // swallowed it as the job finishing. The only trace was a lease
            // that lapsed a minute later. A renewer that dies says so.
            _logger.LogWarning(ex,
                "job {JobId}: lease renewal stopped while the job was still running; the lease will lapse",
                job.JobId);
        }
    }
}
