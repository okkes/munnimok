using System.Text.Json;
using BankConnector.Adapters.Ing;
using BankConnector.Adapters.Parsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// ING's API payloads, read offline.
///
/// THE LANGUAGE IS NOT OURS TO CHOOSE. Switching it in the web session changes
/// it on the account holder's other devices too, so a connector takes whatever
/// it is handed. That makes "the Dutch and English answers mean the same thing"
/// a correctness requirement rather than a nicety, and it is what most of this
/// file checks.
///
/// The shapes are copied field-for-field from a capture of a real account on
/// 2026-08-12, run once in each language; every value is invented.
/// </summary>
public sealed class IngReaderTests
{
    private const string SessionId = "ses_0123456789abcdef0123456789abcdef";
    private const string Iban = "NL01INGB0002345678";
    private const string Agreement = "11111111-2222-3333-4444-555555555555";

    private static readonly DateOnly AsOf = new(2026, 8, 12);

    private static JsonDocument Fixture(string name) => JsonDocument.Parse(BankFixtures.Read(name));

    private static string AccountId => BankRecords.AccountId(SessionId, Iban);

    private static IngTransactionPage Page(string fixture)
    {
        using var document = Fixture(fixture);
        return IngTransactions.Read(document, SessionId, AccountId, Iban);
    }

    // ---- the amounts, which is what everything else is worth nothing without --

    /// <summary>
    /// ING TRIMS TRAILING ZEROS ON BALANCES AND NOT ON AMOUNTS. The captured
    /// page carried "-1656" and "-2785.3" beside "-1731.04", on the same
    /// account, in the same answer. A reader that assumed two decimal places
    /// reads sixteen hundred euros as sixteen.
    /// </summary>
    [Theory]
    [InlineData(BankFixtures.IngTransactionsDutch)]
    [InlineData(BankFixtures.IngTransactionsEnglish)]
    public void Amounts_and_balances_are_read_whether_or_not_ing_trimmed_them(string fixture)
    {
        var page = Page(fixture);

        Assert.Equal([-4_171, -3_230, -120_500], page.Transactions.Select(t => t.Amount.Value));

        // "-1730.01", "-1688.3" and "-1656" - two decimals, one, and none.
        Assert.Equal(
            [-173_001, -168_830, -165_600],
            page.Transactions.Select(t => t.ResultingBalance!.Value.Value));

        Assert.All(page.Transactions, t => Assert.Equal("EUR", t.Amount.Currency));
    }

    /// <summary>
    /// The free integrity check, across a page boundary.
    /// </summary>
    /// <remarks>
    /// ING states its rows NEWEST FIRST and <see cref="BalanceChain"/> is
    /// defined on oldest-first, so the chain only closes once they are
    /// reversed - which is exactly what the adapter does before emitting. On
    /// the real export this held across all 926 rows and all 39 pairs of the
    /// captured API page, in both languages, and it is what proves the amount
    /// signs are read the right way round.
    /// </remarks>
    [Fact]
    public void The_running_balance_chain_closes_across_both_pages_once_reversed()
    {
        var rows = Page(BankFixtures.IngTransactionsDutch).Transactions
            .Concat(Page(BankFixtures.IngTransactionsPageTwo).Transactions)
            .ToList();

        Assert.Equal(6, rows.Count);
        Assert.True(rows[0].BookedAt > rows[^1].BookedAt, "ING states its transactions newest-first");

        Assert.Null(BalanceChain.FindBreak([.. Enumerable.Reverse(rows)]));
    }

    /// <summary>
    /// And the same chain FAILS as ING states it, which is what makes the test
    /// above about the reversal rather than about the fixture.
    /// </summary>
    [Fact]
    public void The_chain_does_not_close_in_the_order_ing_serves_it()
    {
        Assert.NotNull(BalanceChain.FindBreak(Page(BankFixtures.IngTransactionsDutch).Transactions));
    }

    // ---- the two languages ---------------------------------------------------

    /// <summary>
    /// THE FINDING THIS WHOLE ADAPTER IS BUILT ON.
    ///
    /// ING states an id per transaction, and it is identical in both languages -
    /// 40 of 40 on the real capture, 24 characters each. The CSV export states
    /// no id at all, so the parser has to derive one from the description, and
    /// ING TRANSLATES THE LABELS INSIDE THAT TEXT: all 926 rows of the real
    /// export changed id between the two downloads, which on a consumer's side
    /// is the entire history arriving a second time.
    /// </summary>
    [Fact]
    public void A_transactions_identity_does_not_depend_on_the_language()
    {
        var nl = Page(BankFixtures.IngTransactionsDutch).Transactions;
        var en = Page(BankFixtures.IngTransactionsEnglish).Transactions;

        Assert.Equal(nl.Select(t => t.ExternalId), en.Select(t => t.ExternalId));
        Assert.Equal(nl.Select(t => t.Id), en.Select(t => t.Id));
        Assert.All(nl, t => Assert.Equal(24, t.ExternalId.Length));
    }

    /// <summary>
    /// Everything a consumer would act on agrees between the languages: the
    /// amount, the date, the kind, the counterparty and the running balance.
    /// </summary>
    [Fact]
    public void The_facts_of_a_transaction_do_not_depend_on_the_language()
    {
        var nl = Page(BankFixtures.IngTransactionsDutch).Transactions;
        var en = Page(BankFixtures.IngTransactionsEnglish).Transactions;

        Assert.Equal(nl.Select(t => t.Amount), en.Select(t => t.Amount));
        Assert.Equal(nl.Select(t => t.BookedAt), en.Select(t => t.BookedAt));
        Assert.Equal(nl.Select(t => t.Kind), en.Select(t => t.Kind));
        Assert.Equal(nl.Select(t => t.Counterparty), en.Select(t => t.Counterparty));
        Assert.Equal(nl.Select(t => t.ResultingBalance), en.Select(t => t.ResultingBalance));
    }

    /// <summary>
    /// The description, and the residue that is left after choosing the right
    /// field.
    /// </summary>
    /// <remarks>
    /// <c>originalMemos</c> - what the payer actually wrote - was identical on
    /// all 40 captured transactions, where <c>subjectLines</c> matched on ZERO
    /// because ING labels them ("Naam:" / "Name:", "Incassant ID:" / "Creditor
    /// ID:"). What memos cannot cover is a row ING generated itself: a card
    /// payment carries no remittance, so the fallback is <c>subject</c>, and
    /// ING translates its OWN bookkeeping subjects.
    /// <para>
    /// So this is stated exactly rather than rounded up to "identical": two of
    /// forty differed on the real capture, one of four here, and both were
    /// ING's own wording rather than anybody's payment.
    /// </para>
    /// </remarks>
    [Fact]
    public void Only_ings_own_wording_differs_between_the_languages()
    {
        var nl = Page(BankFixtures.IngTransactionsDutch).Transactions;
        var en = Page(BankFixtures.IngTransactionsEnglish).Transactions;

        var differing = nl.Zip(en)
            .Where(pair => pair.First.Description != pair.Second.Description)
            .ToList();

        var only = Assert.Single(differing);

        Assert.Equal("Incasso ING creditcard", only.First.Description);
        Assert.Equal("Direct debit ING credit card", only.Second.Description);

        // And it is ING's own, not a payment: the two rows a payer wrote the
        // text for carry it byte-for-byte in both languages.
        Assert.Equal(2, nl.Zip(en).Count(pair => pair.First.Description == pair.Second.Description));
    }

    /// <summary>
    /// The kind comes from the two-letter code, which ING does not translate,
    /// and through the SAME table the CSV reader uses.
    /// </summary>
    /// <remarks>
    /// <c>DV</c> is ING's own bucket for "something else" and stays
    /// <see cref="TransactionKind.Other"/>: the captured account had an
    /// interest charge, a monthly fee and a credit-card settlement all filed
    /// under it, so giving it a specific kind would invent a fact the bank
    /// declined to state.
    /// </remarks>
    [Theory]
    [InlineData(BankFixtures.IngTransactionsDutch)]
    [InlineData(BankFixtures.IngTransactionsEnglish)]
    public void The_kind_is_the_code_rather_than_the_word_beside_it(string fixture)
    {
        Assert.Equal(
            [TransactionKind.CardPayment, TransactionKind.DirectDebit, TransactionKind.Other],
            Page(fixture).Transactions.Select(t => t.Kind));

        // The same table, reached the same way the CSV reader reaches it.
        Assert.Equal(TransactionKind.Transfer, BankTransactionKinds.FromCode("ST"));
    }

    /// <summary>
    /// That the CODE is the field being read, proved by disagreeing with the
    /// word beside it.
    /// </summary>
    /// <remarks>
    /// The fixture-based test above passes whichever field wins, because both
    /// of ING's vocabularies are known well enough to agree - which is
    /// reassuring and proves nothing about which one is read. Here the
    /// description is a word nobody has taught the parser, so the kind can only
    /// come out right if <c>type.id</c> was the field.
    /// <para>
    /// This is the property that matters on the day ING adds a transaction
    /// type: the codes are stable and shared between languages, so a new word
    /// degrades to Other in both rather than in only one.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_code_wins_over_the_translated_word_beside_it()
    {
        const string Payload = """
        {"transactions":[{
          "id":"010305900000000080000000",
          "executionDate":"2026-08-12",
          "amount":{"currency":"EUR","value":"-10.00"},
          "type":{"id":"IC","description":"Iets Onbekends"},
          "subject":"VOORBEELD",
          "subjectLines":[],
          "reservation":false
        }],"_links":[],"_messages":[]}
        """;

        using var document = JsonDocument.Parse(Payload);

        var transaction = Assert.Single(
            IngTransactions.Read(document, SessionId, AccountId, Iban).Transactions);

        Assert.Equal(TransactionKind.DirectDebit, transaction.Kind);
    }

    // ---- what is left out ----------------------------------------------------

    /// <summary>
    /// A reservation is a card authorisation that has not settled. ING states
    /// no running balance for it and is free to change its amount when it
    /// books, so emitting it would publish a booked transaction that later
    /// changes its own figure - and would break the balance chain at the top of
    /// every page.
    /// </summary>
    [Fact]
    public void An_unsettled_reservation_is_counted_and_left_out()
    {
        var page = Page(BankFixtures.IngTransactionsDutch);

        Assert.Equal(1, page.Reservations);
        Assert.Equal(3, page.Transactions.Count);
        Assert.DoesNotContain("010305900000000010000000", page.Transactions.Select(t => t.ExternalId));
    }

    /// <summary>
    /// No value date, and that is a decision rather than an omission: ING
    /// states one only inside the localised remittance lines, so a reader that
    /// matched "Valutadatum:" would work for most of this country and silently
    /// return nothing for the rest.
    /// </summary>
    [Fact]
    public void No_value_date_is_invented_from_the_localised_lines()
    {
        Assert.All(Page(BankFixtures.IngTransactionsDutch).Transactions, t => Assert.Null(t.ValueAt));
    }

    // ---- counterparties ------------------------------------------------------

    /// <summary>
    /// An IBAN is taken only where ING says the number IS one. It states
    /// <c>{"type":"UNKNOWN","value":""}</c> for a card payment, where the
    /// counterparty is a shop with no account number to give, and reading that
    /// blindly puts an empty string in an IBAN field.
    /// </summary>
    [Fact]
    public void A_counterparty_iban_is_read_only_when_ing_says_it_is_one()
    {
        var rows = Page(BankFixtures.IngTransactionsDutch).Transactions;

        Assert.Equal("SUPERMARKT 0001", rows[0].Counterparty!.Name);
        Assert.Null(rows[0].Counterparty!.Iban);

        Assert.Equal("VOORBEELD TELECOM B.V.", rows[1].Counterparty!.Name);
        Assert.Equal("NL03BANK0000000001", rows[1].Counterparty!.Iban);

        // ING's own bookkeeping states no counterAccount at all.
        Assert.Null(rows[2].Counterparty);
    }

    /// <summary>
    /// The type field is what is READ, proved by a number that is not an IBAN.
    /// </summary>
    /// <remarks>
    /// The fixture-based test above passes just as happily against a reader
    /// that ignores <c>type</c> and takes the value regardless, because ING
    /// pairs <c>UNKNOWN</c> with an EMPTY string and an empty string is
    /// discarded further down anyway. That is a coincidence of ING's own
    /// formatting, not a guarantee.
    /// <para>
    /// Written inline rather than as a fixture on purpose: ING has never been
    /// seen to state a non-empty number under any type but IBAN, and a fixture
    /// would look like evidence that it does.
    /// </para>
    /// </remarks>
    [Fact]
    public void A_counterparty_number_that_ing_does_not_call_an_iban_is_not_read_as_one()
    {
        const string Payload = """
        {"transactions":[{
          "id":"010305900000000090000000",
          "executionDate":"2026-08-12",
          "amount":{"currency":"EUR","value":"-10.00"},
          "type":{"id":"BA","description":"Betaalautomaat"},
          "subject":"WINKEL 0003",
          "counterAccount":{"name":"WINKEL 0003","accountNumber":{"type":"BBAN","value":"0001029507"}},
          "subjectLines":[],
          "reservation":false
        }],"_links":[],"_messages":[]}
        """;

        using var document = JsonDocument.Parse(Payload);

        var transaction = Assert.Single(
            IngTransactions.Read(document, SessionId, AccountId, Iban).Transactions);

        Assert.Equal("WINKEL 0003", transaction.Counterparty!.Name);
        Assert.Null(transaction.Counterparty.Iban);
    }

    /// <summary>
    /// The description is the remittance and nothing else, and it is trimmed:
    /// ING pads its own subjects to a fixed width, so an untrimmed one carries
    /// thirteen trailing spaces into a content hash.
    /// </summary>
    [Fact]
    public void The_description_is_what_the_payer_wrote_or_the_trimmed_subject()
    {
        var rows = Page(BankFixtures.IngTransactionsDutch).Transactions;

        // No remittance on a card payment: the subject stands in.
        Assert.Equal("SUPERMARKT 0001", rows[0].Description);

        // The payer's own text, without ING's labels around it.
        Assert.Equal("Klantnr 9.99999999 Factuur 900000000001 | 500000000001", rows[1].Description);

        Assert.Equal("Incasso ING creditcard", rows[2].Description);
    }

    // ---- paging --------------------------------------------------------------

    [Fact]
    public void The_first_page_states_ings_own_cursor_and_the_last_states_none()
    {
        var first = Page(BankFixtures.IngTransactionsDutch);

        Assert.NotNull(first.NextPath);
        Assert.StartsWith("/v1/agreements/", first.NextPath, StringComparison.Ordinal);
        Assert.Contains("cursor=", first.NextPath, StringComparison.Ordinal);

        Assert.Null(Page(BankFixtures.IngTransactionsPageTwo).NextPath);
    }

    /// <summary>
    /// Which account a page belongs to, by the UUID ING repeats inside the
    /// transactions' own action links.
    /// </summary>
    /// <remarks>
    /// The agreement id in the request URL cannot be used: it is encrypted per
    /// session, and the same account was <c>aYDrNOy1…</c> in one login and
    /// <c>L-zdMpP6…</c> in the next. Not every transaction carries the UUID
    /// either - the fixture's third row states no links at all, exactly as
    /// ING's own bookkeeping rows do - so the first that does decides.
    /// </remarks>
    [Theory]
    [InlineData(BankFixtures.IngTransactionsDutch)]
    [InlineData(BankFixtures.IngTransactionsEnglish)]
    public void A_page_names_the_account_it_belongs_to(string fixture)
    {
        using var document = Fixture(fixture);

        Assert.Equal(Agreement, IngTransactions.AgreementId(document));
    }

    /// <summary>
    /// A page whose links name TWO accounts is refused rather than filed under
    /// whichever came first. Somebody else's transactions under this account
    /// reconcile perfectly and are invisible.
    /// </summary>
    [Fact]
    public void A_page_that_names_two_accounts_is_refused()
    {
        // One row's link, not all of them: the date is what makes the target
        // unique, so the page ends up genuinely disagreeing with itself.
        var mixed = BankFixtures.Read(BankFixtures.IngTransactionsDutch)
            .Replace(
                "date=20260811&productAgreementId=11111111-2222-3333-4444-555555555555",
                "date=20260811&productAgreementId=99999999-8888-7777-6666-555555555555",
                StringComparison.Ordinal);

        using var document = JsonDocument.Parse(mixed);

        var refused = Assert.Throws<ConnectorException>(() => IngTransactions.AgreementId(document));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
    }

    [Fact]
    public void A_payload_that_is_not_a_transactions_answer_is_refused()
    {
        using var document = JsonDocument.Parse("""{"somethingElse":[]}""");

        var refused = Assert.Throws<ConnectorException>(
            () => IngTransactions.Read(document, SessionId, AccountId, Iban));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
    }

    // ---- the accounts --------------------------------------------------------

    [Fact]
    public void A_current_account_is_named_by_its_iban_rather_than_by_its_holder()
    {
        using var document = Fixture(BankFixtures.IngCurrentAccounts);

        var account = Assert.Single(IngAccounts.ReadCurrent(document, SessionId, AsOf));

        Assert.Equal(Iban, account.Record.ExternalId);
        Assert.Equal(Iban, account.Record.Iban);
        Assert.Equal(AccountType.Current, account.Record.Type);

        // NOT "Hr V Oorbeeld", which is in the payload, and not
        // "Betaalrekening", which is a label ING is free to translate.
        Assert.Equal(Iban, account.Record.DisplayName);

        Assert.Equal(-173_001, account.Record.Balance!.Amount.Value);
        Assert.Equal("EUR", account.Record.Balance.Amount.Currency);

        // The UUID, which is the only thing a page of transactions can be tied
        // back to - the encrypted account number beside it rotates per session.
        Assert.Equal(Agreement, account.AgreementId);
    }

    /// <summary>
    /// The savings balance arrives as a JSON NUMBER where the current account
    /// sent a string, and ING states one decimal place rather than two.
    /// </summary>
    /// <remarks>
    /// THE VALUE IS THE TEST, and 8.2 is chosen rather than a round number:
    /// the hand-written version of this - <c>(long)(element.GetDouble() * 100)</c> -
    /// answers 819 for it, because the nearest double to 8.2 is
    /// 8.199999999999999289 and the cast truncates. A balance of 10.00 in the
    /// fixture would let that through.
    /// <para>
    /// What actually stops it is that the value goes through
    /// <c>MoneyParser</c>, which takes a decimal and ROUNDS. The claim being
    /// pinned here is 820 cents, by whichever route - not the type of a local
    /// variable.
    /// </para>
    /// </remarks>
    [Fact]
    public void A_savings_balance_of_eight_euros_twenty_is_eight_hundred_and_twenty_cents()
    {
        using var document = Fixture(BankFixtures.IngSavingsAccounts);

        var account = Assert.Single(IngAccounts.ReadSavings(document, SessionId, AsOf));

        Assert.Equal(820, account.Record.Balance!.Amount.Value);
        Assert.Equal(AccountType.Savings, account.Record.Type);
        Assert.Equal("NL02INGB0009876543", account.Record.ExternalId);

        // The product name, which the two captures proved is the same string in
        // both languages - and not the user's own nickname for the account,
        // which is theirs to change.
        Assert.Equal("Oranje Spaarrekening", account.Record.DisplayName);
    }

    /// <summary>
    /// A credit card is named by its masked number, because the one field that
    /// looks like a name is translated: the same card came back "Creditcard
    /// Extra" in the Dutch session and "Credit Card Extra" in the English one.
    /// </summary>
    [Fact]
    public void A_credit_card_is_named_by_the_number_rather_than_the_translated_product()
    {
        using var document = Fixture(BankFixtures.IngCreditCards);

        var account = Assert.Single(IngAccounts.ReadCreditCards(document, SessionId, "EUR"));

        Assert.Equal("900012345678", account.Record.ExternalId);
        Assert.Equal(AccountType.CreditCard, account.Record.Type);
        Assert.Equal("5100 **** **** 0001", account.Record.DisplayName);
        Assert.Equal("5100 **** **** 0001", account.Record.MaskedNumber);

        // NO BALANCE. Nothing in the payload is an amount, and a zero would
        // read as a settled card.
        Assert.Null(account.Record.Balance);
    }

    [Fact]
    public void An_account_payload_of_the_wrong_shape_is_refused()
    {
        using var document = JsonDocument.Parse("""{"accounts":[]}""");

        Assert.Equal(
            ErrorCode.ProviderChanged,
            Assert.Throws<ConnectorException>(
                () => IngAccounts.ReadCurrent(document, SessionId, AsOf)).Code);
    }

    // ---- feeds that are not shaped like a current account ---------------------

    /// <summary>
    /// A CREDIT CARD STATES ITS ID AS AN EMPTY STRING, on every row.
    /// </summary>
    /// <remarks>
    /// Not missing - present and blank, which is the version that gets past a
    /// null check. A loan omits it outright. Either way there is no id to use,
    /// and the choice is a derived one or no history at all for four of six
    /// accounts.
    /// </remarks>
    [Fact]
    public void A_card_feed_with_no_id_of_its_own_still_yields_transactions()
    {
        using var document = Fixture(BankFixtures.IngCardTransactions);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        // Three, not four: the reservation is skipped as it is everywhere else.
        Assert.Equal(3, page.Transactions.Count);
        Assert.Equal(1, page.Reservations);

        Assert.All(page.Transactions, t => Assert.True(IngTransactions.IsDerived(t)));
        Assert.All(
            page.Transactions,
            t => Assert.StartsWith("ing-d-", t.ExternalId, StringComparison.Ordinal));

        // The merchant is the counterparty. A card payment has no IBAN on the
        // other end, so without this the one column that says where the money
        // went is blank on a whole card statement.
        Assert.Equal("SLAGERIJ OZHALK NIJEHO", page.Transactions[0].Counterparty?.Name);
        Assert.Null(page.Transactions[0].Counterparty?.Iban);

        Assert.Equal(-1_255, page.Transactions[0].Amount.Value);
        Assert.Equal(new DateOnly(2026, 8, 11), page.Transactions[0].BookedAt);
    }

    /// <summary>
    /// MONEY ARRIVING ON A CARD IS NOT THE CARD BEING USED.
    /// </summary>
    /// <remarks>
    /// A live run published "AFLOSSING" - a repayment of +EUR 1,725.13 onto the
    /// credit card - as a <c>CardPayment</c>, because only <c>-credit</c> was
    /// mapped and ING happens to word that one in Dutch. The same inconsistency
    /// that proved these values are codes rather than translations is what made
    /// the mapping incomplete.
    /// <para>
    /// The sign settles it without knowing the word: a card's balance is what is
    /// OWED, so a positive amount is money coming in.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("CRD-aflossing", "1725.13", TransactionKind.Transfer)]
    [InlineData("CRD-credit", "204.18", TransactionKind.Transfer)]
    [InlineData("CRD-debit", "-12.55", TransactionKind.CardPayment)]
    [InlineData("CRD-afschrijving", "-12.55", TransactionKind.CardPayment)]
    public void What_a_card_row_is_follows_its_direction_and_not_only_its_wording(
        string icon, string value, TransactionKind expected)
    {
        // Built by replacement rather than interpolation: the payload's own
        // closing braces sit right against the placeholders, which a raw
        // interpolated literal cannot express without more dollars than anybody
        // wants to count.
        var payload = """
        {"transactions":[
          {"id":"","iconId":"ICON","executionDate":"2026-08-11",
           "amount":{"currency":"EUR","value":"VALUE"}}]}
        """
            .Replace("ICON", icon, StringComparison.Ordinal)
            .Replace("VALUE", value, StringComparison.Ordinal);

        using var document = JsonDocument.Parse(payload);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.Equal(expected, Assert.Single(page.Transactions).Kind);
    }

    /// <summary>
    /// A HOLE IN THE ARRAY COSTS THAT ROW, NOT THE PAGE.
    /// </summary>
    /// <remarks>
    /// This loop read fields straight off whatever the <c>transactions</c>
    /// array held, so one <c>null</c> among them threw
    /// <see cref="InvalidOperationException"/> - which is not a
    /// <see cref="JsonException"/>, walks past every catch on the way out, and
    /// arrives as <c>internal</c>: retriable, blamed on this connector, and
    /// fatal to the whole fetch.
    /// <para>
    /// The rows on either side are still read, which is the point: a row a bank
    /// could not render is worth exactly one row.
    /// </para>
    /// </remarks>
    [Fact]
    public void A_null_among_the_rows_costs_that_row_and_nothing_else()
    {
        const string WithAHole = """
        {"transactions":[
          {"id":"a","executionDate":"2026-08-11","amount":{"currency":"EUR","value":"-1.00"}},
          null,
          "not a row",
          {"id":"b","executionDate":"2026-08-10","amount":{"currency":"EUR","value":"-2.00"}}]}
        """;

        using var document = JsonDocument.Parse(WithAHole);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.Equal(["a", "b"], page.Transactions.Select(t => t.ExternalId));
        Assert.Equal(-100, page.Transactions[0].Amount.Value);
        Assert.Equal(-200, page.Transactions[1].Amount.Value);
    }

    /// <summary>
    /// But a payload with no <c>transactions</c> at all is still refused. An
    /// empty statement and a different endpoint are not the same answer.
    /// </summary>
    [Fact]
    public void A_payload_with_no_transactions_array_is_still_reported_as_drift()
    {
        using var document = JsonDocument.Parse("""{"_links":[]}""");

        var refusal = Assert.Throws<ConnectorException>(
            () => IngTransactions.Read(document, SessionId, AccountId, Iban));

        Assert.Equal(ErrorCode.ProviderChanged, refusal.Code);
    }

    /// <summary>
    /// THE DETAIL LINK IS MEASURED AND NOT USED.
    /// </summary>
    /// <remarks>
    /// Every row a card states no id for links to its own detail page, and that
    /// link ends in something that looks like an identifier. It is the obvious
    /// replacement for a derived id and it is not taken, because one payload
    /// cannot tell an identifier from a row number - and taking a row number
    /// would give this account a fresh set of ids on every fetch.
    /// </remarks>
    [Fact]
    public void A_cards_detail_links_are_collected_but_the_ids_stay_derived()
    {
        using var document = Fixture(BankFixtures.IngCardTransactions);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        // Three, not four. The reservation is skipped before its link is ever
        // read, which is right: it is not a row anybody receives.
        Assert.Equal(["1", "2", "3"], page.DetailIds);

        Assert.All(page.Transactions, t => Assert.True(IngTransactions.IsDerived(t)));
    }

    /// <summary>
    /// AND WHAT IT SAYS ABOUT THEM NAMES NO VALUE.
    /// </summary>
    /// <remarks>
    /// The fixture's links are <c>/nl/card-transactions/1</c> through
    /// <c>/4</c> - one character, digits, counting up - which is precisely what
    /// a position looks like and is why the sentence exists.
    /// </remarks>
    [Fact]
    public void What_is_said_about_the_detail_links_measures_them_and_quotes_none()
    {
        var described = IngTransactions.DescribeDetails(["1", "2", "3"]);

        Assert.Equal(
            "ING's own 'transactiondetails' link offers 3 candidate id(s) for them, 3 distinct, "
            + "1 character(s) of digits, counting up one by one. Not adopted: a link that renumbers "
            + "per page or per session would re-import this account's whole history on every sync. "
            + "Compare this line across two separate logins to settle it",
            described);
    }

    /// <summary>
    /// A LONG OPAQUE TAIL IS DESCRIBED WITHOUT BEING REPEATED.
    /// </summary>
    /// <remarks>
    /// The case where the answer might be yes is also the case where the values
    /// are worth the most to anybody reading a log, so this is the one that has
    /// to hold: the measurements go in, the tails do not.
    /// </remarks>
    [Fact]
    public void A_long_tail_is_measured_rather_than_repeated()
    {
        string[] ids = ["a3f9c1d20b4e", "77de10ab93cc"];

        var described = IngTransactions.DescribeDetails(ids);

        Assert.Contains("2 candidate id(s)", described, StringComparison.Ordinal);
        Assert.Contains("2 distinct, 12 character(s) of hex", described, StringComparison.Ordinal);
        Assert.DoesNotContain("counting up", described, StringComparison.Ordinal);

        Assert.All(ids, id => Assert.DoesNotContain(id, described, StringComparison.Ordinal));
    }

    /// <summary>
    /// THE SAME TAIL ON TWO ROWS IS THE GIVEAWAY, and it is counted rather than
    /// argued about: an identifier cannot repeat, so a repeat proves it is not
    /// one.
    /// </summary>
    [Fact]
    public void A_tail_that_repeats_is_reported_as_fewer_distinct_than_total()
    {
        var described = IngTransactions.DescribeDetails(["1", "2", "1", "2"]);

        Assert.Contains("4 candidate id(s) for them, 2 distinct", described, StringComparison.Ordinal);

        // Not consecutive as a run, because it restarted - which is exactly what
        // a second page of positions does.
        Assert.DoesNotContain("counting up", described, StringComparison.Ordinal);
    }

    /// <summary>
    /// COUNTING DOWN IS THE SAME TELL AS COUNTING UP.
    /// </summary>
    /// <remarks>
    /// ING serves newest first, so a key assigned as rows were booked descends
    /// through a page. A check that only looked for ascent would miss the more
    /// likely of the two shapes.
    /// </remarks>
    [Fact]
    public void A_run_that_descends_counts_as_a_run()
    {
        Assert.Contains(
            "counting up one by one",
            IngTransactions.DescribeDetails(["9012", "9011", "9010"]),
            StringComparison.Ordinal);

        // A gap is not a run: two rows out of a longer history legitimately
        // carry keys that are close together without being adjacent.
        Assert.DoesNotContain(
            "counting up",
            IngTransactions.DescribeDetails(["9012", "9011", "9008"]),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// A feed that offers no detail link says so, rather than describing an
    /// empty list as though it had measured something.
    /// </summary>
    [Fact]
    public void No_detail_link_at_all_is_said_plainly()
    {
        Assert.Equal("ING offers no detail link on them", IngTransactions.DescribeDetails([]));
    }

    /// <summary>
    /// ONLY THE ROWS THAT NEEDED AN ID ARE MEASURED.
    /// </summary>
    /// <remarks>
    /// The sentence this feeds says the links are candidates "for them" - the
    /// derived rows. A row ING states an id for has nothing to weigh, and
    /// counting its link would pad the evidence with rows the question is not
    /// about.
    /// </remarks>
    [Fact]
    public void A_row_ING_states_an_id_for_contributes_no_candidate()
    {
        var payload = BankFixtures.Read(BankFixtures.IngCardTransactions)
            .Replace("\"id\": \"\"", "\"id\": \"ING-STATED-0001\"", StringComparison.Ordinal);

        using var document = JsonDocument.Parse(payload);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.DoesNotContain(page.Transactions, IngTransactions.IsDerived);
        Assert.Empty(page.DetailIds);
    }

    /// <summary>
    /// THE ROUTE AND ITS QUERY ARE NOT THE IDENTIFIER.
    /// </summary>
    /// <remarks>
    /// A link ending <c>?lang=nl</c> measured whole would report the language,
    /// and the language is the one thing about ING already known to move.
    /// </remarks>
    [Fact]
    public void Only_the_last_segment_of_a_detail_link_is_taken()
    {
        var payload = BankFixtures.Read(BankFixtures.IngCardTransactions)
            .Replace(
                "\"href\": \"/nl/card-transactions/1\"",
                "\"href\": \"/nl/card-transactions/8f21?lang=nl\"",
                StringComparison.Ordinal);

        using var document = JsonDocument.Parse(payload);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.Equal(["8f21", "2", "3"], page.DetailIds);
    }

    /// <summary>
    /// TWO IDENTICAL PAYMENTS ON ONE DAY ARE TWO TRANSACTIONS.
    /// </summary>
    /// <remarks>
    /// Same merchant, same amount, same date - two coffees, and the fixture
    /// carries exactly that pair. A derived id built from those fields alone
    /// would collide, and a colliding id is not a duplicate row: it is one row
    /// silently replacing another, so the statement quietly loses a purchase
    /// and still adds up on its face.
    /// </remarks>
    [Fact]
    public void Two_identical_payments_on_one_day_do_not_collapse_into_one()
    {
        using var document = Fixture(BankFixtures.IngCardTransactions);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        var first = page.Transactions[0];
        var second = page.Transactions[1];

        Assert.Equal(first.BookedAt, second.BookedAt);
        Assert.Equal(first.Amount, second.Amount);
        Assert.Equal(first.Counterparty?.Name, second.Counterparty?.Name);

        Assert.NotEqual(first.ExternalId, second.ExternalId);
        Assert.NotEqual(first.Id, second.Id);
    }

    /// <summary>
    /// A DERIVED ID IS BUILT FROM NOTHING ING TRANSLATES, and this is the whole
    /// reason the CSV export was refused.
    /// </summary>
    /// <remarks>
    /// All 926 rows of the real export changed id between the Dutch and English
    /// downloads, because the text they were derived from carries labels ING
    /// translates. So the fields that ARE ING's own wording - a loan's
    /// <c>subject</c> and <c>subjectLines</c>, a card's <c>description</c>,
    /// <c>type.description</c> - must not move the id when they move, and
    /// neither must <c>iconId</c>, whose own observed values mix
    /// <c>CRD-debit</c> with the Dutch <c>CRD-afschrijving</c>.
    /// </remarks>
    [Fact]
    public void A_derived_id_does_not_move_when_the_login_session_does()
    {
        // 2026-10-07 (prod): the card's repayments - the rows ING states no id
        // for - landed a second time after a new sign-in, because the derived
        // id was seeded on the session-tied account record. Two sessions, one
        // page: the same ids.
        const string otherSession = "ses_fedcba9876543210fedcba9876543210";
        using var first = Fixture(BankFixtures.IngLoanTransactions);
        using var second = Fixture(BankFixtures.IngLoanTransactions);

        var one = IngTransactions.Read(first, SessionId, AccountId, Iban);
        var two = IngTransactions.Read(second, otherSession, BankRecords.AccountId(otherSession, Iban), Iban);

        Assert.NotEmpty(one.Transactions);
        Assert.All(one.Transactions, t => Assert.True(t.IdIsDerived));
        Assert.Equal(
            one.Transactions.Select(t => t.ExternalId),
            two.Transactions.Select(t => t.ExternalId));
        // and the account record each row names still follows its session
        Assert.NotEqual(one.Transactions[0].AccountId, two.Transactions[0].AccountId);
    }

    [Fact]
    public void A_derived_id_does_not_move_when_ings_own_wording_does()
    {
        var dutch = BankFixtures.Read(BankFixtures.IngLoanTransactions);

        var english = dutch
            .Replace("Incasso Persoonlijke lening", "Direct debit personal loan", StringComparison.Ordinal)
            .Replace("\"description\": \"Termijn\"", "\"description\": \"Instalment\"", StringComparison.Ordinal)
            .Replace("LOA-DEBIT", "LOA-AFSCHRIJVING", StringComparison.Ordinal);

        using var before = JsonDocument.Parse(dutch);
        using var after = JsonDocument.Parse(english);

        var one = IngTransactions.Read(before, SessionId, AccountId, Iban);
        var two = IngTransactions.Read(after, SessionId, AccountId, Iban);

        Assert.NotEmpty(one.Transactions);
        Assert.Equal(
            one.Transactions.Select(t => t.ExternalId),
            two.Transactions.Select(t => t.ExternalId));

        // And the run is not silently identical because nothing was read: the
        // description really did change, which is what makes the ids holding
        // mean something.
        Assert.NotEqual(
            one.Transactions[0].Description,
            two.Transactions[0].Description);
    }

    /// <summary>
    /// A card's rows are classified from its ICON, which is the only
    /// classification its feed offers.
    /// </summary>
    /// <remarks>
    /// A card and a loan state no two-letter code, so every row of both used to
    /// arrive as <c>Other</c>. What makes <c>iconId</c> safe to read is what its
    /// own values give away: one live response held BOTH <c>CRD-debit</c> and
    /// <c>CRD-afschrijving</c>, and a field ING translated would not carry an
    /// English and a Dutch word in the same payload. They are codes, worded
    /// inconsistently - which is why this needed no language switch to
    /// establish.
    /// </remarks>
    [Theory]
    [InlineData("CRD-debit", TransactionKind.CardPayment)]
    [InlineData("CRD-afschrijving", TransactionKind.CardPayment)]
    [InlineData("CRD-credit", TransactionKind.Transfer)]
    // A loan says which way the money went and nothing about what it was: an
    // instalment, interest and a fee are three kinds and the sign tells them
    // apart from nothing.
    [InlineData("LOA-DEBIT", TransactionKind.Other)]
    [InlineData("LOA-CREDIT", TransactionKind.Other)]
    public void A_row_with_no_code_is_classified_by_its_icon(string icon, TransactionKind expected)
    {
        using var document = JsonDocument.Parse(
            """{"transactions":[{"iconId":"ICON","executionDate":"2026-08-11","amount":{"currency":"EUR","value":"-1.00"}}]}"""
                .Replace("ICON", icon, StringComparison.Ordinal));

        var transaction = Assert.Single(IngTransactions.Read(document, SessionId, AccountId, Iban).Transactions);

        Assert.Equal(expected, transaction.Kind);
    }

    /// <summary>
    /// A row this reader cannot classify reports ING'S OWN CODES for it, and
    /// never the words beside them.
    /// </summary>
    /// <remarks>
    /// The instrument that classified a credit card, pointed at what is left:
    /// <c>iconId</c> turned out to be a code rather than translated text, and
    /// that was knowable only by looking at values. <c>type.id</c> is <c>DV</c>
    /// on interest, on a fee and on a card settlement alike, so on its own it
    /// tells them apart from nothing.
    /// <para>
    /// Held to the schema's own lock, so a field that turns out to hold a
    /// sentence rather than a code is dropped instead of printed - which is the
    /// difference between a diagnostic and a leak.
    /// </para>
    /// </remarks>
    [Fact]
    public void An_unclassified_row_reports_its_codes_and_not_its_words()
    {
        using var document = JsonDocument.Parse(
            """
            {"transactions":[{"iconId":"INT-debit","type":{"id":"DV","description":"Diversen"},
              "subject":"Rente ING Rood Staan","executionDate":"2026-08-11",
              "amount":{"currency":"EUR","value":"-8.09"}}]}
            """);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.Equal(TransactionKind.Other, page.Transactions[0].Kind);
        Assert.Equal(["DV", "INT-debit"], page.Unclassified);

        // The description is ING's own wording and stays out, exactly as it
        // stays out of a derived id.
        Assert.DoesNotContain("Rente", string.Join(" ", page.Unclassified), StringComparison.Ordinal);
        Assert.DoesNotContain("Diversen", string.Join(" ", page.Unclassified), StringComparison.Ordinal);
    }

    /// <summary>
    /// And a row it DID classify contributes nothing to that list, so the list
    /// is a to-do rather than an inventory.
    /// </summary>
    [Fact]
    public void A_classified_row_is_not_reported_as_unclassified()
    {
        using var document = Fixture(BankFixtures.IngCardTransactions);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.All(page.Transactions, t => Assert.NotEqual(TransactionKind.Other, t.Kind));
        Assert.Empty(page.Unclassified);
    }

    /// <summary>
    /// And ING's own code still wins wherever it states one.
    /// </summary>
    /// <remarks>
    /// The icon is a fallback, not a replacement. A current account states both
    /// - <c>type.id</c> of <c>BA</c> beside an icon - and the code is the field
    /// two captures proved identical across languages, where the icon is
    /// merely believed to be.
    /// </remarks>
    [Fact]
    public void A_stated_code_outranks_the_icon_beside_it()
    {
        using var document = JsonDocument.Parse(
            """
            {"transactions":[{"iconId":"CRD-debit","type":{"id":"IC"},"executionDate":"2026-08-11",
              "amount":{"currency":"EUR","value":"-1.00"}}]}
            """);

        var transaction = Assert.Single(IngTransactions.Read(document, SessionId, AccountId, Iban).Transactions);

        Assert.Equal(TransactionKind.DirectDebit, transaction.Kind);
    }

    /// <summary>
    /// Neither feed states a running balance, so the chain cannot be checked -
    /// and the reader does not invent one.
    /// </summary>
    [Theory]
    [InlineData("ing-transactions-card.json")]
    [InlineData("ing-transactions-loan.json")]
    public void A_feed_with_no_running_balance_states_none(string fixture)
    {
        using var document = Fixture(fixture);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.NotEmpty(page.Transactions);
        Assert.All(page.Transactions, t => Assert.Null(t.ResultingBalance));

        // Which BalanceChain skips rather than failing on - a zero here would
        // break every chain it touched.
        Assert.Null(BalanceChain.FindBreak([.. page.Transactions.Reverse()]));
    }

    /// <summary>
    /// And a feed that DOES state ids still uses ING's own, untouched.
    /// </summary>
    [Fact]
    public void A_feed_that_states_its_own_ids_derives_nothing()
    {
        using var document = Fixture(BankFixtures.IngTransactionsDutch);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.DoesNotContain(page.Transactions, IngTransactions.IsDerived);
        Assert.DoesNotContain(page.Transactions, t => t.ExternalId.StartsWith("ing-d-", StringComparison.Ordinal));
    }

    // ---- the agreement list --------------------------------------------------

    /// <summary>
    /// The call the overview lists everything from, and the reason it replaced
    /// three endpoints: it names the accounts the other route could not reach.
    /// </summary>
    /// <remarks>
    /// A live fetch reported an account holder's own savings account as
    /// unreachable, because ING fetches savings and cards on the statement
    /// screen only when somebody switches its picker. This one call carries all
    /// of them, and a loan besides.
    /// </remarks>
    [Fact]
    public void The_agreement_list_names_every_kind_of_account_except_the_points()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal(
            [AccountType.Current, AccountType.Savings, AccountType.CreditCard, AccountType.Loan],
            accounts.Select(a => a.Record.Type));

        Assert.Equal(
            [Iban, "NL02INGB0009876543", "900012345678", "700000000009"],
            accounts.Select(a => a.Record.ExternalId));

        // ING PUNTEN ARE NOT AN ACCOUNT. The LOYALTY agreement states a balance
        // of 1420 PTS, and a ledger that carries it is one that adds points to
        // euros.
        Assert.DoesNotContain(accounts, a => a.Record.ExternalId == "0000001");
        Assert.DoesNotContain(accounts, a => a.Record.Currency == "PTS");
    }

    /// <summary>
    /// Balances, to the cent, from the string ING states them as.
    /// </summary>
    /// <remarks>
    /// The savings figure is the same 8.20 the savings endpoint sends as a JSON
    /// number, and it has to come out at 820 by either route: an account whose
    /// balance changes when a connector changes which call it read is an account
    /// nobody can reconcile.
    /// <para>
    /// THE CARD HAS NONE, and that is ING rather than this reader. Two live runs
    /// established it: <c>/credit-cards/cards</c> carries no amount anywhere in
    /// it, and the agreement list omits the <c>balance</c> object entirely for a
    /// card while carrying one for every other type. A zero here would read as a
    /// settled card.
    /// </para>
    /// </remarks>
    [Fact]
    public void An_agreements_balance_is_read_to_the_cent_in_the_currency_it_states()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal(
            [-173_001, 820, null, -1_250_000],
            accounts.Select(a => a.Record.Balance?.Amount.Value));

        Assert.All(
            accounts.Where(a => a.Record.Balance is not null),
            a => Assert.Equal("EUR", a.Record.Balance!.Amount.Currency));

        // And the card is still an account, in the currency the rest are in.
        Assert.Equal("EUR", accounts[2].Record.Currency);
    }

    /// <summary>
    /// The two routes to the same current account agree on every field a
    /// consumer sees.
    /// </summary>
    /// <remarks>
    /// THIS IS WHY THE NAMING RULES HAD TO MATCH rather than merely both being
    /// defensible. The statement screen is still the fallback when the agreement
    /// list is missing, and an account whose id or display name depends on which
    /// call the connector happened to read is an account that republishes itself
    /// every time ING changes its mind.
    /// </remarks>
    [Fact]
    public void The_same_account_is_the_same_record_whichever_call_it_was_read_from()
    {
        using var agreements = Fixture(BankFixtures.IngAgreements);
        using var current = Fixture(BankFixtures.IngCurrentAccounts);

        var viaAgreements = IngAccounts.ReadAgreements(agreements, SessionId, AsOf)[0];
        var viaEndpoint = Assert.Single(IngAccounts.ReadCurrent(current, SessionId, AsOf));

        Assert.Equal(viaEndpoint.Record.Id, viaAgreements.Record.Id);
        Assert.Equal(viaEndpoint.Record.DisplayName, viaAgreements.Record.DisplayName);
        Assert.Equal(viaEndpoint.Record.Iban, viaAgreements.Record.Iban);
        Assert.Equal(viaEndpoint.Record.Balance, viaAgreements.Record.Balance);

        // Including the key a page of transactions is tied back to, which is
        // what would otherwise file somebody's history under nothing at all.
        Assert.Equal(Agreement, viaAgreements.AgreementId);
        Assert.Equal(viaEndpoint.AgreementId, viaAgreements.AgreementId);
    }

    /// <summary>
    /// A savings account keeps the product name; everything else is named by
    /// something ING cannot translate.
    /// </summary>
    /// <remarks>
    /// The account holder's language is not ours to choose, so a display name
    /// that reads "Creditcard Extra" today and "Credit Card Extra" tomorrow
    /// changes the account's content hash and republishes an account nothing
    /// happened to. <c>productName</c> is used for savings alone because that is
    /// the one field two captures proved identical in both languages -
    /// <c>displayAlias</c> beside it holds the name the account holder gave the
    /// account themselves, and is theirs to change.
    /// </remarks>
    [Fact]
    public void Only_the_savings_product_is_named_by_a_word_rather_than_a_number()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal(
            [Iban, "Oranje Spaarrekening", "900012345678", "700000000009"],
            accounts.Select(a => a.Record.DisplayName));

        // The fixture holds all three of the alternatives, and none of them is
        // on a record: the holder's name, ING's translated product label for the
        // card, and the nickname on the savings pot.
        Assert.DoesNotContain(accounts, a => a.Record.DisplayName.Contains("Oorbeeld", StringComparison.Ordinal));
        Assert.DoesNotContain(accounts, a => a.Record.DisplayName == "Creditcard Extra");
        Assert.DoesNotContain(accounts, a => a.Record.DisplayName == "Nieuwe keuken");
    }

    /// <summary>
    /// An IBAN only when ING says the identifier IS one.
    /// </summary>
    /// <remarks>
    /// The loan states its contract number in the same <c>commercialId</c> field
    /// under a different type. Reading that field without checking the type puts
    /// a twelve-digit lie in an IBAN column, which every downstream thing then
    /// treats as an account number.
    /// </remarks>
    [Fact]
    public void A_commercial_id_that_is_not_an_iban_is_not_filed_as_one()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal([Iban, "NL02INGB0009876543", null, null], accounts.Select(a => a.Record.Iban));

        // And the loan is still listed, by the number itself.
        Assert.Equal("700000000009", accounts[3].Record.ExternalId);
    }

    /// <summary>
    /// The agreement id is taken only when ING states that the id IS a UUID.
    /// </summary>
    /// <remarks>
    /// It is used for exactly one thing - matching a page of transactions to the
    /// account it belongs to - and <c>identifierType</c> was LOCAL_ID on the
    /// card. Matching on a local id that happens to collide would file somebody's
    /// transactions under the wrong account, which reconciles perfectly and is
    /// invisible.
    /// </remarks>
    [Fact]
    public void A_local_id_is_never_mistaken_for_an_agreement_uuid()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal(
            [Agreement, "66666666-7777-8888-9999-000000000000", null, null],
            accounts.Select(a => a.AgreementId));
    }

    /// <summary>
    /// An agreement with no <c>commercialId</c> falls back to ING's own account
    /// id before it falls back to the raw agreement id.
    /// </summary>
    [Fact]
    public void An_agreement_without_a_commercial_id_is_identified_by_its_account_id()
    {
        using var document = JsonDocument.Parse(
            """
            {"agreements":[{"type":"SAVINGS","accountId":"9876543","id":"not-the-external-id",
              "balance":{"currency":"usd","value":"10.00"}}]}
            """);

        var account = Assert.Single(IngAccounts.ReadAgreements(document, SessionId, AsOf));

        Assert.Equal("9876543", account.Record.ExternalId);
        Assert.Null(account.Record.Iban);

        // AND THE CURRENCY ING STATED, not the euro every fixture happens to be
        // in. A customer whose ING account is not in euros gets their own
        // currency, uppercased to ISO-4217 on the way through.
        Assert.Equal("USD", account.Record.Currency);
        Assert.Equal("USD", account.Record.Balance!.Amount.Currency);
    }

    /// <summary>
    /// A balance is read whether ING states it as a string or as a JSON number.
    /// </summary>
    /// <remarks>
    /// IT ALREADY DOES BOTH, in the same session, for a field of this name:
    /// <c>/accounts/current</c> sends <c>"-1730.01"</c> and
    /// <c>/savings/accounts/products</c> sends <c>8.2</c>. A reader that takes
    /// only the string reports an account with no balance and looks perfectly
    /// healthy doing it - which is what a live fetch showed against a credit
    /// card.
    /// <para>
    /// 8.2 rather than a round number on purpose: the hand-written version of
    /// this - <c>(long)(GetDouble() * 100)</c> - answers 819, because the
    /// nearest double to 8.2 is 8.199999999999999289 and the cast truncates.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("\"8.20\"")]
    [InlineData("8.2")]
    public void An_agreements_balance_is_read_as_a_string_or_as_a_number(string value)
    {
        using var document = JsonDocument.Parse(
            """{"agreements":[{"type":"CARD","accountId":"0012345","balance":{"currency":"EUR","value":X}}]}"""
                .Replace("X", value, StringComparison.Ordinal));

        var account = Assert.Single(IngAccounts.ReadAgreements(document, SessionId, AsOf));

        Assert.Equal(820, account.Record.Balance!.Amount.Value);
    }

    /// <summary>
    /// A balance that IS there and cannot be read is told apart from one that
    /// was never sent, because only one of the two is this connector's fault.
    /// </summary>
    /// <remarks>
    /// The shape comes back through <see cref="IngSchema"/>, which cannot carry
    /// the figure itself out of somebody's bank.
    /// </remarks>
    [Fact]
    public void A_balance_that_cannot_be_read_is_told_apart_from_one_never_sent()
    {
        using var document = JsonDocument.Parse(
            """
            {"agreements":[{"type":"CARD","accountId":"0012345",
              "balance":{"currency":"EUR","value":{"amount":-24995,"scale":2}}}]}
            """);

        var notes = new List<string>();

        var account = Assert.Single(IngAccounts.ReadAgreements(document, SessionId, AsOf, notes.Add));

        Assert.Null(account.Record.Balance);
        Assert.Equal("0012345", account.Record.ExternalId);

        var note = Assert.Single(notes);
        Assert.Contains("credit_card", note, StringComparison.Ordinal);
        Assert.Contains("value:{amount:number,scale:number}", note, StringComparison.Ordinal);

        // The structure, and not the figure.
        Assert.DoesNotContain("24995", note, StringComparison.Ordinal);
    }

    /// <summary>
    /// And it says NOTHING when ING simply sent no balance, because that is not
    /// a gap.
    /// </summary>
    /// <remarks>
    /// A credit card states no balance in the agreement list by design - the
    /// live account confirmed it, and ING's own overview shows none either. The
    /// adapter goes and reads it off the card's own resource afterwards, so a
    /// note here said "listed without a balance" about an account that ends the
    /// run with one. The person reading it saw the figure and the contradiction
    /// side by side.
    /// </remarks>
    [Fact]
    public void An_agreement_ing_states_no_balance_for_is_not_reported_as_a_problem()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var notes = new List<string>();

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf, notes.Add);

        Assert.Null(accounts[2].Record.Balance);
        Assert.Empty(notes);
    }

    /// <summary>
    /// The <c>self</c> link is carried on the account, because it is the only
    /// route to a credit card's balance.
    /// </summary>
    [Fact]
    public void An_agreement_carries_the_link_to_its_own_resource()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal("/nl/agreements/900012345678/carddetails", accounts[2].SelfPath);

        // And it is the SELF link rather than whichever link came first: the
        // card's agreement also states a transactions link and an edit one.
        Assert.DoesNotContain(accounts, a => a.SelfPath == "/agreementpreferences/900012345678");
    }

    /// <summary>
    /// What an agreement IS comes from <c>type</c>, and from <c>group</c> when
    /// there is no type.
    /// </summary>
    /// <remarks>
    /// Both fields carry the same five words and they agreed on all seven
    /// agreements of the observed account, so which ING would prefer in a
    /// disagreement is NOT established. What is pinned here is the connector's
    /// own rule: the narrower name wins, and the coarser one is still read, so
    /// an agreement stating only <c>group</c> is classified rather than
    /// quietly filed as unknown.
    /// </remarks>
    [Theory]
    [InlineData("""{"type":"SAVINGS","group":"CURRENT","accountId":"9876543"}""", AccountType.Savings)]
    [InlineData("""{"group":"SAVINGS","accountId":"9876543"}""", AccountType.Savings)]
    public void An_agreements_kind_is_read_from_its_type_first_and_its_group_after(
        string agreement, AccountType expected)
    {
        using var document = JsonDocument.Parse($$"""{"agreements":[{{agreement}}]}""");

        var account = Assert.Single(IngAccounts.ReadAgreements(document, SessionId, AsOf));

        Assert.Equal(expected, account.Record.Type);
    }

    /// <summary>
    /// A product this connector has never heard of is LISTED, under
    /// <see cref="AccountType.Unknown"/>, rather than dropped.
    /// </summary>
    /// <remarks>
    /// Only the taxonomy of one account was ever observed. An account listed
    /// under the wrong heading is a great deal easier to notice than one that is
    /// not listed - and the alternative is somebody's money quietly missing from
    /// a ledger the day ING launches a product.
    /// </remarks>
    [Fact]
    public void An_unrecognised_product_is_listed_as_unknown_rather_than_dropped()
    {
        using var document = JsonDocument.Parse(
            """
            {"agreements":[{"type":"NL_SOMETHING_NEW","commercialId":{"type":"IBAN","value":"NL03INGB0001112223"},
              "balance":{"currency":"EUR","value":"1.00"}}]}
            """);

        var account = Assert.Single(IngAccounts.ReadAgreements(document, SessionId, AsOf));

        Assert.Equal(AccountType.Unknown, account.Record.Type);
        Assert.Equal("NL03INGB0001112223", account.Record.ExternalId);
    }

    /// <summary>
    /// An agreement with no identifier at all is refused rather than given one.
    /// </summary>
    [Fact]
    public void An_agreement_with_nothing_to_identify_it_by_is_refused()
    {
        using var document = JsonDocument.Parse("""{"agreements":[{"type":"CURRENT"}]}""");

        Assert.Equal(
            ErrorCode.ProviderChanged,
            Assert.Throws<ConnectorException>(
                () => IngAccounts.ReadAgreements(document, SessionId, AsOf)).Code);
    }

    [Fact]
    public void An_agreement_payload_of_the_wrong_shape_is_refused()
    {
        using var document = JsonDocument.Parse("""{"accounts":[]}""");

        Assert.Equal(
            ErrorCode.ProviderChanged,
            Assert.Throws<ConnectorException>(
                () => IngAccounts.ReadAgreements(document, SessionId, AsOf)).Code);
    }
}
