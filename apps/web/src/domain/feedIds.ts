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

/** the owner's personal STORE FEED — global receipts + instance metadata */
export const storeFeedId = (sub: string): string => personalFeedSpaceId('STORES', sub);
