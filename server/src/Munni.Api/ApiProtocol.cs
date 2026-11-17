namespace Munni.Api;

// bump Version with CLIENT_PROTOCOL (apps/web/src/lib/protocol.ts) when the sync/API contract changes.
// raise MinClient only when an OLD client would misbehave, not just miss a feature
public static class ApiProtocol
{
    // v2 (#148 r3): the txSeen entity — a v2 client's push would 400 on a v1 server
    // v3 (#546): the family default accounts retire on the client
    // v3 (#569): GET /sync/heads — a v3 client's round asks it instead of pulling every space
    // v3 (#494/#504): plan one-offs and the events segment — a v2 client misreads both
    // v4 (#557): a plan subject's row holds the period's own funding, what rolled over is derived on the client
    // v5 (#606): GET /sync/{space}/bootstrap answers in pages — a v5 client takes them for a space it does not hold yet
    public const int Version = 5;
    /// <summary>oldest client protocol this server still speaks — v4: a v3
    /// client reads a plan subject's row as all it holds, so the money that
    /// rolled over from earlier periods is handed out a second time</summary>
    public const int MinClient = 4;
}
