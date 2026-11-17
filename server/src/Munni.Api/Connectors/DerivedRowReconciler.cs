using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

// connector-invented ids (ING card repayments, loan and savings movements) re-key when a fact in the id moves:
// the login session once did (prod 2026-10-07); the adapter's seed is stable now, this is the net under it
// the row keeps its id and takes the new reference, so category, pairing and reimbursements stay; twins match once each
internal sealed class DerivedRowReconciler(AppDbContext db, IReadOnlySet<string> incomingIds)
{
    private readonly Dictionary<string, AccountIndex> _accounts = new(StringComparer.Ordinal);

    public static string Key(string date, long amountCents, string currency, string? merchant) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"{date}|{amountCents}|{currency.ToUpperInvariant()}|{(merchant ?? string.Empty).Trim().ToUpperInvariant()}");

    public async Task<string> ResolveAsync(ConnectorAccountRef account, string entityId, string externalId, string key, CancellationToken ct)
    {
        if (!_accounts.TryGetValue(account.Id, out var index))
        {
            index = await AccountIndex.LoadAsync(db, account, ct).ConfigureAwait(false);
            _accounts[account.Id] = index;
        }
        return index.Resolve(entityId, externalId, key, incomingIds);
    }

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
