import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';

// the `shared` flip used to happen on the owner's device only: a joiner's copy stayed `personal` without the badge (#277);
// these helpers stamp/heal it from either side, every write an idempotent LWW upsert

interface MemberLike {
  userId: string;
  displayName: string | null;
  role: string;
}

/** returns whether the kind flipped (callers log activity for deliberate shares only); writes only missing fields */
export async function ensureSpaceShared(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  creatorName?: string | null,
): Promise<boolean> {
  const space = await store.get('space', spaceId);
  if (space?.deleted !== 0) return false;
  const flip = space.kind !== 'shared';
  const fields: { kind?: 'shared'; createdByName?: string } = {};
  if (flip) fields.kind = 'shared';
  if (!space.createdByName && creatorName) fields.createdByName = creatorName;
  if (fields.kind === undefined && fields.createdByName === undefined) return false;
  await repo.upsert('space', spaceId, spaceId, fields);
  return flip;
}

/** a space the server says has 2+ members IS shared whatever the local row claims; the owner row backfills createdByName */
export async function healSharedKind(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  members: readonly MemberLike[],
): Promise<void> {
  if (members.length < 2) return;
  const owner = members.find((m) => m.role === 'owner');
  try {
    // #505: a reader's copy learns it from the members who may write the row
    await ensureSpaceShared(store, repo.upkeep(), spaceId, owner?.displayName ?? null);
  } catch {
    // best-effort — it runs again on the next members fetch
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type JoinTarget = { spaceId: string } | { except: ReadonlySet<string>; name: string };

async function joinedRows(store: StorageBackend, target: JoinTarget) {
  if ('spaceId' in target) {
    const row = await store.get('space', target.spaceId);
    return row?.deleted === 0 ? [row] : [];
  }
  // the friend-accept payload names no space id: the joined space is the one `except` did not know that wears the request's
  // name (the name gate keeps a still-syncing personal space from being mis-stamped)
  return (await store.allRows('space')).filter(
    (row) => row.deleted === 0 && !target.except.has(row.id) && row.name === target.name,
  );
}

// bounded retries cover the engine's re-entrancy guard (a running boot pass makes syncAll a no-op);
// the members-fetch heal is the backstop when the server stays away
export async function stampJoinedSharedSpace(
  store: StorageBackend,
  repo: Repo,
  sync: () => Promise<void>,
  target: JoinTarget,
  creatorName?: string | null,
  attempts = 4,
): Promise<void> {
  try {
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await wait(700);
      await sync();
      const rows = await joinedRows(store, target);
      if (rows.length > 0) {
        // #505: joined as a reader, the stamp is the owner's devices' to make
        for (const row of rows) await ensureSpaceShared(store, repo.upkeep(), row.id, creatorName);
        return;
      }
    }
  } catch {
    // best-effort — a torn-down store mid-retry must not surface
  }
}
