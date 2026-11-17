using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Munni.Api.Sync;

/// a space that changed (relayed to every member's connection as <c>{spaceId}</c>), or a frame addressed to one user
/// (connector login or job progress) relayed verbatim to that user's connections only
public sealed record SyncEvent(string? SpaceId, Guid? UserId, string? Json);

/// in-memory pub/sub feeding the SSE stream (/sync/events): single-instance API, so no external broker
public sealed class SpaceEventBroadcaster
{
    private readonly ConcurrentDictionary<Guid, Channel<SyncEvent>> _subscribers = new();

    public void Publish(string spaceId) => Broadcast(new SyncEvent(spaceId, null, null));

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
