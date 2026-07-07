using System.Text.Json;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.GoCardless;

/// <summary>
/// Turns GoCardless account/transaction data into sync ops — the server
/// acting as one more device. Deterministic op ids make every ingest
/// idempotent (SyncWriter dedupes), and entity ids match the client-side
/// CAMT importer so cross-source imports collapse into the same rows.
/// </summary>
public sealed class GcIngest(AppDbContext db)
{
    public async Task<int> IngestAccountAsync(
        Space space,
        GcLinkedAccount linked,
        GcAccountDetails details,
        IReadOnlyList<GcBalance> balances,
        IReadOnlyList<GcTransaction> transactions)
    {
        var ops = new List<SyncOpDto>();
        var counter = 0;
        string NextHlc() => ServerHlc.Now(counter++);

        // account row (create or refresh balance)
        var balance = balances.FirstOrDefault(b => b.BalanceType is "closingBooked" or "interimBooked")
                      ?? balances.FirstOrDefault();
        var accountFields = new Dictionary<string, JsonElement>
        {
            ["name"] = Json(details.Name ?? $"Bank · {linked.Iban[^4..]}"),
            ["type"] = Json("checking"),
            ["source"] = Json("gocardless"),
            ["currency"] = Json(details.Currency ?? linked.Currency),
            ["iban"] = Json(linked.Iban),
        };
        if (balance is not null) accountFields["balanceCents"] = Json(ToCents(balance.BalanceAmount.Amount));
        ops.Add(NewOp(space.Id, "account", linked.AccountEntityId, accountFields, NextHlc(), $"acct:{linked.GcAccountId}:{DateOnly.FromDateTime(DateTime.UtcNow)}"));

        foreach (var tx in transactions)
        {
            var reference = tx.TransactionId ?? tx.InternalTransactionId;
            if (reference is null || tx.BookingDate is null) continue;
            var cents = ToCents(tx.TransactionAmount.Amount);
            var direction = cents < 0 ? "debit" : "credit";
            var counterparty = CleanBankText(cents < 0 ? tx.CreditorName : tx.DebtorName);
            var description = CleanBankText(tx.RemittanceInformationUnstructured) ?? "";
            var predicted = KeywordPredictor.Predict($"{counterparty} {description}", direction);

            var fields = new Dictionary<string, JsonElement>
            {
                ["accountId"] = Json(linked.AccountEntityId),
                ["date"] = Json(tx.BookingDate),
                ["amountCents"] = Json(cents),
                ["currency"] = Json(tx.TransactionAmount.Currency),
                ["merchant"] = Json(counterparty ?? Truncate(description, 40)),
                ["description"] = Json(description),
                ["catId"] = Json(predicted?.CatId ?? "uncategorized"),
                ["txType"] = Json(predicted?.TxType ?? (direction == "credit" ? "income" : "expense")),
                ["needsReview"] = Json(predicted is null ? 1 : 0),
                ["importRef"] = Json(reference),
            };
            var entityId = ImportIds.TransactionId(linked.Iban, reference);
            // op id derived from the entity id: re-fetching the same tx is a no-op
            ops.Add(NewOp(space.Id, "transaction", entityId, fields, NextHlc(), $"gc:{entityId}"));
        }

        var writer = new SyncWriter(db);
        var (_, accepted) = await writer.ApplyAsync(space, null, ops);
        return accepted;
    }

    private static SyncOpDto NewOp(string spaceId, string entity, string entityId, Dictionary<string, JsonElement> fields, string hlc, string opSeed) =>
        new(ImportIds.OpId(opSeed), spaceId, entity, entityId, fields, hlc);

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static int ToCents(string amount) => (int)Math.Round(decimal.Parse(amount, System.Globalization.CultureInfo.InvariantCulture) * 100);

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    /// <summary>ING et al. embed literal &lt;br&gt; separators in remittance text.</summary>
    private static string? CleanBankText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        var cleaned = System.Text.RegularExpressions.Regex.Replace(text, @"<br\s*/?>", " · ",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        cleaned = System.Text.RegularExpressions.Regex.Replace(cleaned, @"</?[a-zA-Z][^>]*>", " ");
        return System.Text.RegularExpressions.Regex.Replace(cleaned, @"\s+", " ").Trim();
    }
}
