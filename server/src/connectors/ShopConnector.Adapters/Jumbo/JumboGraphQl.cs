using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Jumbo;

// no persisted-query handshake: the working client posts query/variables/operationName only
// Jumbo accepts arbitrary documents from an authenticated session
public sealed record JumboGraphQlRequest
{
    public required string OperationName { get; init; }

    public required string Query { get; init; }

    public JsonObject Variables { get; init; } = new();
}

// the transport cannot run offline (live cookie, defended endpoint): everything above it runs on recorded payloads in CI
public interface IJumboGraphQlClient
{
    // deviceId is optional: the working client sends no device header; the caller owns the returned document
    Task<JsonDocument> ExecuteAsync(
        IJobContext ctx, JumboGraphQlRequest request, string? deviceId, CancellationToken ct);
}

// through the job's politeness-limited client: the browser's own request context bypasses the rate limiter
public sealed class HttpJumboGraphQlClient : IJumboGraphQlClient
{
    private readonly JumboOptions _options;

    public HttpJumboGraphQlClient(JumboOptions? options = null) => _options = options ?? new JumboOptions();

    public async Task<JsonDocument> ExecuteAsync(
        IJobContext ctx, JumboGraphQlRequest request, string? deviceId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        var cookies = JumboCookies.Header(ctx.Material?.StorageState, _options.CookieDomainSuffix)
                      ?? throw ConnectorException.SessionExpired(
                          "jumbo: the stored browser session carries no jumbo.com cookies");

        using var message = new HttpRequestMessage(HttpMethod.Post, _options.GraphQlUrl)
        {
            Content = new StringContent(Body(request).ToJsonString(), Encoding.UTF8, "application/json"),
        };

        // headers the router needs, at the working client's values; sent because the API requires them
        message.Headers.TryAddWithoutValidation("apollographql-client-name", _options.ClientNameHeader);
        message.Headers.TryAddWithoutValidation("apollographql-client-version", _options.ClientVersionHeader);
        message.Headers.TryAddWithoutValidation("x-source", _options.SourceHeader);
        message.Headers.TryAddWithoutValidation("User-Agent", _options.UserAgent);
        message.Headers.TryAddWithoutValidation("Cookie", cookies);
        message.Headers.TryAddWithoutValidation("Accept", "application/json");

        // optional, but a stable device id is sent when the session has one: a device changing identity every run is a fraud signal
        if (_options.SendDeviceIdHeader && !string.IsNullOrWhiteSpace(deviceId))
        {
            message.Headers.TryAddWithoutValidation("jmb-device-id", deviceId);
        }

        using var response = await ProviderHttp
            .SendAsync(ctx.Http, message, JumboAdapter.ProviderId, ct).ConfigureAwait(false);

        // Akamai fronts www.jumbo.com: 403/502/504 are its refusal, never a wrong password
        // the body is kept: a GraphQL 400 names the rejected field
        await ProviderHttp.EnsureSuccessAsync(
            response, JumboAdapter.ProviderId, "graphql", RetailHttp.RetailBlockStatuses, ct).ConfigureAwait(false);

        return await ProviderHttp
            .ReadJsonAsync(response, JumboAdapter.ProviderId, "graphql", ct).ConfigureAwait(false);
    }

    internal static JsonObject Body(JumboGraphQlRequest request) => new()
    {
        ["operationName"] = request.OperationName,
        ["query"] = request.Query,
        // deep-cloned: a JsonNode has one parent
        ["variables"] = request.Variables.DeepClone(),
    };
}

// the whole credential: the Auth0 tokens are exchanged into user-session server-side, so there is nothing to refresh
internal static class JumboCookies
{
    public static string? Header(string? storageState, string domainSuffix)
    {
        var pairs = Extract(storageState, domainSuffix);
        return pairs.Count == 0 ? null : string.Join("; ", pairs.Select(p => $"{p.Key}={p.Value}"));
    }

    public static IReadOnlyList<KeyValuePair<string, string>> Extract(string? storageState, string domainSuffix)
    {
        if (string.IsNullOrWhiteSpace(storageState)) return [];

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(storageState);
        }
        catch (JsonException ex)
        {
            throw new ConnectorException(ErrorCode.SessionExpired, "jumbo: stored browser session is unreadable", ex);
        }

        using (document)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var cookies = new List<KeyValuePair<string, string>>();

            foreach (var cookie in JsonAccess.Array(document.RootElement, "cookies"))
            {
                var name = JsonAccess.StrOf(cookie, "name");
                var value = JsonAccess.StrOf(cookie, "value");
                var domain = JsonAccess.StrOf(cookie, "domain");
                if (name is null || value is null || domain is null) continue;

                if (!domain.TrimStart('.').EndsWith(domainSuffix, StringComparison.OrdinalIgnoreCase)) continue;

                // a negative expiry marks a session cookie, which Jumbo's login issues: not "already expired"
                var expires = JsonAccess.Quantity(cookie, "expires");
                if (expires is > 0 && expires < now) continue;

                cookies.Add(new KeyValuePair<string, string>(name, value));
            }

            return cookies;
        }
    }
}

internal static class JumboGraphQlErrors
{
    public static void Throw(JsonElement root)
    {
        var errors = JsonAccess.Array(root, "errors");
        if (errors.Count == 0) return;

        var first = errors[0];
        var code = JsonAccess.TryProp(first, out var extensions, "extensions")
            ? JsonAccess.StrOf(extensions, "code")
            : null;
        var message = JsonAccess.StrOf(first, "message") ?? code ?? "unspecified";

        // an expired cookie reads as an auth error: sign in again
        // a refresh path exists at the OIDC layer, but we hold no refresh token (the callback is server-side)
        if (Mentions(code, message, "UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN", "NOT_AUTHENTICATED"))
        {
            throw ConnectorException.SessionExpired($"jumbo: graphql rejected the session ({message})");
        }

        throw ConnectorException.ProviderChanged($"jumbo: graphql returned an error ({message})");
    }

    private static bool Mentions(string? code, string message, params string[] needles) =>
        needles.Any(n =>
            (code?.Contains(n, StringComparison.OrdinalIgnoreCase) ?? false) ||
            message.Contains(n, StringComparison.OrdinalIgnoreCase));
}
