using System.Text;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.Support;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// include=raw returned the 222KB print page, not a payload: raw is gone and the invoice PDF replaces it
/// routes confirmed live 2026-08-06; fixtures are those captures with order numbers and document ids substituted
public sealed class AmazonInvoiceDocumentTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 28, 2, 0, 0, TimeSpan.Zero);

    private const string Year2026Page1 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

    private const string Year2026Page2 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=10";

    private const string Print = "https://www.amazon.nl/gp/css/summary/print.html?orderID=";

    private const string OrderOne = "402-1122334-5566778";
    private const string OrderTwo = "402-2233445-6677889";
    private const string OrderThree = "402-3344556-7788990";

    /// the list URL is the one the order page wrote, token included: a hand-built one came back empty
    private static string ListUrl(string orderId) =>
        $"/your-orders/invoice/popover?orderId={orderId}" +
        "&relatedRequestId=ZBXE1QKG0BNG18GHP5E3&ref_=fed_invoice_ajax";

    private static string DocUrl(int n) =>
        $"/documents/download/{n:D8}-0000-4000-8000-{n:D12}/invoice.pdf";

    /// the selector is a path, not a label: "Factuur aanvragen" is a support form that starts with the same word
    [Fact]
    public void An_invoice_list_yields_the_document_and_neither_decoy()
    {
        var links = AmazonOrderParser.ParseDocuments(Fragment("invoice-list-one"), new AmazonOptions());

        var only = Assert.Single(links);
        Assert.Equal("/documents/download/00000001-0000-4000-8000-000000000001/invoice.pdf", only.Href);
        Assert.Equal("Factuur", only.Label);
    }

    /// Amazon issues one invoice per shipment (one in ten orders had four): a scalar invoice field drops documents
    [Fact]
    public void An_order_shipped_in_parts_yields_every_invoice_in_order()
    {
        var links = AmazonOrderParser.ParseDocuments(Fragment("invoice-list-four"), new AmazonOptions());

        Assert.Equal(
            [DocUrl(1), DocUrl(2), DocUrl(3), DocUrl(4)],
            links.Select(l => l.Href));

        // the provider's numbering is kept: it names the shipment, "1 of 4" would be a guess
        Assert.Equal(["Factuur 1", "Factuur 2", "Factuur 3", "Factuur 4"], links.Select(l => l.Label));
    }

    /// some lists have no "request an invoice" link: the parser must not depend on that row
    [Fact]
    public void A_list_without_the_request_link_still_yields_its_document()
    {
        var links = AmazonOrderParser.ParseDocuments(Fragment("invoice-list-no-request"), new AmazonOptions());

        Assert.Single(links);
        Assert.Contains("/documents/download/", links[0].Href, StringComparison.Ordinal);
    }

    /// the &amp; decoding is the tokenizer's, not the parser's: decoding twice would corrupt a URL containing "&amp;amp;"
    [Fact]
    public void The_list_url_is_read_off_the_card_and_entity_decoded()
    {
        var rows = AmazonOrderParser.ParseList(
            Dom("orders-2026-p1"), new AmazonOptions(), RetailZones.Dutch);

        var first = rows[0];
        Assert.NotNull(first.DocumentsUrl);
        Assert.Contains("/your-orders/invoice/popover", first.DocumentsUrl, StringComparison.Ordinal);
        Assert.Contains($"orderId={first.Id}", first.DocumentsUrl, StringComparison.Ordinal);

        // an undecoded &amp; makes a parameter named "amp;relatedRequestId", which Amazon ignores
        Assert.Contains("&relatedRequestId=", first.DocumentsUrl, StringComparison.Ordinal);
        Assert.DoesNotContain("&amp;", first.DocumentsUrl, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Asking_for_invoices_attaches_the_pdf_to_the_receipt()
    {
        var pages = OrderPages()
            .Fragment(ListUrl(OrderOne), "invoice-list-one")
            .Document(DocUrl(1), 200, "application/pdf", Pdf(1_024));

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);

        var receipt = result.Receipts.Single(r => r.ExternalId == OrderOne);
        var document = Assert.Single(receipt.Documents);

        Assert.Equal("invoice", document.Kind);
        Assert.Equal("application/pdf", document.MediaType);
        Assert.Equal("Factuur", document.Name);
        Assert.Equal(1_024, document.SizeBytes);

        // a wrong-length base64 is a corrupt download that still renders as a link
        Assert.Equal(Pdf(1_024), Convert.FromBase64String(document.ContentBase64));
    }

    /// the demo client builds exactly this data URL: pinned so a rename on the record does not break download links
    [Fact]
    public async Task The_document_is_one_data_url_away_from_a_download()
    {
        var pages = OrderPages()
            .Fragment(ListUrl(OrderOne), "invoice-list-one")
            .Document(DocUrl(1), 200, "application/pdf", Pdf(64));

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);
        var document = result.Receipts.Single(r => r.ExternalId == OrderOne).Documents[0];

        var href = $"data:{document.MediaType};base64,{document.ContentBase64}";
        Assert.StartsWith("data:application/pdf;base64,", href, StringComparison.Ordinal);

        // Amazon names every document "invoice.pdf": the order number in the filename keeps them apart
        Assert.Equal($"amazon-{OrderOne}-invoice.pdf", document.Filename);
    }

    [Fact]
    public async Task Four_invoices_on_one_order_all_arrive_and_none_share_a_filename()
    {
        var pages = OrderPages().Fragment(ListUrl(OrderTwo), "invoice-list-four");
        for (var n = 1; n <= 4; n++) pages.Document(DocUrl(n), 200, "application/pdf", Pdf(100 + n));

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);
        var receipt = result.Receipts.Single(r => r.ExternalId == OrderTwo);

        Assert.Equal(4, receipt.Documents.Count);
        Assert.Equal([101, 102, 103, 104], receipt.Documents.Select(d => d.SizeBytes));
        Assert.Equal(4, receipt.Documents.Select(d => d.Filename).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task Not_asking_for_invoices_fetches_nothing_and_attaches_nothing()
    {
        var pages = OrderPages();

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: false), pages, null, null, CancellationToken.None);

        Assert.All(result.Receipts, r => Assert.Empty(r.Documents));

        Assert.Empty(pages.Fetched);
    }

    /// an expired session serves an HTML sign-in page at a .pdf URL: the media type, not the extension, decides
    [Fact]
    public async Task A_sign_in_page_wearing_a_pdf_url_is_not_attached()
    {
        var pages = OrderPages()
            .Fragment(ListUrl(OrderOne), "invoice-list-one")
            .Document(DocUrl(1), 200, "text/html", Encoding.UTF8.GetBytes("<html>sign in</html>"));

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);

        Assert.Empty(result.Receipts.Single(r => r.ExternalId == OrderOne).Documents);
    }

    /// Amazon sends application/pdf;charset=UTF-8: an equality check would reject every real invoice
    [Fact]
    public async Task Amazons_charset_on_a_binary_document_is_not_a_rejection()
    {
        var pages = OrderPages()
            .Fragment(ListUrl(OrderOne), "invoice-list-one")
            .Document(DocUrl(1), 200, "application/pdf", Pdf(32));

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);

        Assert.Single(result.Receipts.Single(r => r.ExternalId == OrderOne).Documents);
    }

    /// a document is an extra: failing a fetch that read fifty orders over one PDF trades the answer for a footnote
    [Fact]
    public async Task A_document_that_will_not_download_does_not_fail_the_fetch()
    {
        // the stub throws provider_unavailable for an unrecorded document, like a 500
        var pages = OrderPages().Fragment(ListUrl(OrderOne), "invoice-list-one");

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);
        Assert.Empty(result.Receipts.Single(r => r.ExternalId == OrderOne).Documents);
    }

    [Fact]
    public async Task An_order_whose_invoice_list_cannot_be_read_still_becomes_a_receipt()
    {
        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Wanting(invoice: true), OrderPages(), null, null, CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);
        Assert.All(result.Receipts, r => Assert.Empty(r.Documents));
    }

    /// invoices roughly triple the request count: an unpaced document path would undo pacing where it matters most
    [Fact]
    public async Task Fetching_documents_is_paced_like_everything_else()
    {
        var pacer = new RecordingPacer();
        var pages = OrderPages(pacer).Fragment(ListUrl(OrderTwo), "invoice-list-four");
        for (var n = 1; n <= 4; n++) pages.Document(DocUrl(n), 200, "application/pdf", Pdf(16));

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        _ = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);

        // twelve: 2 list pages, 3 invoices, an invoice list per order (3), 4 documents; empty lists still cost a paced request
        Assert.Equal(12, pacer.Entered);

        Assert.Equal(pacer.Trace.Count(e => e is "open" or "fragment" or "download"), pacer.Entered);
    }

    /// raw is withdrawn: a scraped page is not a provider payload, so the catalogue must not offer it
    [Fact]
    public void The_catalogue_offers_invoices_and_no_longer_offers_raw()
    {
        var include = AmazonManifest.Build()
            .Resource(AmazonAdapter.ReceiptsResource)!
            .Params.Single(p => p.Key == ResourceRequest.IncludeParam);

        Assert.Equal(["items", "invoice"], include.Values);
        Assert.DoesNotContain(ResourceRequest.RawInclude, include.Values!, StringComparer.Ordinal);
    }

    [Fact]
    public async Task Asking_amazon_for_raw_gets_nothing_back_rather_than_a_page()
    {
        var request = Requests.Receipts(
            Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31), items: true, raw: true);

        Assert.True(request.WantsRaw, "the request really does ask for raw");

        using var ctx = new FakeJobContext { Material = Material() };
        var result = await Adapter().FetchAsync(
            ctx, request, OrderPages(), null, null, CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.Empty(result.Raw);
    }

    private static AmazonAdapter Adapter() => new(new AmazonOptions(), new FixedTimeProvider(Now));

    private static HtmlNode Fragment(string fixture) =>
        HtmlParser.Parse(FixtureCatalog.Read($"amazon/{fixture}.html"));

    private static HtmlNode Dom(string fixture) => HtmlParser.Parse(AmazonFixture.Page(fixture).Html);

    private static SessionMaterial Material() =>
        new() { StorageState = FixtureCatalog.Read("amazon/storage-state.json") };

    private static byte[] Pdf(int length)
    {
        var bytes = new byte[length];
        Encoding.ASCII.GetBytes("%PDF-1.4").CopyTo(bytes, 0);
        for (var i = 8; i < length; i++) bytes[i] = (byte)(i % 251);
        return bytes;
    }

    private static ResourceRequest Wanting(bool invoice)
    {
        List<string> include = ["items"];
        if (invoice) include.Add(ResourceRequest.InvoiceInclude);

        return new ResourceRequest
        {
            ResourceId = AmazonAdapter.ReceiptsResource,
            Since = Requests.Day(2026, 1, 1),
            Until = Requests.Day(2026, 12, 31),
            Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                [ResourceRequest.IncludeParam] = include,
            },
        };
    }

    private static StubAmazonPages OrderPages(RecordingPacer? pacer = null) => new()
    {
        Trace = pacer?.Trace,
        [Year2026Page1] = "orders-2026-p1",
        [Year2026Page2] = "orders-2026-p2",
        [Print + OrderOne] = "invoice-402",
        [Print + OrderTwo] = "invoice-two-items",
        [Print + OrderThree] = "invoice-third",
    };
}
