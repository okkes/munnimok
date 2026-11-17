using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Tickets;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Sessions;

/// enforced here, not at call sites (a forgotten one is a security bug): web bundles are capped short whatever the
/// manifest claims; every open is bound to the asking subject and to the manifest version the material was written under
public sealed class SessionService(
    ConnectorDbContext db,
    IProviderRegistry registry,
    SealedBundleCodec codec,
    ITicketStore tickets,
    ConnectorSignals signals,
    IOptions<ConnectorOptions> options,
    TimeProvider time)
{
    private readonly ConnectorOptions _options = options.Value;

    public async Task<SessionRow> CreateAsync(NewSession request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        var manifest = registry.RequireManifest(request.ProviderId);

        if (request.DeviceClass == DeviceClass.Web && manifest.WebSupport == WebSupport.None)
        {
            throw ConnectorException.Unsupported(
                $"provider '{manifest.Id}' does not accept web clients");
        }

        var now = time.GetUtcNow();
        var row = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = manifest.Id,
            Subject = request.Subject,
            State = SessionState.Queued,
            ManifestVersion = manifest.ManifestVersion,
            AgentId = request.PreferAgent,
            ProfileId = request.ProfileId,
            FleetOnly = request.FleetOnly,
            ConfigJson = ConnectorJson.Serialize(request.Config),
            ExpiresAt = now.AddSeconds(TtlSecondsFor(manifest, request.DeviceClass)),
            CreatedAt = now,
            UpdatedAt = now,
            Label = request.Label,
            ConsentAcceptedAt = request.ConsentAcceptedAt,
            ConsentTermsVersion = request.ConsentTermsVersion,
            DeviceClass = request.DeviceClass,
        };

        db.Sessions.Add(row);
        await db.SaveChangesAsync(ct);
        return row;
    }

    /// a mismatch answers "unknown session" like a miss, so a probing caller learns nothing
    public async Task<SessionRow> RequireAsync(string providerId, string sessionId, string? subject, CancellationToken ct)
    {
        var row = await db.Sessions.FirstOrDefaultAsync(
            s => s.Id == sessionId && s.ProviderId == providerId, ct);

        if (row is null) throw ConnectorException.Unsupported($"unknown session '{sessionId}'");

        if (subject is not null && !string.Equals(row.Subject, subject, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"unknown session '{sessionId}'");
        }

        return row;
    }

    /// leaves a session that already moved on alone: a plain transition lost a race (a fast job raised its challenge, then
    /// the endpoint's write moved awaiting_input back to running, a legal edge, and the login hung); the endpoint now marks
    /// running BEFORE the job exists and this guard keeps it so
    public async Task<SessionRow> StartAsync(SessionRow session, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);

        return session.State == SessionState.Queued
            ? await TransitionAsync(session, SessionState.Running, ct).ConfigureAwait(false)
            : session;
    }

    /// no-op when already there; an illegal edge throws: it is a bug in the caller, not an input error
    public async Task<SessionRow> TransitionAsync(SessionRow session, SessionState next, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (session.State == next) return session;

        SessionStateMachine.EnsureTransition(session.State, next);
        session.State = next;
        session.UpdatedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);
        signals.Signal(ConnectorSignals.Session(session.Id));
        return session;
    }

    /// the failure path lands on the nearest terminal state instead of throwing:
    /// refusing to record a failure would leave the session stuck
    public async Task<SessionRow> TransitionOrTerminateAsync(SessionRow session, SessionState next, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (session.State == next || SessionStateMachine.IsTerminal(session.State)) return session;

        if (!SessionStateMachine.CanTransition(session.State, next))
        {
            next = SessionStateMachine.CanTransition(session.State, SessionState.Failed)
                ? SessionState.Failed
                : SessionState.Expired;
        }

        return await TransitionAsync(session, next, ct);
    }

    /// TTL is the minimum of the provider's promise, the adapter's observation and, for web, one hour:
    /// a bundle escaping a browser tab gets a small window
    public SealedSession Seal(SessionRow session, SessionMaterial material, IReadOnlyList<ReachableAccount> accounts, DateTimeOffset? adapterExpiry)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(material);

        var manifest = registry.RequireManifest(session.ProviderId);
        var now = time.GetUtcNow();
        var expiresAt = now.AddSeconds(TtlSecondsFor(manifest, session.DeviceClass));

        // an adapter that observed a shorter real session wins: a longer manifest TTL promises silent syncing that then fails
        if (adapterExpiry is { } observed && observed < expiresAt) expiresAt = observed;

        var config = ConnectorJson.DeserializeOr(session.ConfigJson, EmptyConfig);
        var payload = new BundlePayload
        {
            SessionId = session.Id,
            Provider = session.ProviderId,
            IssuedAt = now,
            ExpiresAt = expiresAt,
            Material = material,
            Config = config,
            Accounts = accounts,
        };

        var bundle = codec.Seal(payload, Binding(session.ProviderId, session.Subject, session.ManifestVersion));
        return new SealedSession(bundle, expiresAt);
    }

    /// null unless the provider declares a credential store and the login collected something
    /// lives CredentialBundleDays, not the session's life: a password never expires, rotates or can be revoked from here
    public string? SealCredentials(SessionRow session, IReadOnlyDictionary<string, string> inputs)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(inputs);

        var manifest = registry.RequireManifest(session.ProviderId);
        if (!manifest.OffersCredentialStore || inputs.Count == 0) return null;

        var now = time.GetUtcNow();

        return codec.SealCredentials(
            new CredentialPayload
            {
                SessionId = session.Id,
                Provider = session.ProviderId,
                IssuedAt = now,
                ExpiresAt = now.AddDays(_options.Timeouts.CredentialBundleDays),
                Inputs = inputs,
            },
            Binding(session.ProviderId, session.Subject, session.ManifestVersion));
    }

    /// the subject is in the AAD, so a blob cannot be redeemed by naming another session id; what comes out is a password
    public IReadOnlyDictionary<string, string> OpenCredentials(string providerId, string subject, string bundle)
    {
        var manifest = registry.RequireManifest(providerId);
        var payload = codec.OpenCredentials(bundle, Binding(manifest.Id, subject, manifest.ManifestVersion));

        if (!string.Equals(payload.Provider, manifest.Id, StringComparison.Ordinal))
        {
            throw ConnectorException.SessionExpired("credential bundle names another provider");
        }

        return payload.Inputs;
    }

    /// every rejection surfaces as the same SessionExpired: a probing caller learns nothing,
    /// a real user is told to sign in again
    public async Task<OpenedSession> OpenAsync(string providerId, string subject, string bundle, CancellationToken ct)
    {
        var manifest = registry.RequireManifest(providerId);
        var payload = codec.Open(bundle, Binding(manifest.Id, subject, manifest.ManifestVersion));

        if (!string.Equals(payload.Provider, manifest.Id, StringComparison.Ordinal))
        {
            throw ConnectorException.SessionExpired("bundle names another provider");
        }

        var session = await db.Sessions.FirstOrDefaultAsync(
            s => s.Id == payload.SessionId && s.ProviderId == manifest.Id, ct)
            ?? throw ConnectorException.SessionExpired("session no longer exists");

        if (!string.Equals(session.Subject, subject, StringComparison.Ordinal))
        {
            throw ConnectorException.SessionExpired("bundle is for another subject");
        }

        if (session.ManifestVersion != manifest.ManifestVersion)
        {
            throw ConnectorException.SessionExpired("session predates a breaking manifest change");
        }

        if (!SessionStateMachine.IsUsable(session.State))
        {
            throw ConnectorException.SessionExpired($"session is {session.State}");
        }

        if (session.ExpiresAt <= time.GetUtcNow())
        {
            throw ConnectorException.SessionExpired("session expired");
        }

        return new OpenedSession(session, payload);
    }

    /// tickets die first so no request slips in behind the purge;
    /// upstream logout is the caller's and its failure never blocks a local disconnect
    public async Task PurgeAsync(SessionRow session, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);

        tickets.RevokeSession(session.Id);

        await db.Results.Where(r => r.SessionId == session.Id).ExecuteDeleteAsync(ct);
        await db.Jobs.Where(j => j.SessionId == session.Id)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.InputsJson, (string?)null)
                .SetProperty(j => j.MaterialJson, (string?)null), ct);
        // a failed run's pending question goes with the connection; what they already chose to share stays (#441 L1)
        await db.JobArtifacts
            .Where(a => a.SessionId == session.Id && a.Status == ArtifactStatus.Pending)
            .ExecuteDeleteAsync(ct);
        // the profile row stays: it names a browser directory on the holder's machine and the bank's trust in it outlives
        // the connection; a declared logout already signs out upstream, and nothing here can empty that directory

        // disconnect means forget: an uncollected bundle would leave their sealed credentials behind
        session.PendingBundle = null;
        session.PendingCredentialBundle = null;

        await TransitionOrTerminateAsync(session, SessionState.Disabled, ct);
    }

    public int TtlSecondsFor(ProviderManifest manifest, DeviceClass deviceClass)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var ttl = manifest.Auth.Session.TtlSeconds;
        return deviceClass == DeviceClass.Web && _options.Timeouts.WebBundleMaxTtlSeconds is { } cap
            ? Math.Min(ttl, cap)
            : ttl;
    }

    private static BundleBinding Binding(string providerId, string subject, int manifestVersion) =>
        new(providerId, subject, manifestVersion);

    private static readonly IReadOnlyDictionary<string, string> EmptyConfig =
        new Dictionary<string, string>(StringComparer.Ordinal);
}

public sealed record NewSession
{
    public required string ProviderId { get; init; }

    public required string Subject { get; init; }

    public DeviceClass DeviceClass { get; init; } = DeviceClass.Native;

    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public string? Label { get; init; }

    public DateTimeOffset? ConsentAcceptedAt { get; init; }

    public string? ConsentTermsVersion { get; init; }

    /// required for a device_persistent provider: the BYO agent holding the profile; never RunOn.Fleet, which the login
    /// turns into FleetOnly, as this is written to a column named AgentId
    public string? PreferAgent { get; init; }

    public string? ProfileId { get; init; }

    public bool FleetOnly { get; init; }
}

public readonly record struct SealedSession(string Bundle, DateTimeOffset ExpiresAt);

public readonly record struct OpenedSession(SessionRow Session, BundlePayload Payload);
