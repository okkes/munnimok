using System.Net;
using System.Text;

namespace ShopConnector.Adapters.Tests.Support;

internal sealed record RecordedRequest(
    HttpMethod Method,
    Uri Uri,
    string? Body,
    IReadOnlyDictionary<string, string> Headers)
{
    public string Path => Uri.AbsolutePath;

    public string Query => Uri.Query;

    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;
}

/// the responder gets the zero-based ordinal: "first call 401s, second succeeds" needs no counter of its own
internal sealed class StubHttpHandler : HttpMessageHandler
{
    private readonly Func<RecordedRequest, int, HttpResponseMessage> _respond;
    private readonly List<RecordedRequest> _requests = [];

    public StubHttpHandler(Func<RecordedRequest, int, HttpResponseMessage> respond) => _respond = respond;

    public IReadOnlyList<RecordedRequest> Requests => _requests;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);

        // NonValidated: enumerating the typed Headers re-renders a User-Agent split into tokens joined by ", ",
        // failing against a header that is intact on the wire (verified against a raw socket)
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, values) in request.Headers.NonValidated)
        {
            headers[name] = values.ToString();
        }

        if (request.Content is not null)
        {
            foreach (var (name, values) in request.Content.Headers.NonValidated)
            {
                headers[name] = values.ToString();
            }
        }

        var recorded = new RecordedRequest(request.Method, request.RequestUri!, body, headers);
        _requests.Add(recorded);

        return _respond(recorded, _requests.Count - 1);
    }
}

/// counts as well as throws: a swallowed exception is still caught, since the claim is zero network calls
internal sealed class ThrowingHttpHandler : HttpMessageHandler
{
    public int Calls { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        Calls++;

        throw new InvalidOperationException(
            $"this adapter must not make network calls, but it requested {request.Method} {request.RequestUri}");
    }
}

internal static class Stub
{
    public static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Fixture(string name, HttpStatusCode status = HttpStatusCode.OK) =>
        Json(Adapters.Fixtures.FixtureCatalog.Read(name), status);

    public static HttpResponseMessage Status(HttpStatusCode status) =>
        new(status) { Content = new StringContent(string.Empty, Encoding.UTF8, "application/json") };

    /// <summary>An interstitial: a block page or a login redirect where JSON was promised.</summary>
    public static HttpResponseMessage Html(string body = "<html><body>blocked</body></html>") =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/html") };

    public static HttpResponseMessage Page(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "text/html") };

    /// the default carries bol's charset parameter on a PDF (wrong, but what bol sends): an adapter comparing the raw
    /// header rejects every invoice; TryAddWithoutValidation keeps it, the typed setter normalises it away
    public static HttpResponseMessage Bytes(
        byte[] body,
        string contentType = "application/pdf;charset=UTF-8",
        HttpStatusCode status = HttpStatusCode.OK)
    {
        var content = new ByteArrayContent(body);
        content.Headers.Remove("Content-Type");
        content.Headers.TryAddWithoutValidation("Content-Type", contentType);

        return new HttpResponseMessage(status) { Content = content };
    }

    public static byte[] FixtureBytes(string name)
    {
        using var stream = Adapters.Fixtures.FixtureCatalog.Open(name);
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }
}
