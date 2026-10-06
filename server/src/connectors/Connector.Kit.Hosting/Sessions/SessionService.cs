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

/// <summary>
/// Sessions and the bundles that represent them.
///
/// Three rules are enforced here rather than at the call sites, because a
/// call site that forgets one of them is a security bug rather than a
/// missing feature: a web-issued bundle is capped short whatever the
/// manifest claims, every open is bound to the subject that asked, and every
/// open is bound to the manifest version the material was written under.
/// </summary>
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

    /// <summary>
    /// Loads a session for a subject. Returning "unknown provider or session"
    /// for a mismatch as well as a miss is deliberate: a caller probing ids
    /// learns nothing from the difference.
    /// </summary>
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

    /// <summary>
    /// Marks a freshly queued session as running, and LEAVES ONE THAT HAS
    /// ALREADY MOVED ON ALONE.
    /// </summary>
    /// <remarks>
    /// <b>A plain transition here loses a race that has been observed.</b> The
    /// login endpoint enqueued the job and then set the session running, so a
    /// job that started immediately - an inline provider, or a pump that got
    /// there first - could raise its challenge and move the session to
    /// <see cref="SessionState.AwaitingInput"/> BEFORE that write landed. And
    /// awaiting_input to running is a legal edge, so the endpoint's write went
    /// through and put the session back.
    /// <para>
    /// What that leaves is a session reporting <c>running</c> while holding an
    /// unanswered challenge, with its own progress step reading
    /// <c>awaiting_human</c>: a consumer polling for state never learns it has
    /// to ask anybody anything, and the login sits there until it expires. It
    /// was caught by an intermittent test failure under load, which is the only
    /// way a race like this ever surfaces.
    /// </para>
    /// <para>
    /// The endpoint now marks the session running BEFORE the job exists, so the
    /// race cannot happen at all; this guard is what keeps it from coming back
    /// the next time somebody reorders those two lines.
    /// </para>
    /// </remarks>
    public async Task<SessionRow> StartAsync(SessionRow session, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);

        return session.State == SessionState.Queued
            ? await TransitionAsync(session, SessionState.Running, ct).ConfigureAwait(false)
            : session;
    }

    /// <summary>
    /// Moves a session through <see cref="SessionStateMachine"/>. A no-op when
    /// the session is already there, and a hard failure on an illegal edge -
    /// an illegal transition is a bug in the caller, not an input error.
    /// </summary>
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

    /// <summary>
    /// Same as <see cref="TransitionAsync"/> but tolerates an edge the machine
    /// forbids by landing on the nearest terminal state instead of throwing.
    /// Used on the failure path, where refusing to record a failure because
    /// the state machine disagrees would leave a session stuck forever.
    /// </summary>
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

    /// <summary>
    /// Seals material into a bundle for this session's owner.
    ///
    /// The TTL is the minimum of what the provider promises, what the adapter
    /// observed, and - for a web client - one hour. A bundle that escapes a
    /// browser tab then has a small window, which is the entire reason web is
    /// supportable at all.
    /// </summary>
    public SealedSession Seal(SessionRow session, SessionMaterial material, IReadOnlyList<ReachableAccount> accounts, DateTimeOffset? adapterExpiry)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(material);

        var manifest = registry.RequireManifest(session.ProviderId);
        var now = time.GetUtcNow();
        var expiresAt = now.AddSeconds(TtlSecondsFor(manifest, session.DeviceClass));

        // An adapter that observed a shorter real session wins: a manifest
        // claiming 30 days for a 24-hour session makes the consumer promise a
        // month of silent syncing and then fail.
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

    /// <summary>
    /// Seals what the human typed, so their own device can offer it back next
    /// time instead of asking them again.
    ///
    /// Null unless the provider declares a credential store and the login
    /// actually collected something - a run that reused a stored bundle, or a
    /// streamed login that asked for nothing, has nothing new to seal.
    ///
    /// Its life is <see cref="ConnectorTimeouts.CredentialBundleDays"/> and not
    /// the session's: a session bundle expires when the provider's session
    /// does, and a password has no such natural end. It is the credential that
    /// does not rotate and cannot be revoked from here, so the only bound
    /// available is one we choose.
    /// </summary>
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

    /// <summary>
    /// Reads back a credential bundle this connector sealed, for one subject.
    ///
    /// The subject is the authorisation. It is part of the AAD, so a blob
    /// cannot be redeemed by naming somebody else's session id - which matters
    /// here more than anywhere, because what comes out is a password rather
    /// than a scoped token.
    /// </summary>
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

    /// <summary>
    /// Opens a bundle for a subject and returns the session it names.
    ///
    /// Every rejection - wrong subject, wrong provider, stale manifest
    /// version, expired, unknown session, disabled session - surfaces as the
    /// same <see cref="ErrorCode.SessionExpired"/>, so a probing caller
    /// learns nothing from the distinction and a real user gets one honest
    /// instruction: sign in again.
    /// </summary>
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

    /// <summary>
    /// Disconnect. Tickets die first so that no request can slip through
    /// behind the purge, then the staged rows go, then the session is
    /// terminal. Upstream logout is attempted by the caller and its failure
    /// is never fatal: a user disconnecting must always succeed locally.
    /// </summary>
    public async Task PurgeAsync(SessionRow session, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);

        tickets.RevokeSession(session.Id);

        await db.Results.Where(r => r.SessionId == session.Id).ExecuteDeleteAsync(ct);
        await db.Jobs.Where(j => j.SessionId == session.Id)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.InputsJson, (string?)null)
                .SetProperty(j => j.MaterialJson, (string?)null), ct);
        // The question a failed run left for this person goes with the
        // connection; what they already chose to share stays (#441 L1).
        await db.JobArtifacts
            .Where(a => a.SessionId == session.Id && a.Status == ArtifactStatus.Pending)
            .ExecuteDeleteAsync(ct);
        // The profile row is deliberately left alone. It is not a claim on a
        // session - it names a browser directory on a machine somebody owns,
        // and the trust a bank put in that browser outlives this connection.
        // Disconnect already ends the provider session properly: a declared
        // logout arrives at the agent as its own job and really does sign out
        // upstream. Deleting the row on top of that would cost the account
        // holder the browser registration and buy nothing, because nothing
        // here can reach into their machine and empty the directory anyway.

        // Anything still waiting to be handed over. Disconnect means forget,
        // and a bundle nobody collected is exactly what "forget" has to cover -
        // otherwise the one action a user takes to be rid of a connection is
        // the one that leaves their sealed credentials behind.
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

    /// <summary>
    /// Required for a <c>device_persistent</c> provider: the BYO agent that
    /// holds the profile. An agent id and never the reserved
    /// <see cref="Connector.Kit.RunOn.Fleet"/> - the login turns that into
    /// <see cref="FleetOnly"/> before it gets here, because this one is
    /// written to a column named <c>AgentId</c> and a word that is not an
    /// agent id has no business in it.
    /// </summary>
    public string? PreferAgent { get; init; }

    public string? ProfileId { get; init; }

    /// <summary>The caller asked for the operator's fleet by name. See <see cref="SessionRow.FleetOnly"/>.</summary>
    public bool FleetOnly { get; init; }
}

public readonly record struct SealedSession(string Bundle, DateTimeOffset ExpiresAt);

public readonly record struct OpenedSession(SessionRow Session, BundlePayload Payload);
