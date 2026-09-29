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

/// <summary>
/// The invoice PDF Amazon issues, carried whole to the consumer.
///
/// What this replaced is worth stating, because it was shipped and it was
/// wrong. <c>include=raw</c> handed back the print-invoice page - 222KB of live
/// Amazon markup per order, under 3% of it visible text and the rest layout and
/// analytics - which is what a consumer saw when they opened "the provider's
/// payload". The kit's own contract had already said not to: an adapter "that
/// scraped a page... leaves it empty rather than inventing a shape". So raw is
/// gone from this provider and this is what was actually wanted.
///
/// Every route below was confirmed live on 2026-08-06 against a real account,
/// and the fixtures are those captures with the order numbers and document ids
/// substituted.
/// </summary>
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

    /// <summary>
    /// The AJAX invoice list, at the URL the ORDER PAGE wrote - token and all.
    /// Hand-building this is what made an earlier attempt come back empty.
    /// </summary>
    private static string ListUrl(string orderId) =>
        $"/your-orders/invoice/popover?orderId={orderId}" +
        "&relatedRequestId=ZBXE1QKG0BNG18GHP5E3&ref_=fed_invoice_ajax";

    private static string DocUrl(int n) =>
        $"/documents/download/{n:D8}-0000-4000-8000-{n:D12}/invoice.pdf";

    // ---- the parse ---------------------------------------------------------

    /// <summary>
    /// One order, one invoice: the ordinary case, and the two decoys beside it.
    ///
    /// The fragment holds three links and only the middle one is a file. The
    /// third is "Factuur aanvragen" - REQUEST an invoice, a support form -
    /// which is why the selector is a path and not a label: it starts with the
    /// same word as the real thing, so matching on "Factuur" would hand
    /// somebody a contact page as their invoice.
    /// </summary>
    [Fact]
    public void An_invoice_list_yields_the_document_and_neither_decoy()
    {
        var links = AmazonOrderParser.ParseDocuments(Fragment("invoice-list-one"), new AmazonOptions());

        var only = Assert.Single(links);
        Assert.Equal("/documents/download/00000001-0000-4000-8000-000000000001/invoice.pdf", only.Href);
        Assert.Equal("Factuur", only.Label);
    }

    /// <summary>
    /// And the case that decided the record's shape: one order, four invoices.
    ///
    /// Amazon issues one per SHIPMENT. Of ten consecutive orders on a real
    /// account, eight had a single invoice, one had two and one had four - so a
    /// scalar <c>invoice</c> field would have looked correct on eight of them
    /// and silently dropped five documents across the other two.
    /// </summary>
    [Fact]
    public void An_order_shipped_in_parts_yields_every_invoice_in_order()
    {
        var links = AmazonOrderParser.ParseDocuments(Fragment("invoice-list-four"), new AmazonOptions());

        Assert.Equal(
            [DocUrl(1), DocUrl(2), DocUrl(3), DocUrl(4)],
            links.Select(l => l.Href));

        // The provider's own numbering, kept rather than re-derived: it names
        // the shipment, and inventing "1 of 4" would be a guess at which.
        Assert.Equal(["Factuur 1", "Factuur 2", "Factuur 3", "Factuur 4"], links.Select(l => l.Label));
    }

    /// <summary>
    /// An order whose list has no "request an invoice" link at all. Real, and
    /// present so the parser is never written to depend on that row existing.
    /// </summary>
    [Fact]
    public void A_list_without_the_request_link_still_yields_its_document()
    {
        var links = AmazonOrderParser.ParseDocuments(Fragment("invoice-list-no-request"), new AmazonOptions());

        Assert.Single(links);
        Assert.Contains("/documents/download/", links[0].Href, StringComparison.Ordinal);
    }

    /// <summary>
    /// The list URL comes off the card, entity-decoded, with its token intact.
    ///
    /// Amazon writes the href with <c>&amp;amp;</c> between the parameters, so
    /// the URL that reaches the fetch has to carry a real <c>&amp;</c> - an
    /// undecoded one arrives as a single parameter and the
    /// <c>relatedRequestId</c> the fragment needs is buried inside it.
    ///
    /// The decoding is the TOKENIZER's, not this parser's, which is worth
    /// stating because the parser briefly did it a second time. That looked
    /// like caution and was a latent bug: a URL legitimately containing the
    /// text "&amp;amp;" would have been decoded twice and corrupted. This test
    /// asserts the property of the pipeline rather than the presence of any
    /// particular call, which is why it kept passing when the redundant one was
    /// removed - and why it fails if the real one ever goes.
    /// </summary>
    [Fact]
    public void The_list_url_is_read_off_the_card_and_entity_decoded()
    {
        var rows = AmazonOrderParser.ParseList(
            Dom("orders-2026-p1"), new AmazonOptions(), RetailZones.Dutch);

        var first = rows[0];
        Assert.NotNull(first.DocumentsUrl);
        Assert.Contains("/your-orders/invoice/popover", first.DocumentsUrl, StringComparison.Ordinal);
        Assert.Contains($"orderId={first.Id}", first.DocumentsUrl, StringComparison.Ordinal);

        // The decode itself. "&amp;relatedRequestId" would be a parameter named
        // "amp;relatedRequestId", which Amazon ignores.
        Assert.Contains("&relatedRequestId=", first.DocumentsUrl, StringComparison.Ordinal);
        Assert.DoesNotContain("&amp;", first.DocumentsUrl, StringComparison.Ordinal);
    }

    // ---- the fetch ---------------------------------------------------------

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

        // The bytes survive the round trip intact - not merely "something was
        // attached". A base64 that decodes to the wrong length is a corrupt
        // download that still renders as a link.
        Assert.Equal(Pdf(1_024), Convert.FromBase64String(document.ContentBase64));
    }

    /// <summary>
    /// And a consumer can open it without decoding anything.
    ///
    /// This is the whole point of carrying a media type and a filename beside
    /// the bytes. The demo client builds exactly this string; asserting it here
    /// is what stops a rename on the record from silently breaking every
    /// download link that was built from it.
    /// </summary>
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

        // A filename somebody can find again. Amazon calls every one of these
        // "invoice.pdf", so four documents off one order would otherwise be
        // four files with the same name and no order number on any of them.
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

        // Not one request. A hundred kilobytes an order is not something to
        // fetch and then throw away.
        Assert.Empty(pages.Fetched);
    }

    /// <summary>
    /// A document that is not what it says it is never becomes an attachment.
    ///
    /// The failure this prevents is silent and nasty: a session that expires
    /// between the order list and the download gets an HTML sign-in page from a
    /// URL ending in ".pdf". A connector trusting the extension would hand
    /// somebody a download that opens to nothing, and the receipt beside it
    /// would look perfectly healthy.
    /// </summary>
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

    /// <summary>
    /// Amazon's own <c>application/pdf;charset=UTF-8</c> - a charset on a
    /// binary file, which is wrong of Amazon and not ours to correct, but it
    /// does mean a naive equality check would reject every real invoice.
    /// </summary>
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

    /// <summary>
    /// A document that cannot be fetched costs its document and nothing else.
    ///
    /// An attachment is an extra the caller asked for. Failing a fetch that has
    /// already read fifty orders correctly, because one PDF would not download,
    /// would trade the whole answer for a footnote.
    /// </summary>
    [Fact]
    public async Task A_document_that_will_not_download_does_not_fail_the_fetch()
    {
        // Fragment served, document deliberately not recorded: the stub throws
        // provider_unavailable, exactly as a 500 from Amazon would.
        var pages = OrderPages().Fragment(ListUrl(OrderOne), "invoice-list-one");

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);
        Assert.Empty(result.Receipts.Single(r => r.ExternalId == OrderOne).Documents);
    }

    [Fact]
    public async Task An_order_whose_invoice_list_cannot_be_read_still_becomes_a_receipt()
    {
        // No fragment recorded at all - an order Amazon has no invoice list for.
        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Wanting(invoice: true), OrderPages(), null, null, CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);
        Assert.All(result.Receipts, r => Assert.Empty(r.Documents));
    }

    /// <summary>
    /// Every document request waits its turn, exactly as every page load does.
    ///
    /// Asking for invoices roughly triples the request count for an order - the
    /// list, then a fetch per document - so a document path that skipped the
    /// pacing would undo the pacing on the very option that needs it most.
    /// </summary>
    [Fact]
    public async Task Fetching_documents_is_paced_like_everything_else()
    {
        var pacer = new RecordingPacer();
        var pages = OrderPages(pacer).Fragment(ListUrl(OrderTwo), "invoice-list-four");
        for (var n = 1; n <= 4; n++) pages.Document(DocUrl(n), 200, "application/pdf", Pdf(16));

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        _ = await Adapter().FetchAsync(ctx, Wanting(invoice: true), pages, null, null, CancellationToken.None);

        // Twelve: two list pages and three print invoices, then an invoice list
        // attempted for EVERY order - three, not one - and four documents off
        // the only order this test recorded any for. The two lists that come
        // back empty still cost a request, and still wait their turn; a pacing
        // rule that only covered the calls that succeed would be no rule at all
        // on the account where most of them do not.
        Assert.Equal(12, pacer.Entered);

        // And every one of those requests happened inside a turn. Derived from
        // the trace rather than restated, so this cannot drift from the count
        // above without one of them failing.
        Assert.Equal(pacer.Trace.Count(e => e is "open" or "fragment" or "download"), pacer.Entered);
    }

    // ---- the manifest ------------------------------------------------------

    /// <summary>
    /// What the catalogue offers, and what it no longer does.
    ///
    /// The absence is the assertion. <c>raw</c> was withdrawn from this
    /// provider because a scraped page is not a provider payload, and a
    /// consumer that goes on asking for it should get a clear rejection rather
    /// than a quarter of a megabyte of markup.
    /// </summary>
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

    // ---- helpers -----------------------------------------------------------

    private static AmazonAdapter Adapter() => new(new AmazonOptions(), new FixedTimeProvider(Now));

    private static HtmlNode Fragment(string fixture) =>
        HtmlParser.Parse(FixtureCatalog.Read($"amazon/{fixture}.html"));

    private static HtmlNode Dom(string fixture) => HtmlParser.Parse(AmazonFixture.Page(fixture).Html);

    private static SessionMaterial Material() =>
        new() { StorageState = FixtureCatalog.Read("amazon/storage-state.json") };

    /// <summary>Recognisable bytes that really do start with a PDF header.</summary>
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
