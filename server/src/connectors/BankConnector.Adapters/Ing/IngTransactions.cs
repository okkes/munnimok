using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using BankConnector.Adapters.Parsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Ing;

// rows stay in ING's order (newest first), unsorted: a wrong order is what the balance chain must catch
// DetailIds are evidence only, never ids: a positional or per-session link would re-import the whole history each fetch
// Unclassified: ING's own codes for rows left as Other, held to IngSchema.IsCode so prose is dropped
internal sealed record IngTransactionPage(
    IReadOnlyList<Transaction> Transactions,
    string? NextPath,
    int Reservations,
    IReadOnlyList<string> DetailIds,
    IReadOnlyList<string> Unclassified,
    IReadOnlyList<string> Messages);

// the feed rather than the CSV export (built in the browser from a blob: URL): ids are ING's and equal in NL and EN
// the CSV derived ids from translated labels, so all 926 rows changed id between languages
// type.id is a code (only its description is translated); endingBalance on every row is the integrity check
internal static partial class IngTransactions
{
    // amounts and balances are strings on the wire ("-41.71")
    // ING trims trailing zeros on balances ("-1656", "-2785.3"), not on amounts
    public const MoneyUnit Unit = MoneyUnit.MajorString;

    // the only stable link between a page and an account: the request URL's agreement id is encrypted per session
    // the first link naming one decides; a page whose links disagree is refused, not filed under the first
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

    // reservations (reservation: true) are skipped and counted: unsettled, no running balance, amount may change
    // accountKey is the account's own key, never the record id: that carries the login session, so derived ids
    // changed on every sign-in (prod 2026-10-07)
    public static IngTransactionPage Read(JsonDocument payload, string sessionId, string accountId, string accountKey)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(accountId);
        ArgumentException.ThrowIfNullOrWhiteSpace(accountKey);

        var transactions = new List<Transaction>();
        var reservations = 0;
        var unclassified = new List<string>();
        var details = new List<string>();

        // occurrences of one derived key, per page, so identical same-day payments stay distinct (see DerivedId)
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var row in Rows(payload))
        {
            if (row.Flag("reservation"))
            {
                reservations++;
                continue;
            }

            var transaction = One(row, sessionId, accountId, accountKey, seen);

            transactions.Add(transaction);

            if (transaction.Kind == TransactionKind.Other) Note(row, unclassified);

            // only where an id was invented: a current account states one, so there is nothing to weigh
            if (IsDerived(transaction) && DetailId(row) is { } detail) details.Add(detail);
        }

        return new IngTransactionPage(
            transactions, NextPath(payload), reservations, details, unclassified, Messages(payload));
    }

    // both fields: type.id is DV (ING's "various") on interest, fees and card settlement alike,
    // so alone it cannot tell them apart
    private static void Note(JsonElement row, List<string> unclassified)
    {
        foreach (var code in new[] { row.Child("type").Text("id"), row.Text("iconId") })
        {
            if (!IngSchema.IsCode(code)) continue;
            if (!unclassified.Contains(code!, StringComparer.Ordinal)) unclassified.Add(code!);
        }
    }

    // asked of the finished record, not counted per page: the walk drops rows outside the window after the reader saw them
    public static bool IsDerived(Transaction transaction)
    {
        ArgumentNullException.ThrowIfNull(transaction);

        return transaction.ExternalId.StartsWith(DerivedPrefix, StringComparison.Ordinal);
    }

    // marks an id as this connector's rather than ING's
    private const string DerivedPrefix = "ing-d-";

    // the tail only (the route says nothing about the row), query string dropped first: ?lang=nl would measure the language
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

    // values never appear, only counts, lengths and alphabet; fewer distinct than total, or counting up by one, means a position
    // a long unequal id is still only a candidate: ING encrypts per session, so two separate logins must be compared
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

    private static string Alphabet(IReadOnlyList<string> ids)
    {
        if (ids.All(id => id.All(char.IsAsciiDigit))) return "digits";
        if (ids.All(id => id.All(char.IsAsciiHexDigit))) return "hex";

        return "mixed characters";
    }

    // either direction counts: newest-first, a page numbered by position ascends and a booking key descends
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
        JsonElement row, string sessionId, string accountId, string accountKey, Dictionary<string, int> seen)
    {
        // Text() rejects an empty string, which is what a credit card's id is on every row
        var stated = row.Text("id");

        var bookedAt = Date(row, "executionDate", stated ?? "an unidentified transaction");

        var amount = row.Child("amount");
        var currency = amount.Text("currency")?.ToUpperInvariant() ?? "EUR";

        var value = amount.Text("value")
                    ?? throw ConnectorException.ProviderChanged(
                        $"{IngAdapter.ProviderId}: a transaction on {bookedAt:yyyy-MM-dd} states no amount");

        var money = new Money(MoneyParser.ToMinor(value, Unit, "amount"), currency);
        var id = stated ?? DerivedId(accountKey, bookedAt, money, row, seen);

        var ending = row.Child("endingBalance");

        return BankRecords.NewTransaction(sessionId, accountId, new TransactionDraft
        {
            ExternalId = id,
            IdIsDerived = stated is null,
            BookedAt = bookedAt,
            Amount = money,
            // no value date, by decision: ING states it only inside remittance lines under a translated label
            // ("Valutadatum"/"Value date"), so matching one language would fail silently for the rest
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

    // the two-letter code first, through the CSV reader's table so one bank never classifies a row two ways
    // cards and loans state none: iconId is a fixed code (one response held CRD-debit and CRD-afschrijving), so readable
    // only card icons are mapped: a loan's LOA-CREDIT/LOA-DEBIT give direction, not kind (instalment, interest, fee)
    private static TransactionKind Kind(JsonElement row, Money amount)
    {
        var stated = BankTransactionKinds.FromCode(row.Child("type").Text("id"));

        return stated != TransactionKind.Other ? stated : FromIcon(row.Text("iconId"), amount);
    }

    // CRD-credit is money arriving on the card (the monthly settlement from a current account): a transfer
    // the rest under CRD- is card use
    private static TransactionKind FromIcon(string? icon, Money amount)
    {
        if (icon is null || !icon.StartsWith("CRD-", StringComparison.OrdinalIgnoreCase))
        {
            return TransactionKind.Other;
        }

        // a card's balance is what is owed, so a positive amount is money in whatever the icon's wording
        // a Dutch-worded repayment once came out as a card payment
        return amount.Value > 0 || icon.EndsWith("-credit", StringComparison.OrdinalIgnoreCase)
            ? TransactionKind.Transfer
            : TransactionKind.CardPayment;
    }

    // cards and loans carry no usable id: derived or no history; only untranslated parts go in
    // absent on purpose: description, subject, subjectLines, iconId (CRD-afschrijving is a Dutch word)
    // the ordinal counts per page: a same-day, same-amount, same-merchant pair split across a page boundary renumbers
    private static string DerivedId(
        string accountKey, DateOnly bookedAt, Money amount, JsonElement row, Dictionary<string, int> seen)
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
            $"{accountKey}|{bookedAt:yyyy-MM-dd}|{amount.Value}|{amount.Currency}|"
            + $"{string.Join('|', parts.Where(p => p is not null))}");

        seen.TryGetValue(seed, out var occurrence);
        seen[seed] = occurrence + 1;

        var digest = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(
                string.Create(CultureInfo.InvariantCulture, $"{seed}|{occurrence}")));

        return DerivedPrefix + Convert.ToHexStringLower(digest.AsSpan(0, 10));
    }

    // the IBAN only when ING says the number is one: a card payment states {"type":"UNKNOWN","value":""}
    private static Counterparty? Counterparty(JsonElement row)
    {
        var counter = row.Child("counterAccount");

        if (counter.ValueKind != JsonValueKind.Object)
        {
            // a card names a shop, not an account: the feed has no counterAccount, only the merchant
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

    // originalMemos, not subjectLines: its labels are translated (matched 0 of 40 across languages, originalMemos 40 of 40)
    // stated on 27 of 40 rows (card payments have none), so fall back to subject (matched 38 of 40)
    private static string? Description(JsonElement row)
    {
        var lines = row.Items("originalMemos")
            .Select(line => line.Text())
            .Where(line => line is not null)
            .ToList();

        if (lines.Count > 0) return string.Join(" ", lines);

        // trimmed: ING pads these to a fixed width, which would enter a content hash
        // description is the card feed's own field; all three are ING's wording, so none goes near a derived id
        return row.Text("subject") ?? row.Text("description");
    }

    private static string? NextPath(JsonDocument payload) =>
        payload.RootElement.Items("_links")
            .Where(link => string.Equals(link.Text("rel"), "next", StringComparison.OrdinalIgnoreCase))
            .Select(link => link.Text("href"))
            .FirstOrDefault();

    // empty on every captured page, read anyway: a field never filled is filled the day something is wrong
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

    // objects only: a null among the rows threw InvalidOperationException, which escapes every catch and costs the whole page
    // a missing array is refused: a payload with no transactions is a different endpoint, not an empty statement
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

    [GeneratedRegex(
        "productAgreementId=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
        RegexOptions.CultureInvariant)]
    private static partial Regex AgreementPattern();
}
