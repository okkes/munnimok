using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Connector.Kit.Hosting.Endpoints;

namespace Connector.Api.Tests.Infrastructure;

// speaks the published contract (snake case in, raw JSON out): deserialising into the kit's own records
// would let a naming regression pass, both sides moving together
internal static class Wire
{
    private static readonly JsonSerializerOptions Options = Build();

    public static HttpRequestMessage Post(string url, object? body = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url);
        if (body is not null)
        {
            request.Content = new StringContent(
                JsonSerializer.Serialize(body, Options), Encoding.UTF8, "application/json");
        }

        return request;
    }

    public static HttpRequestMessage Put(string url, object? body = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, url);
        if (body is not null)
        {
            request.Content = new StringContent(
                JsonSerializer.Serialize(body, Options), Encoding.UTF8, "application/json");
        }

        return request;
    }

    public static HttpRequestMessage Get(string url) => new(HttpMethod.Get, url);

    public static async Task<JsonElement> JsonAsync(this HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);

        var text = await response.Content.ReadAsStringAsync();
        if (string.IsNullOrWhiteSpace(text))
        {
            Assert.Fail($"{response.RequestMessage?.RequestUri} returned {(int)response.StatusCode} with an empty body");
        }

        using var document = JsonDocument.Parse(text);
        // Cloned so the document can be disposed while the element outlives it.
        return document.RootElement.Clone();
    }

    public static string? TextOrNull(this JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public static string Text(this JsonElement element, string property)
    {
        Assert.True(element.TryGetProperty(property, out var value), $"expected a '{property}' property");
        return value.GetString() ?? throw new InvalidOperationException($"'{property}' was null");
    }

    public static IReadOnlyList<string> RawHeader(this HttpResponseMessage response, string name)
    {
        ArgumentNullException.ThrowIfNull(response);
        return response.Headers.TryGetValues(name, out var values) ? [.. values] : [];
    }

    public static void AddHeader(this HttpRequestMessage request, string name, string value)
    {
        ArgumentNullException.ThrowIfNull(request);
        request.Headers.TryAddWithoutValidation(name, value);
    }

    // binds the client to one user via the subject header the connector answers session, job, ticket and agent routes for.
    // Flows stamps it itself
    public static HttpClient ActAs(this HttpClient http, string subject)
    {
        ArgumentNullException.ThrowIfNull(http);

        http.DefaultRequestHeaders.Remove(RequestContext.SubjectHeader);
        http.DefaultRequestHeaders.TryAddWithoutValidation(RequestContext.SubjectHeader, subject);
        return http;
    }

    public static MediaTypeHeaderValue? ContentType(this HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);
        return response.Content.Headers.ContentType;
    }

    private static JsonSerializerOptions Build()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower));
        return options;
    }
}
