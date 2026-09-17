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
export const CLIENT_PROTOCOL = 2;
/** oldest server protocol this client can safely talk to */
export const MIN_SERVER_PROTOCOL = 2;

export type ProtocolIssue = 'client-outdated' | 'server-outdated';

/** the verdict on a /health handshake — both fields are part of the
 *  contract (a server that does not advertise them is not supported) */
export function protocolIssueFor(server: { protocol: number; minClientProtocol: number }): ProtocolIssue | null {
  if (server.minClientProtocol > CLIENT_PROTOCOL) return 'client-outdated';
  if (server.protocol < MIN_SERVER_PROTOCOL) return 'server-outdated';
  return null;
}
