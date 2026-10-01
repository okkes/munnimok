using ShopConnector.Adapters.Amazon;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// Turning an href on a page into an address a client can fetch.
///
/// This exists because one line of it was a live defect on a real account, and
/// the wrong version reads as obviously correct:
/// <code>
/// Uri.TryCreate(url, UriKind.Absolute, out var already) ? already.ToString() : ...
/// </code>
/// On Linux <c>/documents/download/x/invoice.pdf</c> IS a well-formed absolute
/// URI - a rooted FILE PATH - so that branch was taken and produced
/// <c>file:///documents/download/x/invoice.pdf</c>. Every invoice fetch died on
/// <c>Protocol "file:" not supported</c> while every navigation on the same page
/// worked, because navigation never asks whether the href is already absolute.
///
/// Diagnosing it took two deploys, two live fetches against somebody's real
/// Amazon account, and a fallback mechanism that hid the symptom by succeeding.
/// The whole of that is one assertion below.
/// </summary>
public sealed class AmazonUrlTests
{
    private const string Page = "https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1122334-5566778";

    /// <summary>
    /// The bug, exactly. A rooted path is the shape EVERY link on this
    /// provider takes.
    /// </summary>
    /// <remarks>
    /// WORTH KNOWING BEFORE TRUSTING THIS TEST: it cannot fail on Windows.
    /// <c>Uri.TryCreate("/x", UriKind.Absolute, ...)</c> is false there - a
    /// Windows absolute path is <c>C:\x</c> - so the faulty branch is never
    /// taken and the bug is invisible on a developer's machine. It is true on
    /// Linux, which is where the agent runs and where this cost two live
    /// fetches.
    /// <para>
    /// The guard is still protected on every platform, by
    /// <see cref="A_protocol_relative_href_takes_the_pages_scheme"/> below: on
    /// Windows <c>//host/path</c> parses as a UNC path and reaches the same
    /// faulty branch. Restoring the original one-line bug fails that test here
    /// and this one on Linux. Both were confirmed by mutation rather than
    /// assumed.
    /// </para>
    /// </remarks>
    [Fact]
    public void A_rooted_path_becomes_a_web_address_and_never_a_file_path()
    {
        var resolved = AmazonUrl.Resolve(Page, "/documents/download/abc/invoice.pdf");

        Assert.Equal("https://www.amazon.nl/documents/download/abc/invoice.pdf", resolved);

        // Stated separately and on purpose. "Starts with https" is the property
        // that was violated, and an equality check alone would let a future
        // refactor reintroduce file:// under a different assertion.
        Assert.StartsWith("https://", resolved, StringComparison.Ordinal);
    }

    /// <summary>
    /// Plain http is a scheme the web speaks, so it is followed.
    ///
    /// Amazon is https everywhere and this will not arise there. It is here
    /// because narrowing the guard to https alone survived a mutation - nothing
    /// tested it - and a guard nothing tests is one that gets tightened by
    /// accident on a provider that does still redirect through http.
    /// </summary>
    [Fact]
    public void Plain_http_is_still_the_web()
    {
        Assert.Equal(
            "http://www.amazon.nl/documents/download/abc/invoice.pdf",
            AmazonUrl.Resolve("http://www.amazon.nl/gp/css/summary/print.html", "/documents/download/abc/invoice.pdf"));
    }

    /// <summary>
    /// And the query string survives.
    ///
    /// The file:// version escaped the <c>?</c> to <c>%3F</c>, because once a
    /// path is a filename its question mark is just a character. The invoice
    /// list carries its per-render token in that query string, so losing it
    /// loses the only URL that fragment can be fetched at.
    /// </summary>
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

    /// <summary>
    /// A storefront that answers from another host is FOLLOWED.
    ///
    /// Which is why this resolves against the page rather than against a
    /// configured base: pointing everything home would silently rewrite a
    /// document Amazon chose to serve elsewhere.
    /// </summary>
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

    /// <summary>
    /// Protocol-relative, which Amazon has used for assets.
    /// </summary>
    [Fact]
    public void A_protocol_relative_href_takes_the_pages_scheme()
    {
        Assert.Equal(
            "https://images.amazon.com/invoice.pdf",
            AmazonUrl.Resolve(Page, "//images.amazon.com/invoice.pdf"));
    }

    /// <summary>
    /// Anything that is not the web is refused, not converted.
    ///
    /// A <c>javascript:</c> or <c>mailto:</c> href in a document list is not an
    /// address to fetch, and quietly turning one into a request is how a
    /// scraper ends up doing something nobody asked it to.
    /// </summary>
    [Theory]
    [InlineData("javascript:void(0)")]
    [InlineData("mailto:someone@example.com")]
    [InlineData("file:///etc/passwd")]
    public void A_scheme_the_web_does_not_speak_is_handed_back_untouched(string href)
    {
        // Handed back unchanged so the caller's own error quotes what it was
        // given. The fetch then fails naming it, rather than succeeding at
        // something unintended.
        Assert.Equal(href, AmazonUrl.Resolve(Page, href));
    }

    /// <summary>
    /// A page URL we cannot resolve against is not an excuse to invent one.
    /// </summary>
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
