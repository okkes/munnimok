using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using RegistryConnector.Adapters.Bkr;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// fixture structure captured live 2026-08-04, history invented; keeps every shape that yields wrong data quietly:
// hidden #pdf-export block, rows twice (once per tab), "EUR 2.000" = two thousand, revolving credit without end
// dates, "Geen bijzonderheden gemeld" = no arrears code
public sealed partial class BkrParsingTests
{
    private static readonly BkrOptions Options = new();

    [GeneratedRegex("list-group-item contract")]
    private static partial Regex ContractRow { get; }

    private static string Overview() => Fixture.Read("bkr/overview.html");

    private static IReadOnlyList<CreditRegistration> Credits() =>
        BkrCreditParser.Parse(Overview(), Options, "ses_test");

    // the portal renders the "Alles" and "Lopend" tabs into one page: visible rows appear twice, so counting them gives
    // ten credits for five and doubled sums
    [Fact]
    public void Each_credit_is_read_once_even_though_the_page_lists_it_twice()
    {
        var html = Overview();

        Assert.Equal(2, ContractRow.Count(html));

        var credits = Credits();

        Assert.Equal(4, credits.Count);
        Assert.Equal(credits.Count, credits.Select(c => c.ExternalId).Distinct(StringComparer.Ordinal).Count());
    }

    // keyed on BKR's contract number, not the list's GUID: a re-issued GUID would duplicate every credit
    [Fact]
    public void A_credit_is_keyed_on_the_registers_own_contract_number()
    {
        Assert.Equal(
            ["R10000001", "R10000002", "R10000003", "R10000004"],
            Credits().Select(c => c.ExternalId));

        Assert.DoesNotContain(Credits(), c => c.ExternalId.Contains('-', StringComparison.Ordinal));
    }

    // "EUR 2.000" is two thousand; a dot read as decimal gives two and nothing downstream can tell (a register states no lines)
    [Fact]
    public void A_dot_is_a_thousands_separator_and_never_a_decimal_point()
    {
        var revolving = Assert.Single(Credits(), c => c.ExternalId == "R10000001");

        Assert.Equal(200_000, revolving.Amount.Value);   // EUR 2.000,00 in cents
        Assert.Equal("EUR", revolving.Amount.Currency);

        var small = Assert.Single(Credits(), c => c.ExternalId == "R10000002");
        Assert.Equal(99_600, small.Amount.Value);        // EUR 996,00
    }

    [Fact]
    public void Dutch_credit_types_are_mapped_and_the_registers_own_words_ride_along()
    {
        var credits = Credits();

        var revolving = Assert.Single(credits, c => c.ExternalId == "R10000001");
        Assert.Equal(CreditKind.Revolving, revolving.Kind);
        Assert.Equal("Doorlopend krediet", revolving.KindLabel);

        var instalment = Assert.Single(credits, c => c.ExternalId == "R10000002");
        Assert.Equal(CreditKind.Instalment, instalment.Kind);
        Assert.Equal("Aflopend krediet", instalment.KindLabel);
    }

    // status only from an actual end date ("Werkelijke einddatum"), never expected end vs today:
    // that would report live debt as finished
    [Fact]
    public void A_credit_is_ended_only_when_the_register_states_an_actual_end_date()
    {
        var credits = Credits();

        var running = Assert.Single(credits, c => c.ExternalId == "R10000002");
        Assert.Equal(CreditStatus.Running, running.Status);

        Assert.Equal(new DateOnly(2028, 1, 15), running.EndsOn);

        // expected end 2022 and no actual end: a loan past its term, still owed and running
        var overdue = Assert.Single(credits, c => c.ExternalId == "R10000004");
        Assert.Equal(CreditStatus.Running, overdue.Status);
        Assert.Equal(new DateOnly(2022, 3, 1), overdue.EndsOn);
        Assert.True(overdue.EndsOn < DateOnly.FromDateTime(DateTime.UtcNow), "the fixture's expected end must be in the past");

        var ended = Assert.Single(credits, c => c.ExternalId == "R10000003");
        Assert.Equal(CreditStatus.Ended, ended.Status);
        Assert.Equal(new DateOnly(2025, 8, 12), ended.EndsOn);
        Assert.Equal(new DateOnly(2023, 3, 1), ended.StartedOn);
    }

    [Fact]
    public void A_credit_with_no_end_dates_states_none()
    {
        var revolving = Assert.Single(Credits(), c => c.ExternalId == "R10000001");

        Assert.Equal(CreditStatus.Running, revolving.Status);
        Assert.Null(revolving.EndsOn);
        Assert.Equal(new DateOnly(2025, 10, 23), revolving.StartedOn);
    }

    // "Geen bijzonderheden gemeld" is the absence of an arrears code, not a code
    [Fact]
    public void An_arrears_code_is_verbatim_and_no_arrears_is_null()
    {
        var credits = Credits();

        var flagged = Assert.Single(credits, c => c.ExternalId == "R10000003");
        Assert.Equal("A2", flagged.ArrearsCode);

        Assert.All(
            credits.Where(c => c.ExternalId != "R10000003"),
            c => Assert.Null(c.ArrearsCode));
    }

    [Fact]
    public void The_consumers_own_record_is_read_from_the_page_that_has_no_credit_on_it()
    {
        Assert.Equal("T. Testpersoon", BkrCreditParser.ProfileOf(Overview(), Options));
    }

    // dead session and rebuilt portal look alike (bounce to B2C, no print block): only the URL separates them; BKR has no
    // refresh token, so an expired session an hour after connect is normal
    [Fact]
    public void Landing_back_on_the_sign_in_page_is_an_expired_session()
    {
        var adapter = new BkrAdapter(Options);

        var expired = Assert.Throws<ConnectorException>(() => adapter.Credits(
            "https://login.mijnkredietregistratie.nl/bkrconsp.onmicrosoft.com/oauth2/v2.0/authorize?...",
            "<html><body>Inloggen</body></html>",
            "ses_test"));

        Assert.Equal(ErrorCode.SessionExpired, expired.Code);
        Assert.NotEqual(ErrorCode.ProviderChanged, expired.Code);

        // a portal page with no print block is a changed provider, which is why the URL check is load-bearing
        var changed = Assert.Throws<ConnectorException>(() => adapter.Credits(
            "https://portaal.mijnkredietregistratie.nl/",
            "<html><body>something else</body></html>",
            "ses_test"));

        Assert.Equal(ErrorCode.ProviderChanged, changed.Code);
    }

    [Fact]
    public void A_signed_in_page_is_parsed_through_the_same_seam()
    {
        var credits = new BkrAdapter(Options).Credits(
            "https://portaal.mijnkredietregistratie.nl/", Overview(), "ses_test");

        Assert.Equal(4, credits.Count);
    }

    // falling back to the visible list would silently switch to a source with no dates and double rows
    [Fact]
    public void A_page_without_the_print_block_is_a_provider_change()
    {
        var error = Assert.Throws<ConnectorException>(
            () => BkrCreditParser.Parse("<html><body>signed out</body></html>", Options, "ses_test"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("pdf-export", error.Detail, StringComparison.Ordinal);
    }

    // an empty register is an answer only when the page says so, never from a parser that quietly stopped matching
    [Fact]
    public void An_empty_register_is_an_answer_only_when_the_page_says_so()
    {
        const string block = """<div id="pdf-export"><div class="pdf-page"><h5>Uw kredietoverzicht</h5></div></div>""";

        var refused = Assert.Throws<ConnectorException>(
            () => BkrCreditParser.Parse(block, Options, "ses_test"));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);

        var stated = BkrCreditParser.Parse(
            block + "<p>U heeft geen kredieten geregistreerd staan.</p>", Options, "ses_test");

        Assert.Empty(stated);
    }

    [Fact]
    public void A_credit_missing_its_amount_is_a_provider_change_and_never_a_zero()
    {
        const string html = """
            <div id="pdf-export"><div class="pdf-page">
              <div class="info-item"><div class="label">Overeenkomstnummer</div><div class="value">R1</div></div>
              <div class="info-item"><div class="label">Aanbieder</div><div class="value">Testbank</div></div>
            </div></div>
            """;

        var error = Assert.Throws<ConnectorException>(() => BkrCreditParser.Parse(html, Options, "ses_test"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("Bedrag", error.Detail, StringComparison.Ordinal);
    }

    // a refusal names the field and length, never the debt or contract: notes are logged, written to the job row and returned
    [Fact]
    public void An_unreadable_amount_is_refused_without_quoting_it_or_the_contract()
    {
        const string html = """
            <div id="pdf-export"><div class="pdf-page">
              <div class="info-item"><div class="label">Overeenkomstnummer</div><div class="value">R7654321</div></div>
              <div class="info-item"><div class="label">Aanbieder</div><div class="value">Testbank</div></div>
              <div class="info-item"><div class="label">Bedrag</div><div class="value">twaalfduizend euro</div></div>
            </div></div>
            """;

        var error = Assert.Throws<ConnectorException>(() => BkrCreditParser.Parse(html, Options, "ses_test"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);

        Assert.Contains("Bedrag", error.Detail, StringComparison.Ordinal);
        Assert.Contains("18 character", error.Detail, StringComparison.Ordinal);

        Assert.DoesNotContain("twaalfduizend", error.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("R7654321", error.Detail, StringComparison.Ordinal);
    }
}
