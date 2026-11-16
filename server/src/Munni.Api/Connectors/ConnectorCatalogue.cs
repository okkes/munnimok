using System.Text.Json.Nodes;

namespace Munni.Api.Connectors;

// revalidated, not refetched: the connector answers 304 to the ETag it issued and the relay keeps the last document;
// it changes on a deploy or a health change
public sealed class ConnectorCatalogue
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _etag;
    private JsonObject? _document;

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

    public async Task<JsonObject?> ProviderAsync(ConnectorClient client, string providerId, CancellationToken ct)
    {
        var (_, document) = await GetAsync(client, ct);
        return document["providers"] is JsonArray providers
            ? providers.OfType<JsonObject>().FirstOrDefault(p => string.Equals(p.Text("id"), providerId, StringComparison.Ordinal))
            : null;
    }
}

public sealed class ConnectorReplyException(ConnectorReply reply) : Exception($"connector answered {(int)reply.Status}")
{
    public ConnectorReply Reply { get; } = reply;
}
