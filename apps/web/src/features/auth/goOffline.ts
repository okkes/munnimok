import { entriesOnTopOf } from '@/application/entryLink';
import { forgetSpacesNotifyOff } from '@/application/spaceNotifications';
import { apiFetch } from '@/lib/api';
import { reportError } from '@/lib/report';
import { identityKey } from '@/app/session';
import type { Identity } from '@/app/session';
import { getClock } from '@/db/device';
import { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { AccountRow } from '@/db/types';
import { adoptOfflineProfile } from './offlineProfiles';

// an identity REBIND, not a data migration (local-first): the offline profile adopts the existing store;
// bank-linked accounts flip to manual, shared spaces are kept as snapshot or purged, server data is deleted outright;
// every server call is best-effort. The server exit cannot be undone, so it comes last: what can fail fails before it
export interface GoOfflineContext {
  store: StorageBackend;
  engine: { catchUp: () => Promise<boolean>; purgeSpace: (spaceId: string) => Promise<void>; halt: () => Promise<void>; resume: () => void } | null;
  identity: Identity;
}

/** how long the conversion waits for the server's answer: its exit also ends bank consents, and a hung request must not hold the person online */
export const SERVER_EXIT_WAIT_MS = 15_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface GoOfflineOptions {
  dropSpaceIds: readonly string[];
  profileName: string;
  profilePicture?: string;
}

/** nothing was changed: the device could not fetch what the server holds, so the server's copy stays */
export class NotCaughtUpError extends Error {
  constructor() {
    super('the last round before going offline did not reach its end');
    this.name = 'NotCaughtUpError';
  }
}

export async function convertToOffline(ctx: GoOfflineContext, opts: GoOfflineOptions): Promise<string | null> {
  if (ctx.identity.kind !== 'user') return null;

  // the server's copy is deleted at the end: what another device wrote since
  // this one's last round would go with it, so it is fetched first — or nothing happens
  if (ctx.engine && !(await ctx.engine.catchUp())) throw new NotCaughtUpError();

  // no round may run across the conversion: it would pull a dropped space
  // back, or read the ended memberships as evictions and purge what stays
  await ctx.engine?.halt();

  let profileId: string;
  let bankFed: AccountRow[];
  try {
    for (const spaceId of opts.dropSpaceIds) {
      await ctx.engine?.purgeSpace(spaceId);
    }
    bankFed = (await ctx.store.allRows('account')).filter((a) => a.deleted === 0 && a.source === 'connector');
    // last of the steps that can fail, so a profile is never left half-made
    profileId = adoptOfflineProfile(opts.profileName, opts.profilePicture, identityKey(ctx.identity)).id;
  } catch (err) {
    // still a member everywhere: sync goes on and pulls a purged space back
    ctx.engine?.resume();
    throw err;
  }

  // party-fed accounts → manual tier, another member's attached account included: no role
  // guard and no outbox — every space is the profile's own now and nothing syncs any more
  const local = new Repo(ctx.store, getClock(), { trackOutbox: false });
  for (const account of bankFed) {
    // #547: entries typed by hand that still counted on top of the bank's number become part of the balance —
    // no bank number is coming any more that could contain them
    const onTop = await entriesOnTopOf(ctx.store, account).catch(() => 0);
    await local
      .upsert('account', account.spaceId, account.id, { source: 'manual', ...(onTop === 0 ? {} : { balanceCents: account.balanceCents + onTop }) })
      .catch((err: unknown) => reportError('goOffline', err));
  }
  // the account's muted spaces would stay muted in the profile, where no switch reaches them
  await forgetSpacesNotifyOff(ctx.store).catch((err: unknown) => reportError('goOffline', err));

  // server exit, best-effort: going offline always deletes the server data. keepIdentity spares the Logto login
  // (shared by every environment); other devices detect the dead account via the /me binding check and wipe themselves
  await Promise.race([apiFetch('/me?keepIdentity=true', { method: 'DELETE' }).catch(() => undefined), wait(SERVER_EXIT_WAIT_MS)]);

  return profileId;
}
