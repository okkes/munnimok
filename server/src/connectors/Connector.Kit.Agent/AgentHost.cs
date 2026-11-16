#pragma warning disable S107 // the host is composed from its collaborators; the count is the number of them
using System.Collections.Concurrent;
using System.Globalization;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent;

// the lease loop for ONE connector; every call is outbound, so an agent works behind NAT with no inbound port.
// The job slot is the machine's (AgentSlots); a revoked or unreachable connector retires alone (AgentRoster)
public sealed class AgentHost : BackgroundService
{
    private static readonly TimeSpan MinimumBackoff = TimeSpan.FromSeconds(1);

    // a failed beat retries after 5s, not a full interval: it already spent up to KeepaliveTimeout, and the liveness window
    // is 90s (AgentLiveness.OfflineAfterSeconds); three consecutive failures still land at 75s, inside it
    private static readonly TimeSpan HeartbeatRetryDelay = TimeSpan.FromSeconds(5);

    private readonly AgentConnection _connection;
    private readonly ConnectorAgentOptions _options;
    private readonly ControlPlaneClient _control;
    private readonly AgentIdentity _identity;
    private readonly AgentStateStore _state;
    private readonly ProfileStore _profiles;
    private readonly JobRunner _runner;
    private readonly AgentSlots _slots;
    private readonly WorkRoot _work;
    private readonly AgentRoster _roster;
    private readonly ILogger<AgentHost> _logger;
    private readonly TimeProvider _time;

    private readonly ConcurrentDictionary<string, Task> _inflight = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _abort = new();

    private string? _noted;

    // ends this connector's loops only: stopping the application used to end the lease loop, and a revoked connector
    // would otherwise long-poll a control plane that told it to go away, for ever
    private readonly CancellationTokenSource _retire = new();

    private readonly AgentCapabilities _capabilities;

    private TimeSpan _heartbeatInterval = TimeSpan.FromSeconds(30);
    private TimeSpan _leaseTtl = TimeSpan.FromSeconds(120);
    private int _running;

    // every profile was wiped since the asking beat and no beat has answered that yet; cleared once a beat comes back without it
    private volatile bool _resetDone;

    public AgentHost(
        AgentConnection connection,
        ConnectorAgentOptions options,
        AgentStateStore state,
        IProviderRegistry registry,
        AgentSlots slots,
        WorkRoot work,
        AgentRoster roster,
        ILogger<AgentHost> logger,
        TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(slots);
        ArgumentNullException.ThrowIfNull(work);
        ArgumentNullException.ThrowIfNull(roster);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(time);

        _connection = connection;
        _options = options;
        _control = connection.Control;
        _identity = connection.Identity;
        _state = state;
        _profiles = connection.Profiles;
        _runner = connection.Runner;
        _slots = slots;
        _work = work;
        _roster = roster;
        _logger = logger;
        _time = time;

        // built once, here: a bad claim (a BYO agent missing a tier its adapters need) must refuse to start the host,
        // not leave a healthy-looking agent that never picks up work
        _capabilities = options.BuildCapabilities(registry);
    }

    private string Name => _connection.Name;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, _retire.Token);
        var token = stopping.Token;

        _work.SweepOnce();

        if (!await EnsureEnrolledAsync(token).ConfigureAwait(false))
        {
            _roster.Retire(Name, "this agent could not enroll");
            return;
        }

        // providers AND runtimes: the tiers, not the adapters, say what the queue offers this machine; the connector name
        // leads because one process prints this line per connector
        _logger.LogInformation(
            "{Connection}: agent {AgentId} online: providers {Providers}; runtimes {Runtimes}; " +
            "concurrency {Concurrency} for the whole machine",
            Name,
            _identity.AgentId,
            string.Join(", ", _capabilities.Providers),
            string.Join(", ", _capabilities.Runtimes.Select(ConnectorAgentOptions.WireName)),
            _slots.Limit);

        var heartbeat = HeartbeatLoopAsync(token);
        await LeaseLoopAsync(token).ConfigureAwait(false);
        await heartbeat.ConfigureAwait(false);
    }

    // finishes or fails every in-flight job: a dropped one leaves the session stuck until a TTL, a login a browser
    // open on a half-submitted form
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken).ConfigureAwait(false);

        var inflight = _inflight.Values.ToArray();
        if (inflight.Length == 0) return;

        _logger.LogInformation("{Connection}: draining {Count} in-flight job(s)", Name, inflight.Length);

        var all = Task.WhenAll(inflight);
        var finished = await Task
            .WhenAny(all, Task.Delay(_options.ShutdownDrainTimeout, _time, CancellationToken.None))
            .ConfigureAwait(false);

        if (finished != all)
        {
            _logger.LogWarning(
                "{Connection}: the drain window elapsed; aborting {Count} job(s), each of which reports its own failure",
                Name,
                _inflight.Count);

            await _abort.CancelAsync().ConfigureAwait(false);
            try
            {
                await all.WaitAsync(_options.ShutdownAbortGrace, _time, CancellationToken.None).ConfigureAwait(false);
            }
            catch (TimeoutException ex)
            {
                _logger.LogError(
                    ex, "{Connection}: {Count} job(s) did not stop within the abort grace period", Name, _inflight.Count);
            }
        }
    }

    // the slots are the machine's: a finished host must not dispose them from connectors still serving
    public override void Dispose()
    {
        _abort.Dispose();
        _retire.Dispose();
        base.Dispose();
    }

    private async Task LeaseLoopAsync(CancellationToken stoppingToken)
    {
        var backoff = MinimumBackoff;
        var accept = new LeaseRequest { Accept = [JobKind.Login, JobKind.Fetch, JobKind.Refresh, JobKind.Logout] };

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _slots.WaitAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            LeasedJob? job;
            try
            {
                job = await _control.LeaseAsync(accept, stoppingToken).ConfigureAwait(false);
                backoff = MinimumBackoff;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                ReleaseSlot();
                return;
            }
            catch (Exception ex)
            {
                ReleaseSlot();

                if (ex is ControlPlaneException { IsAuthFailure: true })
                {
                    await RevokeAsync("the control plane rejected our token").ConfigureAwait(false);
                    return;
                }

                _logger.LogWarning(ex, "{Connection}: lease poll failed; retrying in {Backoff}", Name, backoff);
                await SafeDelayAsync(backoff, stoppingToken).ConfigureAwait(false);
                backoff = Next(backoff);
                continue;
            }

            if (job is null)
            {
                ReleaseSlot();
                continue;
            }

            Start(job);
        }
    }

    private void Start(LeasedJob job)
    {
        Interlocked.Increment(ref _running);

        // registered before the work starts: publishing the Task afterwards lets a fast job remove an entry not yet added
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _inflight[job.JobId] = completion.Task;

        _ = Task.Run(async () =>
        {
            try
            {
                await _runner.RunAsync(job, _leaseTtl, _abort.Token).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // the runner reports its own failures; anything reaching here would take the lease loop down
                _logger.LogError(ex, "{Connection}: job {JobId} ended unexpectedly", Name, job.JobId);
            }
            finally
            {
                Interlocked.Decrement(ref _running);
                _inflight.TryRemove(job.JobId, out _);
                ReleaseSlot();
                completion.SetResult();
            }
        });
    }

    private void ReleaseSlot() => _slots.Release();

    // a mismatch is not fatal, the control plane just leases this agent nothing: the log line is all the operator gets,
    // so it names the cure
    private void NoteCatalogue(string? theirs)
    {
        if (theirs is null || string.Equals(theirs, _noted, StringComparison.Ordinal)) return;
        _noted = theirs;

        if (string.Equals(theirs, _capabilities.CatalogDigest, StringComparison.Ordinal))
        {
            _logger.LogInformation("{Connection}: adapter catalogue {Digest} matches the control plane", Name, theirs);
            return;
        }

        _logger.LogError(
            "{Connection}: this agent runs adapter catalogue {Ours} and the control plane runs {Theirs}; " +
            "it will be leased no work until it runs the same image and configuration as the connector",
            Name,
            _capabilities.CatalogDigest,
            theirs);
    }

    private async Task HeartbeatLoopAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            TimeSpan next;

            try
            {
                var response = await _control.HeartbeatAsync(new HeartbeatRequest
                {
                    Capabilities = _capabilities,
                    Profiles = _profiles.Snapshot(),
                    Running = Volatile.Read(ref _running),
                    ResetDone = _resetDone,
                }, stoppingToken).ConfigureAwait(false);

                if (response.Revoked)
                {
                    await RevokeAsync("the control plane revoked this agent").ConfigureAwait(false);
                    return;
                }

                next = Absorb(response);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (ControlPlaneException ex) when (ex.IsAuthFailure)
            {
                await RevokeAsync("the control plane rejected our token").ConfigureAwait(false);
                return;
            }
            catch (Exception ex)
            {
                // survivable (lease TTL covers a dead agent; a flapping line must not tear down jobs) but only if the next beat comes
                // soon: a full interval after the keepalive bound spends most of the liveness window on one blip
                _logger.LogDebug(
                    ex, "{Connection}: heartbeat failed; beating again in {Delay}", Name, HeartbeatRetryDelay);
                next = HeartbeatRetryDelay;
            }

            await SafeDelayAsync(next, stoppingToken).ConfigureAwait(false);
        }
    }

    // once per connector: the code is one-time and HMAC-signed, so re-enrolling on every restart would leave a BYO user
    // unable to bring their agent back
    private async Task<bool> EnsureEnrolledAsync(CancellationToken ct)
    {
        var controlPlane = _connection.ControlPlane;

        if (_state.Load(controlPlane) is { } stored)
        {
            _identity.Set(stored);
            _heartbeatInterval = TimeSpan.FromSeconds(Math.Max(5, stored.HeartbeatSeconds));
            _logger.LogInformation("{Connection}: resumed enrollment as {AgentId}", Name, stored.AgentId);
            return true;
        }

        if (string.IsNullOrWhiteSpace(_connection.Settings.EnrollmentCode))
        {
            // the key names the connector: with several on one machine a generic setting name is the wrong advice
            _logger.LogError(
                "{Connection}: no enrollment state at {Path} and no enrollment code configured; mint one and set {Key}",
                Name,
                _state.FilePath,
                CodeSettingKey());
            return false;
        }

        var request = new EnrollRequest
        {
            Code = _connection.Settings.EnrollmentCode,
            Name = _options.AgentName,
            Capabilities = _capabilities,
        };

        var backoff = MinimumBackoff;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var response = await _control.EnrollAsync(request, ct).ConfigureAwait(false);
                var enrollment = new AgentEnrollment
                {
                    AgentId = response.AgentId,
                    Token = response.Token,
                    ControlPlane = controlPlane,
                    EnrolledAt = _time.GetUtcNow(),
                    HeartbeatSeconds = response.HeartbeatSeconds,
                };

                // persisted BEFORE the identity is used, so a crash between the two cannot burn the one-time code
                _state.Save(enrollment);
                _identity.Set(enrollment);
                _heartbeatInterval = TimeSpan.FromSeconds(Math.Max(5, response.HeartbeatSeconds));

                _logger.LogInformation("{Connection}: enrolled as {AgentId}", Name, response.AgentId);
                return true;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return false;
            }
            catch (ControlPlaneException ex) when (!ex.IsTransient)
            {
                // a rejected code is a verdict; retrying would not change it and looks like abuse
                _logger.LogError(
                    ex, "{Connection}: enrollment was rejected; the code is wrong, used, or expired", Name);
                return false;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "{Connection}: enrollment could not reach {ControlPlane}; retrying in {Backoff}",
                    Name,
                    controlPlane,
                    backoff);
                await SafeDelayAsync(backoff, ct).ConfigureAwait(false);
                backoff = Next(backoff);
            }
        }

        return false;
    }

    private string CodeSettingKey()
    {
        if (_connection.Settings.OwnsTheRoot) return $"{ConnectorAgentOptions.SectionName}:EnrollmentCode";

        var connections = _options.ResolvedConnections();
        for (var index = 0; index < connections.Count; index++)
        {
            if (!string.Equals(connections[index].Name, Name, StringComparison.OrdinalIgnoreCase)) continue;

            return string.Create(
                CultureInfo.InvariantCulture,
                $"{ConnectorAgentOptions.SectionName}:Connections:{index}:EnrollmentCode");
        }

        // a host built outside the composition (a test) still gets a key naming its connector
        return $"{ConnectorAgentOptions.SectionName}:Connections:<{Name}>:EnrollmentCode";
    }

    // a revoked connection wipes only ITS profiles (live provider sessions the control plane can no longer route to) and state;
    // a 401 from a bank connector restored from an old backup used to wipe DUO's browser and stop the process
    private async Task RevokeAsync(string why)
    {
        _logger.LogWarning("{Connection}: giving this connector up: {Why}", Name, why);

        _profiles.WipeAll();
        _state.Clear(_connection.ControlPlane);
        _identity.Clear();

        await _abort.CancelAsync().ConfigureAwait(false);
        await _retire.CancelAsync().ConfigureAwait(false);
        _roster.Retire(Name, why);
    }

    private TimeSpan Absorb(HeartbeatResponse response)
    {
        if (response.LeaseTtlSeconds > 0) _leaseTtl = TimeSpan.FromSeconds(response.LeaseTtlSeconds);

        var next = _heartbeatInterval;

        // a released hosted slot (#420 A2): wipe, then beat again soon so the slot is free in seconds;
        // a beat that stops asking is the control plane having heard
        if (response.ResetProfiles)
        {
            if (ResetProfiles()) next = HeartbeatRetryDelay;
        }
        else
        {
            _resetDone = false;
        }

        NoteCatalogue(response.CatalogDigest);
        return next;
    }

    // a released hosted slot: every profile goes as on revoke, but the connector stays enrolled; deferred while a job
    // holds a browser (the control plane keeps asking); true when the wipe happened on this call
    private bool ResetProfiles()
    {
        if (Volatile.Read(ref _running) > 0)
        {
            _logger.LogInformation(
                "{Connection}: the control plane asked for a profile wipe; waiting for {Count} running job(s) to finish",
                Name,
                _running);
            return false;
        }

        _logger.LogWarning(
            "{Connection}: wiping every browser profile: this hosted agent was released and goes to the next person clean",
            Name);
        _profiles.WipeAll();
        _resetDone = true;
        return true;
    }

    private TimeSpan Next(TimeSpan backoff)
    {
        var doubled = backoff * 2;
        return doubled > _options.MaxLeaseBackoff ? _options.MaxLeaseBackoff : doubled;
    }

    private async Task SafeDelayAsync(TimeSpan delay, CancellationToken ct)
    {
        try
        {
            await Task.Delay(delay, _time, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Shutting down mid-wait is ordinary.
        }
    }
}
