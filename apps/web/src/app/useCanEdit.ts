import { useMemo, useSyncExternalStore } from 'react';
import type { SpaceRole } from '@/sync/spaceAccess';
import { useData } from './data';

/** #505: the spaces this identity only reads — for a list of spaces to pick from */
export function useReadOnlySpaceIds(): ReadonlySet<string> {
  const { access } = useData();
  const roles = useSyncExternalStore(access.subscribe, access.snapshot);
  return useMemo(() => new Set(Object.keys(roles).filter((id) => roles[id] === 'reader')), [roles]);
}

/** #505: this identity's role in the space as the server last named it — undefined while unnamed (writable) */
export function useSpaceRole(spaceId: string | undefined): SpaceRole | undefined {
  const { access } = useData();
  const roles = useSyncExternalStore(access.subscribe, access.snapshot);
  return spaceId ? roles[spaceId] : undefined;
}

/**
 * #505 (user): whether this identity may change the space (the active one
 * by default) — false where it only reads. Every edit door asks here; the
 * Repo refuses such a write anyway, this keeps the door from being offered.
 */
export function useCanEdit(spaceId?: string): boolean {
  const { spaceId: active } = useData();
  return useSpaceRole(spaceId ?? active) !== 'reader';
}
