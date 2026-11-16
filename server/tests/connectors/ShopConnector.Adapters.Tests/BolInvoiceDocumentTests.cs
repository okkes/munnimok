using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using ShopConnector.Adapters.Bol;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// recorded live 2026-08-06: the overview has no invoice reference, so ids come from the per-order details page,
// which renders one invoice anchor while the others live only in a script payload (captured order: 3 invoices, 1 shown)
public sealed partial class BolInvoiceDocumentTests
{
    private const string OrderReference = "A000TEST001";

    private const string Details =
        "https://www.bol.com/nl/nl/account/bestellingen/details/A000TEST001/";

    private static string Pdf(string invoiceId) =>
        $"https://www.bol.com/nl/rnwy/invoice/pdf?i={invoiceId}";

    [GeneratedRegex("<a[^>]+facturen/details/")]
    private static partial Regex InvoiceAnchor();

    [GeneratedRegex("facturen/details/[0-9]")]
    private static partial Regex InvoicePath();

    // BolDocuments reads the raw body, not the DOM: an element walk finds the one anchor and loses the other two
    [Fact]
    public void Every_invoice_is_found_even_though_only_one_is_rendered()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        Assert.Single(InvoiceAnchor().Matches(page));

        var links = BolDocuments.Parse(page, new BolOptions());

        Assert.Equal(
            ["3915700000001", "3915700000002", "3915700000003"],
            links.Select(l => l.InvoiceId));
    }

    // the account nav and footer link /facturen: a pattern anchored on the word instead of the path would attach them
    [Fact]
    public void The_account_and_footer_facturen_links_are_not_invoices()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        // a decoy sits right before a 16-digit help-article id: that adjacency is what makes a word-anchored pattern fail
        Assert.Contains("href=\"/nl/nl/rnwy/account/facturen\"", page, StringComparison.Ordinal);
        Assert.Contains(
            "<a href=\"/nl/nl/rnwy/account/facturen\">Al mijn facturen</a>\n" +
            "  <a href=\"/nl/nl/klantenservice/a/5715110588841984/",
            page.Replace("\r\n", "\n", StringComparison.Ordinal),
            StringComparison.Ordinal);

        Assert.Equal(
            ["3915700000001", "3915700000002", "3915700000003"],
            BolDocuments.Parse(page, new BolOptions()).Select(l => l.InvoiceId));
    }

    // help-article and product ids are 16 digits, invoice ids 13: a digit-run pattern would return an article as an invoice
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

    // the ?paid filter's URL shape drops the rnwy segment: pinning the pattern to the common shape loses it
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

    // the anchored invoice is also in the script payload: without a dedupe, one extra download per order
    [Fact]
    public void An_invoice_listed_twice_is_one_document()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");

        Assert.Equal(4, InvoicePath().Count(page));

        Assert.Equal(3, BolDocuments.Parse(page, new BolOptions()).Count);
    }

    [Fact]
    public void An_order_with_nothing_shipped_yields_no_invoice_and_no_error()
    {
        Assert.Empty(BolDocuments.Parse(
            FixtureCatalog.Read("bol/order-details-no-invoice.html"), new BolOptions()));
    }

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

        // byte-exact: a PDF read as text and re-encoded opens to nothing; the live capture holds that corruption
        Assert.Equal(pdf, Convert.FromBase64String(first.ContentBase64));
    }

    // bol sends application/pdf;charset=UTF-8: comparing the raw header would reject every invoice
    [Fact]
    public async Task Bols_charset_on_a_binary_document_is_not_a_rejection()
    {
        var handler = Handler(Stub.FixtureBytes("bol/invoice.pdf"), contentType: "application/pdf;charset=UTF-8");

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.NotEmpty(result.Receipts.Single(r => r.ExternalId == OrderReference).Documents);
    }

    // login.bol.com/wsp sits in passwordForgottenUrl on a healthy page: guarding with the ordinary login markers
    // would report session_expired every time
    [Fact]
    public async Task A_password_forgotten_link_is_not_an_expired_session()
    {
        var page = FixtureCatalog.Read("bol/order-details.html");
        Assert.Contains("login.bol.com/wsp", page, StringComparison.Ordinal);

        var handler = Handler(Stub.FixtureBytes("bol/invoice.pdf"));

        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), CancellationToken.None);

        Assert.Equal(3, result.Receipts.Single(r => r.ExternalId == OrderReference).Documents.Count);
    }

    // a real login form must still end the fetch: a marker set too narrow turns a dead session into a silent zero
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

    // the media type is bol's claim, the first bytes are the file's
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

    // the magic number alone would pass this, so the media-type check needs it: a document labelled as a web page
    // is a change in bol's behaviour and is not accepted
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

    // a failed document costs only itself, not a fetch that already read every order
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

        // half a megabyte per order is not fetched and then discarded
        Assert.DoesNotContain(handler.Requests, r => r.Path.Contains("/details/", StringComparison.Ordinal));
        Assert.DoesNotContain(handler.Requests, r => r.Path.Contains("/invoice/pdf", StringComparison.Ordinal));
    }

    // bltgh is the page's own analytics value, never in bol's href builder: sending a scraped one reports a click nobody made
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

    [Fact]
    public void The_catalogue_offers_invoices_alongside_raw()
    {
        var include = BolManifest.Build()
            .Resource("receipts")!
            .Params.Single(p => p.Key == ResourceRequest.IncludeParam);

        // unlike Amazon, raw stays: bol's is a real JSON payload, not a scraped page (the kit's contract)
        Assert.Equal(["items", "raw", "invoice"], include.Values);
    }

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
