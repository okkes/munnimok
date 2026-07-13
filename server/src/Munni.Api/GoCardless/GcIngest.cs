using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using System.Text.RegularExpressions;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.GoCardless;

/// <summary>
/// Turns GoCardless account/transaction data into sync ops — the server
/// acting as one more device, in the shared-accounts shape: raw facts go
/// once into the account's FEED space, the requisition's target space
/// gets the predicted overlay (txMeta) plus the attachment mirror.
/// Deterministic op/entity ids make every ingest idempotent and match
/// the client-side importer, so cross-source imports collapse into the
/// same rows.
/// </summary>
public sealed partial class GcIngest(AppDbContext db)
{
    public async Task<int> IngestAccountAsync(
        Space space,
        GcLinkedAccount linked,
        GcAccountDetails details,
        IReadOnlyList<GcBalance> balances,
        IReadOnlyList<GcTransaction> transactions)
    {
        var feedSpace = await EnsureFeedAsync(linked, space.Id);

        var accountOps = new List<SyncOpDto>();
        var feedOps = new List<SyncOpDto>();
        var spaceOps = new List<SyncOpDto>();
        var counter = 0;
        string NextHlc() => ServerHlc.Now(counter++);

        // account row in the feed (create or refresh balance — raw bank truth)
        var accountFields = await BuildAccountFieldsAsync(linked, details, balances);
        accountOps.Add(NewOp(feedSpace.Id, "account", linked.AccountEntityId, accountFields, NextHlc(), $"acct:{linked.GcAccountId}:{DateOnly.FromDateTime(DateTime.UtcNow)}"));

        // attachment mirror so offline devices render the link
        spaceOps.Add(NewOp(space.Id, "accountLink", ImportIds.AccountLinkId(space.Id, feedSpace.Id), new Dictionary<string, JsonElement>
        {
            ["feedSpaceId"] = Json(feedSpace.Id),
            ["accountId"] = Json(linked.AccountEntityId),
        }, NextHlc(), $"gclink:{space.Id}:{feedSpace.Id}"));

        foreach (var tx in transactions)
        {
            var reference = tx.TransactionId ?? tx.InternalTransactionId;
            if (reference is null || tx.BookingDate is null) continue;
            var cents = ToCents(tx.TransactionAmount.Amount);
            var direction = cents < 0 ? "debit" : "credit";
            var counterparty = CleanBankText(cents < 0 ? tx.CreditorName : tx.DebtorName);
            var counterIban = cents < 0 ? tx.CreditorAccount?.Iban : tx.DebtorAccount?.Iban;
            var description = CleanBankText(tx.RemittanceInformationUnstructured) ?? "";
            var entityId = ImportIds.TransactionId(linked.Iban, reference);

            // raw half: no opinion, just the bank's facts
            var rawFields = new Dictionary<string, JsonElement>
            {
                ["accountId"] = Json(linked.AccountEntityId),
                ["date"] = Json(tx.BookingDate),
                ["amountCents"] = Json(cents),
                ["currency"] = Json(tx.TransactionAmount.Currency),
                ["merchant"] = Json(counterparty ?? Truncate(description, 40)),
                ["description"] = Json(description),
                ["importRef"] = Json(reference),
            };
            // the other side's account number, when the bank names it —
            // clients surface it and join it to known accounts (user request)
            if (!string.IsNullOrWhiteSpace(counterIban)) rawFields["counterIban"] = Json(ImportIds.Normalize(counterIban));
            // op id derived from the entity id: re-fetching the same tx is a no-op
            feedOps.Add(NewOp(feedSpace.Id, "transaction", entityId, rawFields, NextHlc(), $"gc:{entityId}"));

            // the target space's starting opinion (kept server-side for UX
            // parity — devices and members refine it from here by LWW)
            var predicted = KeywordPredictor.Predict($"{counterparty} {description}", direction);
            var metaFields = new Dictionary<string, JsonElement>
            {
                ["txId"] = Json(entityId),
                ["catId"] = Json(predicted?.CatId ?? "uncategorized"),
                ["txType"] = Json(predicted?.TxType ?? (direction == "credit" ? "income" : "expense")),
                ["needsReview"] = Json(predicted is null ? 1 : 0),
            };
            spaceOps.Add(NewOp(space.Id, "txMeta", ImportIds.TxMetaId(space.Id, entityId), metaFields, NextHlc(), $"gcmeta:{space.Id}:{entityId}"));
        }

        var writer = new SyncWriter(db);
        await writer.ApplyAsync(feedSpace, null, accountOps);
        // returns NEW raw transactions only (account/overlay refresh not counted)
        var (_, accepted) = await writer.ApplyAsync(feedSpace, null, feedOps);
        await writer.ApplyAsync(space, null, spaceOps);
        return accepted;
    }

    /// <summary>The feed account row's fields: raw bank truth plus the logo hint.</summary>
    private async Task<Dictionary<string, JsonElement>> BuildAccountFieldsAsync(
        GcLinkedAccount linked, GcAccountDetails details, IReadOnlyList<GcBalance> balances)
    {
        var balance = balances.FirstOrDefault(b => b.BalanceType is "closingBooked" or "interimBooked")
                      ?? (balances.Count > 0 ? balances[0] : null);
        var fields = new Dictionary<string, JsonElement>
        {
            ["name"] = Json(details.Name ?? $"Bank · {linked.Iban[^4..]}"),
            ["type"] = Json("checking"),
            ["source"] = Json("gocardless"),
            ["currency"] = Json(details.Currency ?? linked.Currency),
            ["iban"] = Json(linked.Iban),
        };
        // the institution id lets clients show the real bank logo
        var requisition = await db.GcRequisitions.FindAsync(linked.RequisitionId);
        if (requisition is not null) fields["bankId"] = Json(requisition.InstitutionId);
        if (balance is not null)
        {
            fields["balanceCents"] = Json(ToCents(balance.BalanceAmount.Amount));
            fields["balanceAsOf"] = Json(DateOnly.FromDateTime(DateTime.UtcNow).ToString("yyyy-MM-dd"));
        }
        return fields;
    }

    /// <summary>
    /// Feed registry + owner membership + server-side attachment for a
    /// GoCardless-linked account (the owning flow that may create feeds).
    /// </summary>
    private async Task<Space> EnsureFeedAsync(GcLinkedAccount linked, string targetSpaceId)
    {
        var feedId = ImportIds.FeedSpaceId(linked.Iban);
        var requisition = await db.GcRequisitions.FindAsync(linked.RequisitionId)
            ?? throw new InvalidOperationException($"requisition {linked.RequisitionId} missing");
        var ownerId = requisition.UserId;

        if (await db.FeedSpaces.FindAsync(feedId) is null)
            db.FeedSpaces.Add(new FeedSpace { Id = feedId, OwnerUserId = ownerId, AccountRef = ImportIds.Normalize(linked.Iban) });

        var feedSpace = await db.Spaces.FindAsync(feedId);
        if (feedSpace is null)
        {
            feedSpace = new Space { Id = feedId };
            db.Spaces.Add(feedSpace);
        }
        if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == feedId && m.UserId == ownerId))
            db.SpaceMembers.Add(new SpaceMember { SpaceId = feedId, UserId = ownerId, Role = Social.SpaceRoles.Owner });

        if (!await db.SpaceAccountLinks.AnyAsync(l => l.SpaceId == targetSpaceId && l.FeedSpaceId == feedId && l.AccountId == linked.AccountEntityId))
        {
            db.SpaceAccountLinks.Add(new SpaceAccountLink
            {
                Id = Guid.NewGuid(),
                SpaceId = targetSpaceId,
                FeedSpaceId = feedId,
                AccountId = linked.AccountEntityId,
                AttachedBy = ownerId,
            });
        }
        await db.SaveChangesAsync();
        return feedSpace;
    }

    private static SyncOpDto NewOp(string spaceId, string entity, string entityId, Dictionary<string, JsonElement> fields, string hlc, string opSeed) =>
        new(ImportIds.OpId(opSeed), spaceId, entity, entityId, fields, hlc);

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);

    private static int ToCents(string amount) => (int)Math.Round(decimal.Parse(amount, System.Globalization.CultureInfo.InvariantCulture) * 100);

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    [GeneratedRegex(@"<br\s*/?>", RegexOptions.IgnoreCase)]
    private static partial Regex BrTagRegex();

    [GeneratedRegex(@"</?[a-zA-Z][^>]*>")]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    /// <summary>ING et al. embed literal &lt;br&gt; separators in remittance text.</summary>
    private static string? CleanBankText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        var cleaned = BrTagRegex().Replace(text, " · ");
        cleaned = HtmlTagRegex().Replace(cleaned, " ");
        return WhitespaceRegex().Replace(cleaned, " ").Trim();
    }
}
