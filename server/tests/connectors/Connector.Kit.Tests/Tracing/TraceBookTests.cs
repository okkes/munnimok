using Connector.Kit.Tracing;
using Xunit;

namespace Connector.Kit.Tests.Tracing;

/// <summary>
/// The bounded, redacting book a recording is written into (#441 L3).
/// </summary>
public sealed class TraceBookTests
{
    private static TraceBook Book(params string[] secrets) => new("job_1", "test-provider", secrets);

    [Fact]
    public void Entries_are_numbered_in_order_and_timed_from_the_start()
    {
        var book = Book();
        book.Navigation("https://provider.test/login");
        book.Console("log", "hello");
        book.Note("done");

        var trace = book.Build();

        Assert.Equal([1, 2, 3], trace.Entries.Select(e => e.Seq));
        Assert.Equal([TraceKind.Navigation, TraceKind.Console, TraceKind.Note], trace.Entries.Select(e => e.Kind));
        Assert.All(trace.Entries, e => Assert.True(e.AtMs >= 0));
        Assert.True(trace.EndedAt >= trace.StartedAt);
        Assert.Equal("job_1", trace.JobId);
        Assert.Equal("test-provider", trace.Provider);
        Assert.False(trace.Truncated);
    }

    [Fact]
    public void Nothing_the_run_was_handed_as_a_secret_survives_into_the_book()
    {
        var book = Book("hunter2", "tok_access_123");
        book.Request(
            TraceBook.ViaBrowser, "POST", "https://provider.test/api/session?token=tok_access_123", "fetch",
            [new("Authorization", "Bearer tok_access_123"), new("Cookie", "sid=hunter2abc"), new("Content-Type", "application/json")],
            "application/json",
            "{\"username\":\"shopper\",\"password\":\"hunter2\",\"note\":\"my password is hunter2\"}");
        book.Response(
            TraceBook.ViaHttp, "GET", "https://api.provider.test/me", 200, "http",
            [new("Set-Cookie", "sid=hunter2abc; Path=/")], "application/json", 40,
            "{\"greeting\":\"hello shopper, token tok_access_123\"}");
        book.Console("error", "leaked hunter2 in a console line");
        book.Dom("https://provider.test/me", "sha256:abc", "<input value=\"hunter2\">");

        var trace = book.Build();
        var json = System.Text.Json.JsonSerializer.Serialize(trace, ConnectorWireJson.Options);

        Assert.DoesNotContain("hunter2", json, StringComparison.Ordinal);
        Assert.DoesNotContain("tok_access_123", json, StringComparison.Ordinal);

        var request = Assert.Single(trace.Entries, e => e.Kind == TraceKind.Request);
        Assert.Contains("\"username\":\"shopper\"", request.Body, StringComparison.Ordinal);
        Assert.Contains("\"password\":\"«redacted:7»\"", request.Body, StringComparison.Ordinal);
        // the by-name rule reaches the query first; the by-value scrub finds nothing left
        Assert.Equal("https://provider.test/api/session?token=«redacted:14»", request.Url);
        Assert.Contains(request.Headers, h => h.Name == "Authorization" && h.Value == "Bearer «redacted:14»");
        Assert.Contains(request.Headers, h => h.Name == "Cookie" && h.Value == "sid=«redacted:10»");

        var response = Assert.Single(trace.Entries, e => e.Kind == TraceKind.Response);
        Assert.Contains(response.Headers, h => h.Name == "Set-Cookie" && h.Value == "sid=«redacted:10»; Path=/");
        Assert.Equal("{\"greeting\":\"hello shopper, token «redacted»\"}", response.Body);
    }

    [Fact]
    public void A_body_is_cut_at_the_cap_and_says_so()
    {
        var book = Book();
        book.Response(TraceBook.ViaBrowser, "GET", "https://provider.test/big", 200, "document", [], "text/html", null,
            new string('x', TraceBook.MaxBodyChars + 100));

        var entry = Assert.Single(book.Build().Entries);

        Assert.True(entry.BodyTruncated);
        Assert.NotNull(entry.Body);
        Assert.True(entry.Body!.Length < TraceBook.MaxBodyChars + 50);
        Assert.EndsWith("[100 more]", entry.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void A_book_that_is_full_counts_what_it_drops_rather_than_growing()
    {
        var book = Book();
        for (var i = 0; i < TraceBook.MaxEntries + 5; i++) book.Note("n" + i);

        var trace = book.Build();

        Assert.Equal(TraceBook.MaxEntries, trace.Entries.Count);
        Assert.Equal(5, trace.Dropped);
        Assert.True(trace.Truncated);
    }

    [Fact]
    public void A_book_past_its_weight_drops_the_next_heavy_entry()
    {
        var book = Book();
        var heavy = new string('y', TraceBook.MaxHtmlChars);
        var fits = TraceBook.MaxTotalChars / TraceBook.MaxHtmlChars;
        for (var i = 0; i < fits + 2; i++) book.Dom("https://provider.test/", null, heavy);

        var trace = book.Build();

        Assert.True(trace.Dropped >= 1, "the book should have run out of room");
        Assert.True(trace.Entries.Count <= fits);
    }

    [Fact]
    public void A_cookie_is_kept_as_a_name_its_attributes_and_a_fingerprint()
    {
        var cookie = TraceBook.Cookie("sid", "secret-cookie-value", "provider.test", "", DateTimeOffset.UnixEpoch, httpOnly: true, secure: true, "Lax");

        Assert.Equal("sid", cookie.Name);
        Assert.Equal("/", cookie.Path);
        Assert.Equal(19, cookie.ValueLength);
        Assert.Equal(12, cookie.ValueHash.Length);
        Assert.True(cookie.HttpOnly);
        Assert.Equal("Lax", cookie.SameSite);

        var json = System.Text.Json.JsonSerializer.Serialize(cookie, ConnectorWireJson.Options);
        Assert.DoesNotContain("secret-cookie-value", json, StringComparison.Ordinal);
        Assert.Contains("\"value_hash\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void The_trace_round_trips_the_wire_with_snake_case_names_and_lower_case_kinds()
    {
        var book = Book();
        book.Navigation("https://provider.test/");
        var json = System.Text.Json.JsonSerializer.Serialize(book.Build([TraceBook.Cookie("a", "b", "provider.test", "/", null, false, false, null)]), ConnectorWireJson.Options);

        Assert.Contains("\"at_ms\"", json, StringComparison.Ordinal);
        Assert.Contains("\"kind\":\"navigation\"", json, StringComparison.Ordinal);
        Assert.Contains("\"job_id\":\"job_1\"", json, StringComparison.Ordinal);

        var back = System.Text.Json.JsonSerializer.Deserialize<JobTrace>(json, ConnectorWireJson.Options)!;
        Assert.Equal(TraceKind.Navigation, Assert.Single(back.Entries).Kind);
        Assert.Equal("a", Assert.Single(back.Cookies).Name);
    }
}
