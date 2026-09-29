using System.Text.Json.Nodes;

namespace Munni.Api.Connectors;

/// <summary>
/// The control plane's catalogue, revalidated rather than refetched: the
/// connector answers 304 to the ETag it issued, and the relay keeps the
/// last document it was given. The document changes on a deploy or a
/// health change, and every relay call that needs a manifest — which
/// resources a provider has, which params they take — reads it from here.
/// </summary>
public sealed class ConnectorCatalogue
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _etag;
    private JsonObject? _document;

    /// <summary>The catalogue as the connector renders it (snake_case), with its ETag.</summary>
    public async Task<(string? ETag, JsonObject Document)> GetAsync(ConnectorClient client, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var reply = await client.GetAsync("v1/providers", new ConnectorCall { IfNoneMatch = _etag }, ct);
            if (reply.NotModified && _document is not null) return (_etag, _document);
            if (!reply.IsSuccess)
            {
                throw new ConnectorReplyException(reply);
            }

            _document = reply.Object;
            _etag = reply.ETag;
            return (_etag, _document);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>One provider's manifest (snake_case), or null when the catalogue has no such provider.</summary>
    public async Task<JsonObject?> ProviderAsync(ConnectorClient client, string providerId, CancellationToken ct)
    {
        var (_, document) = await GetAsync(client, ct);
        return document["providers"] is JsonArray providers
            ? providers.OfType<JsonObject>().FirstOrDefault(p => string.Equals(p.Text("id"), providerId, StringComparison.Ordinal))
            : null;
    }
}

/// <summary>A connector answer that was not a success, carried to the handler that turns it into the app's envelope.</summary>
public sealed class ConnectorReplyException(ConnectorReply reply) : Exception($"connector answered {(int)reply.Status}")
{
    public ConnectorReply Reply { get; } = reply;
}
