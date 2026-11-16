using ShopConnector.Adapters.Amazon;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// Uri.TryCreate(path, Absolute) is true on Linux for "/documents/..." (a rooted file path): it produced file:///
/// and every invoice fetch died on "Protocol file: not supported", while navigation never asks and worked
public sealed class AmazonUrlTests
{
    private const string Page = "https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1122334-5566778";

    /// cannot fail on Windows, where "/x" is not an absolute URI; the protocol-relative test below guards it there (UNC path)
    [Fact]
    public void A_rooted_path_becomes_a_web_address_and_never_a_file_path()
    {
        var resolved = AmazonUrl.Resolve(Page, "/documents/download/abc/invoice.pdf");

        Assert.Equal("https://www.amazon.nl/documents/download/abc/invoice.pdf", resolved);

        // a separate StartsWith: https is the property that was violated, equality alone would let file:// return
        Assert.StartsWith("https://", resolved, StringComparison.Ordinal);
    }

    /// pinned because narrowing the guard to https alone survived mutation
    [Fact]
    public void Plain_http_is_still_the_web()
    {
        Assert.Equal(
            "http://www.amazon.nl/documents/download/abc/invoice.pdf",
            AmazonUrl.Resolve("http://www.amazon.nl/gp/css/summary/print.html", "/documents/download/abc/invoice.pdf"));
    }

    /// the file:// version escaped ? to %3F; the invoice list's per-render token lives in the query
    [Fact]
    public void A_query_string_stays_a_query_string()
    {
        var resolved = AmazonUrl.Resolve(
            Page, "/your-orders/invoice/popover?orderId=402-1122334-5566778&relatedRequestId=ABC123");

        Assert.Equal(
            "https://www.amazon.nl/your-orders/invoice/popover?orderId=402-1122334-5566778&relatedRequestId=ABC123",
            resolved);

        Assert.DoesNotContain("%3F", resolved, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_address_that_is_already_absolute_is_left_alone()
    {
        const string absolute = "https://www.amazon.nl/documents/download/abc/invoice.pdf";

        Assert.Equal(absolute, AmazonUrl.Resolve(Page, absolute));
    }

    /// resolves against the page, not a configured base: a document Amazon serves from another host must not be rewritten
    [Fact]
    public void A_document_on_another_host_is_followed_rather_than_pointed_home()
    {
        Assert.Equal(
            "https://m.media-amazon.com/invoice.pdf",
            AmazonUrl.Resolve(Page, "https://m.media-amazon.com/invoice.pdf"));
    }

    [Fact]
    public void A_relative_path_resolves_against_the_page_it_was_found_on()
    {
        Assert.Equal(
            "https://www.amazon.nl/gp/css/summary/invoice.pdf",
            AmazonUrl.Resolve(Page, "invoice.pdf"));
    }

    [Fact]
    public void A_protocol_relative_href_takes_the_pages_scheme()
    {
        Assert.Equal(
            "https://images.amazon.com/invoice.pdf",
            AmazonUrl.Resolve(Page, "//images.amazon.com/invoice.pdf"));
    }

    /// javascript: and mailto: hrefs are refused: converting one into a request makes a scraper do what nobody asked
    [Theory]
    [InlineData("javascript:void(0)")]
    [InlineData("mailto:someone@example.com")]
    [InlineData("file:///etc/passwd")]
    public void A_scheme_the_web_does_not_speak_is_handed_back_untouched(string href)
    {
        // handed back unchanged so the caller's error quotes what it was given
        Assert.Equal(href, AmazonUrl.Resolve(Page, href));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("about:blank")]
    public void With_no_usable_page_the_href_is_left_as_it_was(string? pageUrl)
    {
        Assert.Equal("/documents/download/abc/invoice.pdf",
            AmazonUrl.Resolve(pageUrl, "/documents/download/abc/invoice.pdf"));
    }
}
