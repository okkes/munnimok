using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Ing;

/// <summary>
/// An account, plus the one ING identifier that is not part of it.
/// </summary>
/// <param name="Record">The normalised account.</param>
/// <param name="AgreementId">
/// ING's product-agreement UUID for this account, where it states one.
/// <para>
/// It is here rather than on <see cref="Account"/> because it is not a fact
/// about the account - it is the key that ties a page of transactions back to
/// the account it belongs to. ING repeats it inside the action links of every
/// transaction it serves, and it is the ONLY stable link between the two: the
/// agreement id in the transactions URL itself is encrypted per session and
/// changes on every login.
/// </para>
/// </param>
/// <param name="SelfPath">
/// The <c>self</c> link ING states on the agreement: the account's own
/// resource, as ING addresses it.
/// <para>
/// Kept for the one account type whose balance is not in any list. A credit
/// card comes back with no balance object at all, and its <c>self</c> link
/// points at <c>/nl/agreements/{id}/carddetails</c> - which is the screen that
/// does show the figure. It is followed rather than composed: this connector
/// has already been refused for composing an address, and a link the payload
/// states is the same kind of thing as the cursor the page walk follows.
/// </para>
/// </param>
/// <param name="TransactionsPath">
/// The <c>transactions</c> link ING states on the agreement.
/// <para>
/// The route to the history of every account the OVERVIEW does not fetch one
/// for. ING's overview asks for transactions per current account and for
/// nothing else, which is why savings and credit-card history was reported as
/// unreadable for so long - and all the while each agreement was carrying the
/// address of its own feed.
/// </para>
/// </param>
internal readonly record struct IngAccount(
    Account Record,
    string? AgreementId,
    string? SelfPath = null,
    string? TransactionsPath = null);

/// <summary>
/// ING's account lists, which are four different shapes of the same idea.
///
/// <see cref="ReadAgreements"/> is the one that matters: <c>/global/agreements</c>
/// is what ING's own overview renders its list from, and it names EVERY account
/// somebody has - current, savings, cards, loans - in one payload. The other
/// three readers below are the fallback, one endpoint per type, kept because
/// each was confirmed against a live capture and the agreement list was not.
/// </summary>
/// <remarks>
/// EVERY DISPLAY NAME HERE IS CHOSEN TO BE LANGUAGE-INDEPENDENT, and that is a
/// correctness requirement rather than tidiness. The account holder's language
/// is theirs, changing it in this session would change it on their phone, and
/// a display name that reads "Creditcard Extra" today and "Credit Card Extra"
/// tomorrow changes the account's content hash and republishes an account
/// nothing happened to.
/// <para>
/// The two captures of one account settled which fields survive that: savings
/// <c>productName</c> is identical in both languages, credit-card
/// <c>creditCardProductName</c> is NOT - it really did come back translated -
/// and current accounts state no name of their own beyond the holder's, which
/// this connector has no business keeping.
/// </para>
/// </remarks>
internal static class IngAccounts
{
    /// <summary>
    /// Every account, from the one call that knows about all of them:
    /// <c>/global/agreements</c>.
    /// </summary>
    /// <remarks>
    /// WRITTEN FROM A SCHEMA RATHER THAN FROM A SAMPLE, which is worth stating
    /// plainly. The capture this adapter was built from withheld this response -
    /// it ran against an account with real money in it - so what is known about
    /// it came back from a live run through <see cref="IngSchema"/>: keys,
    /// nesting, string lengths, and the values of the product taxonomy alone.
    /// That is enough to write this, and it is why the endpoint-per-type readers
    /// below stay as a fallback.
    /// <para>
    /// The taxonomy that run reported: <c>type</c> and <c>group</c> are one of
    /// CURRENT, SAVINGS, CARD, LOAN or LOYALTY; <c>status</c> was ACTIVE on all
    /// seven agreements; <c>identifierType</c> is UUID or LOCAL_ID.
    /// </para>
    /// <para>
    /// NOTHING IS FILTERED ON <c>status</c>. Every agreement on that account was
    /// ACTIVE, so there is no evidence at all about what else appears there - and
    /// a reader that dropped every word it did not recognise would drop somebody's
    /// accounts on the day ING invents a second one. LOYALTY is the one type left
    /// out, because ING Punten are points: an account whose balance is 1420 of
    /// something that is not money has no place in a ledger of money.
    /// </para>
    /// </remarks>
    /// <param name="note">
    /// Told when an agreement carries a balance this reader could not make a
    /// figure out of. It names the TYPE of account and nothing else - never the
    /// balance, never the account - because the whole point of it is to be safe
    /// to read in a log.
    /// </param>
    public static IReadOnlyList<IngAccount> ReadAgreements(
        JsonDocument payload, string sessionId, DateOnly asOf, Action<string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("agreements", out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the agreement list has no 'agreements' array");
        }

        var accounts = new List<IngAccount>();

        foreach (var entry in array.EnumerateArray())
        {
            // AN ENTRY THAT IS NOT AN OBJECT IS A SHAPE CHANGE, not a crash.
            //
            // Refused rather than skipped, and this is the one place in the
            // fleet where that is right: an agreement list is the account
            // holder's whole set of products, so a hole in it is a set that
            // silently lost one - not a row worth dropping. Everywhere the
            // entries are transactions, JsonRead.Objects() drops the hole
            // instead, because there the cost of stopping is the page.
            if (entry.ValueKind != JsonValueKind.Object)
            {
                throw ConnectorException.ProviderChanged(
                    $"{IngAdapter.ProviderId}: the agreement list holds a {entry.ValueKind} where an " +
                    "agreement was expected");
            }

            // TYPE FIRST, GROUP AFTER. Both carry the same five words and on the
            // observed account they agreed on every one of seven agreements, so
            // which ING would prefer in a disagreement is not established -
            // <c>type</c> leads because it is the narrower of the two names, and
            // <c>group</c> is read at all so that an agreement stating only the
            // coarser one is still classified rather than silently unknown.
            var kind = entry.Text("type") ?? entry.Text("group");

            if (string.Equals(kind, "LOYALTY", StringComparison.OrdinalIgnoreCase)) continue;

            var commercial = entry.Child("commercialId");
            var balance = entry.Child("balance");

            var stated = commercial.Text("value");

            // An IBAN only when ING SAYS it is one. A loan states its contract
            // number in the same field under a different type, and filing that
            // as an IBAN would put an eighteen-character lie on the record.
            var iban = string.Equals(commercial.Text("type"), "IBAN", StringComparison.OrdinalIgnoreCase)
                ? stated
                : null;

            var externalId = stated ?? entry.Text("accountId") ?? entry.Text("id")
                ?? throw ConnectorException.ProviderChanged(
                    $"{IngAdapter.ProviderId}: an agreement of type '{kind}' states no identifier of any kind");

            var type = Kind(kind);
            var currency = balance.Currency("currency");
            var figure = Stated(balance, currency, asOf);

            // A BALANCE THAT IS THERE AND UNREADABLE IS NOT THE SAME AS NONE.
            // The first live run showed a credit card with no figure against it,
            // and "ING states no balance for a card" and "we could not read the
            // one it states" are indistinguishable from the outside. Silence
            // here means ING really sent nothing.
            // ONLY WHEN ING SENT ONE AND THIS READER COULD NOT USE IT, which
            // is the only version of this that is our bug.
            //
            // Silence when ING sent nothing is not a gap: a credit card states
            // no balance here by design, and the adapter goes and reads it off
            // the card's own resource afterwards. Speaking here said "listed
            // without a balance" about an account that ends the run with one.
            if (figure is null && balance.ValueKind == JsonValueKind.Object)
            {
                note?.Invoke(
                    $"{IngAdapter.ProviderId}: a {AccountTypes.Wire(type)} agreement states a balance this " +
                    $"reader could not make a figure out of, so it is listed without one. ING stated it as " +
                    $"{Shape(balance)}");
            }

            accounts.Add(new IngAccount(
                BankRecords.NewAccount(sessionId, new AccountDraft
                {
                    ExternalId = externalId,
                    Type = type,
                    DisplayName = Name(entry, type, iban) ?? externalId,
                    Currency = currency,
                    Iban = iban,
                    Balance = figure,
                }),
                Agreement(entry),
                Link(entry, "self"),
                Link(entry, "transactions")));
        }

        return accounts;
    }

    /// <summary>
    /// The balance an agreement states, WHICHEVER OF THE TWO WAYS IT STATES IT.
    /// </summary>
    /// <remarks>
    /// A string or a JSON number, because ING already does both for a field of
    /// this name elsewhere in the same session: <c>/accounts/current</c> sends
    /// <c>"-1730.01"</c> and <c>/savings/accounts/products</c> sends <c>8.2</c>,
    /// for the same customer, minutes apart. A reader that accepts one of the
    /// two reports an account with no balance at all and looks entirely healthy
    /// doing it.
    /// <para>
    /// Both routes go through <see cref="MoneyParser"/> rather than being
    /// multiplied here, so neither can lose the cent an odd number of decimal
    /// places would cost.
    /// </para>
    /// </remarks>
    private static Balance? Stated(JsonElement balance, string currency, DateOnly asOf)
    {
        if (balance.ValueKind != JsonValueKind.Object) return null;

        var value = balance.Child("value");

        return value.ValueKind switch
        {
            JsonValueKind.String => Balance(value.GetString(), currency, asOf),
            JsonValueKind.Number => Balance(balance.Decimal("value"), currency, asOf),
            _ => null,
        };
    }

    /// <summary>
    /// The STRUCTURE of what arrived where a balance was expected, and none of
    /// its contents. See <see cref="IngSchema"/>.
    /// </summary>
    private static string Shape(JsonElement balance) => IngSchema.Describe(balance, maxChars: 120);

    /// <summary>
    /// One of ING's own links off an agreement, by relation.
    /// </summary>
    /// <remarks>
    /// The FIRST match wins, and there are duplicates: the live card agreement
    /// stated <c>self</c> twice, pointing at the same resource. Nothing here
    /// tries to tell them apart, because for the one use this has - reaching an
    /// account's own screen - either would do.
    /// </remarks>
    private static string? Link(JsonElement entry, string relation) =>
        entry.Items("_links")
            .Where(link => string.Equals(link.Text("rel"), relation, StringComparison.OrdinalIgnoreCase))
            .Select(link => link.Text("href"))
            .FirstOrDefault();

    /// <summary>
    /// The balance on an account's OWN resource, for the one type whose list
    /// entry states none.
    /// </summary>
    /// <remarks>
    /// A credit card comes back from <c>/global/agreements</c> with no balance
    /// object at all, and the overview shows none either - the figure is on the
    /// card's own screen, which its <c>self</c> link points at.
    /// <para>
    /// WHAT THIS LOOKS FOR IS THIS READER'S GUESS, NOT AN OBSERVED SHAPE: a
    /// root <c>balance</c> spelled the way every other ING payload spells one.
    /// If ING spells it differently the caller reports the structure of what
    /// arrived instead, which is how this connector has learned every other
    /// shape it reads. The offline tests exercise the contract THIS reader
    /// offers; none of them claims to be a capture.
    /// </para>
    /// </remarks>
    public static Balance? ReadDetailsBalance(JsonDocument payload, string currency, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(payload);

        var balance = payload.RootElement.Child("balance");

        return Stated(balance, balance.Text("currency")?.ToUpperInvariant() ?? currency, asOf);
    }

    /// <summary>
    /// ING's word for what an agreement IS.
    /// </summary>
    /// <remarks>
    /// An unrecognised word becomes <see cref="AccountType.Unknown"/> rather than
    /// disappearing. A new ING product that this connector cannot classify is
    /// still an account somebody has, and an account listed under the wrong
    /// heading is a great deal easier to notice than one that is not listed.
    /// </remarks>
    private static AccountType Kind(string? stated) => stated?.ToUpperInvariant() switch
    {
        "CURRENT" => AccountType.Current,
        "SAVINGS" => AccountType.Savings,
        "CARD" => AccountType.CreditCard,
        "LOAN" => AccountType.Loan,
        _ => AccountType.Unknown,
    };

    /// <summary>
    /// What to call an agreement, under the language rule at the top of this
    /// file.
    /// </summary>
    /// <remarks>
    /// The IBAN wherever there is one, because it is the account and cannot be
    /// translated. Savings is the exception and it is an evidenced one: the two
    /// captures proved that <c>productName</c> is the same string in Dutch and in
    /// English, and "Oranje Spaarrekening" tells somebody which pot this is where
    /// a second IBAN does not.
    /// <para>
    /// <c>displayAlias</c> sits right beside it holding the name they gave the
    /// account themselves, and is deliberately unused: it is theirs to change,
    /// and an account that renames itself when they retitle a savings goal is an
    /// account that republishes for nothing.
    /// </para>
    /// </remarks>
    private static string? Name(JsonElement entry, AccountType type, string? iban) =>
        type == AccountType.Savings ? entry.Text("productName") ?? iban : iban;

    /// <summary>
    /// The product-agreement UUID, WHEN ING SAYS THE ID IS ONE.
    /// </summary>
    /// <remarks>
    /// <c>identifierType</c> exists to say what <c>id</c> holds, and it is not
    /// always a UUID - a card's was LOCAL_ID. This id is used for one thing only,
    /// matching a page of transactions to the account it belongs to, and matching
    /// on a local id that happens to collide would file somebody's transactions
    /// under the wrong account. So it is taken only when ING states UUID.
    /// </remarks>
    private static string? Agreement(JsonElement entry) =>
        string.Equals(entry.Text("identifierType"), "UUID", StringComparison.OrdinalIgnoreCase)
            ? entry.Text("id")
            : null;

    /// <summary>
    /// Current accounts: <c>/accounts/current</c>.
    /// </summary>
    /// <remarks>
    /// Both lists are read. <c>holderAccounts</c> are the ones the person owns;
    /// <c>internetProxyAccounts</c> are accounts somebody else has given them
    /// access to, empty on the captured account and read here so that a user who
    /// does have one is not quietly missing an account.
    /// </remarks>
    public static IReadOnlyList<IngAccount> ReadCurrent(JsonDocument payload, string sessionId, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("currentAccounts", out var wrapper))
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the current-accounts payload has no 'currentAccounts'");
        }

        var accounts = new List<IngAccount>();

        foreach (var list in new[] { "holderAccounts", "internetProxyAccounts" })
        {
            foreach (var entry in wrapper.Items(list).Objects())
            {
                var iban = entry.Text("accountNumber")
                           ?? throw ConnectorException.ProviderChanged(
                               $"{IngAdapter.ProviderId}: a current account states no accountNumber");

                accounts.Add(new IngAccount(
                    BankRecords.NewAccount(sessionId, new AccountDraft
                    {
                        ExternalId = iban,
                        Type = AccountType.Current,
                        // THE IBAN, as the name.
                        //
                        // ING offers two alternatives and neither can be used:
                        // `name` is the account holder's own name, which this
                        // connector has no reason to keep, and
                        // `type.description` is a label ING is free to
                        // translate. The IBAN is the account, is already on the
                        // record, and cannot change under anybody.
                        DisplayName = iban,
                        Currency = entry.Currency("dynamicBalanceCurrency"),
                        Iban = iban,
                        Balance = Balance(
                            entry.Text("dynamicBalance"),
                            entry.Currency("dynamicBalanceCurrency"),
                            asOf),
                    }),
                    entry.Text("uuid")));
            }
        }

        return accounts;
    }

    /// <summary>
    /// Savings: <c>/savings/accounts/products</c>.
    /// </summary>
    /// <remarks>
    /// The balance arrives as a JSON NUMBER here where the current account sent
    /// a string, and ING states it to whatever precision it happens to need -
    /// the captured value had ONE decimal place, not two.
    /// <para>
    /// Which is why it goes through <see cref="MoneyParser"/> rather than being
    /// multiplied here. The obvious hand-written version -
    /// <c>(long)(element.GetDouble() * 100)</c> - reads a one-decimal balance a
    /// cent short every time, because the nearest double to 8.2 is
    /// 8.199999999999999289 and the cast truncates 819.99 to 819. The parser
    /// rounds and takes a decimal, so neither step can lose the cent.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<IngAccount> ReadSavings(JsonDocument payload, string sessionId, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("data", out var array) || array.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the savings payload has no 'data' array");
        }

        var accounts = new List<IngAccount>();

        foreach (var entry in array.EnumerateArray().Objects())
        {
            var id = entry.Child("accountId");

            var iban = id.Text("iban")
                       ?? throw ConnectorException.ProviderChanged(
                           $"{IngAdapter.ProviderId}: a savings account states no iban");

            var currency = entry.Currency("currency");
            var stated = entry.Child("dynamicBalance");

            accounts.Add(new IngAccount(
                BankRecords.NewAccount(sessionId, new AccountDraft
                {
                    ExternalId = iban,
                    Type = AccountType.Savings,
                    // The product's own name, which the two captures proved is
                    // the same string in both languages. The user's nickname for
                    // the account sits beside it in `target.nickName` and is
                    // deliberately not used: it is theirs to change, and an
                    // account that renames itself when they retitle a savings
                    // goal is an account that republishes for nothing.
                    DisplayName = entry.Text("productName") ?? iban,
                    Currency = currency,
                    Iban = iban,
                    Balance = Balance(
                        stated.Decimal("amount"),
                        stated.Text("currency")?.ToUpperInvariant() ?? currency,
                        asOf),
                }),
                id.Text("commercialId")));
        }

        return accounts;
    }

    /// <summary>
    /// Credit cards: <c>/credit-cards/cards</c>.
    /// </summary>
    /// <remarks>
    /// NO BALANCE. The payload states the card, its status, its statement dates
    /// and the export formats ING offers for it, and nothing anywhere in it is
    /// an amount - so the account is emitted without one rather than with a
    /// zero, which would read as a settled card.
    /// <para>
    /// The name is the masked number rather than
    /// <c>creditCardProductName</c>: that field came back "Creditcard Extra" in
    /// the Dutch session and "Credit Card Extra" in the English one, on the same
    /// card, minutes apart.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<IngAccount> ReadCreditCards(
        JsonDocument payload, string sessionId, string currency)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("creditCards", out var array) || array.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the credit-card payload has no 'creditCards' array");
        }

        var accounts = new List<IngAccount>();

        foreach (var entry in array.EnumerateArray().Objects())
        {
            var id = entry.Text("arrangementId")
                     ?? throw ConnectorException.ProviderChanged(
                         $"{IngAdapter.ProviderId}: a credit card states no arrangementId");

            var masked = entry.Text("maskedCardNumber");

            accounts.Add(new IngAccount(
                BankRecords.NewAccount(sessionId, new AccountDraft
                {
                    ExternalId = id,
                    Type = AccountType.CreditCard,
                    DisplayName = masked ?? id,
                    Currency = currency,
                    MaskedNumber = masked,
                }),
                null));
        }

        return accounts;
    }

    /// <summary>
    /// The stated balance, dated by the CALLER rather than by
    /// <c>DateTime.UtcNow</c>.
    /// </summary>
    /// <remarks>
    /// ING states a balance and never says when it was true, so the honest
    /// stamp is the moment of the fetch - which has to arrive from the adapter's
    /// clock, or every content hash in the test suite changes at midnight.
    /// </remarks>
    private static Balance? Balance(string? stated, string currency, DateOnly asOf) =>
        string.IsNullOrWhiteSpace(stated)
            ? null
            : Stamp(MoneyParser.ToMinor(stated, MoneyUnit.MajorString, "balance"), currency, asOf);

    /// <summary>The same, where ING stated a JSON number instead of a string.</summary>
    private static Balance? Balance(decimal? stated, string currency, DateOnly asOf) =>
        stated is not { } value
            ? null
            : Stamp(MoneyParser.ToMinor(value, MoneyUnit.MajorDecimal), currency, asOf);

    private static Balance Stamp(long minorUnits, string currency, DateOnly asOf) =>
        BankRecords.BalanceOn(new Money(minorUnits, currency), asOf);

    /// <summary>
    /// An ISO code, upper-cased, defaulting to euros.
    /// </summary>
    /// <remarks>
    /// The one accessor this file still owns, because the default is ING's
    /// rather than the platform's: every account in the capture is in euros and
    /// several state no currency at all. The guarded reads it is built on live
    /// in <see cref="JsonRead"/> now - four adapters wrote their own and four
    /// got some part of it wrong.
    /// </remarks>
    private static string Currency(this JsonElement parent, string name) =>
        parent.Text(name)?.ToUpperInvariant() ?? "EUR";
}
