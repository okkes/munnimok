using System.Net;
using System.Text.Json;
using Connector.Kit.Errors;

namespace Connector.Kit.Adapters;

// the one place a provider's HTTP status becomes a connector error; a status is InvalidCredentials only where a
// caller proved it (never here): blaming the password for bot protection sends people to reset a fine one. A pack
// declares which statuses mean "refusing us" through blockedStatuses
public static class ProviderHttp
{
    public static async Task<HttpResponseMessage> SendAsync(
        HttpClient http, HttpRequestMessage request, string providerId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(http);
        try
        {
            return await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ConnectorException(ErrorCode.ProviderUnavailable, $"{providerId}: transport failure", ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // Cancellation we did not ask for is the client's own timeout.
            throw new ConnectorException(ErrorCode.ProviderUnavailable, $"{providerId}: request timed out", ex);
        }
    }

    public static ConnectorException Failure(
        HttpStatusCode status, string providerId, string what, IReadOnlySet<int>? blockedStatuses = null)
    {
        var code = (int)status;
        if (blockedStatuses is not null && blockedStatuses.Contains(code))
        {
            return ConnectorException.Blocked($"{providerId}: {what} refused with {code}");
        }
        return code switch
        {
            401 => ConnectorException.SessionExpired($"{providerId}: {what} rejected the session"),
            403 => ConnectorException.Blocked($"{providerId}: {what} refused with 403"),
            404 => ConnectorException.ProviderChanged($"{providerId}: {what} is gone (404)"),
            408 => new ConnectorException(ErrorCode.ProviderUnavailable, $"{providerId}: {what} timed out upstream"),
            429 => new ConnectorException(ErrorCode.RateLimited, $"{providerId}: {what} rate limited"),
            >= 500 => new ConnectorException(ErrorCode.ProviderUnavailable, $"{providerId}: {what} returned {code}"),
            _ => ConnectorException.ProviderChanged($"{providerId}: {what} returned an unexpected {code}"),
        };
    }

    public static void EnsureSuccess(
        HttpResponseMessage response, string providerId, string what, IReadOnlySet<int>? blockedStatuses = null)
    {
        ArgumentNullException.ThrowIfNull(response);
        if (response.IsSuccessStatusCode) return;
        throw Failure(response.StatusCode, providerId, what, blockedStatuses);
    }

    // keeps the provider's error body (a GraphQL 400 names the unknown field): operator-facing only, truncated (a block page can
    // be a megabyte), best effort: a failing read never masks the status-only error
    public static async Task EnsureSuccessAsync(
        HttpResponseMessage response, string providerId, string what,
        IReadOnlySet<int>? blockedStatuses, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(response);
        if (response.IsSuccessStatusCode) return;
        var failure = Failure(response.StatusCode, providerId, what, blockedStatuses);
        string? body = null;
        try
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(text))
            {
                body = text.Length > 600 ? string.Concat(text.AsSpan(0, 600), "...") : text;
                body = body.ReplaceLineEndings(" ");
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or OperationCanceledException)
        {
            // The status is the finding; the body was a bonus.
        }
        throw body is null
            ? failure
            : new ConnectorException(failure.Code, $"{failure.Detail}; provider said: {body}");
    }

    // the caller owns the returned document; every JsonElement read from it dies with it
    public static async Task<JsonDocument> ReadJsonAsync(
        HttpResponseMessage response, string providerId, string what, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(response);
        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        try
        {
            return await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        }
        catch (JsonException ex)
        {
            // Non-JSON where JSON was promised is almost always an
            // interstitial - a block page or a login redirect - so it is a
            // shape change worth paging someone about, not a parse bug.
            throw new ConnectorException(ErrorCode.ProviderChanged, $"{providerId}: {what} did not return JSON", ex);
        }
    }
}
