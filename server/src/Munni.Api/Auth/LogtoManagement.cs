using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Munni.Api.Auth;

public sealed record LogtoSession(HttpClient Http, string Endpoint, string AccessToken)
{
    public HttpRequestMessage Request(HttpMethod method, string path, object? body = null)
    {
        var request = new HttpRequestMessage(method, $"{Endpoint}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AccessToken);
        if (body is not null) request.Content = JsonContent.Create(body, body.GetType());
        return request;
    }
}

// a null session means no machine app in this environment: callers degrade on their own terms
// (deletion leaves the identity for manual cleanup, the portal answers 503)
public interface ILogtoManagement
{
    /// <summary>a session with a valid token, or null when Logto:M2mAppId, Logto:M2mAppSecret and Auth:Authority are not all set</summary>
    Task<LogtoSession?> ConnectAsync(CancellationToken ct);

    /// <summary>drops the cached token (Logto answered 401 with it): the next connect mints afresh</summary>
    void Forget();
}

// the token is kept until 60 s before it expires behind one gate,
// so account deletions and invitation clicks do not each mint one
public sealed class LogtoManagement(IHttpClientFactory httpFactory, IConfiguration config, TimeProvider time) : ILogtoManagement
{
    public const string ClientName = "logto-m2m";

    /// <summary>Logto's fixed resource indicator for its own Management API — an identifier, not an address anyone dials</summary>
    public const string ManagementResource = "https://default.logto.app/api"; // NOSONAR(S1075) resource indicator

    private const string OidcSuffix = "/oidc";
    private static readonly TimeSpan Slack = TimeSpan.FromSeconds(60);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private Minted? _minted;

    private sealed record Credentials(string AppId, string AppSecret, string Endpoint);

    private sealed record Minted(string Token, DateTimeOffset ExpiresAt);

    public async Task<LogtoSession?> ConnectAsync(CancellationToken ct)
    {
        var credentials = Read();
        if (credentials is null) return null;
        var token = await TokenAsync(credentials, ct);
        return new LogtoSession(httpFactory.CreateClient(ClientName), credentials.Endpoint, token);
    }

    public void Forget() => _minted = null;

    /// <summary>Read per call so a reloaded configuration counts.</summary>
    private Credentials? Read()
    {
        var appId = config["Logto:M2mAppId"];
        var appSecret = config["Logto:M2mAppSecret"];
        var authority = config["Auth:Authority"];
        if (string.IsNullOrEmpty(appId) || string.IsNullOrEmpty(appSecret) || string.IsNullOrEmpty(authority)) return null;
        var endpoint = authority.TrimEnd('/');
        if (endpoint.EndsWith(OidcSuffix, StringComparison.Ordinal)) endpoint = endpoint[..^OidcSuffix.Length];
        return new Credentials(appId, appSecret, endpoint);
    }

    private async Task<string> TokenAsync(Credentials credentials, CancellationToken ct)
    {
        if (Fresh() is { } cached) return cached;

        await _gate.WaitAsync(ct);
        try
        {
            // a caller that waited behind the mint takes its result instead of minting again
            if (Fresh() is { } minted) return minted;

            var (token, lifetime) = await MintAsync(credentials, ct);
            _minted = new Minted(token, time.GetUtcNow() + lifetime);
            return token;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Token and expiry travel as one reference, so a reader never sees a torn pair.</summary>
    private string? Fresh()
    {
        var minted = _minted;
        return minted is not null && time.GetUtcNow() < minted.ExpiresAt - Slack ? minted.Token : null;
    }

    private async Task<(string Token, TimeSpan Lifetime)> MintAsync(Credentials credentials, CancellationToken ct)
    {
        var http = httpFactory.CreateClient(ClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{credentials.Endpoint}{OidcSuffix}/token");
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{credentials.AppId}:{credentials.AppSecret}")));
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "client_credentials",
            ["resource"] = ManagementResource,
            ["scope"] = "all",
        });

        using var response = await http.SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var token = json.RootElement.GetProperty("access_token").GetString()
                    ?? throw new InvalidOperationException("Logto token response without access_token");
        // no expires_in reads as an hour; never under two minutes, or the slack would mint on every call
        var seconds = json.RootElement.TryGetProperty("expires_in", out var expires) ? expires.GetInt32() : 3600;
        return (token, TimeSpan.FromSeconds(Math.Max(seconds, 120)));
    }
}
