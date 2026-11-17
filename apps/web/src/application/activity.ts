import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { EntityName } from '@/db/types';
import { useSession } from '@/app/session';
import { offlineProfileName } from '@/features/auth/offlineProfiles';

// newest 200 rows or 90 days, whichever is smaller: the cap bounds sync payloads, the age bound keeps a dormant space
// from replaying stale history
export const ACTIVITY_CAP = 200;
export const ACTIVITY_MAX_AGE_DAYS = 90;

/** the actor's display name is frozen at write time, so every member's device renders it offline */
export interface ActivityFigures {
  detail2?: string;
  amountCents?: number;
  fromCents?: number;
}

export async function logActivity(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  kind: string,
  detail?: string,
  figures?: ActivityFigures,
): Promise<void> {
  try {
    const profile = (await store.metaGet('profile'))?.value as { name?: string } | undefined;
    // actor: profile name, else the offline profile's; the sub lets other devices render "You"
    const identity = useSession.getState().identity;
    const actorName =
      profile?.name ?? (identity?.kind === 'offline' ? offlineProfileName(identity.profileId) : undefined);
    await repo.upsert('activity', spaceId, repo.newId(), {
      kind,
      ...(actorName ? { actorName } : {}),
      ...(identity?.kind === 'user' ? { actorSub: identity.sub } : {}),
      ...(detail ? { detail } : {}),
      ...figures,
      at: new Date().toISOString(),
    });
    await pruneActivity(store, repo, spaceId);
  } catch {
    // history is a nicety — it must never break the action it records
  }
}

export async function logRowActivity(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  table: EntityName,
  id: string,
  kind: string,
  name?: string,
): Promise<void> {
  try {
    const detail = name ?? ((await store.get(table, id)) as { name?: string } | undefined)?.name;
    await logActivity(store, repo, spaceId, kind, detail);
  } catch {
    // history is a nicety — it must never break the action it records
  }
}

export async function pruneActivity(store: StorageBackend, repo: Repo, spaceId: string): Promise<void> {
  const rows = (await store.bySpace('activity', spaceId)).filter((r) => r.deleted === 0);
  const cutoff = new Date(Date.now() - ACTIVITY_MAX_AGE_DAYS * 86_400_000).toISOString();
  const oldestFirst = [...rows].sort((a, b) => a.at.localeCompare(b.at));
  const overCap = Math.max(0, rows.length - ACTIVITY_CAP);
  const excess = oldestFirst.filter((row, i) => i < overCap || row.at < cutoff);
  for (const row of excess) await repo.remove('activity', spaceId, row.id);
}
