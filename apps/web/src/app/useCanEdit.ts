import { useMemo, useSyncExternalStore } from 'react';
import type { SpaceRole } from '@/sync/spaceAccess';
import { useData } from './data';

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

/** #505: false where the identity only reads; the Repo refuses such writes anyway, this keeps the door from being offered */
export function useCanEdit(spaceId?: string): boolean {
  const { spaceId: active } = useData();
  return useSpaceRole(spaceId ?? active) !== 'reader';
}
