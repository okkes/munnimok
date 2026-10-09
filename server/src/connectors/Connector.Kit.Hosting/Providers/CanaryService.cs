using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Logging;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Providers;

/// <summary>
/// The operator's own connections, and the schedule they run on.
///
/// <para>
/// Every other health signal on this platform is reactive: a provider is marked
/// degraded when a REAL user's fetch comes back <c>provider_changed</c>, and
/// recovers when one succeeds. That works, and it has a hole in the middle of
/// it - the first person to find out is a person. A provider that rebuilds its
/// site on a Tuesday afternoon breaks for whoever syncs next, and the platform
/// learns about it from them.
/// </para>
///
/// <para>
/// A canary closes that by being a user who is always there. It is an
/// operator's own account, enrolled once, fetched on a schedule, and fed into
/// exactly the same <see cref="ProviderStatusService"/> machinery a real
/// failure would reach - so nothing downstream needs to know the difference.
/// </para>
///
/// <para>
/// <b>It is also the only thing on this platform that holds a credential at
/// rest</b>, and the rules below exist to keep that exception the size it was
/// meant to be. See <see cref="CanaryRow"/> for why it cannot be avoided and
/// what is claimed instead.
/// </para>
/// </summary>
public sealed class CanaryService(
    ConnectorDbContext db,
    IProviderRegistry registry,
    TimeProvider time,
    ILogger<CanaryService> logger)
{
    /// <summary>
    /// What an operator's subject has to start with.
    /// </summary>
    /// <remarks>
    /// The load-bearing safety check. A bundle opens only against the subject
    /// it was sealed for, so demanding this prefix at enrolment means a real
    /// user's bundle CANNOT be enrolled here - a consumer's subject is an HMAC
    /// of their id under a per-service salt and will never begin with it.
    /// <para>
    /// So the mistake this is really guarding against is not an attacker. It is
    /// an operator with a support ticket open, a user's bundle on their
    /// clipboard, and a reasonable-sounding idea about reproducing a fault.
    /// </para>
    /// </remarks>
    public const string SubjectPrefix = "canary:";

    /// <summary>The floor on how often a canary may run.</summary>
    /// <remarks>
    /// A canary is a real session against a real provider, and hammering one
    /// from a datacentre address is how an account gets blocked - which would
    /// take the canary out and teach the operator nothing. Fifteen minutes is
    /// far below any provider's patience and far above any useful attack on it.
    /// </remarks>
    public const int MinimumIntervalMinutes = 15;

    public Task<List<CanaryRow>> AllAsync(CancellationToken ct) =>
        db.Canaries.AsNoTracking().OrderBy(c => c.ProviderId).ToListAsync(ct);

    /// <summary>
    /// Enrols, or replaces, the canary for one provider.
    /// </summary>
    /// <remarks>
    /// The bundle is not opened here. Opening it needs the subject binding and
    /// the manifest version, which the scheduler does at run time anyway, and a
    /// bundle that will not open is a thing the first run reports honestly
    /// rather than something enrolment has to pre-empt.
    /// </remarks>
    public async Task<CanaryRow> EnrolAsync(
        string providerId, string subject, string bundle, string resourceId, int intervalMinutes, CancellationToken ct)
    {
        var manifest = registry.RequireManifest(providerId);

        if (string.IsNullOrWhiteSpace(subject) || !subject.StartsWith(SubjectPrefix, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidRequest(
                $"canary: the subject must begin with '{SubjectPrefix}', so that a connection belonging to a "
                + "person cannot be enrolled here. Connect the operator's own account with such a subject and "
                + "offer that bundle instead");
        }

        if (string.IsNullOrWhiteSpace(bundle))
        {
            throw ConnectorException.InvalidRequest("canary: no bundle was offered, so there is nothing to run with");
        }

        if (!manifest.Resources.Any(r => string.Equals(r.Id, resourceId, StringComparison.Ordinal)))
        {
            throw ConnectorException.InvalidRequest(
                $"canary: {manifest.Id} offers no resource '{resourceId}'; it has "
                + $"[{string.Join(", ", manifest.Resources.Select(r => r.Id))}]");
        }

        if (intervalMinutes < MinimumIntervalMinutes)
        {
            throw ConnectorException.InvalidRequest(
                $"canary: {intervalMinutes} minute(s) is below the {MinimumIntervalMinutes}-minute floor. A canary "
                + "is a real session against a real provider, and one that runs too often gets its own account "
                + "blocked");
        }

        var row = await db.Canaries.FirstOrDefaultAsync(c => c.ProviderId == manifest.Id, ct);

        if (row is null)
        {
            row = new CanaryRow { ProviderId = manifest.Id, CreatedAt = time.GetUtcNow() };
            db.Canaries.Add(row);
        }

        row.Subject = subject;
        row.Bundle = bundle;
        row.ResourceId = resourceId;
        row.IntervalMinutes = intervalMinutes;

        // A re-enrolment is a new connection, so last time's verdict is about
        // something that no longer exists.
        row.LastRunAt = null;
        row.LastJobId = null;
        row.LastVerdict = null;
        row.LastIntact = null;

        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "canary for {Provider} enrolled against {Resource}, every {Minutes} minute(s)",
            manifest.Id, LogSafe.Line(resourceId), intervalMinutes);

        return row;
    }

    /// <summary>
    /// Forgets a canary, and the credential with it.
    /// </summary>
    /// <remarks>
    /// The row is deleted rather than disabled. A disabled canary would leave
    /// an operator's live provider session sitting in this table indefinitely
    /// with nothing running against it - which is the shape of every credential
    /// that outlives its purpose.
    /// </remarks>
    public async Task<bool> RemoveAsync(string providerId, CancellationToken ct)
    {
        var row = await db.Canaries.FirstOrDefaultAsync(c => c.ProviderId == providerId, ct);
        if (row is null) return false;

        db.Canaries.Remove(row);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("canary for {Provider} removed", LogSafe.Line(providerId));
        return true;
    }

    /// <summary>
    /// Saves a row the scheduler has just armed for a run.
    /// </summary>
    /// <remarks>
    /// <see cref="CanaryScheduler"/> stamps the row and this writes it, so
    /// every write to this table goes through the service that owns it rather
    /// than through whoever happened to be holding the context.
    /// </remarks>
    public Task RecordStartedAsync(CanaryRow canary, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(canary);

        db.Canaries.Update(canary);
        return db.SaveChangesAsync(ct);
    }

    /// <summary>Canaries whose next run is owed, oldest first.</summary>
    public async Task<List<CanaryRow>> DueAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var rows = await db.Canaries.ToListAsync(ct);

        return
        [
            .. rows
                .Where(c => c.LastRunAt is null || c.LastRunAt.Value.AddMinutes(c.IntervalMinutes) <= now)
                .OrderBy(c => c.LastRunAt ?? DateTimeOffset.MinValue),
        ];
    }

    /// <summary>
    /// Records what a run concluded, and keeps the bundle it handed back.
    /// </summary>
    /// <remarks>
    /// ROTATION IS THE PART THAT MATTERS. Most providers issue a fresh bundle
    /// on every fetch and invalidate the one that was used; a canary that kept
    /// the original would open it successfully once and fail every time after,
    /// reporting a break it had caused itself - and reporting it as
    /// <c>provider_changed</c>, which degrades the provider for every real user
    /// too. A self-inflicted outage is a worse failure than the one this is
    /// here to catch.
    /// </remarks>
    public async Task RecordAsync(
        string providerId, string? jobId, bool intact, string verdict, string? rotatedBundle, CancellationToken ct)
    {
        var row = await db.Canaries.FirstOrDefaultAsync(c => c.ProviderId == providerId, ct);
        if (row is null) return;

        row.LastRunAt = time.GetUtcNow();
        row.LastJobId = jobId;
        row.LastIntact = intact;

        // Truncated to the column, because a provider's own refusal can be long
        // and this is a summary an operator scans rather than a record.
        row.LastVerdict = verdict.Length > 512 ? verdict[..512] : verdict;

        if (!string.IsNullOrWhiteSpace(rotatedBundle)) row.Bundle = rotatedBundle;

        await db.SaveChangesAsync(ct);
    }
}
