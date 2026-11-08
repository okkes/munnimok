import type { StorageBackend } from '@/db/backend';

/** a member's say in a space — the server's names (Social/SpaceRoles.cs) */
export type SpaceRole = 'owner' | 'contributor' | 'reader';

/** the roles the server last named, per space (this identity's database) */
export const SPACE_ROLES_KEY = 'spaceRoles';
/** #505: changes undone because the space only lets this identity read — the notice's list */
export const UNSAVED_UNDONE_KEY = 'unsavedUndone';

const ROLES: ReadonlySet<string> = new Set<SpaceRole>(['owner', 'contributor', 'reader']);

/**
 * #505: a write into a space this identity may only read. The Repo throws it
 * before the row changes or an op is queued — the server would refuse the
 * push, and a change kept only here would show the reader something no
 * other member ever sees.
 */
export class SpaceReadOnlyError extends Error {
  constructor(readonly spaceId: string) {
    super(`space ${spaceId} is read-only for this identity`);
    this.name = 'SpaceReadOnlyError';
  }
}

/** one space's changes that never landed, for the notice */
export interface UnsavedUndone {
  spaceId: string;
  spaceName: string;
  count: number;
}

export async function readSpaceRoles(store: StorageBackend): Promise<Record<string, SpaceRole>> {
  const value = (await store.metaGet(SPACE_ROLES_KEY))?.value;
  return value && typeof value === 'object' ? (value as Record<string, SpaceRole>) : {};
}

export async function readUnsavedUndone(store: StorageBackend): Promise<UnsavedUndone[]> {
  const value = (await store.metaGet(UNSAVED_UNDONE_KEY))?.value;
  return Array.isArray(value) ? (value as UnsavedUndone[]) : [];
}

/** adds a space's undone changes to the notice (one entry per space, counts add up) */
export async function noteUnsavedUndone(store: StorageBackend, entry: UnsavedUndone): Promise<void> {
  const list = await readUnsavedUndone(store);
  const prior = list.find((e) => e.spaceId === entry.spaceId);
  const next = prior
    ? list.map((e) => (e === prior ? { ...entry, count: prior.count + entry.count, spaceName: entry.spaceName || prior.spaceName } : e))
    : [...list, entry];
  await store.metaPut(UNSAVED_UNDONE_KEY, next);
}

const sameRoles = (a: Readonly<Record<string, SpaceRole>>, b: Readonly<Record<string, SpaceRole>>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/**
 * #505: what this identity may do in each space, as the server last said —
 * kept on the device (a reader stays a reader offline) and held in memory,
 * because the Repo asks on every write. A space the server never named — a
 * new space not pushed yet, every space of an identity that never syncs —
 * is writable.
 */
export class SpaceAccess {
  private roles: Readonly<Record<string, SpaceRole>> = {};
  private readonly listeners = new Set<() => void>();

  /** `store` null: an identity that never syncs (demo, offline) */
  constructor(private readonly store: StorageBackend | null) {}

  async hydrate(): Promise<void> {
    if (this.store) this.replace(await readSpaceRoles(this.store));
  }

  roleOf(spaceId: string): SpaceRole | undefined {
    return this.roles[spaceId];
  }

  isReadOnly(spaceId: string): boolean {
    return this.roles[spaceId] === 'reader';
  }

  /**
   * The round's heads: every space the identity reaches with its role there —
   * the whole picture replaces the last one. A server that names no role
   * (older than #505) leaves what is known alone.
   */
  async record(heads: readonly { spaceId: string; role?: string }[]): Promise<void> {
    const named = heads.filter((h): h is { spaceId: string; role: SpaceRole } => !!h.role && ROLES.has(h.role));
    if (named.length === 0) return;
    await this.persist(Object.fromEntries(named.map((h) => [h.spaceId, h.role])));
  }

  /** one space's role learned outside a round: the members list, a push the server refused */
  async note(spaceId: string, role: SpaceRole): Promise<void> {
    if (this.roles[spaceId] !== role) await this.persist({ ...this.roles, [spaceId]: role });
  }

  /** for useSyncExternalStore: the same object until a role changes */
  readonly snapshot = (): Readonly<Record<string, SpaceRole>> => this.roles;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private replace(next: Readonly<Record<string, SpaceRole>>): boolean {
    if (sameRoles(this.roles, next)) return false;
    this.roles = next;
    for (const listener of this.listeners) listener();
    return true;
  }

  /** memory first — the very next write already sees the role */
  private async persist(next: Record<string, SpaceRole>): Promise<void> {
    if (this.replace(next) && this.store) await this.store.metaPut(SPACE_ROLES_KEY, next);
  }
}
