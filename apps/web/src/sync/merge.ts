import { compareHlc } from './hlc';

/**
 * Per-field last-writer-wins merge — the convergence core of the sync
 * protocol. The same rule runs on every device and on the server, so any
 * order of applying the same set of ops ends in the same state.
 *
 * Deletion is a pseudo-field ($deleted). A row counts as deleted only when
 * the tombstone is newer than every field edit — so an edit made after
 * (or concurrent-but-later than) a delete revives the row, regardless of
 * which op arrives first. Keeping `deleted` derived from fieldVersions is
 * what makes the merge commutative.
 */

export const DELETED_FIELD = '$deleted';

export interface SyncEnvelope {
  /** field name -> encoded HLC of the last write to that field ($deleted included) */
  fieldVersions: Record<string, string>;
  /** derived from fieldVersions; stored for indexability (0|1 for Dexie) */
  deleted: 0 | 1;
}

export interface Op {
  opId: string;
  spaceId: string;
  entity: string;
  entityId: string;
  /** changed fields and their new values */
  fields: Record<string, unknown>;
  hlc: string;
  deleted?: boolean;
}

export interface MergeResult<T> {
  row: T & SyncEnvelope;
  /** fields from the op that actually won (newer than local); empty if the op was entirely stale */
  appliedFields: string[];
  changed: boolean;
}

function deriveDeleted(fieldVersions: Record<string, string>): 0 | 1 {
  const tombstone = fieldVersions[DELETED_FIELD];
  if (!tombstone) return 0;
  for (const [field, version] of Object.entries(fieldVersions)) {
    if (field !== DELETED_FIELD && compareHlc(version, tombstone) > 0) return 0;
  }
  return 1;
}

/**
 * Apply an op to the local version of a row (null when the row is unknown).
 * Returns the merged row; `changed === false` means the op was entirely stale.
 */
export function applyOp<T extends Record<string, unknown>>(
  local: (T & SyncEnvelope) | null,
  op: Op,
): MergeResult<T> {
  const fieldVersions = { ...local?.fieldVersions };
  const merged: Record<string, unknown> = { ...local };
  const appliedFields: string[] = [];

  for (const [field, value] of Object.entries(op.fields)) {
    const current = fieldVersions[field];
    if (!current || compareHlc(op.hlc, current) > 0) {
      fieldVersions[field] = op.hlc;
      merged[field] = value;
      appliedFields.push(field);
    }
  }

  if (op.deleted) {
    const current = fieldVersions[DELETED_FIELD];
    if (!current || compareHlc(op.hlc, current) > 0) {
      fieldVersions[DELETED_FIELD] = op.hlc;
      appliedFields.push(DELETED_FIELD);
    }
  }

  if (local && appliedFields.length === 0) {
    return { row: local, appliedFields, changed: false };
  }

  merged.fieldVersions = fieldVersions;
  merged.deleted = deriveDeleted(fieldVersions);
  return { row: merged as T & SyncEnvelope, appliedFields, changed: true };
}

/**
 * #505, undoing writes the server never took: the fields those writes
 * stamped lose their version but keep their value (the row still renders
 * whole), so any op on them wins — a pull from the start lays the
 * server's values back over them.
 */
export function unstampWrites<T extends SyncEnvelope>(row: T, hlcs: ReadonlySet<string>): T {
  const fieldVersions = Object.fromEntries(
    Object.entries(row.fieldVersions ?? {}).map(([field, version]) => [field, hlcs.has(version) ? '' : version]),
  );
  return { ...row, fieldVersions, deleted: deriveDeleted(fieldVersions) };
}

/**
 * …and once that pull is through: what no op ever wrote again is gone
 * from the row — null when nothing of it is left (only this device ever
 * had it).
 */
export function dropUnstamped<T extends SyncEnvelope>(row: T): T | null {
  const merged: Record<string, unknown> = { ...(row as SyncEnvelope & Record<string, unknown>) };
  const fieldVersions: Record<string, string> = {};
  for (const [field, version] of Object.entries(row.fieldVersions ?? {})) {
    if (version) fieldVersions[field] = version;
    else if (field !== DELETED_FIELD) delete merged[field];
  }
  if (Object.keys(fieldVersions).length === 0) return null;
  return { ...merged, fieldVersions, deleted: deriveDeleted(fieldVersions) } as T;
}
