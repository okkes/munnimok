namespace Munni.Api;

/// <summary>
/// Client↔server compatibility handshake, the server half (the client
/// half + bump discipline live in apps/web/src/lib/protocol.ts): bump
/// Version together with CLIENT_PROTOCOL when the sync/API contract
/// changes; raise MinClient only when an OLD client would misbehave
/// rather than just miss a feature.
/// </summary>
public static class ApiProtocol
{
    // v2 (#148 r3): the txSeen entity — a v2 client's push would 400 on a v1 server
    // v3 (#546): the family default accounts retire on the client
    // v3 (#569): GET /sync/heads — a v3 client's round asks it instead of pulling every space
    // v3 (#494/#504): plan one-offs and the events segment — a v2 client misreads both
    public const int Version = 3;
    /// <summary>oldest client protocol this server still speaks — v3: a v2
    /// client re-mints the retired family default accounts on every boot and
    /// links bare movements onto them, undoing the v3 client's retire pass</summary>
    public const int MinClient = 3;
}
