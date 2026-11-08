import { describe, expect, it } from 'vitest';
import { encodeHlc } from './hlc';
import { applyOp, dropUnstamped, unstampWrites } from './merge';
import type { Op, SyncEnvelope } from './merge';

type Row = Record<string, unknown> & SyncEnvelope;

const hlc = (wallMs: number, deviceId = 'a', counter = 0) => encodeHlc({ wallMs, counter, deviceId });

const op = (partial: Partial<Op> & Pick<Op, 'fields' | 'hlc'>): Op => ({
  opId: crypto.randomUUID(),
  spaceId: 's1',
  entity: 'category',
  entityId: 'c1',
  ...partial,
});

function applyAll(local: Row | null, ops: Op[]): Row | null {
  let row = local;
  for (const o of ops) row = applyOp(row, o).row;
  return row;
}

// JSON.stringify with sorted keys so structural equality isn't defeated by
// property insertion order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

describe('applyOp', () => {
  it('creates a row from the first op', () => {
    const { row, changed } = applyOp(null, op({ fields: { name: 'Food', color: 'red' }, hlc: hlc(100) }));
    expect(changed).toBe(true);
    expect(row).toMatchObject({ name: 'Food', color: 'red', deleted: 0 });
  });

  it('merges concurrent edits to different fields — both survive', () => {
    const base = applyOp(null, op({ fields: { name: 'Food', color: 'red' }, hlc: hlc(100) })).row!;
    const renamed = applyOp(base, op({ fields: { name: 'Groceries' }, hlc: hlc(200, 'phone') })).row!;
    const recolored = applyOp(renamed, op({ fields: { color: 'green' }, hlc: hlc(150, 'laptop') })).row!;
    expect(recolored).toMatchObject({ name: 'Groceries', color: 'green' });
  });

  it('same field: later HLC wins regardless of arrival order', () => {
    const base = applyOp(null, op({ fields: { name: 'Food' }, hlc: hlc(100) })).row!;
    const early = op({ fields: { name: 'Eten' }, hlc: hlc(150, 'phone') });
    const late = op({ fields: { name: 'Yemek' }, hlc: hlc(200, 'laptop') });

    const lateFirst = applyAll(base, [late, early]);
    const earlyFirst = applyAll(base, [early, late]);
    expect(lateFirst).toEqual(earlyFirst);
    expect(lateFirst).toMatchObject({ name: 'Yemek' });
  });

  it('stale op is a no-op and reports changed=false', () => {
    const base = applyOp(null, op({ fields: { name: 'Food' }, hlc: hlc(200) })).row!;
    const result = applyOp(base, op({ fields: { name: 'Old' }, hlc: hlc(100, 'z') }));
    expect(result.changed).toBe(false);
    expect(result.row).toMatchObject({ name: 'Food' });
  });

  it('delete tombstones the row; older edits cannot resurrect it', () => {
    const base = applyOp(null, op({ fields: { name: 'Food' }, hlc: hlc(100) })).row!;
    const deleted = applyOp(base, op({ fields: {}, hlc: hlc(300), deleted: true })).row!;
    expect(deleted.deleted).toBe(1);
    const afterStaleEdit = applyOp(deleted, op({ fields: { name: 'Zombie' }, hlc: hlc(200, 'phone') })).row!;
    expect(afterStaleEdit.deleted).toBe(1);
  });

  it('an edit newer than the tombstone revives the row', () => {
    const base = applyOp(null, op({ fields: { name: 'Food' }, hlc: hlc(100) })).row!;
    const deleted = applyOp(base, op({ fields: {}, hlc: hlc(300), deleted: true })).row!;
    const revived = applyOp(deleted, op({ fields: { name: 'Back' }, hlc: hlc(400, 'phone') })).row!;
    expect(revived).toMatchObject({ deleted: 0, name: 'Back' });
  });

  it('delete for a never-seen row materializes a tombstone', () => {
    const { row } = applyOp(null, op({ fields: {}, hlc: hlc(100), deleted: true }));
    expect(row?.deleted).toBe(1);
  });

  it('convergence: any interleaving of the same ops ends in the same state', () => {
    const ops: Op[] = [
      op({ fields: { name: 'A', color: 'red' }, hlc: hlc(100, 'p') }),
      op({ fields: { name: 'B' }, hlc: hlc(120, 'q') }),
      op({ fields: { color: 'blue' }, hlc: hlc(110, 'r') }),
      op({ fields: {}, hlc: hlc(130, 'p'), deleted: true }),
      op({ fields: { name: 'C' }, hlc: hlc(140, 'q') }),
    ];
    // all 120 permutations
    const permutations = (arr: Op[]): Op[][] =>
      arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest]));

    const outcomes = new Set(
      permutations(ops).map((order) => canonical(applyAll(null, order))),
    );
    expect(outcomes.size).toBe(1);
    const final = JSON.parse([...outcomes][0]);
    expect(final).toMatchObject({ name: 'C', color: 'blue', deleted: 0 });
  });
});

describe('undoing writes the server never took (#505)', () => {
  const server = hlc(1_000, 'owner');
  const mine = hlc(2_000, 'reader');

  it('the row keeps rendering until the server’s values come back over it', () => {
    const local = applyAll(null, [op({ fields: { name: 'Food', color: 'red' }, hlc: server }), op({ fields: { name: 'Mine', note: 'x' }, hlc: mine })])!;

    const unstamped = unstampWrites(local, new Set([mine]));
    expect(unstamped).toMatchObject({ name: 'Mine', note: 'x', color: 'red' });
    const repulled = applyOp(unstamped, op({ fields: { name: 'Food', color: 'red' }, hlc: server })).row;
    expect(dropUnstamped(repulled)).toMatchObject({ name: 'Food', color: 'red', deleted: 0 });
    expect(dropUnstamped(repulled)).not.toHaveProperty('note');
  });

  it('a delete of its own is taken back too', () => {
    const local = applyAll(null, [op({ fields: { name: 'Food' }, hlc: server }), op({ fields: {}, deleted: true, hlc: mine })])!;
    expect(local.deleted).toBe(1);
    expect(unstampWrites(local, new Set([mine])).deleted).toBe(0);
  });

  it('a row only this device ever wrote is gone', () => {
    const local = applyAll(null, [op({ fields: { name: 'Trip' }, hlc: mine })])!;
    expect(dropUnstamped(unstampWrites(local, new Set([mine])))).toBeNull();
  });
});
