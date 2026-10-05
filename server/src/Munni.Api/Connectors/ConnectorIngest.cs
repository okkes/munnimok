using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Social;
using Munni.Api.Sync;

namespace Munni.Api.Connectors;

/// <summary>What one ingest wrote, by record kind, plus what it could not represent.</summary>
public sealed record ConnectorIngestCounts(int Receipts, int Accounts, int Transactions, int Positions, int Dropped)
{
    public static ConnectorIngestCounts None { get; } = new(0, 0, 0, 0, 0);

    public int Records => Receipts + Accounts + Transactions + Positions;

    public ConnectorIngestCounts Plus(ConnectorIngestCounts other) => new(
        Receipts + other.Receipts,
        Accounts + other.Accounts,
        Transactions + other.Transactions,
        Positions + other.Positions,
        Dropped + other.Dropped);
}

/// <summary>What an ingest landed and where, so the caller can wake the devices reading those feeds.</summary>
public sealed record ConnectorIngestResult(
    ConnectorIngestCounts Counts,
    IReadOnlySet<string> TouchedSpaces,
    /// <summary>The pending rows this ingest mirrored (§15): the sync settles the account's earlier ones against them once the fetch is complete.</summary>
    IReadOnlyList<ConnectorPendingTx>? Pending = null,
    /// <summary>The spaces the accounts are attached to, where the prediction overlays went: the ones a scheduled fetch wakes with a push.</summary>
    IReadOnlySet<string>? AttachedSpaces = null)
{
    public IReadOnlyList<ConnectorPendingTx> PendingRows => Pending ?? [];

    public IReadOnlySet<string> Attached => AttachedSpaces ?? new HashSet<string>(StringComparer.Ordinal);
}

/// <summary>
/// Turns the connector's normalised records into sync ops — the server
/// acting as one more device, as the api's own open-banking ingest did
/// before the banks became parties (docs/connector-integration-plan.md
/// §5.6, §15). Receipts land in
/// the owner's store feed, bank accounts and their transactions in the
/// account's IBAN feed (a card or wallet without one in a personal feed),
/// registry positions as liability accounts in a personal registry feed.
/// Every op id is deterministic, so a re-fetch is a no-op and a crash
/// between fetch and ack costs nothing. Attaching to a space stays the
/// user's explicit step — ingest never writes a link.
/// </summary>
public sealed class ConnectorIngest(AppDbContext db, TimeProvider time, ILogger<ConnectorIngest> logger)
{
    /// <summary>The account-row source every connector-fed row carries (apps/web AccountSource gains it in M3).</summary>
    public const string Source = "connector";

    public const string StoreFeedRef = "STORES";
    public const string RegistryFeedRef = "REG";

    // the entities the rows become, and the connector fields read by name
    private const string AccountEntity = "account";
    private const string TransactionEntity = "transaction";
    private const string ReceiptEntity = "receipt";
    private const string ExternalIdField = "external_id";
    /// <summary>What a bank party prefixes the external id of a row the bank has not booked yet (§15).</summary>
    public const string PendingPrefix = "pending:";
    /// <summary>A row's money direction as the keyword predictor reads it (the other being <c>debit</c>).</summary>
    private const string CreditDirection = "credit";
    /// <summary>The app's account type for a card the party calls credit, revolving or deferred.</summary>
    private const string CreditAccountType = "credit";
    private const string SourceField = "source";
    private const string CurrencyField = "currency";
    private const string ProviderField = "provider";
    private const string NameField = "name";
    private const string TypeField = "type";
    private const string NoteField = "note";
    private const string BalanceField = "balanceCents";
    private const string BalanceAsOfField = "balanceAsOf";

    private const int EntityIdMaximumLength = 128;

    /// <summary>The record kinds this ingest files, in the order a page is worked: accounts before the transactions that name them.</summary>
    private static readonly string[] Shapes = [AccountEntity, TransactionEntity, ReceiptEntity, "credit_registration", "student_debt"];

    private int _counter;

    /// <summary>
    /// Files one page. A page is not one shape: a bank's transactions pass
    /// carries the accounts it read them from, so every record is filed by
    /// what it IS — the connector's own id prefix — and the resource's
    /// declared shape only stands in for a record without one.
    /// </summary>
    public async Task<ConnectorIngestResult> IngestAsync(
        Guid userId, string provider, string providerName, string connectionId, string shape, JsonArray records, CancellationToken ct)
    {
        var user = await db.Users.FindAsync([userId], ct) ?? throw new InvalidOperationException($"user {userId} missing");
        var touched = new HashSet<string>(StringComparer.Ordinal);
        var pending = new List<ConnectorPendingTx>();
        var attached = new HashSet<string>(StringComparer.Ordinal);
        var byShape = records.OfType<JsonObject>().GroupBy(r => ShapeOf(r, shape)).ToDictionary(g => g.Key, g => g.ToList());

        var counts = ConnectorIngestCounts.None;
        foreach (var kind in Shapes)
        {
            if (!byShape.Remove(kind, out var items)) continue;
            counts = counts.Plus(kind switch
            {
                AccountEntity => await AccountsAsync(user, provider, connectionId, items, touched, ct),
                TransactionEntity => await TransactionsAsync(user, provider, items, touched, pending, attached, ct),
                ReceiptEntity => await ReceiptsAsync(user, provider, connectionId, items, touched, ct),
                "credit_registration" => await RegistrationsAsync(user, provider, items, touched, ct),
                _ => await StudentDebtsAsync(user, provider, providerName, items, touched, ct),
            });
        }
        foreach (var (unknown, items) in byShape) counts = counts.Plus(Unknown(unknown, items.Count));

        return new ConnectorIngestResult(counts, touched, pending, attached);
    }

    /// <summary>The connector mints <c>acc_</c>, <c>txn_</c>, <c>rcp_</c>, <c>crd_</c> and <c>sdt_</c> ids; a record without one is what the resource says it returns.</summary>
    internal static string ShapeOf(JsonObject record, string declared) => record.Text("id") switch
    {
        { } id when id.StartsWith("acc_", StringComparison.Ordinal) => AccountEntity,
        { } id when id.StartsWith("txn_", StringComparison.Ordinal) => TransactionEntity,
        { } id when id.StartsWith("rcp_", StringComparison.Ordinal) => ReceiptEntity,
        { } id when id.StartsWith("crd_", StringComparison.Ordinal) => "credit_registration",
        { } id when id.StartsWith("sdt_", StringComparison.Ordinal) => "student_debt",
        _ => declared,
    };

    private ConnectorIngestCounts Unknown(string shape, int count)
    {
        if (logger.IsEnabled(LogLevel.Warning))
        {
            logger.LogWarning("connector ingest: {Count} record(s) of an unknown shape '{Shape}' dropped", count, shape);
        }
        return new ConnectorIngestCounts(0, 0, 0, 0, count);
    }

    // ── receipts → the owner's store feed ────────────────────────────────

    private async Task<ConnectorIngestCounts> ReceiptsAsync(
        User user, string provider, string connectionId, List<JsonObject> records, HashSet<string> touched, CancellationToken ct)
    {
        var feed = await EnsurePersonalFeedAsync(user, StoreFeedRef, ct);
        var ops = new List<SyncOpDto>();
        var dropped = 0;

        foreach (var receipt in records)
        {
            var op = ReceiptOp(feed.Id, provider, connectionId, receipt);
            if (op is null) dropped++;
            else ops.Add(op);
        }

        var accepted = await ApplyAsync(feed, ops, touched);
        return new ConnectorIngestCounts(accepted, 0, 0, 0, dropped);
    }

    /// <summary>One receipt as the app's row, or null when the record lacks what a row needs.</summary>
    private SyncOpDto? ReceiptOp(string feedId, string provider, string connectionId, JsonObject receipt)
    {
        var externalId = receipt.Text(ExternalIdField);
        var purchasedAt = receipt["purchased_at"]?.GetValue<DateTimeOffset>();
        var total = Money(receipt["total"]);
        if (externalId is null || purchasedAt is null || total is null) return null;

        var entityId = Fit($"rcpt:{provider}:{connectionId}:", externalId);
        var fields = new Dictionary<string, JsonElement>
        {
            [SourceField] = Json(provider),
            ["date"] = Json(purchasedAt.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
            ["totalCents"] = Json(total.Value.Value),
            [CurrencyField] = Json(total.Value.Currency),
            ["storeRef"] = Json($"{provider}:{externalId}"),
            ["instanceId"] = Json(connectionId),
        };
        if (receipt["merchant"] is JsonObject merchant && merchant.Text(NameField) is { } merchantName)
        {
            fields["merchant"] = Json(merchantName);
        }
        if (receipt["items"] is JsonArray lines && lines.Count > 0)
        {
            fields["items"] = Json(lines.OfType<JsonObject>().Select(ReceiptLine).Where(l => l is not null).ToList());
        }
        if (receipt["payment"] is JsonObject payment) fields["payment"] = Json(ReceiptPayment(payment));
        if (receipt["reconciled"]?.GetValue<bool>() == false) fields["reconciled"] = Json(false);
        if (receipt["documents"] is JsonArray documents && documents.Count > 0)
        {
            fields["documents"] = Json(documents.OfType<JsonObject>().Select(Document).Where(d => d is not null).ToList());
        }

        return Op(feedId, ReceiptEntity, entityId, fields, Seed(entityId, receipt, fields));
    }

    /// <summary>A line as the app draws it; a kind other than a product rides along so a breakdown can say what a line was.</summary>
    private static object? ReceiptLine(JsonObject line)
    {
        var name = line.Text(NameField);
        var total = Money(line["total"]);
        if (name is null || total is null) return null;
        return new
        {
            name,
            qty = line["quantity"]?.GetValue<decimal>(),
            unitCents = Money(line["unit_price"])?.Value,
            totalCents = total.Value.Value,
            kind = line.Text("kind") is { } kind && kind != "product" ? kind : null,
        };
    }

    private static object ReceiptPayment(JsonObject payment) => new
    {
        method = payment.Text("method"),
        accountTail = payment.Text("card_last4") ?? payment.Text("iban_tail"),
    };

    /// <summary>A provider's document, carried whole as a data URL the browser can open without a decoding step.</summary>
    private static object? Document(JsonObject document)
    {
        var mediaType = document.Text("media_type");
        var content = document.Text("content_base64");
        if (mediaType is null || content is null) return null;
        return new
        {
            kind = document.Text("kind") ?? "invoice",
            mime = mediaType,
            name = document.Text(NameField),
            filename = document.Text("filename"),
            sizeBytes = document["size_bytes"]?.GetValue<int>(),
            dataUrl = $"data:{mediaType};base64,{content}",
        };
    }

    // ── bank accounts and their transactions → the account's feed ────────

    private async Task<ConnectorIngestCounts> AccountsAsync(
        User user, string provider, string connectionId, List<JsonObject> records, HashSet<string> touched, CancellationToken ct)
    {
        var written = 0;
        var dropped = 0;
        var now = time.GetUtcNow();

        foreach (var account in records)
        {
            var accepted = await AccountAsync(user, provider, connectionId, account, now, touched, ct);
            if (accepted is null) dropped++;
            else written += accepted.Value;
        }

        return new ConnectorIngestCounts(0, written, 0, 0, dropped);
    }

    /// <summary>
    /// One account: its feed, its row, and the reference the transactions
    /// will resolve it by. Null when the record lacks an id; otherwise how
    /// many ops landed — zero when this minute already wrote the same row,
    /// which is what a transactions pass carrying its accounts does.
    /// </summary>
    private async Task<int?> AccountAsync(
        User user, string provider, string connectionId, JsonObject account, DateTimeOffset now, HashSet<string> touched, CancellationToken ct)
    {
        var id = account.Text("id");
        var externalId = account.Text(ExternalIdField);
        if (id is null || externalId is null) return null;
        // an account the person dropped while its consent lives on: the party still lists it, the relay leaves it alone
        if (await db.ConnectorAccountRefs.AnyAsync(a => a.Id == id && a.Excluded, ct)) return 0;

        var iban = account.Text("iban");
        var accountRef = string.IsNullOrWhiteSpace(iban) ? $"CONN:{provider}:{externalId}" : ImportIds.Normalize(iban);
        var isIban = !accountRef.StartsWith("CONN:", StringComparison.Ordinal);
        var feed = isIban
            ? await EnsureIbanFeedAsync(user, accountRef, ct)
            : await EnsurePersonalFeedAsync(user, accountRef, ct);
        var accountEntityId = isIban ? await BankAccountEntityIdAsync(feed.Id, accountRef) : ImportIds.AccountId(accountRef);

        var reference = new ConnectorAccountRef
        {
            Id = id,
            UserId = user.Id,
            Provider = provider,
            ExternalId = externalId,
            ConnectionId = connectionId,
            AccountRef = accountRef,
            FeedSpaceId = feed.Id,
            AccountEntityId = accountEntityId,
            Currency = account.Text(CurrencyField) ?? "EUR",
            SeenAt = now,
        };
        var fields = await AccountFieldsAsync(reference, account, ct);
        // minute-grained seed: a balance refresh must re-emit while the same
        // minute's retry stays a no-op (the GcIngest rule)
        var op = Op(feed.Id, AccountEntity, accountEntityId, fields, $"conn:{accountEntityId}:{now:yyyy-MM-ddTHH:mm}");
        var accepted = await ApplyAsync(feed, [op], touched);

        await RememberAccountAsync(reference, ct);
        return accepted;
    }

    /// <summary>The feed account row's fields: the party's facts, the seed-only name and type, the balance when stated.</summary>
    private async Task<Dictionary<string, JsonElement>> AccountFieldsAsync(ConnectorAccountRef reference, JsonObject account, CancellationToken ct)
    {
        var isIban = !reference.AccountRef.StartsWith("CONN:", StringComparison.Ordinal);
        var fields = new Dictionary<string, JsonElement>
        {
            [SourceField] = Json(Source),
            [ProviderField] = Json(reference.Provider),
            [CurrencyField] = Json(reference.Currency),
            // every device shows when this account last heard from its party
            ["lastSyncedAt"] = Json(reference.SeenAt.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture)),
        };
        // #445: and which connection fetched it - when that connection is gone
        // (reconnected with a consent that reaches other accounts, removed),
        // nothing fetches the row any more, and the app can say so
        if (reference.ConnectionId is { } connectionId) fields["connectionId"] = Json(connectionId);
        if (isIban) fields["iban"] = Json(reference.AccountRef);
        if (account.Text("masked_number") is { } masked) fields["maskedNumber"] = Json(masked);
        // the institution as the party lists it (§15): the app fetches the same logo the lookup showed
        if (account.Text("institution") is { Length: > 0 } institution) fields["bankId"] = Json(institution);

        // the party's display name and type seed the row once; after that
        // the fields belong to the user (GcIngest: re-asserting them every
        // fetch clobbered renames made in the app)
        var exists = await db.EntityRows.AnyAsync(
            r => r.SpaceId == reference.FeedSpaceId && r.Entity == AccountEntity && r.EntityId == reference.AccountEntityId, ct);
        if (!exists)
        {
            fields[NameField] = Json(account.Text("display_name") ?? (isIban ? $"Bank · {reference.AccountRef[^4..]}" : "Card"));
            fields[TypeField] = Json(AccountTypeOf(account.Text(TypeField)));
        }
        if (account["balance"] is JsonObject balance && Money(balance["amount"]) is { } money)
        {
            fields[BalanceField] = Json(money.Value);
            var asOf = balance["as_of"]?.GetValue<DateTimeOffset>() ?? reference.SeenAt;
            fields[BalanceAsOfField] = Json(asOf.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        }
        return fields;
    }

    private async Task<ConnectorIngestCounts> TransactionsAsync(
        User user, string provider, List<JsonObject> records, HashSet<string> touched,
        List<ConnectorPendingTx> pending, HashSet<string> attached, CancellationToken ct)
    {
        var accountIds = records.Select(t => t.Text("account_id")).Where(a => a is not null).Distinct().ToList();
        var known = await db.ConnectorAccountRefs
            .Where(a => a.UserId == user.Id && accountIds.Contains(a.Id))
            .ToDictionaryAsync(a => a.Id, ct);

        var batch = new TransactionBatch();
        foreach (var tx in records) await PlaceAsync(tx, known, batch, pending, ct);

        if (batch.Dropped > 0 && logger.IsEnabled(LogLevel.Warning))
        {
            logger.LogWarning(
                "connector ingest {Provider}: {Dropped} of {Total} transactions dropped — {Orphaned} name an account this relay never saw (first: {Account}), the rest lack an id, a date or an amount",
                provider, batch.Dropped, records.Count, batch.Orphaned, batch.OrphanAccount ?? "-");
        }

        var written = 0;
        foreach (var (feedId, ops) in batch.ByFeed)
        {
            var feed = await db.Spaces.FindAsync([feedId], ct) ?? throw new InvalidOperationException($"feed {feedId} missing");
            written += await ApplyAsync(feed, ops, touched);
        }
        foreach (var (spaceId, metas) in batch.Overlays)
        {
            var space = await db.Spaces.FindAsync([spaceId], ct);
            if (space is null) continue;   // an attachment to a space that is gone: nothing to predict for
            await ApplyAsync(space, metas, touched);
            attached.Add(spaceId);
        }

        return new ConnectorIngestCounts(0, 0, written, 0, batch.Dropped);
    }

    /// <summary>One transactions pass sorted by where its rows go: the feed ops per feed, the overlays per attached space, and what was dropped.</summary>
    private sealed class TransactionBatch
    {
        public Dictionary<string, List<SyncOpDto>> ByFeed { get; } = new(StringComparer.Ordinal);

        /// <summary>The prediction overlay goes to every space the account is attached to, never to the feed (§15).</summary>
        public Dictionary<string, List<SyncOpDto>> Overlays { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, List<string>> SpacesOf { get; } = new(StringComparer.Ordinal);

        public int Dropped { get; set; }

        public int Orphaned { get; set; }

        public string? OrphanAccount { get; set; }
    }

    /// <summary>
    /// One transaction into the batch: its feed row, then its pending mirror
    /// or its overlays — or dropped, when it names an account the accounts
    /// pass never did or one the person dropped (its rows are not invented
    /// back), or lacks an id, a date or an amount.
    /// </summary>
    private async Task PlaceAsync(
        JsonObject tx, Dictionary<string, ConnectorAccountRef> known, TransactionBatch batch, List<ConnectorPendingTx> pending, CancellationToken ct)
    {
        var accountId = tx.Text("account_id");
        var account = accountId is null ? null : known.GetValueOrDefault(accountId);
        if (account is null || account.Excluded)
        {
            batch.Dropped++;
            if (accountId is not null && account is null)
            {
                batch.Orphaned++;
                batch.OrphanAccount ??= accountId;
            }
            return;
        }
        var row = TransactionOp(account, tx);
        if (row is null)
        {
            batch.Dropped++;
            return;
        }
        if (!batch.ByFeed.TryGetValue(row.Op.SpaceId, out var ops)) batch.ByFeed[row.Op.SpaceId] = ops = [];
        ops.Add(row.Op);
        if (row.Pending)
        {
            pending.Add(new ConnectorPendingTx { AccountRefId = account.Id, EntityId = row.EntityId });
            return;   // a pending row is a fact the bank may still withdraw: no opinion on it yet
        }
        if (!batch.SpacesOf.TryGetValue(account.Id, out var spaces)) batch.SpacesOf[account.Id] = spaces = await AttachedSpacesAsync(account, ct);
        foreach (var spaceId in spaces)
        {
            if (!batch.Overlays.TryGetValue(spaceId, out var metas)) batch.Overlays[spaceId] = metas = [];
            metas.Add(OverlayOp(spaceId, row));
        }
    }

    /// <summary>A transaction as it lands: the feed's raw row, and what the overlay needs to know about it.</summary>
    private sealed record TransactionRow(SyncOpDto Op, string EntityId, bool Pending, string Direction, string Text);

    /// <summary>
    /// One transaction as the feed's raw row — no opinion, just the party's
    /// facts — or null when it lacks an id, a date or an amount. A row whose
    /// external id the party prefixed <c>pending:</c> is mirrored as pending
    /// (§15): the bank has not booked it, and may yet withdraw it.
    /// </summary>
    private TransactionRow? TransactionOp(ConnectorAccountRef account, JsonObject tx)
    {
        var externalId = tx.Text(ExternalIdField);
        var bookedAt = tx.Text("booked_at");
        var amount = Money(tx["amount"]);
        if (externalId is null || bookedAt is null || amount is null) return null;

        var entityId = ImportIds.TransactionId(account.AccountRef, externalId);
        var pending = externalId.StartsWith(PendingPrefix, StringComparison.Ordinal);
        var counterparty = tx["counterparty"] as JsonObject;
        var description = tx.Text("description") ?? string.Empty;
        var merchant = counterparty?.Text(NameField);
        var fields = new Dictionary<string, JsonElement>
        {
            ["accountId"] = Json(account.AccountEntityId),
            ["date"] = Json(bookedAt),
            ["amountCents"] = Json(amount.Value.Value),
            [CurrencyField] = Json(amount.Value.Currency),
            ["merchant"] = Json(string.IsNullOrWhiteSpace(merchant) ? Truncate(description, 40) : merchant),
            ["description"] = Json(description),
            ["importRef"] = Json(externalId),
        };
        if (counterparty?.Text("iban") is { Length: > 0 } counterIban) fields["counterIban"] = Json(ImportIds.Normalize(counterIban));
        if (pending) fields["pending"] = Json(1);

        var op = Op(account.FeedSpaceId, TransactionEntity, entityId, fields, Seed(entityId, tx, fields));
        return new TransactionRow(op, entityId, pending, amount.Value.Value < 0 ? "debit" : CreditDirection, $"{merchant} {description}");
    }

    /// <summary>
    /// The predicted category and type for one booked row in one space, as
    /// the api's own bank ingest wrote it: written once per row and space
    /// (the op id is the pair) and stamped with the FLOOR clock, so it only
    /// fills what nobody said yet — a person's choice, made before or after,
    /// always outranks it. (2026-10-05: with the server's live clock the first
    /// overlay the new op-id scheme wrote buried a whole evening's
    /// categorisations; <see cref="TxMetaOverlayRepair"/> put them back.)
    /// </summary>
    private static SyncOpDto OverlayOp(string spaceId, TransactionRow row)
    {
        var predicted = KeywordPredictor.Predict(row.Text, row.Direction);
        var fields = new Dictionary<string, JsonElement>
        {
            ["txId"] = Json(row.EntityId),
            ["catId"] = Json(predicted?.CatId ?? "uncategorized"),
            ["txType"] = Json(predicted?.TxType ?? (row.Direction == CreditDirection ? "income" : "expense")),
            ["needsReview"] = Json(predicted is null ? 1 : 0),
        };
        return new SyncOpDto(ImportIds.OpId($"connmeta:{spaceId}:{row.EntityId}"), spaceId, "txMeta", ImportIds.TxMetaId(spaceId, row.EntityId), fields, ServerHlc.Floor);
    }

    private Task<List<string>> AttachedSpacesAsync(ConnectorAccountRef account, CancellationToken ct) =>
        db.SpaceAccountLinks
            .Where(l => l.FeedSpaceId == account.FeedSpaceId && l.AccountId == account.AccountEntityId)
            .Select(l => l.SpaceId)
            .Distinct()
            .ToListAsync(ct);

    /// <summary>
    /// A complete fetch settles the pending mirror (§15): every pending row
    /// the connection's accounts carried that the party no longer reports
    /// is tombstoned — booked under a new reference, or withdrawn — and the
    /// ones it reported now are remembered for the next time.
    /// </summary>
    public async Task<int> SettlePendingAsync(
        Guid userId, string provider, string connectionId, IReadOnlyList<ConnectorPendingTx> seen, CancellationToken ct)
    {
        var accounts = await db.ConnectorAccountRefs
            .Where(a => a.UserId == userId && a.Provider == provider && a.ConnectionId == connectionId)
            .ToListAsync(ct);
        if (accounts.Count == 0) return 0;
        var accountIds = accounts.Select(a => a.Id).ToList();
        var tracked = await db.ConnectorPendingTxs.Where(p => accountIds.Contains(p.AccountRefId)).ToListAsync(ct);
        var current = seen.Where(p => accountIds.Contains(p.AccountRefId)).Select(p => p.EntityId).ToHashSet(StringComparer.Ordinal);
        var stale = tracked.Where(p => !current.Contains(p.EntityId)).ToList();

        var tombstoned = 0;
        var touched = new HashSet<string>(StringComparer.Ordinal);
        foreach (var byAccount in stale.GroupBy(p => p.AccountRefId))
        {
            var account = accounts.First(a => a.Id == byAccount.Key);
            var feed = await db.Spaces.FindAsync([account.FeedSpaceId], ct);
            if (feed is null) continue;
            var ops = byAccount.Select(p => new SyncOpDto(
                ImportIds.OpId($"connpendrm:{p.EntityId}:{time.GetUtcNow().Ticks}"),
                account.FeedSpaceId, TransactionEntity, p.EntityId, new Dictionary<string, JsonElement>(), ServerHlc.Now(_counter++), Deleted: true)).ToList();
            tombstoned += await ApplyAsync(feed, ops, touched);
        }
        db.ConnectorPendingTxs.RemoveRange(stale);
        var trackedIds = tracked.Select(p => p.EntityId).ToHashSet(StringComparer.Ordinal);
        foreach (var fresh in seen.Where(p => accountIds.Contains(p.AccountRefId) && !trackedIds.Contains(p.EntityId)).DistinctBy(p => p.EntityId))
        {
            db.ConnectorPendingTxs.Add(new ConnectorPendingTx { AccountRefId = fresh.AccountRefId, EntityId = fresh.EntityId });
        }
        await db.SaveChangesAsync(ct);
        return tombstoned;
    }

    private async Task RememberAccountAsync(ConnectorAccountRef fresh, CancellationToken ct)
    {
        var known = await db.ConnectorAccountRefs.FindAsync([fresh.Id], ct);
        if (known is null)
        {
            db.ConnectorAccountRefs.Add(fresh);
        }
        else
        {
            known.AccountRef = fresh.AccountRef;
            known.FeedSpaceId = fresh.FeedSpaceId;
            known.AccountEntityId = fresh.AccountEntityId;
            known.Currency = fresh.Currency;
            known.SeenAt = fresh.SeenAt;
            known.ConnectionId = fresh.ConnectionId ?? known.ConnectionId;
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The kit's account type as the app names it.</summary>
    internal static string AccountTypeOf(string? type) => type switch
    {
        "savings" => "savings",
        "credit_card" => CreditAccountType,
        "loan" => "loan",
        _ => AccountTypes.Default,
    };

    /// <summary>
    /// #311 r4: the canonical id, unless a statement import already owns that
    /// row on the feed — then the party forks to its own row and the user
    /// merges the two in the app. The same rule GcEndpoints applies.
    /// </summary>
    private async Task<string> BankAccountEntityIdAsync(string feedId, string accountRef)
    {
        var canonical = ImportIds.AccountId(accountRef);
        var row = await db.EntityRows.FirstOrDefaultAsync(r =>
            r.SpaceId == feedId && r.Entity == AccountEntity && r.EntityId == canonical && !r.Deleted);
        if (row is null) return canonical;
        using var data = JsonDocument.Parse(row.DataJson);
        var providerOwned = data.RootElement.TryGetProperty(SourceField, out var source)
                            && source.GetString() is "gocardless" or Source;
        return providerOwned ? canonical : ImportIds.BankAccountId(accountRef);
    }

    // ── registry positions → liability accounts in the registry feed ─────

    private async Task<ConnectorIngestCounts> RegistrationsAsync(
        User user, string provider, List<JsonObject> records, HashSet<string> touched, CancellationToken ct)
    {
        var feed = await EnsurePersonalFeedAsync(user, RegistryFeedRef, ct);
        var ops = new List<SyncOpDto>();
        var dropped = 0;

        foreach (var credit in records)
        {
            var externalId = credit.Text(ExternalIdField);
            var amount = Money(credit["amount"]);
            if (externalId is null || amount is null)
            {
                dropped++;
                continue;
            }

            var entityId = Fit($"acct:{provider}:", externalId);
            var ended = credit.Text("status") == "ended";
            var fields = new Dictionary<string, JsonElement>
            {
                [SourceField] = Json(Source),
                [ProviderField] = Json(provider),
                [NameField] = Json(credit.Text("creditor") ?? provider),
                [TypeField] = Json(LiabilityTypeOf(credit.Text("kind"))),
                [CurrencyField] = Json(amount.Value.Currency),
                // the registry states what was registered, not what is left —
                // the note says so, and an ended credit reads as settled
                ["originalCents"] = Json(amount.Value.Value),
                [BalanceField] = Json(ended ? 0L : amount.Value.Value),
                ["archived"] = Json(ended ? 1 : 0),
                [NoteField] = Json(RegistrationNote(credit)),
            };
            if (Money(credit["monthly_amount"]) is { } monthly)
            {
                fields["paymentCents"] = Json(monthly.Value);
                fields["paymentEvery"] = Json("month");
            }
            if (credit.Text("started_on") is { } started) fields[BalanceAsOfField] = Json(started);

            ops.Add(Op(feed.Id, AccountEntity, entityId, fields, Seed(entityId, credit, fields)));
        }

        var accepted = await ApplyAsync(feed, ops, touched);
        return new ConnectorIngestCounts(0, 0, 0, accepted, dropped);
    }

    private async Task<ConnectorIngestCounts> StudentDebtsAsync(
        User user, string provider, string providerName, List<JsonObject> records, HashSet<string> touched, CancellationToken ct)
    {
        var feed = await EnsurePersonalFeedAsync(user, RegistryFeedRef, ct);
        var ops = new List<SyncOpDto>();
        var dropped = 0;

        foreach (var debt in records)
        {
            var externalId = debt.Text(ExternalIdField);
            var total = Money(debt["total"]);
            if (externalId is null || total is null)
            {
                dropped++;
                continue;
            }

            var entityId = Fit($"acct:{provider}:", externalId);
            var fields = new Dictionary<string, JsonElement>
            {
                [SourceField] = Json(Source),
                [ProviderField] = Json(provider),
                [NameField] = Json(providerName),
                [TypeField] = Json("loan"),
                [CurrencyField] = Json(total.Value.Currency),
                [BalanceField] = Json(total.Value.Value),
                [NoteField] = Json(StudentDebtNote(debt)),
            };
            if (debt["interest_rate"]?.GetValue<decimal>() is { } rate) fields["interestPctYear"] = Json(rate);
            if (debt.Text("interest_calculated_until") is { } until) fields[BalanceAsOfField] = Json(until);

            ops.Add(Op(feed.Id, AccountEntity, entityId, fields, Seed(entityId, debt, fields)));
        }

        var accepted = await ApplyAsync(feed, ops, touched);
        return new ConnectorIngestCounts(0, 0, 0, accepted, dropped);
    }

    /// <summary>D9: the liability account IS the debt — its type from the registry's classification.</summary>
    internal static string LiabilityTypeOf(string? kind) => kind switch
    {
        "mortgage" => "mortgage",
        "revolving" or "deferred_payment" => CreditAccountType,
        _ => "loan",
    };

    private static string RegistrationNote(JsonObject credit)
    {
        var parts = new List<string>();
        if (credit.Text("kind_label") is { Length: > 0 } label) parts.Add(label);
        parts.Add(credit.Text("status") == "ended" ? "beëindigd" : "geregistreerd bedrag, niet het openstaande saldo");
        if (credit.Text("ends_on") is { } ends) parts.Add($"tot {ends}");
        if (credit.Text("arrears_code") is { Length: > 0 } arrears) parts.Add($"code {arrears}");
        return string.Join(" · ", parts);
    }

    private static string StudentDebtNote(JsonObject debt)
    {
        var parts = new List<string>();
        if (debt.Text("phase_label") is { Length: > 0 } phase) parts.Add(phase);
        if (debt["total_is_derived"]?.GetValue<bool>() == true) parts.Add("som van de onderdelen");
        if (debt.Text("interest_regime") is { Length: > 0 } regime) parts.Add(regime);
        return string.Join(" · ", parts);
    }

    // ── feeds ────────────────────────────────────────────────────────────

    /// <summary>The user's own feed for a reference: registered the way <c>POST /feeds</c> registers it, owner and member.</summary>
    private async Task<Space> EnsurePersonalFeedAsync(User user, string accountRef, CancellationToken ct)
    {
        var feedId = ImportIds.PersonalFeedSpaceId(accountRef, user.Sub);
        if (await db.FeedSpaces.FindAsync([feedId], ct) is null)
        {
            db.FeedSpaces.Add(new FeedSpace { Id = feedId, OwnerUserId = user.Id, AccountRef = ImportIds.Normalize(accountRef) });
        }
        return await EnsureSpaceAsync(feedId, user.Id, ct);
    }

    /// <summary>
    /// An IBAN feed is shared by construction: whoever connects the same
    /// account first owns it, and everyone whose own connection covers it
    /// afterwards co-owns it (#240: the IBAN proves it is the same account).
    /// </summary>
    private async Task<Space> EnsureIbanFeedAsync(User user, string iban, CancellationToken ct)
    {
        var feedId = ImportIds.FeedSpaceId(iban);
        var feed = await db.FeedSpaces.FindAsync([feedId], ct);
        if (feed is null)
        {
            db.FeedSpaces.Add(new FeedSpace { Id = feedId, OwnerUserId = user.Id, AccountRef = ImportIds.Normalize(iban) });
        }
        else if (feed.OwnerUserId != user.Id
                 && !await db.FeedOwners.AnyAsync(o => o.FeedSpaceId == feedId && o.UserId == user.Id, ct))
        {
            db.FeedOwners.Add(new FeedOwner { FeedSpaceId = feedId, UserId = user.Id });
        }
        return await EnsureSpaceAsync(feedId, user.Id, ct);
    }

    private async Task<Space> EnsureSpaceAsync(string feedId, Guid userId, CancellationToken ct)
    {
        var space = await db.Spaces.FindAsync([feedId], ct);
        if (space is null)
        {
            space = new Space { Id = feedId };
            db.Spaces.Add(space);
        }
        if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == feedId && m.UserId == userId, ct))
        {
            db.SpaceMembers.Add(new SpaceMember { SpaceId = feedId, UserId = userId, Role = SpaceRoles.Owner });
        }
        await db.SaveChangesAsync(ct);
        return space;
    }

    // ── ops ──────────────────────────────────────────────────────────────

    private async Task<int> ApplyAsync(Space space, List<SyncOpDto> ops, HashSet<string> touched)
    {
        if (ops.Count == 0) return 0;
        var (_, accepted) = await new SyncWriter(db).ApplyAsync(space, null, ops);
        await db.SaveChangesAsync();
        if (accepted > 0) touched.Add(space.Id);
        return accepted;
    }

    private SyncOpDto Op(string spaceId, string entity, string entityId, Dictionary<string, JsonElement> fields, string seed) =>
        new(ImportIds.OpId(seed), spaceId, entity, entityId, fields, ServerHlc.Now(_counter++));

    /// <summary>
    /// The op's seed: the record's own content hash when the connector
    /// stated one, else a hash of what this ingest wrote — either way the
    /// same fact fetched twice is one op.
    /// </summary>
    private static string Seed(string entityId, JsonObject record, Dictionary<string, JsonElement> fields)
    {
        var hash = record.Text("content_hash");
        if (string.IsNullOrEmpty(hash))
        {
            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(fields)));
            hash = Convert.ToHexString(bytes, 0, 16).ToLowerInvariant();
        }
        return $"conn:{entityId}:{hash}";
    }

    /// <summary>An entity id within the sync limit: a party's external id that would push it over is replaced by its uuid.</summary>
    private static string Fit(string prefix, string externalId)
    {
        var id = prefix + externalId;
        return id.Length <= EntityIdMaximumLength ? id : prefix + ImportIds.OpId(externalId);
    }

    private static (long Value, string Currency)? Money(JsonNode? node)
    {
        if (node is not JsonObject money) return null;
        var value = money["value"];
        if (value is null) return null;
        return (value.GetValue<long>(), money.Text(CurrencyField) ?? "EUR");
    }

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, JsonWeb);

    private static readonly JsonSerializerOptions JsonWeb = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
