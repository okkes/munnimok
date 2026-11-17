using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Parsing;

public sealed record Camt053Options
{
    public required string SessionId { get; init; }

    public required string ProviderId { get; init; }

    // CAMT.053 never says an account's kind; the adapter that drove the export declares it,
    // the parser does not guess from a name
    public AccountType AccountType { get; init; } = AccountType.Unknown;

    /// <summary>Overrides <c>Stmt/Acct/Nm</c>, which many banks omit.</summary>
    public string? DisplayName { get; init; }
}

public sealed record Camt053Statement
{
    public required string StatementId { get; init; }

    public required Account Account { get; init; }

    /// <summary>Oldest-first, in the file's own order.</summary>
    public required IReadOnlyList<Transaction> Transactions { get; init; }

    /// <summary><c>OPBD</c>, when the bank states one.</summary>
    public Balance? Opening { get; init; }

    /// <summary><c>CLBD</c>, when the bank states one.</summary>
    public Balance? Closing { get; init; }
}

// optional elements stay optional (banks differ); a missing REQUIRED element or unparseable value is ProviderChanged
// (pages an operator, degrades the provider), never Internal, which would be retried forever
public static class Camt053Parser
{
    public static IReadOnlyList<Camt053Statement> Parse(string xml, Camt053Options options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (string.IsNullOrWhiteSpace(xml))
        {
            throw ConnectorException.ProviderChanged($"{options.ProviderId}: camt.053 export is empty");
        }

        XDocument document;
        try
        {
            // DTD off: a statement is third-party data and an external entity is a file-read primitive on the agent
            using var reader = XmlReader.Create(
                new StringReader(xml),
                new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            document = XDocument.Load(reader);
        }
        catch (XmlException ex)
        {
            throw new ConnectorException(
                ErrorCode.ProviderChanged, $"{options.ProviderId}: camt.053 export is not well-formed XML", ex);
        }

        var root = document.Root
                   ?? throw ConnectorException.ProviderChanged($"{options.ProviderId}: camt.053 export has no root element");

        // some banks wrap the message in an envelope: locate the report by name
        var report = string.Equals(root.Name.LocalName, "BkToCstmrStmt", StringComparison.Ordinal)
            ? root
            : root.Descendants().FirstOrDefault(e => string.Equals(e.Name.LocalName, "BkToCstmrStmt", StringComparison.Ordinal));

        if (report is null)
        {
            throw ConnectorException.ProviderChanged(
                $"{options.ProviderId}: no BkToCstmrStmt element - this is not a camt.053 statement");
        }

        var statements = report.Children("Stmt").ToList();
        if (statements.Count == 0)
        {
            throw ConnectorException.ProviderChanged($"{options.ProviderId}: BkToCstmrStmt contains no Stmt");
        }

        return [.. statements.Select(stmt => ParseStatement(stmt, options))];
    }

    public static IReadOnlyList<Camt053Statement> ParseFile(string path, Camt053Options options) =>
        Parse(File.ReadAllText(path), options);

    private static Camt053Statement ParseStatement(XElement stmt, Camt053Options options)
    {
        var provider = options.ProviderId;
        var statementId = stmt.Child("Id").Text() ?? stmt.Child("ElctrncSeqNb").Text() ?? "stmt";

        var accountExternalId = AccountIdentification(stmt, provider, out var iban);

        var opening = FindBalance(stmt, provider, "OPBD", "PRCD");
        var closing = FindBalance(stmt, provider, "CLBD", "CLAV");

        var entries = stmt.Children("Ntry").ToList();

        // currency by authority: the account's Ccy, the first entry's amount, the closing balance; none of them cannot be normalised
        var currency = stmt.Path("Acct", "Ccy").Text()
                       ?? entries.FirstOrDefault().Child("Amt").Attr("Ccy")
                       ?? closing?.Amount.Currency
                       ?? throw ConnectorException.ProviderChanged(
                           $"{provider}: statement '{statementId}' states no currency on Acct/Ccy, Ntry/Amt@Ccy or Bal");

        var accountId = BankRecords.AccountId(options.SessionId, accountExternalId);

        var transactions = new List<Transaction>(entries.Count);
        var synthesized = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            transactions.Add(ParseEntry(entry, options, accountId, currency, statementId, synthesized));
        }

        VerifyAgainstBalances(provider, statementId, opening, closing, transactions);

        var account = BankRecords.NewAccount(options.SessionId, new AccountDraft
        {
            ExternalId = accountExternalId,
            Type = options.AccountType,
            DisplayName = options.DisplayName ?? stmt.Path("Acct", "Nm").Text() ?? accountExternalId,
            Currency = currency,
            Iban = iban,
            Balance = closing ?? opening,
        });

        return new Camt053Statement
        {
            StatementId = statementId,
            Account = account,
            Transactions = transactions,
            Opening = opening,
            Closing = closing,
        };
    }

    // IBAN, else Othr/Id: how credit-card and non-payment accounts appear
    private static string AccountIdentification(XElement stmt, string provider, out string? iban)
    {
        var id = stmt.Path("Acct", "Id");
        iban = id.Child("IBAN").Text();

        var external = iban ?? id.Path("Othr", "Id").Text();
        return external ?? throw ConnectorException.ProviderChanged(
            $"{provider}: Stmt/Acct/Id carries neither IBAN nor Othr/Id");
    }

    private static Transaction ParseEntry(
        XElement entry,
        Camt053Options options,
        string accountId,
        string statementCurrency,
        string statementId,
        Dictionary<string, int> synthesized)
    {
        var provider = options.ProviderId;

        var amountElement = entry.Child("Amt")
                            ?? throw ConnectorException.ProviderChanged($"{provider}: Ntry without Amt in statement '{statementId}'");

        // the currency lives on the amount; per-entry currencies occur on card statements
        var currency = amountElement.Attr("Ccy") ?? statementCurrency;
        var magnitude = MoneyParser.ToMinor(amountElement.Text(), MoneyUnit.MajorString, $"{provider}: Ntry/Amt");

        var sign = DebitCreditSign(entry.Child("CdtDbtInd").Text(), provider, "Ntry/CdtDbtInd");
        var amount = new Money(magnitude * sign, currency);

        var booked = OptionalDate(entry.Child("BookgDt"), provider, "Ntry/BookgDt");
        var value = OptionalDate(entry.Child("ValDt"), provider, "Ntry/ValDt");

        // some banks date an entry only by value: falling back is tolerance, having neither is a shape change
        var bookedAt = booked ?? value
            ?? throw ConnectorException.ProviderChanged(
                $"{provider}: Ntry in statement '{statementId}' has neither BookgDt nor ValDt");

        var details = entry.Path("NtryDtls").Children("TxDtls").ToList();
        var description = Description(entry, details);
        var counterparty = Counterparty(details, sign);

        var externalId = ExternalId(entry, details, accountId, bookedAt, amount, description, synthesized);

        return BankRecords.NewTransaction(options.SessionId, accountId, new TransactionDraft
        {
            ExternalId = externalId,
            BookedAt = bookedAt,
            Amount = amount,
            ValueAt = value,
            Counterparty = counterparty,
            Description = description,
            Kind = Kind(entry),
            // no per-entry balance: deriving one would check our own arithmetic against itself; the real check is OPBD + entries = CLBD
            ResultingBalance = null,
        });
    }

    // Ustrd is the remitter's message and what a user recognises, AddtlNtryInf the bank's rendering of the line; Ustrd repeats
    // because banks split long messages
    private static string? Description(XElement entry, List<XElement> details)
    {
        var unstructured = details
            .SelectMany(d => d.Child("RmtInf").Children("Ustrd"))
            .Select(e => e.Text())
            .Where(t => t is not null)
            .ToList();

        if (unstructured.Count > 0) return string.Join(' ', unstructured);

        return entry.Child("AddtlNtryInf").Text()
               ?? details.Select(d => d.Child("AddtlTxInf").Text()).FirstOrDefault(t => t is not null);
    }

    // debit: creditor, credit: debtor, the other side when absent (some banks always fill Cdtr); a batched entry
    // (several TxDtls) has no single counterparty: none, and AddtlNtryInf carries the batch label
    private static Counterparty? Counterparty(List<XElement> details, int sign)
    {
        if (details.Count != 1) return null;

        var parties = details[0].Child("RltdPties");
        if (parties is null) return null;

        var (primary, primaryAccount, secondary, secondaryAccount) = sign < 0
            ? ("Cdtr", "CdtrAcct", "Dbtr", "DbtrAcct")
            : ("Dbtr", "DbtrAcct", "Cdtr", "CdtrAcct");

        var name = PartyName(parties, primary) ?? PartyName(parties, secondary);
        var iban = parties.Path(primaryAccount, "Id", "IBAN").Text()
                   ?? parties.Path(secondaryAccount, "Id", "IBAN").Text();

        return name is null && iban is null ? null : new Counterparty { Name = name, Iban = iban };
    }

    // from camt.053.001.08 the party sits under an extra Pty wrapper; both shapes are in production
    private static string? PartyName(XElement parties, string role) =>
        parties.Path(role, "Nm").Text() ?? parties.Path(role, "Pty", "Nm").Text();

    // stable id in the order banks populate them; when none (older exports) synthesized from content plus an occurrence counter,
    // so identical rows on one day stay distinct and a re-fetch deduplicates
    private static string ExternalId(
        XElement entry,
        List<XElement> details,
        string accountId,
        DateOnly bookedAt,
        Money amount,
        string? description,
        Dictionary<string, int> synthesized)
    {
        var stated = entry.Child("AcctSvcrRef").Text()
                     ?? entry.Child("NtryRef").Text()
                     ?? details.Select(d => d.Path("Refs", "AcctSvcrRef").Text()).FirstOrDefault(t => t is not null)
                     ?? details.Select(d => d.Path("Refs", "EndToEndId").Text()).FirstOrDefault(t => t is not null)
                     ?? details.Select(d => d.Path("Refs", "TxId").Text()).FirstOrDefault(t => t is not null);

        // "NOTPROVIDED" is the ISO placeholder for "no end-to-end reference",
        // and treating it as an id would collapse every such row onto one.
        if (stated is not null && !string.Equals(stated, "NOTPROVIDED", StringComparison.OrdinalIgnoreCase))
        {
            return stated;
        }

        var seed = string.Create(CultureInfo.InvariantCulture,
            $"{accountId}|{bookedAt:yyyy-MM-dd}|{amount.Value}|{amount.Currency}|{description}");

        synthesized.TryGetValue(seed, out var occurrence);
        synthesized[seed] = occurrence + 1;

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Create(CultureInfo.InvariantCulture, $"{seed}|{occurrence}")));
        return "syn-" + Convert.ToHexStringLower(digest.AsSpan(0, 10));
    }

    // a UI hint only: an unrecognised code degrades to Other instead of failing the run, unlike an unparseable amount
    private static TransactionKind Kind(XElement entry)
    {
        var code = entry.Path("BkTxCd", "Domn");
        var domain = code.Child("Cd").Text();
        var family = code.Path("Fmly", "Cd").Text();
        var subFamily = code.Path("Fmly", "SubFmlyCd").Text();

        if (string.Equals(domain, "INTR", StringComparison.Ordinal)) return TransactionKind.Interest;

        if (subFamily is "CHRG" or "FEES") return TransactionKind.Fee;
        if (subFamily is "INTR") return TransactionKind.Interest;

        switch (family)
        {
            case "CCRD" or "MCRD": return TransactionKind.CardPayment;
            case "ICDT" or "RCDT": return TransactionKind.Transfer;
            case "IDDT" or "RDDT": return TransactionKind.DirectDebit;
        }

        // Dutch banks that predate the ISO code set still emit their own
        // two-letter mutation codes under Prtry.
        return entry.Path("BkTxCd", "Prtry", "Cd").Text() switch
        {
            "BA" or "GM" => TransactionKind.CardPayment,
            "GT" or "OV" or "VZ" or "TB" => TransactionKind.Transfer,
            "IC" or "DV" => TransactionKind.DirectDebit,
            "RE" or "RB" => TransactionKind.Interest,
            "KN" or "KS" => TransactionKind.Fee,
            _ => TransactionKind.Other,
        };
    }

    private static Balance? FindBalance(XElement stmt, string provider, params string[] codes)
    {
        foreach (var code in codes)
        {
            foreach (var balance in stmt.Children("Bal"))
            {
                var stated = balance.Path("Tp", "CdOrPrtry", "Cd").Text()
                             ?? balance.Path("Tp", "CdOrPrtry", "Prtry").Text();

                if (!string.Equals(stated, code, StringComparison.Ordinal)) continue;

                var amount = balance.Child("Amt")
                             ?? throw ConnectorException.ProviderChanged($"{provider}: Bal '{code}' without Amt");
                var currency = amount.Attr("Ccy")
                               ?? throw ConnectorException.ProviderChanged($"{provider}: Bal '{code}' Amt without Ccy");

                var minor = MoneyParser.ToMinor(amount.Text(), MoneyUnit.MajorString, $"{provider}: Bal[{code}]/Amt");
                var sign = DebitCreditSign(balance.Child("CdtDbtInd").Text(), provider, $"Bal[{code}]/CdtDbtInd");

                // A balance without a date is not a balance - a consumer
                // cannot tell whether it precedes or follows the entries.
                var asOf = OptionalDate(balance.Child("Dt"), provider, $"Bal[{code}]/Dt")
                           ?? throw ConnectorException.ProviderChanged($"{provider}: Bal '{code}' states no date");

                return BankRecords.BalanceOn(new Money(minor * sign, currency), asOf);
            }
        }

        return null;
    }

    // opening + entries = closing: catches a dropped entry, an inverted debit/credit flag and a misread decimal separator
    private static void VerifyAgainstBalances(
        string provider,
        string statementId,
        Balance? opening,
        Balance? closing,
        List<Transaction> transactions)
    {
        if (opening is null || closing is null) return;
        if (!string.Equals(opening.Amount.Currency, closing.Amount.Currency, StringComparison.OrdinalIgnoreCase)) return;

        var expected = opening.Amount.Value;
        foreach (var amount in transactions.Select(tx => tx.Amount))
        {
            if (!string.Equals(amount.Currency, opening.Amount.Currency, StringComparison.OrdinalIgnoreCase))
            {
                // A foreign-currency entry on a statement makes the sum
                // meaningless; we decline to check rather than to claim.
                return;
            }

            expected += amount.Value;
        }

        if (Math.Abs(expected - closing.Amount.Value) > Reconciliation.ToleranceMinorUnits)
        {
            throw ConnectorException.ProviderChanged(
                $"{provider}: statement '{statementId}' does not reconcile - " +
                $"OPBD {opening.Amount.Value} plus {transactions.Count} entries gives {expected}, CLBD states {closing.Amount.Value}");
        }
    }

    private static int DebitCreditSign(string? indicator, string provider, string where) => indicator switch
    {
        "DBIT" => -1,
        "CRDT" => 1,
        null => throw ConnectorException.ProviderChanged($"{provider}: {where} is missing"),
        _ => throw ConnectorException.ProviderChanged($"{provider}: {where} has unknown value '{indicator}'"),
    };

    // absent is fine, present but unparseable is a shape change; the wrapper holds Dt (date) or DtTm (timestamp)
    // depending on the bank and message version
    private static DateOnly? OptionalDate(XElement? wrapper, string provider, string where)
    {
        if (wrapper is null) return null;

        var date = wrapper.Child("Dt").Text();
        if (date is not null)
        {
            return DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
                ? parsed
                : throw ConnectorException.ProviderChanged($"{provider}: {where}/Dt is not an ISO date: '{date}'");
        }

        var timestamp = wrapper.Child("DtTm").Text();
        if (timestamp is not null)
        {
            return DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)
                ? DateOnly.FromDateTime(parsed.UtcDateTime)
                : throw ConnectorException.ProviderChanged($"{provider}: {where}/DtTm is not an ISO timestamp: '{timestamp}'");
        }

        // A wrapper with neither child is a bank emitting an empty element,
        // which is noise rather than a shape change.
        return null;
    }
}
