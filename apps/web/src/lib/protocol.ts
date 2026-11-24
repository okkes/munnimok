// the apps and the API deploy on their own cadence: the client compares both directions BEFORE syncing
// and says which side must update; bump CLIENT_PROTOCOL and the server's ApiProtocol.Version together
// on any contract change, MinClient/MIN_SERVER_PROTOCOL only when the change is INCOMPATIBLE
// v2 (#148 r3): the txSeen entity rides the push — a v1 server rejects it
// v3 (#546): the family default accounts retire — a v2 client re-mints
// them every boot and links bare movements onto them, undoing the retire;
// v3 (#494/#504) too: a v2 client leaves the plan's one-offs out of its sums
// and breaks on an event subject in the cover list
// v4 (#557): a plan subject's row holds the period's own funding, what rolled
// over is derived on top — a v3 client reads the row as the whole and hands
// the rolled-over money out a second time
// v5 (#606): a space this device holds nothing of is taken as the server's rows, in pages
// v6 (#630): a receipt's photo and invoices are receiptFile rows, the receipt names them
export const CLIENT_PROTOCOL = 7;
/** oldest server protocol this client can safely talk to — v6 (#630): a v5
 *  server refuses a receiptFile ("unknown entity"), and a refused push
 *  holds back everything queued behind it */
export const MIN_SERVER_PROTOCOL = 6;

export type ProtocolIssue = 'client-outdated' | 'server-outdated';

/** both fields are part of the contract: a server that does not advertise them is not supported */
export function protocolIssueFor(server: { protocol: number; minClientProtocol: number }): ProtocolIssue | null {
  if (server.minClientProtocol > CLIENT_PROTOCOL) return 'client-outdated';
  if (server.protocol < MIN_SERVER_PROTOCOL) return 'server-outdated';
  return null;
}
