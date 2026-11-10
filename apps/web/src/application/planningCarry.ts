import { v5 as uuidv5 } from 'uuid';
import type { EntityName } from '@/db/types';

// wall 0, like the server's floor stamp: whatever a person or a device writes to the row wins, whenever it arrives
const CARRIED = '000000000-0000-c';
const WRITTEN_AT = 13;
const DIGEST = 20;
const DIGEST_NAMESPACE = '7f0f4f3a-3c1b-5d0e-9a43-1f6f0c2d9b11';

// a stamp carried again hands on the moment its content was really written: the order holds period after
// period and the stamp never grows (the server refuses one past 64 characters)
const writtenAt = (stamp: string | undefined): string => {
  if (!stamp) return ''.padEnd(WRITTEN_AT, '0');
  const at = stamp.startsWith(CARRIED) ? stamp.slice(CARRIED.length, CARRIED.length + WRITTEN_AT) : `${stamp.slice(0, 9)}${stamp.slice(10, 14)}`;
  return at.padEnd(WRITTEN_AT, '0');
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return Object.fromEntries(entries.map(([key, inner]) => [key, canonical(inner)]));
  }
  return value ?? null;
};

/** every device derives the same stamp for the same content, so a second copy is no write; the digest
 *  leaves no tie between different contents, which the merge would otherwise keep apart per device for good */
export const carriedStamp = (sourceStamp: string | undefined, fields: Readonly<Record<string, unknown>>): string =>
  `${CARRIED}${writtenAt(sourceStamp)}${uuidv5(JSON.stringify(canonical(fields)), DIGEST_NAMESPACE).replaceAll('-', '').slice(0, DIGEST)}`;

/** a source that never was a row (a generated suggestion) has no stamps: its place in the list is all that orders it */
export const orderStamp = (index: number): string => `000000000-${index.toString(36).padStart(4, '0')}-`;

export interface StampedWrite {
  entity: EntityName;
  entityId: string;
  fields: Record<string, unknown>;
  hlc: string;
}

/** each field under the stamp of the source field it comes from: copies made from different states of the
 *  source merge field by field as the source itself did; what the copy sets itself (`own`) rides with `origin` */
export function carriedWrites(
  entity: EntityName,
  entityId: string,
  fields: Readonly<Record<string, unknown>>,
  sourceVersions: Readonly<Record<string, string>>,
  origin: string,
  own: readonly string[] = [],
): StampedWrite[] {
  const groups = new Map<string, { source: string | undefined; fields: Record<string, unknown> }>();
  for (const [field, value] of Object.entries(fields)) {
    const source = own.includes(field) ? sourceVersions[origin] : (sourceVersions[field] ?? sourceVersions[origin]);
    const key = writtenAt(source);
    const group = groups.get(key) ?? { source, fields: {} };
    group.fields[field] = value;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ entity, entityId, fields: group.fields, hlc: carriedStamp(group.source, group.fields) }));
}
