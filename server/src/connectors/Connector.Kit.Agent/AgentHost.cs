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

/// <summary>
/// The lease loop for ONE connector: enroll once, heartbeat, long-poll for
/// work, run it, repeat.
///
/// Every call in here is outbound. That single property is what lets an agent
/// sit behind NAT on a residential line, in a home lab, or on a user's own
/// machine with no inbound port and no redesign - and it is why bring-your-own
/// hardware is the same protocol from day one rather than a bolt-on.
///
/// <para>
/// There is one of these per connector this process serves, which is what
/// makes a household's three connectors one container instead of three. What
/// that costs is written down in the two places it matters: a job slot is the
/// MACHINE's (<see cref="AgentSlots"/>), so three lease loops do not open three
/// browsers, and a connector that is revoked or unreachable retires on its own
/// (<see cref="AgentRoster"/>) instead of stopping the process out from under
/// the others.
/// </para>
/// </summary>
public sealed class AgentHost : BackgroundService
{
    private static readonly TimeSpan MinimumBackoff = TimeSpan.FromSeconds(1);

    /// <summary>
    /// How long a FAILED heartbeat waits before the next one, instead of the
    /// whole interval.
    /// </summary>
    /// <remarks>
    /// The interval is how often a healthy agent says hello; it is not how long
    /// to leave the control plane thinking this one has gone. A beat that fails
    /// has already spent up to
    /// <see cref="ConnectorAgentOptions.KeepaliveTimeout"/> failing, and a full
    /// interval on top of that is most of the window the far end judges this
    /// agent by (<c>AgentLiveness.OfflineAfterSeconds</c>, ninety seconds)
    /// spent on one blip: a beat due at thirty that gives up at forty and then
    /// sleeps another thirty lands at seventy, and two in a row land at a
    /// hundred and ten - offline, by a rule that is meant to forgive three.
    /// <para>
    /// Five seconds, which makes a failed beat cost fifteen: the beat after
    /// three consecutive failures still lands at seventy-five, inside the
    /// window, which is what forgiving three missed beats means. It never
    /// exceeds the interval itself - enrollment floors that at five seconds.
    /// </para>
    /// <para>
    /// It is not a thundering herd. The lease loop beside it already retries a
    /// failed poll after one second, doubling, against the same control plane,
    /// so an agent whose link is down was never quiet to begin with - and this
    /// one stops the moment a beat lands.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// Ends THIS connector's two loops without ending anybody else's.
    /// </summary>
    /// <remarks>
    /// A revoke used to stop the application, and stopping the application is
    /// what ended the lease loop: the host's own stopping token came from the
    /// framework. With several connectors the process carries on, so a revoked
    /// connection that did not cancel something of its own would go on
    /// long-polling a control plane that has just told it to go away - for
    /// ever, on somebody's NAS, at one poll per thirty seconds.
    /// </remarks>
    private readonly CancellationTokenSource _retire = new();

    private readonly AgentCapabilities _capabilities;

    private TimeSpan _heartbeatInterval = TimeSpan.FromSeconds(30);
    private TimeSpan _leaseTtl = TimeSpan.FromSeconds(120);
    private int _running;

    /// <param name="connection">
    /// The connector this host serves: its address, its identity, its client,
    /// its profiles and its runner. Everything after it is the machine's and is
    /// the same object in every host of this process.
    /// </param>
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

        // Once, here, and not per heartbeat - nothing it is built from changes
        // for the life of the process, and HERE is what makes a bad claim the
        // host refusing to start. BuildCapabilities throws for a BYO agent
        // whose configuration leaves out a tier its adapters need; from a
        // constructor that is an exception out of Host.RunAsync before
        // anything is online, in the same place the registry refuses a
        // manifest that does not validate. Deferred to ExecuteAsync it would
        // depend on nothing yielding before the first call, and deferred to
        // the first lease it is the healthy-looking agent that never picks up
        // work - which is the failure this replaces.
        _capabilities = options.BuildCapabilities(registry);
    }

    /// <summary>The connector this host serves, as every line about it says.</summary>
    private string Name => _connection.Name;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Either the process is going or this connector is: a retired
        // connection ends its own loops and leaves the others polling.
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, _retire.Token);
        var token = stopping.Token;

        _work.SweepOnce();

        if (!await EnsureEnrolledAsync(token).ConfigureAwait(false))
        {
            // A connector this agent cannot enroll with has nothing for it to
            // do. The roster decides what that means for the process: with one
            // connector it is still an honest exit code for a container
            // runtime, and with three it is two that carry on.
            _roster.Retire(Name, "this agent could not enroll");
            return;
        }

        // The runtimes as well as the providers, because the providers alone
        // looked fine on an agent that could serve none of the persistent
        // ones: they come from the adapters, the tiers come from the
        // configuration, and only the tiers said what the queue would
        // actually offer this machine.
        //
        // And the CONNECTOR first, because this line is now printed once per
        // connector by one process: three of them without a name are the same
        // machine appearing to say the same thing three times, and the one
        // question a reader has - which connector came up, and did all of them
        // - is the one it would not answer.
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

    /// <summary>
    /// Finishes or fails every in-flight job. A job that is simply dropped
    /// leaves a session stuck until a TTL notices it, and for a login that is a
    /// browser sitting open on a provider with a half-submitted form.
    /// </summary>
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

    /// <summary>
    /// The abort source is this host's; the slots are the machine's and are
    /// disposed with it, so a host that has finished must not take them away
    /// from the connectors still serving.
    /// </summary>
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

        // Registered before the work starts, and completed by the work itself.
        // Publishing the Task afterwards would let a fast job remove an entry
        // that had not been added yet and leak it for the life of the process.
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
                // The runner reports its own failures; anything reaching here
                // would otherwise take the whole lease loop down with it.
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

    /// <summary>
    /// Hands the job slot back to the machine, for whichever connector asks
    /// next - which may well not be this one.
    /// </summary>
    private void ReleaseSlot() => _slots.Release();

    /// <summary>
    /// Says, once per value, whether the control plane runs the adapter
    /// catalogue this agent runs. A mismatch is not fatal here - the control
    /// plane simply leases this agent nothing - so the log line is the whole
    /// of what an operator gets, and it has to name the cure.
    /// </summary>
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
            // The ordinary cadence unless the beat fails, in which case the
            // next one is owed much sooner than the interval - see
            // HeartbeatRetryDelay.
            var next = _heartbeatInterval;

            try
            {
                var response = await _control.HeartbeatAsync(new HeartbeatRequest
                {
                    Capabilities = _capabilities,
                    Profiles = _profiles.Snapshot(),
                    Running = Volatile.Read(ref _running),
                }, stoppingToken).ConfigureAwait(false);

                if (response.LeaseTtlSeconds > 0) _leaseTtl = TimeSpan.FromSeconds(response.LeaseTtlSeconds);

                if (response.Revoked)
                {
                    await RevokeAsync("the control plane revoked this agent").ConfigureAwait(false);
                    return;
                }

                NoteCatalogue(response.CatalogDigest);
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
                // A missed heartbeat is survivable: the control plane's lease
                // TTL handles a genuinely dead agent, and a flapping home line
                // must not tear down running jobs.
                //
                // Survivable ONE at a time, though, and only if the next one
                // comes soon. This is also the arm a beat the client gave up
                // on arrives in, which costs the keepalive bound before we even
                // get here; waiting a full interval on top of that spends most
                // of the liveness window on a single blip, and everything the
                // control plane routes to this agent is refused meanwhile.
                _logger.LogDebug(
                    ex, "{Connection}: heartbeat failed; beating again in {Delay}", Name, HeartbeatRetryDelay);
                next = HeartbeatRetryDelay;
            }

            await SafeDelayAsync(next, stoppingToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Enrollment happens exactly once per connector. The code is one-time and
    /// HMAC-signed, so re-enrolling on every restart would leave a BYO user
    /// unable to bring their own agent back without asking for a new one.
    /// </summary>
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
            // The key names the connector, because on a machine serving three
            // of them the instruction "set ConnectorAgent:EnrollmentCode" would
            // be advice about the wrong setting two thirds of the time.
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

                // Persisted BEFORE the identity is used, so a crash between the
                // two cannot burn the one-time code.
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
                // A rejected code is a verdict: it was wrong, used, or expired.
                // Hammering it would not change that and would look like abuse.
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

    /// <summary>
    /// The configuration key that carries THIS connector's code, in the shape
    /// the operator's file has it.
    /// </summary>
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

        // A host built outside the composition - in a test - still gets a key
        // that names its connector rather than one that names nothing.
        return $"{ConnectorAgentOptions.SectionName}:Connections:<{Name}>:EnrollmentCode";
    }

    /// <summary>
    /// A revoked connection stops and wipes ITS profiles. Those profiles hold
    /// live provider sessions the control plane can no longer route to, and
    /// leaving them on disk after the user has revoked the agent is exactly the
    /// residue the custody model exists to avoid.
    /// </summary>
    /// <remarks>
    /// <b>Everything here is this connector's and nobody else's</b>, and that
    /// is the change: the profile store is rooted under this connection's own
    /// directory, the state file entry is keyed by this control plane, and the
    /// abort source only cancels jobs this host started. A 401 from a bank
    /// connector restored from an old backup used to wipe the browser DUO is
    /// signed into and stop the process; now it costs the bank connector its
    /// enrollment and leaves the rest of the machine serving.
    /// </remarks>
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
