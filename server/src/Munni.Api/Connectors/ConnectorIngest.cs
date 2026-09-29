using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.GoCardless;
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
public sealed record ConnectorIngestResult(ConnectorIngestCounts Counts, IReadOnlySet<string> TouchedSpaces);

/// <summary>
/// Turns the connector's normalised records into sync ops — the server
/// acting as one more device, exactly as <see cref="GcIngest"/> does for
/// open banking (docs/connector-integration-plan.md §5.6). Receipts land in
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
        var byShape = records.OfType<JsonObject>().GroupBy(r => ShapeOf(r, shape)).ToDictionary(g => g.Key, g => g.ToList());

        var counts = ConnectorIngestCounts.None;
        foreach (var kind in Shapes)
        {
            if (!byShape.Remove(kind, out var items)) continue;
            counts = counts.Plus(kind switch
            {
                AccountEntity => await AccountsAsync(user, provider, items, touched, ct),
                TransactionEntity => await TransactionsAsync(user, provider, items, touched, ct),
                ReceiptEntity => await ReceiptsAsync(user, provider, connectionId, items, touched, ct),
                "credit_registration" => await RegistrationsAsync(user, provider, items, touched, ct),
                _ => await StudentDebtsAsync(user, provider, providerName, items, touched, ct),
            });
        }
        foreach (var (unknown, items) in byShape) counts = counts.Plus(Unknown(unknown, items.Count));

        return new ConnectorIngestResult(counts, touched);
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
        User user, string provider, List<JsonObject> records, HashSet<string> touched, CancellationToken ct)
    {
        var written = 0;
        var dropped = 0;
        var now = time.GetUtcNow();

        foreach (var account in records)
        {
            var accepted = await AccountAsync(user, provider, account, now, touched, ct);
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
    private async Task<int?> AccountAsync(User user, string provider, JsonObject account, DateTimeOffset now, HashSet<string> touched, CancellationToken ct)
    {
        var id = account.Text("id");
        var externalId = account.Text(ExternalIdField);
        if (id is null || externalId is null) return null;

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
        if (isIban) fields["iban"] = Json(reference.AccountRef);
        if (account.Text("masked_number") is { } masked) fields["maskedNumber"] = Json(masked);

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
        User user, string provider, List<JsonObject> records, HashSet<string> touched, CancellationToken ct)
    {
        var accountIds = records.Select(t => t.Text("account_id")).Where(a => a is not null).Distinct().ToList();
        var known = await db.ConnectorAccountRefs
            .Where(a => a.UserId == user.Id && accountIds.Contains(a.Id))
            .ToDictionaryAsync(a => a.Id, ct);

        var byFeed = new Dictionary<string, List<SyncOpDto>>(StringComparer.Ordinal);
        var dropped = 0;
        var orphaned = 0;
        string? orphanAccount = null;

        foreach (var tx in records)
        {
            var accountId = tx.Text("account_id");
            var account = accountId is null ? null : known.GetValueOrDefault(accountId);
            if (accountId is not null && account is null)
            {
                // a transaction of an account the accounts pass never named:
                // nothing to file it under, and the row is not invented
                dropped++;
                orphaned++;
                orphanAccount ??= accountId;
                continue;
            }
            var op = account is null ? null : TransactionOp(account, tx);
            if (op is null)
            {
                dropped++;
                continue;
            }
            if (!byFeed.TryGetValue(op.SpaceId, out var ops)) byFeed[op.SpaceId] = ops = [];
            ops.Add(op);
        }

        if (dropped > 0 && logger.IsEnabled(LogLevel.Warning))
        {
            logger.LogWarning(
                "connector ingest {Provider}: {Dropped} of {Total} transactions dropped — {Orphaned} name an account this relay never saw (first: {Account}), the rest lack an id, a date or an amount",
                provider, dropped, records.Count, orphaned, orphanAccount ?? "-");
        }

        var written = 0;
        foreach (var (feedId, ops) in byFeed)
        {
            var feed = await db.Spaces.FindAsync([feedId], ct) ?? throw new InvalidOperationException($"feed {feedId} missing");
            written += await ApplyAsync(feed, ops, touched);
        }

        return new ConnectorIngestCounts(0, 0, written, 0, dropped);
    }

    /// <summary>One transaction as the feed's raw row — no opinion, just the party's facts — or null when it lacks an id, a date or an amount.</summary>
    private SyncOpDto? TransactionOp(ConnectorAccountRef account, JsonObject tx)
    {
        var externalId = tx.Text(ExternalIdField);
        var bookedAt = tx.Text("booked_at");
        var amount = Money(tx["amount"]);
        if (externalId is null || bookedAt is null || amount is null) return null;

        var entityId = ImportIds.TransactionId(account.AccountRef, externalId);
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

        return Op(account.FeedSpaceId, TransactionEntity, entityId, fields, Seed(entityId, tx, fields));
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
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>The kit's account type as the app names it.</summary>
    internal static string AccountTypeOf(string? type) => type switch
    {
        "savings" => "savings",
        "credit_card" => "credit",
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
        "revolving" or "deferred_payment" => "credit",
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
