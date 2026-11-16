using System.Net;
using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Security;
using Connector.Kit.Adapters;

namespace ShopConnector.Adapters.Support;

internal sealed record TokenSet
{
    public required string AccessToken { get; init; }

    /// null when not re-issued: the old refresh token still stands and must be carried forward
    public string? RefreshToken { get; init; }

    public DateTimeOffset? ExpiresAt { get; init; }

    public static TokenSet Parse(JsonElement root, string providerId, TimeProvider time)
    {
        var access = JsonAccess.StrOf(root, "access_token", "accessToken");
        if (string.IsNullOrWhiteSpace(access))
        {
            throw ConnectorException.ProviderChanged($"{providerId}: token response carries no access token");
        }

        var expiresIn = JsonAccess.Quantity(root, "expires_in", "expiresIn");

        return new TokenSet
        {
            AccessToken = access,
            // blank is absence: "" is truthy to ?? and would replace a good refresh token with nothing (Tokens.Present)
            RefreshToken = Tokens.Present(JsonAccess.StrOf(root, "refresh_token", "refreshToken")),
            // renew a minute early: a token expiring in flight costs a round trip and a 401
            ExpiresAt = expiresIn is > 60 ? time.GetUtcNow().AddSeconds((double)expiresIn.Value - 60) : null,
        };
    }
}

/// an empty token is absence, not a credential: sealing "" in place of a refresh token silently turns a permanent
/// connection into a one-hour one. Normalised at both boundaries (provider and bundle).
internal static class Tokens
{
    public static string? Present(string? token) => string.IsNullOrWhiteSpace(token) ? null : token;
}

/// one refresh, one retry: a second rejection means the refresh token is dead, and re-presenting a dead session
/// gets a client treated as hostile
internal sealed class BearerSession
{
    private readonly string _providerId;
    private readonly TimeProvider _time;

    public BearerSession(SessionMaterial? material, string providerId, TimeProvider time)
    {
        _providerId = providerId;
        _time = time;

        AccessToken = Tokens.Present(material?.AccessToken);
        RefreshToken = Tokens.Present(material?.RefreshToken);
        ExpiresAt = material?.AccessTokenExpiresAt;

        if (AccessToken is null && RefreshToken is null)
        {
            throw ConnectorException.SessionExpired($"{providerId}: session material carries no token");
        }
    }

    public string? AccessToken { get; private set; }

    public string? RefreshToken { get; private set; }

    public DateTimeOffset? ExpiresAt { get; private set; }

    /// <summary>True once a refresh produced material the caller must persist.</summary>
    public bool Rotated { get; private set; }

    public delegate Task<TokenSet> Refresher(string refreshToken, CancellationToken ct);

    public async Task<HttpResponseMessage> SendAsync(
        HttpClient http, Func<string, HttpRequestMessage> factory, Refresher refresh,
        string what, CancellationToken ct)
    {
        if (AccessToken is null || (ExpiresAt is { } expiry && expiry <= _time.GetUtcNow()))
        {
            await RefreshAsync(refresh, ct).ConfigureAwait(false);
        }

        var response = await ProviderHttp.SendAsync(http, factory(AccessToken!), _providerId, ct).ConfigureAwait(false);
        if (response.StatusCode != HttpStatusCode.Unauthorized) return response;

        response.Dispose();
        await RefreshAsync(refresh, ct).ConfigureAwait(false);

        var retry = await ProviderHttp.SendAsync(http, factory(AccessToken!), _providerId, ct).ConfigureAwait(false);
        if (retry.StatusCode != HttpStatusCode.Unauthorized) return retry;

        retry.Dispose();
        throw ConnectorException.SessionExpired($"{_providerId}: {what} still rejected after a refresh");
    }

    public SessionMaterial? RefreshedMaterial(SessionMaterial? original) => Rotated
        ? (original ?? new SessionMaterial()) with
        {
            AccessToken = AccessToken,
            RefreshToken = RefreshToken,
            AccessTokenExpiresAt = ExpiresAt,
        }
        : null;

    private async Task RefreshAsync(Refresher refresh, CancellationToken ct)
    {
        if (RefreshToken is not { } token)
        {
            throw ConnectorException.SessionExpired($"{_providerId}: access token expired and no refresh token was stored");
        }

        var refreshed = await refresh(token, ct).ConfigureAwait(false);

        AccessToken = refreshed.AccessToken;
        RefreshToken = refreshed.RefreshToken ?? token;   // no re-issue means the old one still stands
        ExpiresAt = refreshed.ExpiresAt;
        Rotated = true;
    }
}
