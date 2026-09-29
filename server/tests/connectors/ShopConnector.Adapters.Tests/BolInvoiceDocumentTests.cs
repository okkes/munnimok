using System.Net;
using System.Text;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using ShopConnector.Adapters.Bol;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// The invoice PDF bol issues, carried whole to the consumer.
///
/// Every route here was recorded from a live bol.com session on 2026-08-06,
/// driven by the account's owner, and the fixtures are those captures with the
/// order reference and invoice ids substituted. Two things that recording
/// settled could not have been guessed at, and both are asserted below:
///
/// The orders overview carries NO invoice reference at all, so the ids can only
/// come from a per-order details page. And bol renders only ONE invoice anchor
/// into that page - the one for the item named in the URL - while the order's
/// other invoices live solely inside a script payload. The order captured had
/// THREE invoices and showed one.
/// </summary>
public sealed class BolInvoiceDocumentTests
{
    private const string OrderReference = "A000TEST001";

    private const string Details =
        "https://www.bol.com/nl/nl/account/bestellingen/details/A000TEST001/";

    private static string Pdf(string invoiceId) =>
        $"https://www.bol.com/nl/rnwy/invoice/pdf?i={invoiceId}";

    // ---- the harvest -------------------------------------------------------

    /// <summary>
    /// Three invoices off one order, when the page renders one anchor.
    ///
    /// This is the entire reason <see cref="BolDocuments"/> reads the raw body
    /// rather than the DOM. A reader that walked elements - the obviously
    /// correct instinct, and what every other reader on this adapter does -
    /// would find the first and silently lose the other two, on an order that
    /// really does have three.
    /// </summary>
    [Fact]
    public void Every_invoice_is_found_even_though_only_one_is_rendered()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        // The premise, asserted rather than assumed: one anchor, three ids.
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(page, "<a[^>]+facturen/details/"));

        var links = BolDocuments.Parse(page, new BolOptions());

        Assert.Equal(
            ["3915700000001", "3915700000002", "3915700000003"],
            links.Select(l => l.InvoiceId));
    }

    /// <summary>
    /// The account nav and the footer both link to /facturen. Neither is an
    /// invoice, and a pattern anchored on the word rather than the path would
    /// attach two of them to somebody's receipt.
    /// </summary>
    [Fact]
    public void The_account_and_footer_facturen_links_are_not_invoices()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        // The decoys really are in the fixture, and one of them sits directly
        // in front of a sixteen-digit help-article id. That adjacency is the
        // point: on the real page /facturen appears forty-four times against a
        // dozen such ids, so a pattern anchored on the WORD rather than on the
        // path swallows one as an invoice. Without the adjacency the fixture
        // let that mutation live.
        Assert.Contains("href=\"/nl/nl/rnwy/account/facturen\"", page, StringComparison.Ordinal);
        Assert.Contains(
            "<a href=\"/nl/nl/rnwy/account/facturen\">Al mijn facturen</a>\n" +
            "  <a href=\"/nl/nl/klantenservice/a/5715110588841984/",
            page.Replace("\r\n", "\n", StringComparison.Ordinal),
            StringComparison.Ordinal);

        // Exactly the three, and nothing the decoys dragged in.
        Assert.Equal(
            ["3915700000001", "3915700000002", "3915700000003"],
            BolDocuments.Parse(page, new BolOptions()).Select(l => l.InvoiceId));
    }

    /// <summary>
    /// And the longer numbers on the same page are not invoice ids either.
    ///
    /// bol's order-details page carries sixteen-digit help-article ids and
    /// sixteen-digit product ids against a thirteen-digit invoice id. A pattern
    /// matching a run of digits would hand a customer-service article back as
    /// somebody's invoice.
    /// </summary>
    [Fact]
    public void A_help_article_id_is_not_an_invoice_id()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        Assert.Contains("klantenservice/a/5715110588841984", page, StringComparison.Ordinal);
        Assert.Contains("/nl/nl/p/een-product/9200000123456789/", page, StringComparison.Ordinal);

        var ids = BolDocuments.Parse(page, new BolOptions()).Select(l => l.InvoiceId).ToList();

        Assert.DoesNotContain("5715110588841984", ids);
        Assert.DoesNotContain("9200000123456789", ids);
    }

    /// <summary>
    /// bol writes the invoice URL two ways, and the ?paid filter's shape drops
    /// the <c>rnwy</c> segment. Pinning the pattern to the common one loses it.
    /// </summary>
    [Fact]
    public void The_paid_filters_url_shape_is_also_an_invoice()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        Assert.Contains(
            "/nl/nl/account/facturen/details/3915700000003/?order_item_id=",
            page,
            StringComparison.Ordinal);

        Assert.Contains(
            "3915700000003",
            BolDocuments.Parse(page, new BolOptions()).Select(l => l.InvoiceId));
    }

    /// <summary>
    /// The one invoice bol renders as an anchor appears in the script payload
    /// too. Without a dedupe that is one extra download and one extra
    /// attachment per order, of the same document.
    /// </summary>
    [Fact]
    public void An_invoice_listed_twice_is_one_document()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        Assert.Equal(
            4,
            System.Text.RegularExpressions.Regex.Matches(page, "facturen/details/[0-9]").Count);

        Assert.Equal(3, BolDocuments.Parse(page, new BolOptions()).Count);
    }

    [Fact]
    public void An_order_with_nothing_shipped_yields_no_invoice_and_no_error()
    {
        Assert.Empty(BolDocuments.Parse(
            FixtureCatalog.Read("bol/order-details-no-invoice.html"), new BolOptions()));
    }

    // ---- the fetch ---------------------------------------------------------

    [Fact]
    public async Task Asking_for_invoices_attaches_the_pdf_to_the_receipt()
    {
        var pdf = Stub.FixtureBytes("bol/invoice.pdf");
        var handler = Handler(pdf);

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);
        var receipt = result.Receipts.Single(r => r.ExternalId == OrderReference);

        Assert.Equal(3, receipt.Documents.Count);

        var first = receipt.Documents[0];
        Assert.Equal("invoice", first.Kind);
        Assert.Equal("application/pdf", first.MediaType);
        Assert.Equal($"bol-{OrderReference}-invoice-3915700000001.pdf", first.Filename);
        Assert.Equal(pdf.Length, first.SizeBytes);

        // Byte-exact, not merely "something arrived". A PDF read as text and
        // re-encoded still looks like a file and opens to nothing - the live
        // capture contains exactly that corruption, seven thousand replacement
        // characters deep.
        Assert.Equal(pdf, Convert.FromBase64String(first.ContentBase64));
    }

    /// <summary>
    /// bol sends <c>application/pdf;charset=UTF-8</c> - a charset on a binary
    /// file. Comparing the raw header rather than the parsed media type rejects
    /// every invoice bol has, and it is the likeliest way to copy Amazon's
    /// adapter wrongly.
    /// </summary>
    [Fact]
    public async Task Bols_charset_on_a_binary_document_is_not_a_rejection()
    {
        var handler = Handler(Stub.FixtureBytes("bol/invoice.pdf"), contentType: "application/pdf;charset=UTF-8");

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.NotEmpty(result.Receipts.Single(r => r.ExternalId == OrderReference).Documents);
    }

    /// <summary>
    /// The trap this whole path had to be built around.
    ///
    /// bol's account pages carry <c>login.bol.com/wsp</c> once, inside
    /// <c>passwordForgottenUrl</c> - on a page that is working perfectly. The
    /// adapter's ordinary login markers include that host, so guarding a
    /// document fetch with them reports <c>session_expired</c> every single
    /// time and sends a human off to sign in again for nothing.
    /// </summary>
    [Fact]
    public async Task A_password_forgotten_link_is_not_an_expired_session()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");
        Assert.Contains("login.bol.com/wsp", page, StringComparison.Ordinal);

        var handler = Handler(Stub.FixtureBytes("bol/invoice.pdf"));

        using var ctx = Context(handler);

        // No throw, and the documents arrive.
        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.Equal(3, result.Receipts.Single(r => r.ExternalId == OrderReference).Documents.Count);
    }

    /// <summary>
    /// And the other direction, which matters just as much: a REAL login form
    /// on that page still has to end the fetch. A marker set so narrow it
    /// matches nothing would turn a dead session into a silent zero.
    /// </summary>
    [Fact]
    public async Task A_real_login_form_on_the_details_page_is_still_an_expired_session()
    {
        var handler = new StubHttpHandler((request, _) =>
            request.Path.Contains("/details/", StringComparison.Ordinal)
                ? Stub.Page(FixtureCatalog.Read("bol/order-details-loggedout.html"))
                : Stub.Fixture("bol/orders-graphql.json"));

        using var ctx = Context(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    /// <summary>
    /// A 200 that is not a PDF by its own first bytes is not a PDF, whatever
    /// its content type says. The media type is bol's claim; this is the file's.
    /// </summary>
    [Fact]
    public async Task A_two_hundred_that_is_not_a_pdf_by_its_own_bytes_is_not_attached()
    {
        var handler = Handler(Encoding.UTF8.GetBytes("<html><body>not a pdf at all</body></html>"));

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.Empty(result.Receipts.Single(r => r.ExternalId == OrderReference).Documents);
    }

    [Fact]
    public async Task A_sign_in_page_wearing_a_pdf_url_is_not_attached()
    {
        var handler = Handler(Encoding.UTF8.GetBytes("<html>sign in</html>"), contentType: "text/html");

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.Empty(result.Receipts.Single(r => r.ExternalId == OrderReference).Documents);
    }

    /// <summary>
    /// And the case that keeps BOTH checks honest: real PDF bytes, served under
    /// a media type bol has never used for them.
    ///
    /// The magic number alone would wave this through, so without this test the
    /// media-type check is dead weight - a mutation removing it survived until
    /// this existed. It is refused rather than accepted because bol answering a
    /// document request with a document it labels as a web page is a change in
    /// how bol behaves, and quietly accepting it is how a connector ends up
    /// carrying whatever a provider starts serving next.
    /// </summary>
    [Fact]
    public async Task Real_pdf_bytes_under_a_media_type_bol_never_uses_are_still_refused()
    {
        var pdf = Stub.FixtureBytes("bol/invoice.pdf");
        Assert.Equal("%PDF-"u8.ToArray(), pdf.Take(5));

        var handler = Handler(pdf, contentType: "text/html;charset=UTF-8");

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.Empty(result.Receipts.Single(r => r.ExternalId == OrderReference).Documents);
    }

    /// <summary>
    /// A document that will not download costs its document and nothing else.
    /// Failing a fetch that has already read every order correctly, over one
    /// PDF, trades the whole answer for a footnote.
    /// </summary>
    [Fact]
    public async Task A_document_that_will_not_download_does_not_fail_the_fetch()
    {
        var handler = new StubHttpHandler((request, _) =>
            request.Path.Contains("/invoice/pdf", StringComparison.Ordinal)
                ? Stub.Status(HttpStatusCode.InternalServerError)
                : request.Path.Contains("/details/", StringComparison.Ordinal)
                    ? Stub.Page(FixtureCatalog.Read("bol/order-details.html"))
                    : Stub.Fixture("bol/orders-graphql.json"));

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.Empty(result.Receipts.Single(r => r.ExternalId == OrderReference).Documents);
    }

    [Fact]
    public async Task Not_asking_for_invoices_fetches_nothing_and_attaches_nothing()
    {
        var handler = Handler(Stub.FixtureBytes("bol/invoice.pdf"));

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: false), CancellationToken.None);

        Assert.All(result.Receipts, r => Assert.Empty(r.Documents));

        // Not one details page and not one download. Half a megabyte an order
        // is not something to fetch and then discard.
        Assert.DoesNotContain(handler.Requests, r => r.Path.Contains("/details/", StringComparison.Ordinal));
        Assert.DoesNotContain(handler.Requests, r => r.Path.Contains("/invoice/pdf", StringComparison.Ordinal));
    }

    /// <summary>
    /// The route, exactly, and without the tracking token the browser adds.
    ///
    /// <c>bltgh</c> is the page's own analytics value: bol's href builder never
    /// adds it, and its sibling builder treats it as optional. Sending one we
    /// scraped would be reporting a click nobody made.
    /// </summary>
    [Fact]
    public async Task The_pdf_url_is_the_rnwy_route_and_carries_no_tracking_token()
    {
        var handler = Handler(Stub.FixtureBytes("bol/invoice.pdf"));

        using var ctx = Context(handler);

        _ = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        var asked = handler.Requests.Select(r => r.Uri.AbsoluteUri).Where(u => u.Contains("invoice", StringComparison.Ordinal));

        Assert.Contains(Pdf("3915700000001"), asked);
        Assert.DoesNotContain(handler.Requests, r => r.Uri.AbsoluteUri.Contains("bltgh", StringComparison.Ordinal));
    }

    // ---- the manifest ------------------------------------------------------

    [Fact]
    public void The_catalogue_offers_invoices_alongside_raw()
    {
        var include = BolManifest.Build()
            .Resource("receipts")!
            .Params.Single(p => p.Key == ResourceRequest.IncludeParam);

        // Unlike Amazon, raw STAYS: bol's is a real JSON payload rather than a
        // scraped page, which is exactly the distinction the kit's contract
        // draws.
        Assert.Equal(["items", "raw", "invoice"], include.Values);
    }

    // ---- helpers -----------------------------------------------------------

    private static BolAdapter Adapter() => new(new BolOptions());

    private static StubHttpHandler Handler(byte[] pdf, string contentType = "application/pdf;charset=UTF-8") =>
        new((request, _) =>
            request.Path.Contains("/invoice/pdf", StringComparison.Ordinal)
                ? Stub.Bytes(pdf, contentType)
                : request.Path.Contains("/details/", StringComparison.Ordinal)
                    ? Stub.Page(FixtureCatalog.Read("bol/order-details.html"))
                    : Stub.Fixture("bol/orders-graphql.json"));

    private static FakeJobContext Context(StubHttpHandler handler) => new(handler)
    {
        Material = new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") },
    };

    private static ResourceRequest Wanting(bool invoice)
    {
        List<string> include = ["items"];
        if (invoice) include.Add(ResourceRequest.InvoiceInclude);

        return new ResourceRequest
        {
            ResourceId = "receipts",
            Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                [ResourceRequest.IncludeParam] = include,
            },
        };
    }
}
