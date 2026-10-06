using Connector.Kit.Tracing;
using Xunit;

namespace Connector.Kit.Tests.Tracing;

/// <summary>
/// digest.md (#441 L3): the page an adapter author reads first, rendered
/// from a trace - pages, the calls worth reading with the shape of every
/// JSON answer, the forms posted by field name, the jar, the console.
/// </summary>
public sealed class TraceDigestTests
{
    private static JobTrace Sample()
    {
        var book = new TraceBook("job_42", "mock-store", ["hunter2"]);
        book.Navigation("https://shop.test/login");
        book.Request(TraceBook.ViaBrowser, "GET", "https://shop.test/login", "document", [], null, null);
        book.Response(TraceBook.ViaBrowser, "GET", "https://shop.test/login", 200, "document", [], "text/html; charset=utf-8", 2048, "<html></html>");
        book.Request(TraceBook.ViaBrowser, "GET", "https://cdn.shop.test/app.js", "script", [], null, null);
        book.Response(TraceBook.ViaBrowser, "GET", "https://cdn.shop.test/app.js", 200, "script", [], "application/javascript", 90_000, null);
        book.Request(TraceBook.ViaBrowser, "POST", "https://shop.test/api/session", "fetch", [], "application/x-www-form-urlencoded", "username=shopper&password=hunter2");
        book.Response(TraceBook.ViaBrowser, "POST", "https://shop.test/api/session", 200, "fetch", [], "application/json", 80,
            "{\"ok\":true,\"orders\":[{\"id\":\"o1\",\"total\":12.5,\"lines\":[{\"sku\":\"a\"}]}],\"customer\":{\"name\":\"x\"}}");
        book.Response(TraceBook.ViaHttp, "GET", "https://api.shop.test/v1/orders", 200, "http", [], "application/json", 20, "[{\"id\":\"o1\"}]");
        book.Console("error", "Uncaught TypeError: x is undefined\n  at app.js:1");
        book.Console("log", "noise");
        return book.Build([TraceBook.Cookie("sid", "secret", "shop.test", "/", null, true, true, "Lax")]);
    }

    [Fact]
    public void The_digest_lists_pages_calls_forms_cookies_and_the_console_and_never_a_value()
    {
        var digest = TraceDigest.Render(Sample());

        Assert.StartsWith("# Recording of mock-store · job job_42", digest, StringComparison.Ordinal);
        Assert.Contains("## Pages", digest, StringComparison.Ordinal);
        Assert.Contains("https://shop.test/login → 200 text/html 2 KB", digest, StringComparison.Ordinal);

        Assert.Contains("### shop.test", digest, StringComparison.Ordinal);
        Assert.Contains("POST /api/session → 200 application/json", digest, StringComparison.Ordinal);
        Assert.Contains("shape: `{ok: bool, orders: [1 × {id: string, total: number, lines: [1 × …]}], customer: {name: string}}`", digest, StringComparison.Ordinal);
        Assert.Contains("### api.shop.test", digest, StringComparison.Ordinal);
        Assert.Contains("(http client)", digest, StringComparison.Ordinal);
        Assert.DoesNotContain("app.js", digest, StringComparison.Ordinal);

        Assert.Contains("## Forms and bodies posted", digest, StringComparison.Ordinal);
        Assert.Contains("fields: username, password", digest, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2", digest, StringComparison.Ordinal);
        Assert.DoesNotContain("shopper", digest, StringComparison.Ordinal);

        Assert.Contains("| sid | shop.test | / | httpOnly secure sameSite=Lax | session |", digest, StringComparison.Ordinal);
        Assert.DoesNotContain("secret", digest.Split("## Cookies")[1].Split("## Console")[0], StringComparison.Ordinal);

        Assert.Contains("2 lines, 1 errors, 0 warnings.", digest, StringComparison.Ordinal);
        Assert.Contains("[error] Uncaught TypeError: x is undefined", digest, StringComparison.Ordinal);
    }

    [Fact]
    public void An_empty_trace_still_renders_every_section()
    {
        var digest = TraceDigest.Render(new TraceBook("job_0", "p", []).Build());

        Assert.Contains("No navigation was recorded.", digest, StringComparison.Ordinal);
        Assert.Contains("Nothing worth reading was recorded.", digest, StringComparison.Ordinal);
        Assert.Contains("Nothing was posted.", digest, StringComparison.Ordinal);
        Assert.Contains("None.", digest, StringComparison.Ordinal);
    }

    [Fact]
    public void A_truncated_trace_says_how_much_was_dropped()
    {
        var book = new TraceBook("job_t", "p", []);
        for (var i = 0; i < TraceBook.MaxEntries + 3; i++) book.Note("n");

        Assert.Contains("3 entries were dropped", TraceDigest.Render(book.Build()), StringComparison.Ordinal);
    }

    [Fact]
    public void A_shape_names_keys_and_types_and_counts_arrays_never_values()
    {
        Assert.Equal("{a: string, b: number, c: bool, d: null, e: [2 × number]}", TraceDigest.Shape("{\"a\":\"x\",\"b\":1,\"c\":true,\"d\":null,\"e\":[1,2]}"));
        Assert.Equal("[0 × ?]", TraceDigest.Shape("[]"));
        Assert.Equal("(not JSON)", TraceDigest.Shape("<html>"));

        var wide = "{" + string.Join(",", Enumerable.Range(0, 15).Select(i => $"\"k{i}\":1")) + "}";
        Assert.EndsWith("… 3 more}", TraceDigest.Shape(wide), StringComparison.Ordinal);
    }
}
