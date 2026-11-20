using System.Text.Json;
using BankConnector.Adapters.Ing;
using BankConnector.Adapters.Parsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

// the language is not ours to choose (it changes on the holder's other devices): Dutch and English answers must
// mean the same
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

    // ING trims trailing zeros on balances but not amounts ("-1656" beside "-1731.04"): never assume two decimals
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

    // ING states rows newest first and BalanceChain is oldest-first: the chain closes only once reversed, as the
    // adapter does
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

    [Fact]
    public void The_chain_does_not_close_in_the_order_ing_serves_it()
    {
        Assert.NotNull(BalanceChain.FindBreak(Page(BankFixtures.IngTransactionsDutch).Transactions));
    }

    // the API id is identical in both languages; the CSV states none, and an id derived from its translated text
    // re-imported the whole history
    [Fact]
    public void A_transactions_identity_does_not_depend_on_the_language()
    {
        var nl = Page(BankFixtures.IngTransactionsDutch).Transactions;
        var en = Page(BankFixtures.IngTransactionsEnglish).Transactions;

        Assert.Equal(nl.Select(t => t.ExternalId), en.Select(t => t.ExternalId));
        Assert.Equal(nl.Select(t => t.Id), en.Select(t => t.Id));
        Assert.All(nl, t => Assert.Equal(24, t.ExternalId.Length));
    }

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

    // originalMemos (what the payer wrote) match across languages, subjectLines do not (labels are translated); ING's
    // own bookkeeping subjects are the only ones that differ
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

        Assert.Equal(2, nl.Zip(en).Count(pair => pair.First.Description == pair.Second.Description));
    }

    // the kind comes from the untranslated two-letter code; DV is ING's own "something else" bucket and stays Other, a
    // specific kind would invent a fact
    [Theory]
    [InlineData(BankFixtures.IngTransactionsDutch)]
    [InlineData(BankFixtures.IngTransactionsEnglish)]
    public void The_kind_is_the_code_rather_than_the_word_beside_it(string fixture)
    {
        Assert.Equal(
            [TransactionKind.CardPayment, TransactionKind.DirectDebit, TransactionKind.Other],
            Page(fixture).Transactions.Select(t => t.Kind));

        Assert.Equal(TransactionKind.Transfer, BankTransactionKinds.FromCode("ST"));
    }

    // the description is a word the parser does not know, so only type.id can give the kind
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

    // a reservation has no running balance and may change its amount on booking: emitting it would break the chain
    [Fact]
    public void An_unsettled_reservation_is_counted_and_left_out()
    {
        var page = Page(BankFixtures.IngTransactionsDutch);

        Assert.Equal(1, page.Reservations);
        Assert.Equal(3, page.Transactions.Count);
        Assert.DoesNotContain("010305900000000010000000", page.Transactions.Select(t => t.ExternalId));
    }

    // no value date by decision: ING states one only inside localised remittance lines
    [Fact]
    public void No_value_date_is_invented_from_the_localised_lines()
    {
        Assert.All(Page(BankFixtures.IngTransactionsDutch).Transactions, t => Assert.Null(t.ValueAt));
    }

    // an IBAN only where type says IBAN: a card payment states {"type":"UNKNOWN","value":""}.
    [Fact]
    public void A_counterparty_iban_is_read_only_when_ing_says_it_is_one()
    {
        var rows = Page(BankFixtures.IngTransactionsDutch).Transactions;

        Assert.Equal("SUPERMARKT 0001", rows[0].Counterparty!.Name);
        Assert.Null(rows[0].Counterparty!.Iban);

        Assert.Equal("VOORBEELD TELECOM B.V.", rows[1].Counterparty!.Name);
        Assert.Equal("NL03BANK0000000001", rows[1].Counterparty!.Iban);

        Assert.Null(rows[2].Counterparty);
    }

    // proves type is read: ING pairs UNKNOWN with an empty string, so the fixture test cannot tell it from a reader
    // that ignores type
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

    // ING pads its own subjects to a fixed width: untrimmed, trailing spaces reach the content hash
    [Fact]
    public void The_description_is_what_the_payer_wrote_or_the_trimmed_subject()
    {
        var rows = Page(BankFixtures.IngTransactionsDutch).Transactions;

        Assert.Equal("SUPERMARKT 0001", rows[0].Description);

        Assert.Equal("Klantnr 9.99999999 Factuur 900000000001 | 500000000001", rows[1].Description);

        Assert.Equal("Incasso ING creditcard", rows[2].Description);
    }

    [Fact]
    public void The_first_page_states_ings_own_cursor_and_the_last_states_none()
    {
        var first = Page(BankFixtures.IngTransactionsDutch);

        Assert.NotNull(first.NextPath);
        Assert.StartsWith("/v1/agreements/", first.NextPath, StringComparison.Ordinal);
        Assert.Contains("cursor=", first.NextPath, StringComparison.Ordinal);

        Assert.Null(Page(BankFixtures.IngTransactionsPageTwo).NextPath);
    }

    // the agreement id in the request URL is encrypted per session; the UUID in the transactions' action links is
    // stable and the first row that carries one decides (bookkeeping rows have no links)
    [Theory]
    [InlineData(BankFixtures.IngTransactionsDutch)]
    [InlineData(BankFixtures.IngTransactionsEnglish)]
    public void A_page_names_the_account_it_belongs_to(string fixture)
    {
        using var document = Fixture(fixture);

        Assert.Equal(Agreement, IngTransactions.AgreementId(document));
    }

    // two accounts named in one page is refused: another account's transactions would reconcile and be invisible
    [Fact]
    public void A_page_that_names_two_accounts_is_refused()
    {
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

    [Fact]
    public void A_current_account_is_named_by_its_iban_rather_than_by_its_holder()
    {
        using var document = Fixture(BankFixtures.IngCurrentAccounts);

        var account = Assert.Single(IngAccounts.ReadCurrent(document, SessionId, AsOf));

        Assert.Equal(Iban, account.Record.ExternalId);
        Assert.Equal(Iban, account.Record.Iban);
        Assert.Equal(AccountType.Current, account.Record.Type);

        // named by IBAN, not by the holder's name or "Betaalrekening" (a label ING translates)
        Assert.Equal(Iban, account.Record.DisplayName);

        Assert.Equal(-173_001, account.Record.Balance!.Amount.Value);
        Assert.Equal("EUR", account.Record.Balance.Amount.Currency);

        // the UUID ties a page of transactions to the account; the encrypted account number beside it rotates per session
        Assert.Equal(Agreement, account.AgreementId);
    }

    // 8.2 on purpose: (long)(GetDouble() * 100) answers 819; MoneyParser rounds, and 820 cents is the claim
    [Fact]
    public void A_savings_balance_of_eight_euros_twenty_is_eight_hundred_and_twenty_cents()
    {
        using var document = Fixture(BankFixtures.IngSavingsAccounts);

        var account = Assert.Single(IngAccounts.ReadSavings(document, SessionId, AsOf));

        Assert.Equal(820, account.Record.Balance!.Amount.Value);
        Assert.Equal(AccountType.Savings, account.Record.Type);
        Assert.Equal("NL02INGB0009876543", account.Record.ExternalId);

        // the product name is identical in both languages; the user's own nickname is theirs to change
        Assert.Equal("Oranje Spaarrekening", account.Record.DisplayName);
    }

    // named by the masked number: the product name is translated ("Creditcard Extra" / "Credit Card Extra")
    [Fact]
    public void A_credit_card_is_named_by_the_number_rather_than_the_translated_product()
    {
        using var document = Fixture(BankFixtures.IngCreditCards);

        var account = Assert.Single(IngAccounts.ReadCreditCards(document, SessionId, "EUR"));

        Assert.Equal("900012345678", account.Record.ExternalId);
        Assert.Equal(AccountType.CreditCard, account.Record.Type);
        Assert.Equal("5100 **** **** 0001", account.Record.DisplayName);
        Assert.Equal("5100 **** **** 0001", account.Record.MaskedNumber);

        // no balance: nothing in the payload is an amount, and a zero would read as a settled card
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

    // a card states its id as an empty string (present, so it passes a null check) and a loan omits it: derived ids,
    // or no history for four of six accounts
    [Fact]
    public void A_card_feed_with_no_id_of_its_own_still_yields_transactions()
    {
        using var document = Fixture(BankFixtures.IngCardTransactions);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.Equal(3, page.Transactions.Count);
        Assert.Equal(1, page.Reservations);

        Assert.All(page.Transactions, t => Assert.True(IngTransactions.IsDerived(t)));
        Assert.All(
            page.Transactions,
            t => Assert.StartsWith("ing-d-", t.ExternalId, StringComparison.Ordinal));

        // the merchant is the counterparty: a card payment has no IBAN on the other end
        Assert.Equal("SLAGERIJ OZHALK NIJEHO", page.Transactions[0].Counterparty?.Name);
        Assert.Null(page.Transactions[0].Counterparty?.Iban);

        Assert.Equal(-1_255, page.Transactions[0].Amount.Value);
        Assert.Equal(new DateOnly(2026, 8, 11), page.Transactions[0].BookedAt);
    }

    // "AFLOSSING" (+1,725.13 onto a card) was published as CardPayment because only -credit was mapped; a card's
    // balance is what is owed, so a positive amount is money coming in
    [Theory]
    [InlineData("CRD-aflossing", "1725.13", TransactionKind.Transfer)]
    [InlineData("CRD-credit", "204.18", TransactionKind.Transfer)]
    [InlineData("CRD-debit", "-12.55", TransactionKind.CardPayment)]
    [InlineData("CRD-afschrijving", "-12.55", TransactionKind.CardPayment)]
    public void What_a_card_row_is_follows_its_direction_and_not_only_its_wording(
        string icon, string value, TransactionKind expected)
    {
        // replacement, not interpolation: the payload's braces sit against the placeholders
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

    // one null among the rows threw InvalidOperationException, which skips every catch and arrives as a retriable
    // internal error failing the whole fetch; a row a bank cannot render costs one row
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

    // no transactions array at all is still drift: an empty statement and a different endpoint are not the same answer
    [Fact]
    public void A_payload_with_no_transactions_array_is_still_reported_as_drift()
    {
        using var document = JsonDocument.Parse("""{"_links":[]}""");

        var refusal = Assert.Throws<ConnectorException>(
            () => IngTransactions.Read(document, SessionId, AccountId, Iban));

        Assert.Equal(ErrorCode.ProviderChanged, refusal.Code);
    }

    // the detail link is not adopted as an id: one payload cannot tell an identifier from a row number, and a row
    // number would give the account fresh ids on every fetch
    [Fact]
    public void A_cards_detail_links_are_collected_but_the_ids_stay_derived()
    {
        using var document = Fixture(BankFixtures.IngCardTransactions);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.Equal(["1", "2", "3"], page.DetailIds);

        Assert.All(page.Transactions, t => Assert.True(IngTransactions.IsDerived(t)));
    }

    // the fixture's links are /1../4, which is what a position looks like: the sentence names no value
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

    // a long opaque tail is measured, not quoted: the values are worth most in a log exactly when it might be an id
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

    // an identifier cannot repeat, so a repeated tail proves it is not one
    [Fact]
    public void A_tail_that_repeats_is_reported_as_fewer_distinct_than_total()
    {
        var described = IngTransactions.DescribeDetails(["1", "2", "1", "2"]);

        Assert.Contains("4 candidate id(s) for them, 2 distinct", described, StringComparison.Ordinal);

        Assert.DoesNotContain("counting up", described, StringComparison.Ordinal);
    }

    // ING serves newest first, so a key assigned as rows were booked descends: counting down is a run too
    [Fact]
    public void A_run_that_descends_counts_as_a_run()
    {
        Assert.Contains(
            "counting up one by one",
            IngTransactions.DescribeDetails(["9012", "9011", "9010"]),
            StringComparison.Ordinal);

        // a gap is not a run: keys out of a longer history can be close without being adjacent
        Assert.DoesNotContain(
            "counting up",
            IngTransactions.DescribeDetails(["9012", "9011", "9008"]),
            StringComparison.Ordinal);
    }

    [Fact]
    public void No_detail_link_at_all_is_said_plainly()
    {
        Assert.Equal("ING offers no detail link on them", IngTransactions.DescribeDetails([]));
    }

    // only derived rows are measured: a row with an ING-stated id has nothing to weigh
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

    // only the last segment: a link ending ?lang=nl measured whole would report the language, which already moves
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

    // two identical payments on one day: an id from merchant, amount and date alone would collide, and one row would
    // silently replace the other
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

    // a derived id uses nothing ING translates (loan subject/subjectLines, card description, type.description, iconId
    // mixing CRD-debit and CRD-afschrijving): this is why the CSV export was refused
    [Fact]
    public void A_derived_id_does_not_move_when_the_login_session_does()
    {
        // the card's repayments (no id stated) landed twice after a new sign-in because the derived id was seeded on the
        // session-tied account record: two sessions, one page, the same ids
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

        Assert.NotEqual(
            one.Transactions[0].Description,
            two.Transactions[0].Description);
    }

    // card and loan state no two-letter code: classified from iconId, a code (one response held both CRD-debit and
    // CRD-afschrijving, so it is not translated text)
    [Theory]
    [InlineData("CRD-debit", TransactionKind.CardPayment)]
    [InlineData("CRD-afschrijving", TransactionKind.CardPayment)]
    [InlineData("CRD-credit", TransactionKind.Transfer)]
    // a loan states direction but not what it was (instalment, interest, fee): stays Other
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

    // unclassified rows report ING's codes, never the words beside them: held to the schema's lock, a sentence is
    // dropped not printed
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

        Assert.DoesNotContain("Rente", string.Join(" ", page.Unclassified), StringComparison.Ordinal);
        Assert.DoesNotContain("Diversen", string.Join(" ", page.Unclassified), StringComparison.Ordinal);
    }

    [Fact]
    public void A_classified_row_is_not_reported_as_unclassified()
    {
        using var document = Fixture(BankFixtures.IngCardTransactions);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.All(page.Transactions, t => Assert.NotEqual(TransactionKind.Other, t.Kind));
        Assert.Empty(page.Unclassified);
    }

    // the icon is a fallback: the code, proven identical across languages, wins wherever it is stated
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

    // neither feed states a running balance: none is invented
    [Theory]
    [InlineData("ing-transactions-card.json")]
    [InlineData("ing-transactions-loan.json")]
    public void A_feed_with_no_running_balance_states_none(string fixture)
    {
        using var document = Fixture(fixture);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.NotEmpty(page.Transactions);
        Assert.All(page.Transactions, t => Assert.Null(t.ResultingBalance));

        // BalanceChain skips a missing balance; a zero would break every chain it touched
        Assert.Null(BalanceChain.FindBreak([.. page.Transactions.Reverse()]));
    }

    [Fact]
    public void A_feed_that_states_its_own_ids_derives_nothing()
    {
        using var document = Fixture(BankFixtures.IngTransactionsDutch);

        var page = IngTransactions.Read(document, SessionId, AccountId, Iban);

        Assert.DoesNotContain(page.Transactions, IngTransactions.IsDerived);
        Assert.DoesNotContain(page.Transactions, t => t.ExternalId.StartsWith("ing-d-", StringComparison.Ordinal));
    }

    // ING calls a loan it proposed and nobody signed OFFER (#656, read in a production run's notes): no account,
    // whatever the entry states. An agreement with any other status is read as before
    [Fact]
    public void An_agreement_ING_calls_an_offer_is_not_listed_as_an_account()
    {
        const string Payload = """
            {"agreements":[
              {"type":"LOAN","group":"LOAN","status":"OFFER","identifierType":"LOCAL_ID","id":"D1",
               "commercialId":{"type":"NL_CORBANK_ID","value":"D1"},"balance":{"currency":"EUR","value":"0.00"},
               "_links":[{"rel":"self","href":"/v1/agreements/d1"}]},
              {"type":"LOAN","group":"LOAN","status":"offer","identifierType":"LOCAL_ID","id":"D2","_links":[]},
              {"type":"LOAN","group":"LOAN","status":"ACTIVE","identifierType":"LOCAL_ID","id":"R2",
               "commercialId":{"type":"NL_CORBANK_ID","value":"R2"},"balance":{"currency":"EUR","value":"-2713.43"},
               "_links":[{"rel":"transactions","href":"/v1/agreements/r2/transactions"}]}
            ]}
            """;
        using var document = JsonDocument.Parse(Payload);
        var notes = new List<string>();

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf, notes.Add);

        Assert.Equal(["R2"], accounts.Select(a => a.Record.ExternalId));
        Assert.Equal(2, notes.Count);
        Assert.All(notes, note => Assert.Contains("'OFFER'", note, StringComparison.Ordinal));
        Assert.All(notes, note => Assert.DoesNotContain("D1", note, StringComparison.Ordinal));
    }

    // the same offer under a word this reader does not know: a loan with no balance and nothing to open is held back
    // too. A loan that states a balance, or anything to open, stays
    [Fact]
    public void A_loan_that_was_only_offered_is_not_listed_as_an_account()
    {
        const string Payload = """
            {"agreements":[
              {"type":"LOAN","group":"LOAN","status":"OFFERED","identifierType":"LOCAL_ID","id":"D1",
               "commercialId":{"type":"NL_CORBANK_ID","value":"D1"},"productName":"Persoonlijke Lening","_links":[]},
              {"type":"LOAN","group":"LOAN","status":"ACTIVE","identifierType":"LOCAL_ID","id":"R2",
               "commercialId":{"type":"NL_CORBANK_ID","value":"R2"},"balance":{"currency":"EUR","value":"-2713.43"},
               "_links":[{"rel":"transactions","href":"/v1/agreements/r2/transactions"}]},
              {"type":"LOAN","group":"LOAN","status":"ACTIVE","identifierType":"LOCAL_ID","id":"S3",
               "commercialId":{"type":"NL_CORBANK_ID","value":"S3"},
               "_links":[{"rel":"transactions","href":"/v1/agreements/s3/transactions"}]},
              {"type":"CARD","group":"CARD","status":"ACTIVE","identifierType":"LOCAL_ID","id":"C4",
               "commercialId":{"type":"MASKED_PAN","value":"C4"},"_links":[]}
            ]}
            """;
        using var document = JsonDocument.Parse(Payload);
        var notes = new List<string>();

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf, notes.Add);

        Assert.Equal(["R2", "S3", "C4"], accounts.Select(a => a.Record.ExternalId));
        Assert.Equal(-271_343, accounts[0].Record.Balance?.Amount.Value);

        // the note names ING's own status word, so the Lab shows what an offer is called; it names no account
        var note = Assert.Single(notes);
        Assert.Contains("'OFFERED'", note, StringComparison.Ordinal);
        Assert.DoesNotContain("D1", note, StringComparison.Ordinal);
    }

    // the agreement list replaced three endpoints: ING fetches savings and cards on the statement screen only when its
    // picker is switched, so the other route reported an own savings account unreachable
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

        // ING Punten (LOYALTY, 1420 PTS) is not an account: carrying it adds points to euros
        Assert.DoesNotContain(accounts, a => a.Record.ExternalId == "0000001");
        Assert.DoesNotContain(accounts, a => a.Record.Currency == "PTS");
    }

    // 8.20 must be 820 by either route; the card has none, which is ING: /credit-cards/cards carries no amount and the
    // list omits the balance object for a card; a zero would read as a settled card
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

        Assert.Equal("EUR", accounts[2].Record.Currency);
    }

    // the naming rules must match across both routes: the statement screen is the fallback, and a name that depends on
    // the call read republishes the account
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

        // the key a page of transactions is tied back to, or the history is filed under nothing
        Assert.Equal(Agreement, viaAgreements.AgreementId);
        Assert.Equal(viaEndpoint.AgreementId, viaAgreements.AgreementId);
    }

    // only savings use productName, identical in both languages; displayAlias is the holder's own nickname; a
    // translated name would change the content hash and republish the account
    [Fact]
    public void Only_the_savings_product_is_named_by_a_word_rather_than_a_number()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal(
            [Iban, "Oranje Spaarrekening", "900012345678", "700000000009"],
            accounts.Select(a => a.Record.DisplayName));

        // the fixture holds the holder's name, the translated card label and the savings nickname: none may land on a
        // record
        Assert.DoesNotContain(accounts, a => a.Record.DisplayName.Contains("Oorbeeld", StringComparison.Ordinal));
        Assert.DoesNotContain(accounts, a => a.Record.DisplayName == "Creditcard Extra");
        Assert.DoesNotContain(accounts, a => a.Record.DisplayName == "Nieuwe keuken");
    }

    // the loan states its contract number in commercialId under another type: an IBAN only when type says IBAN
    [Fact]
    public void A_commercial_id_that_is_not_an_iban_is_not_filed_as_one()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal([Iban, "NL02INGB0009876543", null, null], accounts.Select(a => a.Record.Iban));

        Assert.Equal("700000000009", accounts[3].Record.ExternalId);
    }

    // the agreement id only matches transactions to an account: taken only for UUID (the card was LOCAL_ID), a
    // collision would file transactions under the wrong account invisibly
    [Fact]
    public void A_local_id_is_never_mistaken_for_an_agreement_uuid()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal(
            [Agreement, "66666666-7777-8888-9999-000000000000", null, null],
            accounts.Select(a => a.AgreementId));
    }

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

        // the stated currency, uppercased to ISO-4217, not the euro every fixture happens to be in
        Assert.Equal("USD", account.Record.Currency);
        Assert.Equal("USD", account.Record.Balance!.Amount.Currency);
    }

    // string or number, in one session: /accounts/current sends "-1730.01", savings 8.2; a string-only reader reports
    // a card with no balance; 8.2 because (long)(GetDouble() * 100) answers 819
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

    // a balance that is there but unreadable is told apart from one never sent: only the first is this connector's
    // fault
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

        Assert.DoesNotContain("24995", note, StringComparison.Ordinal);
    }

    // a card has no balance in the agreement list by design and the adapter reads it from the card's own resource
    // afterwards: a note would contradict the final figure
    [Fact]
    public void An_agreement_ing_states_no_balance_for_is_not_reported_as_a_problem()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var notes = new List<string>();

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf, notes.Add);

        Assert.Null(accounts[2].Record.Balance);
        Assert.Empty(notes);
    }

    // the self link is the only route to a credit card's balance
    [Fact]
    public void An_agreement_carries_the_link_to_its_own_resource()
    {
        using var document = Fixture(BankFixtures.IngAgreements);

        var accounts = IngAccounts.ReadAgreements(document, SessionId, AsOf);

        Assert.Equal("/nl/agreements/900012345678/carddetails", accounts[2].SelfPath);

        Assert.DoesNotContain(accounts, a => a.SelfPath == "/agreementpreferences/900012345678");
    }

    // type and group agreed on all seven observed agreements, so ING's preference is not established: the narrower
    // name wins and group is the fallback
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

    // an unknown product is listed as Unknown, not dropped: a misfiled account is easier to notice than a missing one
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
