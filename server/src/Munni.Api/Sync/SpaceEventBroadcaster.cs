using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Munni.Api.Sync;

/// <summary>
/// One event on the stream: a space that changed (every member's connection
/// relays it as <c>{spaceId}</c>), or a frame addressed to one user — a
/// connector's login or job progress — relayed verbatim to that user's
/// connections and nobody else's.
/// </summary>
public sealed record SyncEvent(string? SpaceId, Guid? UserId, string? Json);

/// <summary>
/// In-memory pub/sub for "space changed" signals feeding the SSE stream
/// (/sync/events). Single-instance API, so no external broker needed;
/// connected clients re-sync a space within ~a second of any accepted
/// push or bank ingest. Each connection filters to its own memberships —
/// and, for user-addressed frames, to its own user.
/// </summary>
public sealed class SpaceEventBroadcaster
{
    private readonly ConcurrentDictionary<Guid, Channel<SyncEvent>> _subscribers = new();

    public void Publish(string spaceId) => Broadcast(new SyncEvent(spaceId, null, null));

    /// <summary>A frame for one user's connections — the JSON is what the client receives, verbatim.</summary>
    public void PublishToUser(Guid userId, string json) => Broadcast(new SyncEvent(null, userId, json));

    private void Broadcast(SyncEvent evt)
    {
        foreach (var channel in _subscribers.Values)
        {
            channel.Writer.TryWrite(evt); // bounded, drop-oldest: slow readers never block
        }
    }

    public (Guid Id, ChannelReader<SyncEvent> Reader) Subscribe()
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateBounded<SyncEvent>(new BoundedChannelOptions(64)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
        });
        _subscribers[id] = channel;
        return (id, channel.Reader);
    }

    public void Unsubscribe(Guid id)
    {
        if (_subscribers.TryRemove(id, out var channel)) channel.Writer.TryComplete();
    }
}
