import { v5 as uuidv5 } from 'uuid';

// ids derive from the import namespace shared with the server: any device or reconnecting member gets identical ids
const IMPORT_NS = '5f3c9a70-0d3e-4e0f-9a57-6d2b3a1c8e42';

export const normalizeIban = (iban: string) => iban.replaceAll(/\s/g, '').toUpperCase();

export const feedSpaceId = (iban: string): string => uuidv5(`feed:${normalizeIban(iban)}`, IMPORT_NS);

// a bank-fed account owning `acct:{iban}` keeps statement imports as a separate account until the user merges (#311);
// the server forks `acct:{iban}:bank` when the import owned the canonical id first
export const importAccountId = (iban: string): string => uuidv5(`acct:${normalizeIban(iban)}:import`, IMPORT_NS);

/** the canonical per-IBAN account id (shared with the server's ImportIds) */
export const canonicalAccountId = (iban: string): string => uuidv5(`acct:${normalizeIban(iban)}`, IMPORT_NS);

// salted with the owner's subject when another user registered the deterministic feed id (squatting defence, S1)
// costs only cross-user dedupe
export const personalFeedSpaceId = (iban: string, sub: string): string =>
  uuidv5(`feed:${normalizeIban(iban)}:${sub}`, IMPORT_NS);

export const txMetaId = (spaceId: string, txId: string): string => uuidv5(`meta:${spaceId}:${txId}`, IMPORT_NS);

/** minted counter leg of a transfer to a MANUAL account; deterministic so two devices converge on one mirror */
export const mirrorTxId = (txId: string): string => uuidv5(`mirror:${txId}`, IMPORT_NS);

/** a part's counter leg: ':' never occurs in real ids (uuid charset), so the key is unambiguous */
export const partMirrorSourceId = (txId: string, partId: string): string => `${txId}:${partId}`;

/** the app's own counter leg (a row's or a part's mint): its id IS the
 *  mirror of the source it points back at — no bank row, nobody's decision */
export const isMintedLeg = (tx: { id: string; transferPeerId?: string }): boolean =>
  !!tx.transferPeerId && tx.id === mirrorTxId(tx.transferPeerId);

export const accountLinkId = (spaceId: string, feedId: string): string =>
  uuidv5(`link:${spaceId}:${feedId}`, IMPORT_NS);

/** deterministic so two owners' devices adopting concurrently converge on the same rows */
export const adoptedCategoryId = (spaceId: string, sourceCatId: string): string =>
  uuidv5(`catcopy:${spaceId}:${sourceCatId}`, IMPORT_NS);

export const recurringDismissId = (spaceId: string, merchantKeyValue: string): string =>
  uuidv5(`recdis:${spaceId}:${merchantKeyValue}`, IMPORT_NS);

export const receiptLinkId = (spaceId: string, receiptId: string): string =>
  uuidv5(`rlink:${spaceId}:${receiptId}`, IMPORT_NS);

/** #630: what a receipt or a link holds in one of its slots (its photo, its n-th document); the server's ingest names
 *  an invoice the same way, and a device and the server splitting the same old row land on one file */
export const receiptFileId = (ownerId: string, slot: string): string => uuidv5(`rfile:${ownerId}:${slot}`, IMPORT_NS);

/** the id of a change every writer derives from the same seed (the server's ImportIds.OpId): the server keeps it once */
export const importOpId = (seed: string): string => uuidv5(`op:${seed}`, IMPORT_NS);

export const storeConnLinkId = (spaceId: string, instanceId: string): string => `sclink:${spaceId}:${instanceId}`;

/** the owner's personal feed that lists their connections (it held every receipt before #648) */
export const storeFeedId = (sub: string): string => personalFeedSpaceId('STORES', sub);

// #648: a connection's receipts are a feed of their own, a person's scans another — a space is given one to read,
// never everything the person holds (the server's ImportIds names them the same way)
export const receiptFeedRef = (connectionId: string): string => `STORE:${connectionId}`;
export const SCANS_FEED_REF = 'SCANS';
export const receiptFeedId = (connectionId: string, sub: string): string => personalFeedSpaceId(receiptFeedRef(connectionId), sub);
export const scansFeedId = (sub: string): string => personalFeedSpaceId(SCANS_FEED_REF, sub);

const ENTITY_ID_MAX = 128;
const fit = (prefix: string, rest: string): string => (prefix.length + rest.length <= ENTITY_ID_MAX ? prefix + rest : prefix + importOpId(rest));

/** the id a receipt has in its own feed: what the ingest names a fetched one, or a scan's (the server's ReceiptFeeds) */
export function movedReceiptId(oldId: string, scan: boolean): string {
  if (scan) return fit('scan:', oldId);
  return fit('rcp2:', oldId.startsWith('rcpt:') ? oldId.slice('rcpt:'.length) : oldId);
}

/** the receipt a space made itself out of the copy a link held */
export const spaceReceiptId = (linkId: string): string => fit('srcp:', linkId);
