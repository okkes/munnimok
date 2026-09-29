using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Munni.Api.Connectors;

/// <summary>What one call to the control plane carries beside its path and body.</summary>
public sealed record ConnectorCall
{
    /// <summary>The minted subject; every session, job, ticket and agent route needs it, the catalogue does not.</summary>
    public string? Subject { get; init; }

    /// <summary>Serialised in the connector's own JSON (snake_case) when present.</summary>
    public object? Body { get; init; }

    /// <summary>A ticket from <c>sessions/resume</c>, for the fetch and ack routes.</summary>
    public string? Ticket { get; init; }

    /// <summary><c>user</c> (default) or <c>schedule</c>.</summary>
    public string? Trigger { get; init; }

    /// <summary><c>native</c> (default) or <c>web</c>; web bundles live shorter.</summary>
    public string? DeviceClass { get; init; }

    public string? IdempotencyKey { get; init; }

    /// <summary>Catalogue revalidation.</summary>
    public string? IfNoneMatch { get; init; }
}

/// <summary>The connector's error envelope, as it came (docs/connectors/contract.md).</summary>
public sealed record ConnectorError(
    string Code,
    bool Retriable,
    string UserAction,
    string MessageKey,
    string? DetailId,
    int? RetryAfterSeconds);

/// <summary>
/// One answer from the control plane. JSON bodies arrive as a node the
/// caller reads what it needs from; pictures and documents as bytes. An
/// error status carries the parsed envelope so a handler can relay it.
/// </summary>
public sealed record ConnectorReply(
    HttpStatusCode Status,
    JsonNode? Json,
    byte[]? Bytes,
    string? ContentType,
    string? ETag,
    string? ManifestVersion,
    ConnectorError? Error,
    IReadOnlyDictionary<string, string>? Extensions = null)
{
    /// <summary>The <c>X-</c> response headers, for the ones a handler relays (the live view's frame sequence and size).</summary>
    public IReadOnlyDictionary<string, string> Headers => Extensions ?? EmptyHeaders;

    private static readonly Dictionary<string, string> EmptyHeaders = new(StringComparer.OrdinalIgnoreCase);

    public bool IsSuccess => (int)Status is >= 200 and < 300;

    public bool NotModified => Status == HttpStatusCode.NotModified;

    /// <summary>The body as an object, or an empty one — never null, so reads chain.</summary>
    public JsonObject Object => Json as JsonObject ?? [];

    public string? Text(string property) => Object[property]?.GetValue<string>();
}

/// <summary>
/// The typed client the relay speaks to the control plane with. Authenticates
/// every call (<see cref="ConnectorAuthSource"/>), stamps the subject and the
/// per-call headers, and never logs a body: bodies carry bundles.
/// </summary>
public sealed class ConnectorClient(HttpClient http, ConnectorAuthSource auth)
{
    public const string SubjectHeader = "X-Connector-Subject";
    public const string TicketHeader = "X-Connector-Ticket";
    public const string TriggerHeader = "X-Connector-Trigger";
    public const string DeviceClassHeader = "X-Device-Class";
    public const string IdempotencyHeader = "Idempotency-Key";
    public const string ManifestVersionHeader = "X-Manifest-Version";

    /// <summary>The connector's encoding: snake_case names, snake_case enums, nulls omitted.</summary>
    public static JsonSerializerOptions WireJson { get; } = BuildWireJson();

    public Task<ConnectorReply> GetAsync(string path, ConnectorCall call, CancellationToken ct) =>
        SendAsync(HttpMethod.Get, path, call, ct);

    public Task<ConnectorReply> PostAsync(string path, ConnectorCall call, CancellationToken ct) =>
        SendAsync(HttpMethod.Post, path, call, ct);

    public Task<ConnectorReply> DeleteAsync(string path, ConnectorCall call, CancellationToken ct) =>
        SendAsync(HttpMethod.Delete, path, call, ct);

    public async Task<ConnectorReply> SendAsync(HttpMethod method, string path, ConnectorCall call, CancellationToken ct)
    {
        using var request = await BuildAsync(method, path, call, ct);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        return await ReadAsync(response, ct);
    }

    /// <summary>
    /// Opens a server-sent event stream. The caller owns the response and
    /// disposes it when it stops reading — the stream is the body.
    /// </summary>
    public async Task<HttpResponseMessage> OpenStreamAsync(string path, ConnectorCall call, CancellationToken ct)
    {
        using var request = await BuildAsync(HttpMethod.Get, path, call, ct);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private async Task<HttpRequestMessage> BuildAsync(HttpMethod method, string path, ConnectorCall call, CancellationToken ct)
    {
        var request = new HttpRequestMessage(method, path);
        await auth.ApplyAsync(request, ct);
        if (call.Subject is not null) request.Headers.Add(SubjectHeader, call.Subject);
        if (call.Ticket is not null) request.Headers.Add(TicketHeader, call.Ticket);
        if (call.Trigger is not null) request.Headers.Add(TriggerHeader, call.Trigger);
        if (call.DeviceClass is not null) request.Headers.Add(DeviceClassHeader, call.DeviceClass);
        if (call.IdempotencyKey is not null) request.Headers.Add(IdempotencyHeader, call.IdempotencyKey);
        if (call.IfNoneMatch is not null) request.Headers.TryAddWithoutValidation("If-None-Match", call.IfNoneMatch);
        if (call.Body is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(call.Body, WireJson), Encoding.UTF8, "application/json");
        }
        return request;
    }

    private static async Task<ConnectorReply> ReadAsync(HttpResponseMessage response, CancellationToken ct)
    {
        var status = response.StatusCode;
        var contentType = response.Content.Headers.ContentType?.MediaType;
        var etag = response.Headers.ETag?.ToString();
        var manifestVersion = response.Headers.TryGetValues(ManifestVersionHeader, out var versions)
            ? versions.FirstOrDefault()
            : null;
        var extensions = response.Headers
            .Where(h => h.Key.StartsWith("X-", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);

        if (status is HttpStatusCode.NotModified or HttpStatusCode.NoContent)
        {
            return new ConnectorReply(status, null, null, contentType, etag, manifestVersion, null, extensions);
        }

        if (IsBinary(contentType))
        {
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            return new ConnectorReply(status, null, bytes, contentType, etag, manifestVersion, null, extensions);
        }

        var text = await response.Content.ReadAsStringAsync(ct);
        JsonNode? json = null;
        if (text.Length > 0)
        {
            try
            {
                json = JsonNode.Parse(text);
            }
            catch (JsonException)
            {
                // a reverse proxy's HTML error page, or an empty 5xx — the
                // status is the answer and the body is nobody's contract
            }
        }

        var error = (int)status >= 400 ? ParseError(json, status) : null;
        return new ConnectorReply(status, json, null, contentType, etag, manifestVersion, error, extensions);
    }

    private static bool IsBinary(string? contentType) =>
        contentType is not null
        && (contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
            || contentType.Equals("application/pdf", StringComparison.OrdinalIgnoreCase)
            || contentType.Equals("application/octet-stream", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// The envelope when the control plane sent one; a synthetic
    /// <c>internal</c> when it did not (a proxy answered, or it crashed
    /// before it could say), so every failure reaches the app in one shape.
    /// </summary>
    private static ConnectorError ParseError(JsonNode? json, HttpStatusCode status)
    {
        if (json?["error"] is JsonObject error && error["code"]?.GetValue<string>() is { Length: > 0 } code)
        {
            return new ConnectorError(
                code,
                error["retriable"]?.GetValue<bool>() ?? false,
                error["user_action"]?.GetValue<string>() ?? "none",
                error["message_key"]?.GetValue<string>() ?? $"connect.error.{code}",
                error["detail_id"]?.GetValue<string>(),
                error["retry_after_seconds"]?.GetValue<int>());
        }

        var unavailable = (int)status >= 500;
        return new ConnectorError(
            unavailable ? "provider_unavailable" : "invalid_request",
            unavailable,
            unavailable ? "retry" : "none",
            unavailable ? "connect.error.provider_unavailable" : "connect.error.invalid_request",
            null,
            null);
    }

    private static JsonSerializerOptions BuildWireJson()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            // dictionary keys are data (inputs, config) — never renamed
            DictionaryKeyPolicy = null,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower));
        return options;
    }
}

/// <summary>
/// How the relay authenticates to the control plane: the development key
/// as a header, or a Logto machine token (client credentials for the
/// connector's audience) minted once and reused until shortly before it
/// expires. One instance per process; the token is the only state.
/// </summary>
public sealed class ConnectorAuthSource(ConnectorOptions options, IHttpClientFactory httpFactory, IConfiguration config, TimeProvider time)
{
    public const string DevelopmentHeader = "X-Connector-Key";
    public const string TokenClientName = "logto-m2m";

    private static readonly TimeSpan Slack = TimeSpan.FromSeconds(60);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _token;
    private DateTimeOffset _expiresAt;

    public async ValueTask ApplyAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (options.UsesDevKey)
        {
            request.Headers.Add(DevelopmentHeader, options.DevKey);
            return;
        }

        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await TokenAsync(ct));
    }

    private async Task<string> TokenAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        if (_token is not null && now < _expiresAt - Slack) return _token;

        await _gate.WaitAsync(ct);
        try
        {
            now = time.GetUtcNow();
            if (_token is not null && now < _expiresAt - Slack) return _token;

            var (token, lifetime) = await MintAsync(ct);
            _token = token;
            _expiresAt = now + lifetime;
            return token;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Logto: <c>client_credentials</c> for the API resource, basic-authenticated with the app's id and secret.</summary>
    private async Task<(string Token, TimeSpan Lifetime)> MintAsync(CancellationToken ct)
    {
        var authority = config["Auth:Authority"]?.TrimEnd('/')
                        ?? throw new InvalidOperationException("Auth:Authority is required to mint connector tokens");
        var endpoint = authority.EndsWith("/oidc", StringComparison.Ordinal) ? $"{authority}/token" : $"{authority}/oidc/token";

        var http = httpFactory.CreateClient(TokenClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{options.M2mAppId}:{options.M2mAppSecret}")));
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "client_credentials",
            ["resource"] = options.Audience!,
        });

        using var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var token = json.RootElement.GetProperty("access_token").GetString()
                    ?? throw new InvalidOperationException("Logto token response without access_token");
        var seconds = json.RootElement.TryGetProperty("expires_in", out var expires) ? expires.GetInt32() : 3600;
        return (token, TimeSpan.FromSeconds(Math.Max(seconds, 120)));
    }
}
