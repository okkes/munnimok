using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

/// <summary>
/// A transaction whose id the CONNECTOR invented (the party states none for
/// the row — ING's card repayments, its loan and savings movements) can
/// land under a new id when a fact the id is built from moves. 2026-10-07
/// (prod): such ids once carried the login session, so every new sign-in
/// re-keyed the fetched window and the repayments landed a second time.
/// The adapter's seed is stable now; this is the net under it. Before a
/// derived row becomes a NEW entity, the account's existing rows are asked:
/// <list type="number">
/// <item>the stable id already has a row - nothing to reconcile;</item>
/// <item>a row carries this external id as its import reference (it adopted the id on an earlier pass) - that row;</item>
/// <item>a row of the same account with the same booked date, amount, currency and counterparty that no incoming
/// row claims - the oldest such twin, each one at most once (two identical payments on one day stay two rows).</item>
/// </list>
/// The row keeps its id and takes the new reference, so the person's category,
/// pairing and reimbursements stay where they were filed.
/// </summary>
internal sealed class DerivedRowReconciler(AppDbContext db, IReadOnlySet<string> incomingIds)
{
    private readonly Dictionary<string, AccountIndex> _accounts = new(StringComparer.Ordinal);

    /// <summary>The content twins are matched on: booked date, amount, currency and the counterparty as the ingest names it.</summary>
    public static string Key(string date, long amountCents, string currency, string? merchant) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"{date}|{amountCents}|{currency.ToUpperInvariant()}|{(merchant ?? string.Empty).Trim().ToUpperInvariant()}");

    /// <summary>The entity id a derived row lands on: its own, or the existing row it is the same transaction as.</summary>
    public async Task<string> ResolveAsync(ConnectorAccountRef account, string entityId, string externalId, string key, CancellationToken ct)
    {
        if (!_accounts.TryGetValue(account.Id, out var index))
        {
            index = await AccountIndex.LoadAsync(db, account, ct).ConfigureAwait(false);
            _accounts[account.Id] = index;
        }
        return index.Resolve(entityId, externalId, key, incomingIds);
    }

    /// <summary>One account's existing rows, by reference and by content, loaded once per ingest pass.</summary>
    private sealed class AccountIndex
    {
        private readonly HashSet<string> _ids = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _byReference = new(StringComparer.Ordinal);
        private readonly Dictionary<string, List<(string Id, string Born)>> _byKey = new(StringComparer.Ordinal);
        private readonly HashSet<string> _claimed = new(StringComparer.Ordinal);

        public static async Task<AccountIndex> LoadAsync(AppDbContext db, ConnectorAccountRef account, CancellationToken ct)
        {
            var index = new AccountIndex();
            var rows = await db.EntityRows
                .Where(r => r.SpaceId == account.FeedSpaceId && r.Entity == "transaction" && !r.Deleted)
                .Select(r => new { r.EntityId, r.DataJson, r.FieldVersionsJson })
                .ToListAsync(ct)
                .ConfigureAwait(false);
            foreach (var row in rows)
            {
                var data = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(row.DataJson);
                if (data is null || Text(data, "accountId") != account.AccountEntityId) continue;
                index._ids.Add(row.EntityId);
                if (Text(data, "importRef") is { Length: > 0 } reference) index._byReference.TryAdd(reference, row.EntityId);
                var date = Text(data, "date");
                var currency = Text(data, "currency") ?? "EUR";
                if (date is null || !data.TryGetValue("amountCents", out var cents) || cents.ValueKind != JsonValueKind.Number) continue;
                var versions = JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new();
                var born = versions.GetValueOrDefault("date") ?? string.Empty;
                var key = Key(date, cents.GetInt64(), currency, Text(data, "merchant"));
                if (!index._byKey.TryGetValue(key, out var twins)) index._byKey[key] = twins = [];
                twins.Add((row.EntityId, born));
            }
            foreach (var twins in index._byKey.Values) twins.Sort((a, b) => string.CompareOrdinal(a.Born, b.Born));
            return index;
        }

        public string Resolve(string entityId, string externalId, string key, IReadOnlySet<string> incoming)
        {
            if (_ids.Contains(entityId)) return entityId;
            if (_byReference.TryGetValue(externalId, out var adopted)) return adopted;
            if (!_byKey.TryGetValue(key, out var twins)) return entityId;
            foreach (var (id, _) in twins)
            {
                if (_claimed.Contains(id) || incoming.Contains(id)) continue;
                _claimed.Add(id);
                return id;
            }
            return entityId;
        }

        private static string? Text(Dictionary<string, JsonElement> data, string field) =>
            data.TryGetValue(field, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }
}
