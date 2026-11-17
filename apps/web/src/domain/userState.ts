import { v5 as uuidv5 } from 'uuid';
import { decodeHlc } from '@/sync/hlc';

// #148: per-user state that must agree across devices rides sync through a PRIVATE space whose id derives from the Logto sub
// (nobody can pre-claim it); the version nibble is forced to 8 because the server's feed-shape guard keys on v5;
// no local space row, so no list shows it
const USER_STATE_NS = '9c1f4b2e-6a3d-4f7b-8c5e-2d1a0b9e8f31';

export function userStateSpaceId(sub: string): string {
  const id = uuidv5(`userstate:${sub}`, USER_STATE_NS);
  return `${id.slice(0, 14)}8${id.slice(15)}`;
}

/** the per-space baseline row: when the first-seen scheme started */
export const txSeenBaseId = (forSpaceId: string): string => uuidv5(`txseenbase:${forSpaceId}`, USER_STATE_NS);

/** one row per first-seen transaction — deterministic, so two devices
 *  first-seeing the same row converge on ONE record */
export const txSeenRowId = (forSpaceId: string, txId: string): string =>
  uuidv5(`txseen:${forSpaceId}:${txId}`, USER_STATE_NS);

/** the earliest wall-clock any field of the row was written — a row
 *  born before the baseline is known history, never "new" */
export function bornAtMs(fieldVersions: Record<string, string> | undefined): number {
  const versions = Object.values(fieldVersions ?? {});
  if (versions.length === 0) return 0;
  return Math.min(...versions.map((v) => decodeHlc(v).wallMs));
}
