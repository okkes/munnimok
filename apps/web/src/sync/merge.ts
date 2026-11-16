import { compareHlc } from './hlc';

// per-field last-writer-wins: the same rule runs on every device and the server, so any order of the same ops converges
// deletion is the pseudo-field $deleted: a row is deleted only while the tombstone is newer than every field edit,
// so a later edit revives it whichever op arrives first; deriving `deleted` from fieldVersions keeps it commutative

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

/** a row as the server holds it: every field with the stamp of the write that won it (#606) */
export interface SnapshotRow {
  entity: string;
  entityId: string;
  data: Record<string, unknown>;
  fieldVersions: Record<string, string>;
}

/** the server's row as one op per stamp, applied by the pull's own rule: a field this device wrote later keeps its value */
export function snapshotOps(spaceId: string, row: SnapshotRow): Op[] {
  const byStamp = new Map<string, Op>();
  for (const [field, hlc] of Object.entries(row.fieldVersions)) {
    let op = byStamp.get(hlc);
    if (!op) {
      op = { opId: '', spaceId, entity: row.entity, entityId: row.entityId, fields: {}, hlc };
      byStamp.set(hlc, op);
    }
    if (field === DELETED_FIELD) op.deleted = true;
    else op.fields[field] = row.data[field];
  }
  return [...byStamp.values()];
}

// #505: fields stamped by writes the server never took lose their version but keep their value (the row still renders
// whole), so any op wins: a pull from the start lays the server's values back
export function unstampWrites<T extends SyncEnvelope>(row: T, hlcs: ReadonlySet<string>): T {
  const fieldVersions = Object.fromEntries(
    Object.entries(row.fieldVersions ?? {}).map(([field, version]) => [field, hlcs.has(version) ? '' : version]),
  );
  return { ...row, fieldVersions, deleted: deriveDeleted(fieldVersions) };
}

// once that pull is through: fields no op wrote again are dropped; null when nothing is left (only this device had the row)
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
