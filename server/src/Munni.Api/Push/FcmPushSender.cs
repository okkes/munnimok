using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Munni.Api.Push;

/// <summary>
/// Routes each subscription to its transport: browser rows (webpush) to
/// the VAPID sender, native shell rows (fcm) to Firebase. A kind whose
/// transport is not configured reports success so the row survives
/// until the transport arrives.
/// </summary>
public sealed class RoutingPushSender(IPushSender? webPush, IPushSender? fcm) : IPushSender
{
    public Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct)
    {
        var sender = subscription.Kind == "fcm" ? fcm : webPush;
        return sender is null ? Task.FromResult(true) : sender.SendAsync(subscription, payload, ct);
    }
}

/// <summary>
/// FCM HTTP v1 (native-apps design N4): a service-account JWT buys a
/// short-lived OAuth token; messages go out data-only so the app layer
/// localizes the visible text, exactly like the web push path.
/// Configured via Fcm:ServiceAccountJson (the downloaded key file).
/// </summary>
public sealed class FcmPushSender : IPushSender
{
    private readonly HttpClient _http;
    private readonly string _projectId;
    private readonly string _clientEmail;
    private readonly RSA _key;
    private string? _accessToken;
    private DateTimeOffset _accessTokenExpiry = DateTimeOffset.MinValue;

    public FcmPushSender(HttpClient http, IConfiguration config)
    {
        _http = http;
        using var account = JsonDocument.Parse(config["Fcm:ServiceAccountJson"]!);
        _projectId = account.RootElement.GetProperty("project_id").GetString()!;
        _clientEmail = account.RootElement.GetProperty("client_email").GetString()!;
        _key = RSA.Create();
        _key.ImportFromPem(account.RootElement.GetProperty("private_key").GetString()!);
    }

    public async Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct)
    {
        var token = await GetAccessTokenAsync(ct);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"v1/projects/{_projectId}/messages:send");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            message = new
            {
                token = subscription.Endpoint,
                // data-only: the app renders + localizes, matching sw.ts
                data = new { payload },
                android = new { priority = "high" },
            },
        }), Encoding.UTF8, "application/json");

        using var response = await _http.SendAsync(request, ct);
        if (response.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Gone)
            return false; // UNREGISTERED — the caller removes the row
        response.EnsureSuccessStatusCode();
        return true;
    }

    private async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        if (_accessToken is not null && DateTimeOffset.UtcNow < _accessTokenExpiry) return _accessToken;

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var claims = JsonSerializer.Serialize(new
        {
            iss = _clientEmail,
            scope = "https://www.googleapis.com/auth/firebase.messaging",
            aud = "https://oauth2.googleapis.com/token",
            iat = now,
            exp = now + 3600,
        });
        var jwt = SignJwt(claims);

        using var response = await _http.PostAsync("https://oauth2.googleapis.com/token", new FormUrlEncodedContent(new Dictionary<string, string> // NOSONAR(S1075) vendor token endpoint
        {
            ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ["assertion"] = jwt,
        }), ct);
        response.EnsureSuccessStatusCode();
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        _accessToken = body.RootElement.GetProperty("access_token").GetString()!;
        var expiresIn = body.RootElement.TryGetProperty("expires_in", out var e) ? e.GetInt32() : 3600;
        _accessTokenExpiry = DateTimeOffset.UtcNow.AddSeconds(expiresIn - 300);
        return _accessToken;
    }

    private string SignJwt(string claimsJson)
    {
        static string B64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var header = B64Url(Encoding.UTF8.GetBytes("""{"alg":"RS256","typ":"JWT"}"""));
        var body = B64Url(Encoding.UTF8.GetBytes(claimsJson));
        var signature = _key.SignData(Encoding.UTF8.GetBytes($"{header}.{body}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{body}.{B64Url(signature)}";
    }
}
