/**
 * Client↔server compatibility handshake (user request 2026-07-25): the
 * native apps, the PWA and the API all deploy on their own cadence, so
 * either side can run ahead. /health advertises the server's protocol
 * and the oldest client it still speaks; the client compares both
 * directions BEFORE syncing and says which side must update instead of
 * corrupting data with a mismatched contract.
 *
 * Bump discipline: raise CLIENT_PROTOCOL and the server's
 * ApiProtocol.Version together whenever the sync/API contract changes;
 * raise MinClient/MIN_SERVER_PROTOCOL only when the change is
 * INCOMPATIBLE (an old peer would misbehave, not just miss a feature).
 */
// v2 (#148 r3): the txSeen entity rides the push — a v1 server rejects it
// v3 (#546): the family default accounts retire — a v2 client re-mints
// them every boot and links bare movements onto them, undoing the retire;
// v3 (#494/#504) too: a v2 client leaves the plan's one-offs out of its sums
// and breaks on an event subject in the cover list
// v4 (#557): a plan subject's row holds the period's own funding, what rolled
// over is derived on top — a v3 client reads the row as the whole and hands
// the rolled-over money out a second time
// v5 (#606): a space this device holds nothing of is taken as the server's rows, in pages
export const CLIENT_PROTOCOL = 5;
/** oldest server protocol this client can safely talk to — v5 (#606): a v4
 *  server answers GET /sync/{space}/bootstrap with the whole space at once,
 *  which a phone cannot download inside the limit a request has */
export const MIN_SERVER_PROTOCOL = 5;

export type ProtocolIssue = 'client-outdated' | 'server-outdated';

/** the verdict on a /health handshake — both fields are part of the
 *  contract (a server that does not advertise them is not supported) */
export function protocolIssueFor(server: { protocol: number; minClientProtocol: number }): ProtocolIssue | null {
  if (server.minClientProtocol > CLIENT_PROTOCOL) return 'client-outdated';
  if (server.protocol < MIN_SERVER_PROTOCOL) return 'server-outdated';
  return null;
}
