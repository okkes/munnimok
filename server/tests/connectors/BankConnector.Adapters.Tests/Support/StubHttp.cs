using System.Net;
using System.Text;

namespace BankConnector.Adapters.Tests.Support;

/// <summary>One request as the adapter sent it, for the assertions to read.</summary>
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

/// <summary>Scripted answers by request; the shop pack's pattern, shared so an aggregator's wire can be replayed offline.</summary>
internal sealed class StubHttpHandler : HttpMessageHandler
{
    private readonly Func<RecordedRequest, int, HttpResponseMessage> _respond;
    private readonly List<RecordedRequest> _requests = [];

    public StubHttpHandler(Func<RecordedRequest, int, HttpResponseMessage> respond) => _respond = respond;

    public IReadOnlyList<RecordedRequest> Requests => _requests;

    public int Count(string method, string pathEnd) =>
        _requests.Count(r => r.Method.Method == method && r.Path.EndsWith(pathEnd, StringComparison.Ordinal));

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, values) in request.Headers.NonValidated) headers[name] = values.ToString();
        if (request.Content is not null)
        {
            foreach (var (name, values) in request.Content.Headers.NonValidated) headers[name] = values.ToString();
        }
        var recorded = new RecordedRequest(request.Method, request.RequestUri!, body, headers);
        _requests.Add(recorded);
        return _respond(recorded, _requests.Count - 1);
    }
}

internal static class Stub
{
    public static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Status(HttpStatusCode status, string body = "") =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Bytes(byte[] body, string contentType, HttpStatusCode status = HttpStatusCode.OK)
    {
        var content = new ByteArrayContent(body);
        content.Headers.Remove("Content-Type");
        content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        return new HttpResponseMessage(status) { Content = content };
    }
}

/// <summary>A clock that stands still, so tokens, consents and windows are asserted against known instants.</summary>
internal sealed class FixedTime(DateTimeOffset now) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = now;

    public override DateTimeOffset GetUtcNow() => Now;
}
