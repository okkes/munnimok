using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Connector.Kit.Tracing;
using Xunit;

namespace Connector.Kit.Tests.Tracing;

/// <summary>
/// The HTTP client's half of a recording (#441 L3): one handler, a book
/// resolved per call, text answers kept and still readable, binary ones
/// left streaming.
/// </summary>
public sealed class TraceHttpHandlerTests
{
    private sealed class Stub(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(answer(request));
    }

    private static HttpClient Client(Func<TraceBook?> book, Func<HttpRequestMessage, HttpResponseMessage> answer) =>
        new(new TraceHttpHandler(book) { InnerHandler = new Stub(answer) });

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    [Fact]
    public async Task A_text_call_is_written_down_in_full_and_the_adapter_still_reads_the_same_bytes()
    {
        var book = new TraceBook("job_1", "p", ["hunter2"]);
        using var client = Client(() => book, _ => Json("{\"ok\":true,\"token\":\"hunter2\"}"));

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.test/session?token=hunter2")
        {
            Content = new StringContent("{\"password\":\"hunter2\"}", Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "hunter2");

        using var response = await client.SendAsync(request);
        var read = await response.Content.ReadAsStringAsync();

        Assert.Equal("{\"ok\":true,\"token\":\"hunter2\"}", read);

        var trace = book.Build();
        var sent = Assert.Single(trace.Entries, e => e.Kind == TraceKind.Request);
        var got = Assert.Single(trace.Entries, e => e.Kind == TraceKind.Response);

        Assert.Equal(TraceBook.ViaHttp, sent.Via);
        Assert.Equal("POST", sent.Method);
        Assert.Equal("https://api.test/session?token=«redacted:7»", sent.Url);
        Assert.Contains(sent.Headers, h => h.Name == "Authorization" && h.Value == "Bearer «redacted:7»");
        Assert.DoesNotContain("hunter2", sent.Body, StringComparison.Ordinal);

        Assert.Equal(200, got.Status);
        Assert.Equal("application/json; charset=utf-8", got.ContentType);
        Assert.DoesNotContain("hunter2", got.Body, StringComparison.Ordinal);
        Assert.Contains("\"ok\":true", got.Body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_binary_answer_is_kept_as_a_size_and_a_type_and_left_streaming()
    {
        var book = new TraceBook("job_1", "p", []);
        var pdf = new byte[] { 0x25, 0x50, 0x44, 0x46, 1, 2, 3 };
        using var client = Client(() => book, _ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(pdf) { Headers = { ContentType = new MediaTypeHeaderValue("application/pdf") } },
        });

        using var response = await client.GetAsync("https://api.test/receipt.pdf");

        Assert.Equal(pdf, await response.Content.ReadAsByteArrayAsync());
        var got = Assert.Single(book.Build().Entries, e => e.Kind == TraceKind.Response);
        Assert.Null(got.Body);
        Assert.Equal("application/pdf", got.ContentType);
        Assert.Equal(7, got.Size);
    }

    [Fact]
    public async Task With_no_book_open_nothing_is_written_and_nothing_is_buffered()
    {
        var calls = 0;
        using var client = Client(() => null, _ =>
        {
            calls++;
            return Json("{}");
        });

        using var response = await client.GetAsync("https://api.test/");

        Assert.Equal(1, calls);
        Assert.Equal("{}", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task The_scope_hands_the_book_to_a_shared_pipeline_for_the_flow_that_opened_it()
    {
        var book = new TraceBook("job_s", "p", []);
        using var client = Client(() => TraceScope.Book, _ => Json("[]"));

        using (TraceScope.Open(book))
        {
            using var inside = await client.GetAsync("https://api.test/inside");
        }

        using var outside = await client.GetAsync("https://api.test/outside");

        var urls = book.Build().Entries.Select(e => e.Url).ToList();
        Assert.Contains("https://api.test/inside", urls);
        Assert.DoesNotContain("https://api.test/outside", urls);
        Assert.Null(TraceScope.Book);
    }
}
