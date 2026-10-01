using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using BankConnector.Adapters.Parsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Ing;

/// <summary>One answer from ING's transactions endpoint.</summary>
/// <param name="Transactions">
/// In ING's own order, which is NEWEST FIRST. Deliberately not sorted here:
/// "the rows arrived in the wrong order" is one of the things the balance
/// chain exists to catch, and a reader that sorts first hides it.
/// </param>
/// <param name="NextPath">
/// ING's own cursor link, or null on the last page. A path, not a URL.
/// </param>
/// <param name="Reservations">
/// How many rows were skipped for not having settled yet. Counted rather than
/// discarded silently - see <see cref="IngTransactions"/>.
/// </param>
/// <param name="Messages">Anything ING said about this answer.</param>
/// <param name="DetailIds">
/// The tail of ING's own <c>transactiondetails</c> link, for the rows this
/// reader had to invent an id for, in page order.
/// <para>
/// EVIDENCE, NOT A SOURCE OF IDS. A card's rows state <c>id</c> as an empty
/// string but each one links to its own detail page, and that link ends in
/// something that looks like it identifies the row. Adopting it would retire
/// every derived id on the account - if it is an identifier. If it is instead
/// the row's position in the page, adopting it would give the account a fresh
/// set of ids on every fetch and re-import its entire history each time, which
/// is the exact failure that made this adapter refuse the CSV export.
/// </para>
/// <para>
/// Nothing here distinguishes those two offline, and the captured fixture is
/// invented, so it is not evidence either. These are therefore counted and
/// measured rather than used - see <see cref="DescribeDetails"/>.
/// </para>
/// </param>
/// <param name="Unclassified">
/// ING's OWN CODES for the rows this reader could not put a kind to, distinct
/// and in the order they appeared.
/// <para>
/// A research instrument, and the same one that classified a credit card:
/// <c>iconId</c> turned out to be a code rather than translated text, which was
/// only knowable by looking at the values. Everything left as
/// <see cref="TransactionKind.Other"/> is a row ING classified somehow and this
/// connector did not, and the codes are the shortest route to knowing whether
/// it could have.
/// </para>
/// <para>
/// Held to <see cref="IngSchema.IsCode"/> - the same lock the schema uses
/// before it quotes anything - so a field that turns out to hold prose rather
/// than a code is dropped rather than printed.
/// </para>
/// </param>
internal sealed record IngTransactionPage(
    IReadOnlyList<Transaction> Transactions,
    string? NextPath,
    int Reservations,
    IReadOnlyList<string> DetailIds,
    IReadOnlyList<string> Unclassified,
    IReadOnlyList<string> Messages);

/// <summary>
/// ING's own transaction feed, which is the reason this adapter does not drive
/// the CSV export.
///
/// The export was the obvious route - the account holder downloads six of them
/// in the capture - and it is generated in the browser from a
/// <c>blob:</c> URL, so there is no file to fetch, only the API that fills it.
/// Reading that API instead turned out to settle a problem the CSV could not:
/// <list type="bullet">
/// <item><b>The id is ING's.</b> Twenty-four characters, and byte-identical
/// across the Dutch and English captures of the same account - 40 of 40.
/// The CSV states no id at all, so the parser has to derive one from the
/// description text, and ING TRANSLATES THE LABELS INSIDE THAT TEXT
/// ("Naam:" becomes "Name:", "Incassant ID:" becomes "Creditor ID:"). All 926
/// rows of the real export changed id between the two languages, which on a
/// consumer's side is the entire history arriving a second time.</item>
/// <item><b>The kind is a code.</b> <c>type.id</c> is <c>BA</c>/<c>GT</c>/
/// <c>IC</c> in both languages; only <c>type.description</c> is translated.</item>
/// <item><b>The balance is per row.</b> <c>endingBalance</c> on every
/// transaction, which is the free integrity check the platform is built
/// around. It held across all 39 pairs, in both languages.</item>
/// </list>
/// </summary>
internal static partial class IngTransactions
{
    /// <summary>
    /// Amounts and balances arrive as strings with a dot separator and a
    /// leading sign: <c>"-41.71"</c>.
    /// </summary>
    /// <remarks>
    /// <c>MajorString</c> rather than <c>MajorDecimal</c> because they are
    /// strings on the wire, and reading them as JSON numbers would put every
    /// amount through a double on the way. The unit is declared rather than
    /// inferred, which is the platform's rule everywhere money is read.
    /// <para>
    /// ING TRIMS TRAILING ZEROS ON BALANCES and not on amounts: the captured
    /// page carries <c>"-1656"</c> and <c>"-2785.3"</c> beside <c>"-1731.04"</c>.
    /// The parser takes all three, and no value anywhere in the capture used a
    /// thousands separator.
    /// </para>
    /// </remarks>
    public const MoneyUnit Unit = MoneyUnit.MajorString;

    /// <summary>
    /// Which account this page belongs to, as ING's product-agreement UUID.
    /// </summary>
    /// <remarks>
    /// THE ONLY STABLE LINK BETWEEN A PAGE AND AN ACCOUNT. The agreement id in
    /// the request URL is encrypted per session - the same account was
    /// <c>aYDrNOy1…</c> in one login and <c>L-zdMpP6…</c> in the next - so it
    /// cannot be matched against anything. The UUID inside the transactions'
    /// own action links is the <c>uuid</c> <c>/accounts/current</c> states, and
    /// it did not move between the two captures.
    /// <para>
    /// Not every transaction carries one; a few state no action links at all.
    /// The first that does decides, and a page whose links disagree is refused
    /// rather than attributed to whichever came first - a page of somebody
    /// else's transactions filed under this account is the kind of wrong that
    /// reconciles perfectly.
    /// </para>
    /// </remarks>
    public static string? AgreementId(JsonDocument payload)
    {
        ArgumentNullException.ThrowIfNull(payload);

        string? found = null;

        foreach (var transaction in Rows(payload))
        {
            foreach (var link in transaction.Items("_links"))
            {
                if (link.Text("href") is not { } href) continue;

                var match = AgreementPattern().Match(href);
                if (!match.Success) continue;

                var stated = match.Groups[1].Value;

                if (found is null)
                {
                    found = stated;
                }
                else if (!string.Equals(found, stated, StringComparison.OrdinalIgnoreCase))
                {
                    throw ConnectorException.ProviderChanged(
                        $"{IngAdapter.ProviderId}: one page of transactions names two different accounts " +
                        "in its links, so there is no safe way to say whose they are");
                }
            }
        }

        return found;
    }

    /// <summary>
    /// The page, normalised.
    /// </summary>
    /// <remarks>
    /// RESERVATIONS ARE SKIPPED. ING marks a card authorisation that has not
    /// settled with <c>reservation: true</c>, states no running balance for it,
    /// and is free to change its amount or drop it entirely when it books. The
    /// platform's <see cref="Transaction"/> has no way to say "not final", so
    /// emitting one would publish a booked transaction that later changes its
    /// own amount - and it would break the balance chain at the top of every
    /// page. They are counted so the adapter can say how many it left out.
    /// <para>
    /// None appeared in the capture (0 of 40, twice), so this is written
    /// against ING's field rather than against an observed row.
    /// </para>
    /// </remarks>
    public static IngTransactionPage Read(JsonDocument payload, string sessionId, string accountId)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(accountId);

        var transactions = new List<Transaction>();
        var reservations = 0;
        var unclassified = new List<string>();
        var details = new List<string>();

        // Occurrences of one derived key, so two identical payments on one day
        // do not become one transaction. Per page, which is the limit of what a
        // reader that sees one page can know - see DerivedId.
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var row in Rows(payload))
        {
            if (row.Flag("reservation"))
            {
                reservations++;
                continue;
            }

            var transaction = One(row, sessionId, accountId, seen);

            transactions.Add(transaction);

            if (transaction.Kind == TransactionKind.Other) Note(row, unclassified);

            // Only where an id had to be invented. On a current account ING
            // states one and there is nothing to weigh a candidate against.
            if (IsDerived(transaction) && DetailId(row) is { } detail) details.Add(detail);
        }

        return new IngTransactionPage(
            transactions, NextPath(payload), reservations, details, unclassified, Messages(payload));
    }

    /// <summary>
    /// The codes ING put on a row this reader could not classify.
    /// </summary>
    /// <remarks>
    /// Both fields, because either could be the one that distinguishes.
    /// <c>type.id</c> is <c>DV</c> - ING's own "various" bucket - on interest,
    /// on a monthly fee and on a card settlement alike, so on its own it cannot
    /// tell them apart. Whether <c>iconId</c> can is exactly what this is for.
    /// </remarks>
    private static void Note(JsonElement row, List<string> unclassified)
    {
        foreach (var code in new[] { row.Child("type").Text("id"), row.Text("iconId") })
        {
            if (!IngSchema.IsCode(code)) continue;
            if (!unclassified.Contains(code!, StringComparer.Ordinal)) unclassified.Add(code!);
        }
    }

    /// <summary>
    /// Did this connector make this id up, or did ING state it?
    /// </summary>
    /// <remarks>
    /// Asked of the finished record rather than counted as pages are read,
    /// because the count that matters is of the rows a caller actually
    /// RECEIVES - and the walk drops every row outside the requested window
    /// after the reader has seen it. Counting per page produced "10 of 3
    /// transaction(s) carry a derived id", which is not a sentence about
    /// anything.
    /// </remarks>
    public static bool IsDerived(Transaction transaction)
    {
        ArgumentNullException.ThrowIfNull(transaction);

        return transaction.ExternalId.StartsWith(DerivedPrefix, StringComparison.Ordinal);
    }

    /// <summary>
    /// What marks an id as this connector's rather than ING's, in the id
    /// itself, so nobody downstream has to be told separately.
    /// </summary>
    private const string DerivedPrefix = "ing-d-";

    /// <summary>
    /// The last segment of the row's own detail link, if it has one.
    /// </summary>
    /// <remarks>
    /// The tail rather than the whole href, because the rest is a route
    /// (<c>/nl/card-transactions/</c>) that says nothing about the row. Any
    /// query string is dropped first: a link ending <c>?lang=nl</c> would
    /// otherwise measure the language rather than the identifier.
    /// </remarks>
    private static string? DetailId(JsonElement row)
    {
        foreach (var link in row.Items("_links"))
        {
            if (!string.Equals(link.Text("rel"), "transactiondetails", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (link.Text("href") is not { } href) continue;

            var path = href.Split('?', 2)[0].TrimEnd('/');
            var tail = path[(path.LastIndexOf('/') + 1)..];

            if (tail.Length > 0) return tail;
        }

        return null;
    }

    /// <summary>
    /// What ING's detail links look like, measured, so a live run can settle
    /// whether they are identifiers at all.
    /// </summary>
    /// <remarks>
    /// THE VALUES NEVER APPEAR - only how many there are, how many are
    /// distinct, how long they are and which characters they are drawn from.
    /// That is enough to read the answer off:
    /// <list type="bullet">
    /// <item>Fewer distinct than total means the same tail came back on
    /// different rows, which an identifier cannot do. That is a position.</item>
    /// <item>One or two characters, running consecutively, is a row number on a
    /// page of forty. Also a position.</item>
    /// <item>Long, unequal and not consecutive is a candidate - and still only a
    /// candidate, because ING encrypts a product agreement's id PER SESSION
    /// (the same account was <c>aYDrNOy1…</c> in one login and <c>L-zdMpP6…</c>
    /// in the next). A per-session id would look perfect here and re-import the
    /// account's whole history on the next sync.</item>
    /// </list>
    /// Which is why the line ends by asking for a second login rather than
    /// concluding. Two runs settle it; one cannot.
    /// </remarks>
    public static string DescribeDetails(IReadOnlyList<string> ids)
    {
        ArgumentNullException.ThrowIfNull(ids);

        if (ids.Count == 0) return "ING offers no detail link on them";

        var distinct = ids.Distinct(StringComparer.Ordinal).Count();
        var shortest = ids.Min(id => id.Length);
        var longest = ids.Max(id => id.Length);

        var alphabet = Alphabet(ids);

        var length = shortest == longest
            ? $"{shortest} character(s)"
            : $"{shortest}-{longest} characters";

        return $"ING's own 'transactiondetails' link offers {ids.Count} candidate id(s) for them, " +
               $"{distinct} distinct, {length} of {alphabet}{(Consecutive(ids) ? ", counting up one by one" : "")}. " +
               "Not adopted: a link that renumbers per page or per session would re-import this account's " +
               "whole history on every sync. Compare this line across two separate logins to settle it";
    }

    /// <summary>Which characters the ids are drawn from, narrowest set first.</summary>
    private static string Alphabet(IReadOnlyList<string> ids)
    {
        if (ids.All(id => id.All(char.IsAsciiDigit))) return "digits";
        if (ids.All(id => id.All(char.IsAsciiHexDigit))) return "hex";

        return "mixed characters";
    }

    /// <summary>
    /// Do these read as 1, 2, 3 - which is what a row's position looks like and
    /// what an identifier almost never does?
    /// </summary>
    /// <remarks>
    /// EITHER DIRECTION COUNTS. ING serves newest first, so a page numbered by
    /// position ascends and a database key assigned as rows were booked
    /// descends. Both are a step of one, and both are the thing worth noticing.
    /// </remarks>
    private static bool Consecutive(IReadOnlyList<string> ids)
    {
        if (ids.Count < 2) return false;

        var numbers = new List<long>(ids.Count);

        foreach (var id in ids)
        {
            if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var number))
            {
                return false;
            }

            numbers.Add(number);
        }

        var step = numbers[1] - numbers[0];

        if (step != 1 && step != -1) return false;

        for (var i = 1; i < numbers.Count; i++)
        {
            if (numbers[i] - numbers[i - 1] != step) return false;
        }

        return true;
    }

    private static Transaction One(
        JsonElement row, string sessionId, string accountId, Dictionary<string, int> seen)
    {
        // Text() rejects an empty string, which is what a credit card's `id`
        // actually is - the field is present and blank on every row of it.
        var stated = row.Text("id");

        var bookedAt = Date(row, "executionDate", stated ?? "an unidentified transaction");

        var amount = row.Child("amount");
        var currency = amount.Text("currency")?.ToUpperInvariant() ?? "EUR";

        var value = amount.Text("value")
                    ?? throw ConnectorException.ProviderChanged(
                        $"{IngAdapter.ProviderId}: a transaction on {bookedAt:yyyy-MM-dd} states no amount");

        var money = new Money(MoneyParser.ToMinor(value, Unit, "amount"), currency);
        var id = stated ?? DerivedId(accountId, bookedAt, money, row, seen);

        var ending = row.Child("endingBalance");

        return BankRecords.NewTransaction(sessionId, accountId, new TransactionDraft
        {
            ExternalId = id,
            BookedAt = bookedAt,
            Amount = money,
            // NO VALUE DATE, and this is a decision rather than an omission.
            //
            // ING states one only inside the remittance lines, as
            // "Valutadatum: 12-08-2026" in Dutch and "Value date: ..." in
            // English. A reader that matched the Dutch label would work
            // perfectly for most of this country and silently return nothing
            // for the rest, which is worse than stating nothing for everybody.
            ValueAt = null,
            Counterparty = Counterparty(row),
            Description = Description(row),
            Kind = Kind(row, money),
            ResultingBalance = ending.Text("value") is { } balance
                ? new Money(
                    MoneyParser.ToMinor(balance, Unit, "balance"),
                    ending.Text("currency")?.ToUpperInvariant() ?? currency)
                : null,
        });
    }

    /// <summary>
    /// What kind of transaction this is: ING's own code first, its icon after.
    /// </summary>
    /// <remarks>
    /// THE TWO-LETTER CODE IS STILL THE ANSWER where ING states one - through
    /// the same table the CSV reader uses, so one bank cannot classify one row
    /// two ways depending on which door it came through.
    /// <para>
    /// A card and a loan state no such code, so every row of both came out as
    /// <c>Other</c>. <c>iconId</c> is what they carry instead, and it can be
    /// trusted for the reason its own values give away: one response contained
    /// BOTH <c>CRD-debit</c> and <c>CRD-afschrijving</c>. A field ING
    /// translated would not hold an English and a Dutch word in the same
    /// payload - so these are fixed codes that ING happens to have worded
    /// inconsistently, not text that moves with the account holder's language.
    /// That is what makes this safe to read without changing anybody's language
    /// to find out.
    /// </para>
    /// <para>
    /// ONLY THE CARD ICONS ARE MAPPED. A loan's <c>LOA-CREDIT</c> and
    /// <c>LOA-DEBIT</c> say which way the money went and nothing about what it
    /// WAS - an instalment, interest and a fee are three different kinds and
    /// the sign does not tell them apart. The amount already carries direction;
    /// inventing a kind from it would be stating something ING did not.
    /// </para>
    /// </remarks>
    private static TransactionKind Kind(JsonElement row, Money amount)
    {
        var stated = BankTransactionKinds.FromCode(row.Child("type").Text("id"));

        return stated != TransactionKind.Other ? stated : FromIcon(row.Text("iconId"), amount);
    }

    /// <summary>
    /// A card's icon, which is the only classification its feed offers.
    /// </summary>
    /// <remarks>
    /// <c>CRD-credit</c> is money arriving ON the card - the monthly settlement
    /// from a current account - which is a transfer between two accounts the
    /// same person holds. Everything else under <c>CRD-</c> is the card being
    /// used.
    /// </remarks>
    private static TransactionKind FromIcon(string? icon, Money amount)
    {
        if (icon is null || !icon.StartsWith("CRD-", StringComparison.OrdinalIgnoreCase))
        {
            return TransactionKind.Other;
        }

        // MONEY ARRIVING ON A CARD IS NOT THE CARD BEING USED, however ING has
        // worded the icon. A live run published "AFLOSSING", a repayment of
        // +EUR 1,725.13, as a card payment - because only `-credit` was mapped
        // and this one is worded in Dutch, which is the very inconsistency that
        // made these values readable as codes in the first place.
        //
        // The sign is not a guess. A card's balance is what is OWED, so a
        // positive amount can only be money coming in: a settlement from a
        // current account, or a refund. Neither is somebody spending.
        return amount.Value > 0 || icon.EndsWith("-credit", StringComparison.OrdinalIgnoreCase)
            ? TransactionKind.Transfer
            : TransactionKind.CardPayment;
    }

    /// <summary>
    /// An id for a row ING states none for, built from the parts of it that
    /// ING does not translate.
    /// </summary>
    /// <remarks>
    /// A CREDIT CARD AND A LOAN ARE NOT SHAPED LIKE A CURRENT ACCOUNT. Their
    /// feeds carry no usable id at all - a card states <c>id</c> as an empty
    /// string on every row, a loan omits it - so the choice is a derived id or
    /// no history for four of six accounts.
    /// <para>
    /// WHAT GOES IN IS THE POINT. The reason this adapter refused the CSV
    /// export was that ids derived from ITS text moved when the text moved: all
    /// 926 rows changed id between the Dutch and English downloads, because the
    /// remittance carries labels ING translates. So nothing translatable goes
    /// in here. Date, amount and currency are numbers; the merchant's name and
    /// country are the merchant's, not ING's; a card number is a card number;
    /// and <c>type.id</c> is the code whose whole virtue - established across
    /// both captures - is that only its <c>description</c> sibling is
    /// translated.
    /// </para>
    /// <para>
    /// Deliberately absent: <c>description</c>, <c>subject</c> and
    /// <c>subjectLines</c>, which are ING's own wording, and <c>iconId</c> -
    /// whose observed values include <c>CRD-afschrijving</c>, a Dutch word
    /// sitting in what otherwise looks like a code.
    /// </para>
    /// <para>
    /// THE ORDINAL IS THE WEAK PART, and it is weak in a knowable way. Two
    /// identical payments to one merchant on one day are told apart by their
    /// order, counted within the page - so a page boundary falling between two
    /// such rows would renumber them. It takes a same-day, same-amount,
    /// same-merchant pair split across a page of forty to reach it. The prefix
    /// is there so nobody has to guess which ids are ING's and which are ours.
    /// </para>
    /// </remarks>
    private static string DerivedId(
        string accountId, DateOnly bookedAt, Money amount, JsonElement row, Dictionary<string, int> seen)
    {
        var merchant = row.Child("merchant");

        var parts = new[]
        {
            row.Text("cardNumber"),
            merchant.Text("name"),
            merchant.Text("country"),
            row.Child("type").Text("id"),
        };

        var seed = string.Create(
            CultureInfo.InvariantCulture,
            $"{accountId}|{bookedAt:yyyy-MM-dd}|{amount.Value}|{amount.Currency}|"
            + $"{string.Join('|', parts.Where(p => p is not null))}");

        seen.TryGetValue(seed, out var occurrence);
        seen[seed] = occurrence + 1;

        var digest = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(
                string.Create(CultureInfo.InvariantCulture, $"{seed}|{occurrence}")));

        return DerivedPrefix + Convert.ToHexStringLower(digest.AsSpan(0, 10));
    }

    /// <summary>
    /// Who the money went to or came from.
    /// </summary>
    /// <remarks>
    /// The IBAN is taken only when ING says the number IS one: it states
    /// <c>{"type":"UNKNOWN","value":""}</c> for a card payment, where the
    /// counterparty is a shop with no account number to give. Reading that
    /// blindly would put an empty string in an IBAN field.
    /// </remarks>
    private static Counterparty? Counterparty(JsonElement row)
    {
        var counter = row.Child("counterAccount");

        if (counter.ValueKind != JsonValueKind.Object)
        {
            // A CARD NAMES A SHOP, NOT AN ACCOUNT. The credit-card feed has no
            // counterAccount at all - a card payment has no IBAN on the other
            // end - and states the merchant instead. Without this the whole
            // counterparty column of a card statement is blank, which is the
            // one column that says where the money went.
            return row.Child("merchant").Text("name") is { } shop
                ? new Counterparty { Name = shop }
                : null;
        }

        var name = counter.Text("name");
        var number = counter.Child("accountNumber");

        var iban = string.Equals(number.Text("type"), "IBAN", StringComparison.OrdinalIgnoreCase)
            ? number.Text("value")
            : null;

        return name is null && iban is null ? null : new Counterparty { Name = name, Iban = iban };
    }

    /// <summary>
    /// What the payer wrote, and nothing else.
    /// </summary>
    /// <remarks>
    /// <c>originalMemos</c> rather than <c>subjectLines</c>, and the difference
    /// is the whole language problem in miniature. <c>subjectLines</c> is what
    /// the screen shows: the remittance broken up and LABELLED - "Naam:",
    /// "Omschrijving:", "IBAN:", "Kenmerk:" - and every one of those labels is
    /// translated. Of 40 transactions captured twice, <c>subjectLines</c>
    /// matched on ZERO and <c>originalMemos</c> on all 40.
    /// <para>
    /// The labelled parts are also the parts this reader already has as fields,
    /// so what is lost by not using them is duplication.
    /// </para>
    /// <para>
    /// It is stated on 27 of 40 rows - a card payment has no remittance to
    /// carry - so the fallback is <c>subject</c>, which matched on 38 of 40.
    /// The two that differed were ING's own bookkeeping ("Rente ING Rood Staan"
    /// / "Interest ING Overdraft"), and there is nothing else to fall back to.
    /// </para>
    /// </remarks>
    private static string? Description(JsonElement row)
    {
        var lines = row.Items("originalMemos")
            .Select(line => line.Text())
            .Where(line => line is not null)
            .ToList();

        if (lines.Count > 0) return string.Join(" ", lines);

        // Trimmed: ING pads these to a fixed width, so an untrimmed
        // "Incasso ING creditcard             " would carry thirteen spaces
        // into a content hash.
        //
        // `description` is the card feed's own field, last because the two
        // above are what a current account carries. All three are ING's
        // wording rather than the payer's, which is why none of them goes
        // anywhere near a derived id.
        return row.Text("subject") ?? row.Text("description");
    }

    /// <summary>ING's own cursor link, or null when this was the last page.</summary>
    private static string? NextPath(JsonDocument payload) =>
        payload.RootElement.Items("_links")
            .Where(link => string.Equals(link.Text("rel"), "next", StringComparison.OrdinalIgnoreCase))
            .Select(link => link.Text("href"))
            .FirstOrDefault();

    /// <summary>
    /// Anything ING said about this answer. Empty on every captured page, read
    /// anyway: a field a bank puts in every payload and never fills is one it
    /// fills on the day something is wrong.
    /// </summary>
    private static IReadOnlyList<string> Messages(JsonDocument payload)
    {
        return
        [
            .. payload.RootElement.Items("_messages")
                .Select(message => message.Text() ?? message.Text("message") ?? message.Text("code"))
                .Where(text => text is not null)
                .Select(text => text!),
        ];
    }

    /// <summary>
    /// The rows, and only the ones shaped like rows.
    /// </summary>
    /// <remarks>
    /// OBJECTS ONLY. This walked whatever the array held and read fields off
    /// each entry, so a single <c>null</c> among them threw
    /// <see cref="InvalidOperationException"/> - which is not a
    /// <see cref="JsonException"/>, escapes every catch on the way out, and
    /// costs the whole page rather than the one row the bank could not render.
    /// <para>
    /// The missing array itself is still refused, because a payload with no
    /// <c>transactions</c> at all is not an empty statement - it is a different
    /// endpoint.
    /// </para>
    /// </remarks>
    private static IEnumerable<JsonElement> Rows(JsonDocument payload)
    {
        if (!payload.RootElement.Has("transactions", out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the transactions payload has no 'transactions' array");
        }

        return array.EnumerateArray().Objects();
    }

    private static DateOnly Date(JsonElement parent, string name, string id) =>
        parent.Text(name) is { } stated
        && DateOnly.TryParseExact(stated, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date
            : throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: transaction {id} has no readable '{name}'");

    /// <summary>
    /// The account UUID ING repeats in a transaction's action links.
    /// </summary>
    [GeneratedRegex(
        "productAgreementId=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
        RegexOptions.CultureInvariant)]
    private static partial Regex AgreementPattern();
}
