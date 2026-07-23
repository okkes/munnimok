import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import { useSession } from '@/app/session';
import { offlineProfileName } from '@/features/auth/offlineProfiles';

/** newest rows kept per space (user ruling: the last 200 actions) */
export const ACTIVITY_CAP = 200;

/**
 * Append one "who did what" line to the space's history (YNAB-style,
 * user request). The actor's display name is frozen at write time so
 * every member's device can render it offline. Writes ride the normal
 * Repo/outbox path — history syncs like any other space data.
 */
export async function logActivity(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  kind: string,
  detail?: string,
): Promise<void> {
  try {
    const profile = (await store.metaGet('profile'))?.value as { name?: string } | undefined;
    // actor resolution: profile display name first, the offline profile's
    // name as fallback — plus the sub so other devices can render "You"
    const identity = useSession.getState().identity;
    const actorName =
      profile?.name ?? (identity?.kind === 'offline' ? offlineProfileName(identity.profileId) : undefined);
    await repo.upsert('activity', spaceId, repo.newId(), {
      kind,
      ...(actorName ? { actorName } : {}),
      ...(identity?.kind === 'user' ? { actorSub: identity.sub } : {}),
      ...(detail ? { detail } : {}),
      at: new Date().toISOString(),
    });
    await pruneActivity(store, repo, spaceId);
  } catch {
    // history is a nicety — it must never break the action it records
  }
}

/** tombstone everything beyond the newest ACTIVITY_CAP rows */
export async function pruneActivity(store: StorageBackend, repo: Repo, spaceId: string): Promise<void> {
  const rows = (await store.bySpace('activity', spaceId)).filter((r) => r.deleted === 0);
  if (rows.length <= ACTIVITY_CAP) return;
  const oldestFirst = [...rows].sort((a, b) => a.at.localeCompare(b.at));
  const excess = oldestFirst.slice(0, rows.length - ACTIVITY_CAP);
  for (const row of excess) await repo.remove('activity', spaceId, row.id);
}
