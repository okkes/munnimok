using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// amazon.nl, offline.
///
/// There is no API to stub on this provider - three independently maintained
/// projects all scrape HTML because no JSON consumer endpoint exists - so
/// every test below runs against a recorded PAGE: the Dutch order list, the
/// print invoice, and each of the walls Amazon puts in front of them. Nothing
/// here opens a socket or starts a browser.
///
/// The suite is weighted towards the two things that fail SILENTLY. Money,
/// because the best public reference turns "€ 12,50" into 1250.0 and does not
/// throw; and locale, because that same reference cannot read a Dutch month
/// name and hands back a null date rather than an error. Both produce output
/// that looks entirely reasonable.
/// </summary>
public sealed class AmazonAdapterTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 28, 2, 0, 0, TimeSpan.Zero);

    private static readonly AmazonOptions Options = new();

    private const string Year2026Page1 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

    private const string Year2026Page2 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=10";

    // The three orders the recorded list pages hold, in the order the walk
    // meets them. Substituted numbers over real markup - see the fixtures.
    private const string OrderOne = "402-1122334-5566778";
    private const string OrderTwo = "402-2233445-6677889";
    private const string OrderThree = "402-3344556-7788990";

    private const string Print = "https://www.amazon.nl/gp/css/summary/print.html?orderID=";

    private const string Invoice402 = Print + OrderOne;
    private const string Invoice403 = Print + OrderTwo;
    private const string Invoice404 = Print + OrderThree;

    private static AmazonAdapter Adapter(AmazonOptions? options = null) =>
        new(options ?? Options, new FixedTimeProvider(Now));

    // ---- the manifest ------------------------------------------------------

    [Fact]
    public void Manifest_validates()
    {
        // The validator refuses a bad manifest at startup, so a manifest that
        // cannot boot the host must not pass the suite either.
        ManifestValidator.Validate(Adapter().Describe());
    }

    [Fact]
    public void Manifest_admits_what_this_provider_actually_is()
    {
        var manifest = Adapter().Describe();

        Assert.Equal("amazon-nl", manifest.Id);
        Assert.Equal("NL", manifest.Country);

        // Browser or nothing: there is no consumer API to fall back to.
        Assert.Equal(ProviderRuntime.BrowserInteractive, manifest.Runtime);
        Assert.True(manifest.Agent.Required, "a browser runtime cannot run inline");
        Assert.Equal("residential", manifest.Agent.Egress?.Kind);

        // Desktop, and it is load-bearing rather than cosmetic. The agent
        // emulates a phone by default, and amazon.nl's mobile sign-in does not
        // submit in a containerised headed Chromium: no request is made at all,
        // by a click or by Enter, with the password sitting correctly in the
        // field. The same run without device emulation posts immediately. Four
        // live sign-ins were spent before that was reproduced in the container.
        Assert.True(manifest.Agent.DesktopBrowser, "amazon.nl's mobile sign-in does not submit");

        // The load-bearing admission. Amazon's WAF and ACIC walls are
        // interactive widgets, which means a human at the browser or nothing;
        // claiming unattended operation would make the consuming app offer
        // scheduled syncing and then fail it at three in the morning.
        Assert.False(manifest.UnattendedFetch, "a wall can arrive with nobody watching");
        Assert.False(manifest.Auth.Session.Refreshable, "the credential is a cookie jar with no refresh grant");
        Assert.False(manifest.Auth.Reauth.Cheap);
        Assert.Equal(SecretCustody.Client, manifest.SecretCustody);

        // Three, each for a different wall. LiveView is the one that matters:
        // a correct password from a pooled browser lands on Amazon's
        // verification flow rather than on the order list, so streaming the
        // page to its owner is the normal path here and not the fallback.
        Assert.Contains(ChallengeType.LiveView, manifest.Auth.Challenges);
        Assert.Contains(ChallengeType.MfaCode, manifest.Auth.Challenges);
        Assert.Contains(ChallengeType.Image, manifest.Auth.Challenges);

        // AppApproval is gone. It was this manifest saying "a widget passed in
        // the browser in front of somebody", which a consumer renders as
        // "approve it in the app" - an instruction about a window the user
        // cannot see, for a puzzle that has no app behind it.
        Assert.DoesNotContain(ChallengeType.AppApproval, manifest.Auth.Challenges);
    }

    [Fact]
    public void Manifest_asks_for_a_password_and_never_for_the_second_factor()
    {
        var fields = Adapter().Describe().Auth.AllFields().ToList();

        var password = Assert.Single(fields, f => f.Type == FieldType.Password);
        Assert.True(password.Secret, "a password that is not marked secret is logged and screenshotted");

        // The reference library accepts a TOTP shared secret and auto-solves
        // Amazon's one-time code with it. A service holding both factors has
        // not connected to an account on somebody's behalf; it has taken the
        // account over. The code is relayed to the human instead.
        Assert.DoesNotContain(fields, f =>
            f.Key.Contains("otp", StringComparison.OrdinalIgnoreCase)
            || f.Key.Contains("totp", StringComparison.OrdinalIgnoreCase)
            || f.Key.Contains("secret", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void The_order_url_leaves_the_storefront_in_dutch_unless_an_operator_says_otherwise()
    {
        // azad appends &language=en_GB on every non-English storefront to dodge
        // locale parsing. We do not have the problem it solves - our unit is
        // declared and our parser reads Dutch - and the parameter is
        // unverified on .nl, so the default must not depend on it.
        var plain = Adapter().OrdersUrl(2026, 0);

        Assert.Equal(Year2026Page1, plain);
        Assert.DoesNotContain("language", plain, StringComparison.Ordinal);

        // It is still one edit away, because a live run may find Dutch
        // rendering has a shape the parser cannot read.
        var forced = Adapter(Options with { LanguageOverride = "en_GB" }).OrdersUrl(2026, 10);
        Assert.Contains("language=en_GB", forced, StringComparison.Ordinal);
        Assert.Contains("startIndex=10", forced, StringComparison.Ordinal);
    }

    // ---- money: the trap ---------------------------------------------------

    [Theory]
    // The reference's own worst case. re.sub("[a-zA-Z$£€₹,]+", "", "€ 12,50")
    // is "1250", and float("1250") is a hundred times the real order.
    [InlineData("€ 12,50", 1_250)]
    [InlineData("€ 1.234,56", 123_456)]
    [InlineData("EUR 1.234,56", 123_456)]
    // English rendering, which is what a forced language would produce.
    [InlineData("€1,234.56", 123_456)]
    [InlineData("€ 0,00", 0)]
    [InlineData("-€ 9,99", -999)]
    [InlineData("€ -9,99", -999)]
    // Whole euros with grouping and no cents. Handed to the kit's parser alone
    // this reads as one thousandth of the real figure - see the test below,
    // which pins that.
    [InlineData("€ 1.234", 123_400)]
    [InlineData("€ 1,234", 123_400)]
    public void Dutch_amounts_are_read_as_major_units_in_euros(string rendered, long expectedMinorUnits)
    {
        var money = AmazonMoney.Parse(rendered, MoneyUnit.MajorString, "EUR", "total", Options);

        Assert.Equal(expectedMinorUnits, money.Value);
        Assert.Equal("EUR", money.Currency);
    }

    [Fact]
    public void The_grouping_guard_is_the_one_thing_the_kit_cannot_decide_alone()
    {
        // With both separators present the kit resolves the string perfectly:
        // whichever comes last is the decimal point.
        Assert.Equal(123_456, MoneyParser.ToMinor("1.234,56", MoneyUnit.MajorString));
        Assert.Equal(123_456, MoneyParser.ToMinor("1,234.56", MoneyUnit.MajorString));

        // With ONE separator it reads that separator as a decimal point, which
        // is right for "12,50" and a factor of a thousand out for a whole-euro
        // amount written with grouping. That is not a bug in the kit - the
        // string really is ambiguous - it is why the adapter resolves the
        // shape before handing the digits over.
        Assert.Equal(123, MoneyParser.ToMinor("1.234", MoneyUnit.MajorString));
        Assert.Equal(123_400, AmazonMoney.Parse("€ 1.234", MoneyUnit.MajorString, "EUR", "total", Options).Value);
    }

    [Fact]
    public void The_declared_unit_governs_and_is_never_inferred_from_the_value()
    {
        // The same string, two declarations, two answers. Nothing about "1234"
        // says which it is, which is exactly why the field declares it and the
        // parser never guesses.
        Assert.Equal(123_400, AmazonMoney.Parse("€ 1234", MoneyUnit.MajorString, "EUR", "t", Options).Value);
        Assert.Equal(1_234, AmazonMoney.Parse("€ 1234", MoneyUnit.Minor, "EUR", "t", Options).Value);

        // And the one this adapter declares for every field it reads. Amazon
        // publishes no number anywhere; every amount is a rendered currency
        // string in major units.
        Assert.Equal(MoneyUnit.MajorString, Options.OrderTotalUnit);
        Assert.Equal(MoneyUnit.MajorString, Options.ItemAmountUnit);
        Assert.Equal(MoneyUnit.MajorString, Options.InvoiceTotalUnit);
        Assert.Equal(MoneyUnit.MajorString, Options.DiscountAmountUnit);
        Assert.Equal("EUR", Options.Currency);
    }

    [Theory]
    [InlineData("$ 12.50")]
    [InlineData("£ 12.50")]
    [InlineData("USD 1,234.56")]
    public void An_amount_in_another_currency_stops_the_parse_instead_of_becoming_euros(string rendered)
    {
        // amazon.nl bills in EUR and the currency is declared, never inferred
        // from a symbol - "$" is at least four different currencies. Recording
        // a dollar figure as euros is the silent kind of wrong.
        var error = Assert.Throws<ConnectorException>(
            () => AmazonMoney.Parse(rendered, MoneyUnit.MajorString, "EUR", "order total", Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("another currency", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_hyphen_in_a_label_does_not_turn_a_charge_into_a_credit()
    {
        // "Btw-bedrag" and "Actie-korting" both contain a hyphen. Scanning the
        // whole line for one subtracts the tax and leaves the discount correct
        // by luck, and the receipt still looks perfectly plausible.
        var tax = AmazonMoney.Row("Btw-bedrag: € 214,26", MoneyUnit.MajorString, "EUR", "t", Options);
        Assert.Equal(21_426, tax.Amount?.Value);
        Assert.Equal("Btw-bedrag", tax.Label);

        var discount = AmazonMoney.Row("Actie-korting: -€ 9,99", MoneyUnit.MajorString, "EUR", "t", Options);
        Assert.Equal(-999, discount.Amount?.Value);
        Assert.Equal("Actie-korting", discount.Label);
    }

    // ---- dates and offsets -------------------------------------------------

    [Fact]
    public void A_dutch_month_name_is_read_and_carries_a_real_amsterdam_offset()
    {
        // dateutil.parser.parse(..., fuzzy=True) - what the reference uses -
        // does not know "mei" and returns None, so the order silently loses
        // its date.
        var summer = AmazonDate.Parse("Besteld op 14 mei 2026", RetailZones.Dutch, "order date");
        var winter = AmazonDate.Parse("Besteld op 3 januari 2026", RetailZones.Dutch, "order date");

        Assert.Equal(new DateTimeOffset(2026, 5, 14, 0, 0, 0, TimeSpan.FromHours(2)), summer);
        Assert.Equal(new DateTimeOffset(2026, 1, 3, 0, 0, 0, TimeSpan.FromHours(1)), winter);

        // Never a bare date. A near-midnight purchase read in the agent's own
        // zone lands on the wrong day for anybody running outside CET, and a
        // receipt matched to the wrong day is worse than one not matched.
        Assert.Equal(TimeSpan.FromHours(2), summer.Offset);
        Assert.Equal(TimeSpan.FromHours(1), winter.Offset);
    }

    [Theory]
    [InlineData("12 mei 2026", 2026, 5, 12)]
    [InlineData("12 May 2026", 2026, 5, 12)]
    [InlineData("May 12, 2026", 2026, 5, 12)]
    [InlineData("2 maart 2026", 2026, 3, 2)]
    [InlineData("28 augustus 2025", 2025, 8, 28)]
    [InlineData("1 okt. 2025", 2025, 10, 1)]
    [InlineData("2026-05-12", 2026, 5, 12)]
    public void Both_languages_are_read_so_the_language_switch_changes_nothing(
        string rendered, int year, int month, int day)
    {
        var parsed = AmazonDate.Parse(rendered, RetailZones.Dutch, "order date");

        Assert.Equal(new DateOnly(year, month, day), DateOnly.FromDateTime(parsed.Date));
    }

    [Fact]
    public void An_unreadable_date_is_a_shape_change_and_not_a_null()
    {
        var error = Assert.Throws<ConnectorException>(
            () => AmazonDate.Parse("Besteld op ergens", RetailZones.Dutch, "order date"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    // ---- the order list ----------------------------------------------------

    /// <summary>
    /// The order list, out of markup amazon.nl actually served on 2026-08-05.
    ///
    /// The values are substituted - names, addresses, order numbers, products -
    /// and every attribute, class and label the parser reads is the real
    /// thing. That distinction is the whole point of the fixture: the version
    /// of this test that came before it passed against invented markup, while
    /// the live page had no <c>.yohtmlc-order-date</c> on it at all.
    /// </summary>
    [Fact]
    public void The_dutch_order_list_parses_into_summaries()
    {
        var rows = AmazonOrderParser.ParseList(Dom("orders-2026-p1"), Options, RetailZones.Dutch);

        Assert.Equal(2, rows.Count);

        Assert.Equal("402-1122334-5566778", rows[0].Id);
        Assert.Equal(2_598, rows[0].Total?.Value);
        Assert.Equal("EUR", rows[0].Total?.Currency);

        // "21 juni 2026", read in Dutch, at Amsterdam's summer offset.
        Assert.Equal(new DateTimeOffset(2026, 6, 21, 0, 0, 0, TimeSpan.FromHours(2)), rows[0].PurchasedAt);
        Assert.Equal(
            "https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1122334-5566778",
            rows[0].InvoiceUrl);

        Assert.Equal("402-2233445-6677889", rows[1].Id);
    }

    /// <summary>
    /// The id comes out of the card's own slot attribute, and the widget name
    /// wrapped around it does not come with it.
    ///
    /// <c>data-csa-c-slot-id="amzn1.yourorders.order-card.402-…"</c> is the
    /// sturdiest identifier on the page - it outlives every class name - and
    /// taking the attribute whole gives every receipt an external id with a
    /// widget prefix glued to the front. Which dedupes against itself
    /// perfectly, looks completely stable, and matches nothing.
    /// </summary>
    [Fact]
    public void An_order_id_is_the_number_inside_the_attribute_not_the_attribute()
    {
        var rows = AmazonOrderParser.ParseList(Dom("orders-2026-p1"), Options, RetailZones.Dutch);

        Assert.All(rows, row =>
        {
            Assert.Matches(@"^\d{3}-\d{7}-\d{7}$", row.Id);
            Assert.DoesNotContain("amzn1", row.Id, StringComparison.Ordinal);
        });
    }

    /// <summary>
    /// The date and the total are found by their LABEL, because the four facts
    /// in a card's header are identical <c>li</c> elements and nothing else
    /// separates them. The fixture proves the labels are there; this proves
    /// they are what is being read, by removing the only other candidate.
    /// </summary>
    [Fact]
    public void The_header_is_read_by_its_labels_and_not_by_its_layout()
    {
        var blind = Options with
        {
            OrderDateSelectors = ["#nothing-date"],
            OrderTotalSelectors = ["#nothing-total"],
        };

        var rows = AmazonOrderParser.ParseList(Dom("orders-2026-p1"), blind, RetailZones.Dutch);

        Assert.Equal(2_598, rows[0].Total?.Value);
        Assert.Equal(new DateTimeOffset(2026, 6, 21, 0, 0, 0, TimeSpan.FromHours(2)), rows[0].PurchasedAt);
    }

    /// <summary>
    /// A card that states no total is a fact about that order, not a shape
    /// change.
    ///
    /// This used to fail the whole fetch, and on a real account it did: one
    /// order in nineteen had no "Totaal" in its header, so every receipt in
    /// every year was thrown away over a single card. The order is kept and
    /// its total comes from the invoice, which states one.
    /// </summary>
    [Fact]
    public void A_card_that_states_no_total_is_carried_rather_than_fatal()
    {
        var rows = AmazonOrderParser.ParseList(Dom("orders-missing-total"), Options, RetailZones.Dutch);

        var row = Assert.Single(rows);
        Assert.Null(row.Total);

        // Everything else about it still resolved, which is what makes the
        // order worth keeping.
        Assert.NotEqual(string.Empty, row.Id);
        Assert.NotEqual(default, row.PurchasedAt);
    }

    /// <summary>
    /// And the invoice is opened for such an order even when the caller asked
    /// for NO items.
    ///
    /// Without the total from the card there is no total at all, so the choice
    /// is one extra page for one odd order or no receipt for it. The order is
    /// the point: dropping a purchase because its card was unusual is the
    /// silent data loss this whole adapter is written against.
    /// </summary>
    [Fact]
    public async Task An_order_with_no_card_total_still_gets_one_from_its_invoice()
    {
        var pages = new StubAmazonPages
        {
            [Year2026Page1] = "orders-missing-total",
            ["https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1234567-1234567"] = "invoice-402",
        };

        using var ctx = new FakeJobContext { Material = Material() };

        // items: false - so the ONLY reason to open an invoice is the missing
        // total, which is exactly what this pins.
        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31), items: false),
            pages, wall: null, redirects: null, CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);

        // The invoice's own Eindtotaal, since the card stated nothing.
        Assert.Equal(2_598, receipt.Total.Value);

        // And no items, because none were asked for: the invoice was opened for
        // its total and nothing else.
        Assert.Empty(receipt.Items);

        Assert.Contains(pages.Opened, url => url.Contains("print.html", StringComparison.Ordinal));
    }

    /// <summary>
    /// A cancelled order is not a receipt, and its empty invoice is not a
    /// shape change.
    ///
    /// This is what the missing total on a real account turned out to BE.
    /// Amazon cancels an order, states no total on its card because nothing was
    /// charged, and serves an invoice carrying one sentence - "Deze bestelling
    /// is geannuleerd" - with no lines and no charge summary. Read as a
    /// redesign, that failed every receipt in every year.
    /// </summary>
    [Fact]
    public async Task A_cancelled_order_is_skipped_rather_than_reported_or_failed()
    {
        var pages = new StubAmazonPages
        {
            [Year2026Page1] = "orders-missing-total",
            ["https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1234567-1234567"] = "invoice-cancelled",
        };

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        // No receipt, and no error: nothing was bought.
        Assert.Empty(result.Receipts);
        Assert.True(result.Complete);
    }

    [Fact]
    public void A_cancelled_invoice_is_recognised_and_a_real_one_is_not()
    {
        Assert.True(AmazonOrderParser.IsCancelled(Dom("invoice-cancelled"), Options));

        Assert.False(AmazonOrderParser.IsCancelled(Dom("invoice-402"), Options));
        Assert.False(AmazonOrderParser.IsCancelled(Dom("invoice-two-items"), Options));
    }

    /// <summary>
    /// The marker is the whole sentence, and this is why.
    ///
    /// "Geannuleerd" on its own also appears on a LIVE order where one item was
    /// cancelled and the rest shipped. Matching the bare word would skip that
    /// order and lose a real purchase - silently, which is the failure mode
    /// this adapter exists to avoid. Asserted rather than asserted-in-a-comment:
    /// the bare word passes every other test in this file.
    /// </summary>
    [Fact]
    public void An_order_with_one_cancelled_item_is_still_a_purchase()
    {
        var page = AmazonFixture.Page("invoice-402").Html.Replace(
            "<div id=\"a-page\">",
            "<div id=\"a-page\"><div class=\"a-row\"><span>Geannuleerd: 1 artikel</span></div>",
            StringComparison.Ordinal);

        var dom = HtmlParser.Parse(page);

        // The word really is on the page.
        Assert.Contains("Geannuleerd", page, StringComparison.Ordinal);

        Assert.False(AmazonOrderParser.IsCancelled(dom, Options));

        // And it still parses into the purchase it is.
        var invoice = AmazonOrderParser.ParseInvoice(dom, Options);
        Assert.Single(invoice.Items);
        Assert.Equal(2_598, invoice.StatedTotal?.Value);
    }

    /// <summary>
    /// But a total that IS stated and cannot be read is still a shape change.
    ///
    /// The distinction is the whole point: absent means "this order has no
    /// total", unreadable means "the number we are about to use has changed
    /// meaning", and only the second one is a reason to stop.
    /// </summary>
    [Fact]
    public void A_total_that_is_stated_and_unreadable_still_stops_everything()
    {
        var page = AmazonFixture.Page("orders-2026-p1").Html
            .Replace("&euro;&nbsp;25,98", "twenty-five ninety-eight", StringComparison.Ordinal)
            .Replace("€&nbsp;25,98", "twenty-five ninety-eight", StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(
            () => AmazonOrderParser.ParseList(HtmlParser.Parse(page), Options, RetailZones.Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("no readable total", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void Pagination_stops_where_the_page_says_it_stops()
    {
        Assert.True(AmazonOrderParser.HasNextPage(Dom("orders-2026-p1"), Options));

        // The last page still renders a "Vorige" anchor carrying startIndex=.
        // Reading any such anchor as "next" costs one extra request per year
        // against a site that challenges when it is bored.
        Assert.False(AmazonOrderParser.HasNextPage(Dom("orders-2026-p2"), Options));
    }

    // ---- the print invoice -------------------------------------------------

    /// <summary>
    /// The print invoice, out of the page amazon.nl actually serves.
    ///
    /// It was a table when this adapter was written. It is not one now: it is
    /// built from <c>data-component</c> attributes, and every selector aimed at
    /// a <c>tr.item-row</c> matched nothing on the live page while this suite
    /// went on passing against markup nobody serves.
    /// </summary>
    [Fact]
    public void The_print_invoice_parses_into_lines_and_charges()
    {
        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-402"), Options);

        // One product, and no synthetic lines: postage is €0,00 on this order
        // and the BTW row decomposes the total rather than adding to it.
        var item = Assert.Single(invoice.Items);

        Assert.Equal("Testartikel een", item.Name);
        Assert.Equal(1_299, item.UnitPrice?.Value);

        // The quantity badge, which is the trap on this page - see below.
        Assert.Equal(2m, item.Quantity);
        Assert.Equal(2_598, item.Total.Value);

        Assert.Equal("card", invoice.Payment.Method);
        Assert.Equal("4242", invoice.Payment.CardLast4);
        Assert.Equal(2_598, invoice.StatedTotal?.Value);
    }

    /// <summary>
    /// The quantity is not where the page says it is.
    ///
    /// Every line carries an EMPTY <c>[data-component='quantity']</c>, whatever
    /// the quantity is. The number a human sees is a badge drawn over the
    /// thumbnail, and it is absent altogether when the quantity is one.
    ///
    /// A parser trusting the obvious element reads every line as quantity one,
    /// which halves a two-pack's total and then fails reconciliation against an
    /// order total that was right all along.
    /// </summary>
    [Fact]
    public void A_quantity_comes_from_the_badge_because_the_quantity_element_is_empty()
    {
        var dom = Dom("invoice-402");

        // The decoy really is in the fixture, and really is empty.
        var decoy = HtmlQuery.First(dom, "[data-component='quantity']");
        Assert.NotNull(decoy);
        Assert.Equal(string.Empty, decoy.Text().Trim());

        Assert.Equal(2m, Assert.Single(AmazonOrderParser.ParseInvoice(dom, Options).Items).Quantity);

        // And with only the decoy to read, the line falls back to one rather
        // than to nothing - which is right for THIS page, because Amazon omits
        // the badge on single items, and is the reason the fallback is not
        // covering a parse failure.
        var blind = Options with { InvoiceItemQuantitySelectors = ["[data-component='quantity']"] };
        Assert.Equal(1m, Assert.Single(AmazonOrderParser.ParseInvoice(dom, blind).Items).Quantity);
    }

    /// <summary>
    /// An order with two products yields two lines, each with its own price.
    /// The single-item invoice cannot show this: one block and a repeated block
    /// look identical when there is only one.
    /// </summary>
    [Fact]
    public void Every_purchased_line_becomes_its_own_item()
    {
        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-two-items"), Options);

        Assert.Equal(2, invoice.Items.Count);
        Assert.Equal(["Testartikel een", "Testartikel twee"], invoice.Items.Select(i => i.Name));

        // Prices differ per line, so neither is the other's echo.
        Assert.Equal(2_299, invoice.Items[0].UnitPrice?.Value);
        Assert.Equal(2_199, invoice.Items[1].UnitPrice?.Value);
    }

    /// <summary>
    /// A shipment is not a line.
    ///
    /// <c>[data-component='purchasedItems']</c> appears ONCE per shipment
    /// however many products are in it, and it is the obvious thing to treat as
    /// the row. Doing so collapses a two-product order into one item priced at
    /// the first - a receipt that looks completely normal and is missing goods.
    /// </summary>
    [Fact]
    public void A_shipment_holding_two_products_is_not_read_as_one_line()
    {
        var dom = Dom("invoice-two-items");

        // One shipment block, two items inside it. Both facts are the page's.
        Assert.Single(HtmlQuery.All(dom, "[data-component='purchasedItems']"));
        Assert.Equal(2, HtmlQuery.All(dom, "[data-component='itemTitle']").Count);

        Assert.Equal(2, AmazonOrderParser.ParseInvoice(dom, Options).Items.Count);

        // And with the shipment itself as the row - the mistake - the second
        // product simply disappears.
        var collapsed = Options with { InvoiceItemRowSelectors = ["[data-component='purchasedItems']"] };
        Assert.Single(AmazonOrderParser.ParseInvoice(dom, collapsed).Items);
    }

    /// <summary>
    /// Amazon renders every price TWICE inside <c>span.a-price</c> - once for a
    /// screen reader and once, aria-hidden, for everyone else. The text of the
    /// container therefore reads "€22,99€22,99".
    ///
    /// Asserted BOTH ways on purpose. The options prefer the inner
    /// <c>.a-offscreen</c> span, and removing that preference changes nothing -
    /// the money parser takes the first amount it finds and is right either
    /// way. So this pins the property that actually holds, rather than
    /// crediting a selector for a robustness that lives somewhere else.
    /// </summary>
    [Fact]
    public void A_doubled_price_is_read_once_however_it_is_selected()
    {
        var dom = Dom("invoice-two-items");

        // The doubling is in the fixture, because it is in the page.
        var price = HtmlQuery.First(dom, "[data-component='unitPrice']");
        Assert.NotNull(price);
        Assert.Equal(
            "€22,99€22,99",
            HtmlText.Normalize(price.Text()).Replace(" ", string.Empty, StringComparison.Ordinal));

        Assert.Equal(2_299, AmazonOrderParser.ParseInvoice(dom, Options).Items[0].UnitPrice?.Value);

        // The whole container, doubling and all.
        var blunt = Options with { InvoiceItemPriceSelectors = ["[data-component='unitPrice']"] };
        Assert.Equal(2_299, AmazonOrderParser.ParseInvoice(dom, blunt).Items[0].UnitPrice?.Value);
    }

    /// <summary>
    /// Postage is called "Porto- en verpakkingskosten" on this storefront, and
    /// the shipping labels held no word that appears in it - so a real postage
    /// charge was categorised as Unknown and dropped from the receipt.
    ///
    /// Invisible on the captured orders, which were all free delivery. On an
    /// order with postage it removes money the customer paid, and the receipt
    /// then fails to reconcile by exactly that amount.
    /// </summary>
    [Fact]
    public void Dutch_postage_is_recognised_as_shipping()
    {
        Assert.Equal(
            AmazonTotalKind.Shipping,
            AmazonOrderParser.Categorize("Porto- en verpakkingskosten:", Options));

        // The charge reaches the receipt as a line, under the register's own
        // words, once it is non-zero.
        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-402"), Options);
        Assert.DoesNotContain(invoice.Items, item => item.Name.Contains("Porto", StringComparison.Ordinal));
    }

    /// <summary>
    /// "Totaal" and "Eindtotaal" are different claims: what the order came to,
    /// and what was actually charged. They diverge the moment a gift card pays
    /// part of it, and they were equal on every captured order - which is the
    /// condition under which preferring the wrong one goes unnoticed.
    /// </summary>
    [Fact]
    public void The_stated_total_is_what_was_charged()
    {
        Assert.Equal(AmazonTotalKind.FinalTotal, AmazonOrderParser.Categorize("Eindtotaal:", Options));
        Assert.Equal(AmazonTotalKind.GrandTotal, AmazonOrderParser.Categorize("Totaal:", Options));

        // And "Totaal excl. btw" is neither, though it contains "totaal".
        Assert.Equal(AmazonTotalKind.TotalBeforeTax, AmazonOrderParser.Categorize("Totaal excl. btw:", Options));
    }

    [Fact]
    public void The_btw_row_decomposes_the_total_and_is_never_added_to_it()
    {
        // A Dutch consumer price is quoted including BTW, so the invoice's tax
        // row explains the total rather than adding to it. Emitting it as a
        // line would double-count the VAT on every single receipt - and the
        // receipt would still look like a receipt.
        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-402"), Options);

        Assert.DoesNotContain(invoice.Items, item => item.Name.Contains("Btw", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(invoice.Items, item => item.Name.Contains("vóór", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(invoice.Items,
            item => item.Name.Contains("Subtotaal", StringComparison.OrdinalIgnoreCase));

        // A switch rather than an assumption, because whether Amazon ever
        // renders a tax-exclusive breakdown is unconfirmed.
        var exclusive = AmazonOrderParser.ParseInvoice(
            Dom("invoice-402"), Options with { TaxIsIncludedInItemPrices = false });

        Assert.Contains(exclusive.Items, item => item.Name.Equals("Btw", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Artikelen (Subtotaal)", "Subtotal")]
    [InlineData("Subtotaal", "Subtotal")]
    [InlineData("Totaal vóór btw", "TotalBeforeTax")]
    [InlineData("Btw", "Tax")]
    [InlineData("Verzendkosten", "Shipping")]
    [InlineData("Actiekorting", "Promotion")]
    [InlineData("Cadeaubon", "GiftCard")]
    [InlineData("Totaal", "GrandTotal")]
    [InlineData("Grand Total", "FinalTotal")]
    public void Label_priority_keeps_the_subtotal_from_becoming_the_total(string label, string expected)
    {
        // "subtotaal" CONTAINS "totaal" and "totaal vóór btw" CONTAINS "btw".
        // One contains-match against one list files both of them wrongly, and
        // the receipt then reconciles against a number that is not its total.
        Assert.Equal(expected, AmazonOrderParser.Categorize(label, Options).ToString());
    }

    // ---- the whole fetch ---------------------------------------------------

    [Fact]
    public async Task A_year_of_dutch_orders_becomes_normalized_receipts()
    {
        var pages = OrderPages();
        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.True(result.Complete);
        Assert.Equal("orders-html+print-invoice", result.Via);
        Assert.Equal(3, result.Receipts.Count);

        var first = result.Receipts[0];
        Assert.Equal(OrderOne, first.ExternalId);
        Assert.Equal(new DateTimeOffset(2026, 6, 21, 0, 0, 0, TimeSpan.FromHours(2)), first.PurchasedAt);
        Assert.Equal(2_598, first.Total.Value);
        Assert.Equal("EUR", first.Total.Currency);
        Assert.Equal("amazon-nl", first.Merchant.Id);
        Assert.Equal("card", first.Payment?.Method);
        Assert.Equal("4242", first.Payment?.CardLast4);

        // One product, bought twice. Postage is €0,00 and the BTW row
        // decomposes the total rather than adding to it, so neither becomes a
        // line of its own.
        var only = Assert.Single(first.Items);
        Assert.Equal(2m, only.Quantity);
        Assert.Equal(2_598, only.Total.Value);

        // The one redundancy Amazon gives us, spent: the list card stated the
        // total, the invoice stated the lines, and they agree. Every fixture
        // pairs a card with the invoice for THAT order, so this is a real
        // check rather than two copies of one number.
        Assert.True(first.Reconciled, "the invoice lines must sum to the total the list card stated");
        Assert.All(result.Receipts, receipt => Assert.True(receipt.Reconciled));

        // The two-product order, which is the case a single-item invoice
        // cannot distinguish from a shipment read as one line.
        Assert.Equal(2, result.Receipts[1].Items.Count);
        Assert.Equal(4_498, result.Receipts[1].Total.Value);

        // Newest first, with a real offset on every one of them.
        DateOnly[] days = [new(2026, 6, 21), new(2026, 6, 2), new(2026, 3, 6)];
        Assert.Equal(days, result.Receipts.Select(r => DateOnly.FromDateTime(r.PurchasedAt.Date)));
        Assert.All(result.Receipts, receipt => Assert.NotEqual(TimeSpan.Zero, receipt.PurchasedAt.Offset));

        // Idempotency is not optional; a re-run must not duplicate.
        Assert.All(result.Receipts, receipt => Assert.NotEqual(string.Empty, receipt.ContentHash));
        Assert.Equal(3, result.Receipts.Select(r => r.Id).Distinct(StringComparer.Ordinal).Count());

        string[] expected =
        [
            Year2026Page1, Year2026Page2, Invoice402, Invoice403, Invoice404,
        ];

        Assert.Equal(expected, pages.Opened);
    }

    // Raw_hands_back_the_invoice_it_read_and_only_when_asked lived here, and
    // passed, for a feature that should never have shipped.
    //
    // It asserted the print page came back under include=raw, which it did -
    // 222KB of live Amazon markup per order, under 3% of it visible text. Raw
    // means the payload a record was DERIVED from, so a shape change can be
    // diagnosed; on a provider with an API that is a JSON object worth keeping,
    // and here it was a page carrying Amazon's analytics scripts. The kit's own
    // contract said so before any of it was written: an adapter "that scraped a
    // page... leaves it empty rather than inventing a shape".
    //
    // The test was not wrong about the code. It was faithful to a decision that
    // was wrong, which is the harder kind to notice - so what replaced it is in
    // AmazonInvoiceDocumentTests: raw comes back EMPTY on this provider now,
    // and include=invoice hands over the PDF Amazon actually issues.

    [Fact]
    public async Task Without_items_no_invoice_is_ever_opened()
    {
        var pages = OrderPages();
        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31), items: false),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.Equal("orders-html", result.Via);
        Assert.Equal(3, result.Receipts.Count);
        Assert.All(result.Receipts, receipt => Assert.Empty(receipt.Items));
        Assert.DoesNotContain(pages.Opened, url => url.Contains("print.html", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_receipt_that_does_not_reconcile_is_flagged_and_never_dropped()
    {
        // The invoice is internally consistent and one line short of what the
        // order list said the order cost. Nothing on the page looks wrong.
        var pages = OrderPages();
        pages.Replace(Invoice403, "invoice-403-short");

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        var shortened = Assert.Single(
            result.Receipts, r => string.Equals(r.ExternalId, OrderTwo, StringComparison.Ordinal));

        Assert.False(shortened.Reconciled);
        Assert.Equal(4_498, shortened.Total.Value);                         // the list card's figure is kept
        Assert.NotEqual(4_498, shortened.Items.Sum(item => item.Total.Value));

        // Still emitted. Dropping it would hide a real purchase; trusting it
        // silently would hand over a total we know disagrees with its lines.
        Assert.Equal(3, result.Receipts.Count);
    }

    [Fact]
    public async Task An_empty_year_is_an_empty_answer_and_not_an_error()
    {
        var pages = new StubAmazonPages
        {
            ["https://www.amazon.nl/your-orders/orders?timeFilter=year-2025&startIndex=0"] = "orders-2025-empty",
        };

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2025, 1, 1), Requests.Day(2025, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.Empty(result.Receipts);
        Assert.True(result.Complete);
    }

    [Fact]
    public async Task A_redesigned_list_is_a_shape_change_and_never_an_empty_history()
    {
        // The most believable wrong answer this adapter could give is "you have
        // bought nothing". An expired card selector and a genuinely empty year
        // must not look alike.
        var pages = new StubAmazonPages { [Year2026Page1] = "orders-redesigned" };

        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("empty-history notice", error.Detail, StringComparison.Ordinal);
        Assert.Contains("js-order-card", error.Detail, StringComparison.Ordinal);
    }

    // ---- bot protection ----------------------------------------------------

    [Theory]
    [InlineData("blocked-403")]
    [InlineData("blocked-429")]
    public async Task Bot_protection_statuses_are_blocked_by_provider_and_never_a_credential_problem(string fixture)
    {
        // 429 matters most here. The platform's default reading of it is
        // rate_limited - retriable, "wait a moment" - and from a bot wall that
        // is wrong in the dangerous direction: retrying into it is how a
        // working session gets escalated to a hard block.
        var pages = new StubAmazonPages { [Year2026Page1] = fixture };

        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.NotEqual(ErrorCode.RateLimited, error.Code);
    }

    [Theory]
    [InlineData("challenge-acic", "Interactive")]
    [InlineData("challenge-waf", "Interactive")]
    [InlineData("captcha-image", "Image")]
    [InlineData("blocked-403", "HttpFailure")]
    [InlineData("blocked-429", "HttpFailure")]
    [InlineData("signin", "SignIn")]
    [InlineData("orders-2026-p1", "Ok")]
    public void Every_wall_amazon_serves_is_recognised_for_what_it_is(string fixture, string expected)
    {
        var page = AmazonFixture.Page(fixture);

        Assert.Equal(expected, AmazonGuard.Inspect(page, HtmlParser.Parse(page.Html), Options).Kind.ToString());
    }

    [Fact]
    public async Task An_unattended_agent_refuses_a_widget_at_once_and_nobody_is_asked()
    {
        // Nobody can reach a headless browser in a pool, so there is nothing to
        // wait for. Saying so immediately is what lets a consumer tell the user
        // to connect this one from a machine they are sitting at - and it is
        // the failure that hanging until the job budget expires replaces.
        var pages = new StubAmazonPages { [Year2026Page1] = "challenge-acic" };

        using var ctx = new FakeJobContext { Material = Material(), Attended = false };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Empty(ctx.Asked);
    }

    [Fact]
    public async Task An_attended_browser_is_asked_to_pass_the_widget_and_the_page_is_read_again()
    {
        // The only honest way past an ACIC puzzle: the person sitting at the
        // browser passes it themselves. Nothing is solved here and no solving
        // service is called - the reference ships three, we ship none - and the
        // proof that the wall came down is that the same URL reads as order
        // history on the next attempt.
        var pages = OrderPages();
        pages.Once(Year2026Page1, "challenge-acic");

        var wall = AmazonStubPage.Showing("#aa-challenge-page-captcha-container");
        using var ctx = new FakeJobContext
        {
            Material = Material(),
            Attended = true,
            Browser = new AmazonStubBrowser(wall),
            Answer = _ => string.Empty,
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall, new StubRedirectWaiter(null, int.MaxValue), CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.AppApproval, asked.Type);
        Assert.True(asked.IsPassive, "there is nothing for the human to type back at a widget");
        Assert.Equal(3, result.Receipts.Count);

        // Asked once and only once: a wall that is still standing on the retry
        // ends the job instead of looping on a human who already tried.
        Assert.Equal(2, pages.Opened.Count(url => url == Year2026Page1));
    }

    [Fact]
    public async Task Landing_on_the_sign_in_chain_during_a_fetch_is_a_dead_session()
    {
        var pages = new StubAmazonPages { [Year2026Page1] = "signin" };

        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        // Not invalid_credentials: no credential was submitted during a fetch,
        // and there is nothing for the user to correct except reconnecting.
        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    [Fact]
    public async Task A_fetch_with_no_browser_state_asks_for_a_new_login_rather_than_guessing()
    {
        using var ctx = new FakeJobContext { Material = new SessionMaterial() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1)), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.False(ctx.Browser.Started, "no browser is worth starting for a session that is not there");
    }

    [Fact]
    public async Task An_unknown_resource_is_refused_before_anything_is_opened()
    {
        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = "invoices" }, CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
    }

    // ---- the session marker ------------------------------------------------

    /// <summary>
    /// The cookie that decides a login worked - on THIS storefront.
    ///
    /// The list was <c>["x-main"]</c>, described as confirmed from the
    /// reference's own constants. It was confirmed for amazon.COM. The Dutch
    /// site suffixes its cookies with its marketplace - x-acbnl, at-acbnl,
    /// sess-at-acbnl - and never sets x-main at all, so a login that worked
    /// completely, puzzle passed and order list on screen, was thrown away at
    /// the last gate for lacking a cookie this storefront does not have.
    /// </summary>
    [Fact]
    public void A_real_signed_in_jar_is_recognised_on_this_storefront()
    {
        Assert.True(AmazonCookies.HasAny(
            FixtureCatalog.Read("amazon/storage-state.json"), Options.AuthCookieNames));

        Assert.DoesNotContain("x-main", Options.AuthCookieNames[0], StringComparison.Ordinal);
    }

    /// <summary>
    /// And the far more dangerous direction: a jar from a visit that never
    /// signed in.
    ///
    /// amazon.nl hands an anonymous visitor session-id, ubid-acbnl, lc-acbnl
    /// and sst-acbnl before anybody types anything. Any of those in the list
    /// would seal a bundle for a login that FAILED - a connection that looks
    /// healthy and can never fetch a receipt, which is worse than the bug this
    /// replaced. Both jars were captured live on 2026-08-06.
    /// </summary>
    [Fact]
    public void An_anonymous_jar_is_refused_however_many_cookies_it_carries()
    {
        var anonymous = FixtureCatalog.Read("amazon/storage-state-anonymous.json");

        // It really is a full jar - this is not an empty-string test.
        Assert.Contains("ubid-acbnl", anonymous, StringComparison.Ordinal);
        Assert.Contains("sst-acbnl", anonymous, StringComparison.Ordinal);
        Assert.Contains("session-token", anonymous, StringComparison.Ordinal);

        Assert.False(AmazonCookies.HasAny(anonymous, Options.AuthCookieNames));
    }

    [Fact]
    public void A_jar_we_cannot_read_is_one_we_cannot_vouch_for()
    {
        Assert.False(AmazonCookies.HasAny(
            """{"cookies":[{"name":"session-id","value":"x"}]}""", Options.AuthCookieNames));

        Assert.False(AmazonCookies.HasAny("not json at all", Options.AuthCookieNames));
        Assert.False(AmazonCookies.HasAny(null, Options.AuthCookieNames));
    }

    // ---- helpers -----------------------------------------------------------

    private static HtmlNode Dom(string fixture) => HtmlParser.Parse(AmazonFixture.Page(fixture).Html);

    private static SessionMaterial Material() =>
        new() { StorageState = FixtureCatalog.Read("amazon/storage-state.json") };

    private static StubAmazonPages OrderPages() => new()
    {
        [Year2026Page1] = "orders-2026-p1",
        [Year2026Page2] = "orders-2026-p2",
        [Invoice402] = "invoice-402",
        [Invoice403] = "invoice-two-items",
        [Invoice404] = "invoice-third",
    };
}
