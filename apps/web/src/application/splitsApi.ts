import { apiFetch } from '@/lib/api';

/**
 * Split events (#538) live on the server and nowhere else: roles, a link's
 * uses, the queue and "settled" are rules one place keeps, so the app only
 * asks and shows — it needs a connection and an account, and keeps no copy.
 * Every call answers null when it could not be asked or was refused; the
 * screens say "no connection" or re-read, never guess.
 */

export type SplitStatus = 'open' | 'settled' | 'archived';
export type SplitRole = 'owner' | 'contributor';
export type SplitMemberState = 'active' | 'left' | 'removed';
export type SplitShareMode = 'equal' | 'exact' | 'percent';

export interface SplitSummary {
  id: string;
  name: string;
  currency: string;
  status: SplitStatus;
  role: SplitRole;
  /** the caller's own standing: someone who left or was taken out still reads the event */
  state: SplitMemberState;
  picture: string | null;
  startDate: string | null;
  endDate: string | null;
  attachedSpaceId: string | null;
  attachedEventId: string | null;
  memberCount: number;
  entryCount: number;
  /** what the event cost: its expenses together, in its currency */
  totalCents: number;
  /** where the caller stands: owed (+) or owing (−) */
  myBalanceCents: number;
  /** set while a deletion counts down */
  deleteAt: string | null;
}

export interface SplitMember {
  userId: string;
  role: SplitRole;
  state: SplitMemberState;
  displayName: string | null;
  picture: string | null;
  isMe: boolean;
}

export interface SplitShare {
  userId: string;
  cents: number;
  pct?: number | null;
}

export interface SplitEntry {
  id: string;
  /** an expense somebody paid for the group, or a payment one member made to another */
  kind: 'expense' | 'settlement';
  paidByUserId: string;
  description: string;
  amountCents: number;
  date: string;
  shareMode: SplitShareMode;
  shares: SplitShare[];
  originalCurrency: string | null;
  originalCents: number | null;
  hasReceipt: boolean;
  /** the adder's private backlink — the server hands it to them alone */
  sourceTxId: string | null;
  sourceSpaceId: string | null;
  createdBy: string;
  canEdit: boolean;
}

export interface SplitPayment {
  id: string;
  fromUserId: string;
  toUserId: string;
  amountCents: number;
  paidAt: string | null;
}

export interface SplitJoinRequest {
  id: string;
  userId: string;
  displayName: string | null;
  picture: string | null;
  createdAt: string;
}

export interface SplitFriendInvite {
  id: string;
  toUserId: string;
  displayName: string | null;
  picture: string | null;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

export interface SplitDetail {
  split: SplitSummary;
  members: SplitMember[];
  entries: SplitEntry[];
  payments: SplitPayment[];
  /** owners only */
  requests: SplitJoinRequest[] | null;
  friendInvites: SplitFriendInvite[] | null;
}

export interface SplitLink {
  token: string | null;
  expiresAt: string | null;
  /** 0 = any number of people */
  maxUses: number;
  uses: number;
  needsApproval: boolean;
}

export interface SplitLinkOptions {
  maxUses?: number;
  needsApproval?: boolean;
  /** 0 or absent = no end date */
  validDays?: number;
}

export interface SplitPeek {
  splitName: string;
  currency: string;
  picture: string | null;
  inviterName: string | null;
  mine: boolean;
  member: boolean;
  splitId: string | null;
  needsApproval: boolean;
  waiting: boolean;
  removed: boolean;
}

export interface SplitInvitation {
  id: string;
  splitId: string;
  splitName: string;
  picture: string | null;
  fromName: string | null;
  createdAt: string;
}

export interface SplitFacts {
  name: string;
  currency: string;
  picture: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface SplitEntryDraft {
  id: string;
  kind: 'expense' | 'settlement';
  paidByUserId: string;
  description: string;
  amountCents: number;
  date: string;
  shareMode: SplitShareMode;
  shares: { userId: string; cents?: number; pct?: number }[];
  originalCurrency?: string | null;
  originalCents?: number | null;
  /** a picture sets or replaces the photo, an empty text takes it off, absent leaves it */
  receipt?: string;
  sourceTxId?: string | null;
  sourceSpaceId?: string | null;
}

export interface SplitTransfer {
  fromUserId: string;
  toUserId: string;
  amountCents: number;
}

/** what a call came to when it was answered at all */
export interface SplitAnswer<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

async function ask<T>(path: string, method = 'GET', body?: unknown): Promise<SplitAnswer<T> | null> {
  const res = await apiFetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => null);
  if (!res) return null;
  const parsed = res.ok ? ((await res.json().catch(() => null)) as T | null) : null;
  return { ok: res.ok, status: res.status, body: parsed };
}

/** the answer's body when the call went well, else null */
const got = async <T>(call: Promise<SplitAnswer<T> | null>): Promise<T | null> => {
  const answer = await call;
  return answer?.ok ? answer.body : null;
};

/** whether the call went well */
const done = async (call: Promise<SplitAnswer<unknown> | null>): Promise<boolean> => (await call)?.ok === true;

export interface SplitsApi {
  list(): Promise<SplitSummary[] | null>;
  /** the event; 'gone' when it does not exist for the caller (deleted, or never theirs) */
  get(splitId: string): Promise<SplitDetail | 'gone' | null>;
  create(id: string, facts: SplitFacts, spaceId: string): Promise<boolean>;
  update(splitId: string, facts: SplitFacts): Promise<boolean>;
  attach(splitId: string, wiring: { spaceId?: string; eventId?: string | null }): Promise<boolean>;
  leave(splitId: string): Promise<boolean>;
  promote(splitId: string, userId: string): Promise<boolean>;
  removeMember(splitId: string, userId: string): Promise<boolean>;
  link(splitId: string): Promise<SplitLink | null>;
  newLink(splitId: string, options: SplitLinkOptions): Promise<SplitLink | null>;
  endLink(splitId: string): Promise<boolean>;
  /** null = could not ask; 'gone' = the link does not work (any more) */
  peek(token: string): Promise<SplitPeek | 'gone' | null>;
  /** the caller's place after using a link; 'removed' = an owner took them out before */
  accept(token: string, spaceId: string): Promise<{ splitId: string | null; state: 'joined' | 'member' | 'waiting' } | 'gone' | 'removed' | null>;
  answerRequest(splitId: string, requestId: string, approve: boolean): Promise<boolean>;
  inviteFriend(splitId: string, userId: string): Promise<boolean>;
  cancelFriendInvite(splitId: string, inviteId: string): Promise<boolean>;
  invitations(): Promise<SplitInvitation[] | null>;
  answerInvitation(inviteId: string, accept: boolean): Promise<boolean>;
  addEntry(splitId: string, entry: SplitEntryDraft): Promise<boolean>;
  changeEntry(splitId: string, entry: SplitEntryDraft): Promise<boolean>;
  deleteEntry(splitId: string, entryId: string): Promise<boolean>;
  receipt(splitId: string, entryId: string): Promise<string | null>;
  /** who would pay whom if the event were settled as it stands */
  preview(splitId: string): Promise<SplitTransfer[] | null>;
  settle(splitId: string): Promise<boolean>;
  reopen(splitId: string): Promise<boolean>;
  paid(splitId: string, paymentId: string, paid: boolean): Promise<boolean>;
  archive(splitId: string): Promise<boolean>;
  /** true when the event went at once (nobody else in it), false when a countdown started */
  deleteEvent(splitId: string): Promise<{ deleted: boolean; deleteAt: string | null } | null>;
  keep(splitId: string): Promise<boolean>;
}

const at = (splitId: string) => `/splits/${encodeURIComponent(splitId)}`;

export const serverSplits: SplitsApi = {
  list: () => got(ask<SplitSummary[]>('/splits')),
  get: async (splitId) => {
    const answer = await ask<SplitDetail>(at(splitId));
    if (answer?.status === 404) return 'gone';
    return answer?.ok ? answer.body : null;
  },
  create: (id, facts, spaceId) => done(ask('/splits', 'POST', { id, ...facts, spaceId })),
  update: (splitId, facts) => done(ask(at(splitId), 'PUT', facts)),
  attach: (splitId, wiring) => done(ask(`${at(splitId)}/attach`, 'POST', wiring)),
  leave: (splitId) => done(ask(`${at(splitId)}/leave`, 'POST')),
  promote: (splitId, userId) => done(ask(`${at(splitId)}/members/${userId}/promote`, 'POST')),
  removeMember: (splitId, userId) => done(ask(`${at(splitId)}/members/${userId}`, 'DELETE')),
  link: (splitId) => got(ask<SplitLink>(`${at(splitId)}/invites`)),
  newLink: (splitId, options) => got(ask<SplitLink>(`${at(splitId)}/invites`, 'POST', options)),
  endLink: (splitId) => done(ask(`${at(splitId)}/invites`, 'DELETE')),
  peek: async (token) => {
    const answer = await ask<SplitPeek>(`/splits/invites/${encodeURIComponent(token)}`);
    if (answer?.status === 404) return 'gone';
    return answer?.ok ? answer.body : null;
  },
  accept: async (token, spaceId) => {
    const answer = await ask<{ splitId: string | null; state: 'joined' | 'member' | 'waiting' }>(`/splits/invites/${encodeURIComponent(token)}/accept`, 'POST', { spaceId });
    if (answer?.status === 404) return 'gone';
    if (answer?.status === 403) return 'removed';
    return answer?.ok ? answer.body : null;
  },
  answerRequest: (splitId, requestId, approve) => done(ask(`${at(splitId)}/requests/${requestId}/${approve ? 'approve' : 'refuse'}`, 'POST')),
  inviteFriend: (splitId, userId) => done(ask(`${at(splitId)}/friend-invites`, 'POST', { toUserId: userId })),
  cancelFriendInvite: (splitId, inviteId) => done(ask(`${at(splitId)}/friend-invites/${inviteId}`, 'DELETE')),
  invitations: () => got(ask<SplitInvitation[]>('/splits/friend-invites')),
  answerInvitation: (inviteId, accept) => done(ask(`/splits/friend-invites/${inviteId}/${accept ? 'accept' : 'decline'}`, 'POST')),
  addEntry: (splitId, entry) => done(ask(`${at(splitId)}/entries`, 'POST', entry)),
  changeEntry: (splitId, entry) => done(ask(`${at(splitId)}/entries/${encodeURIComponent(entry.id)}`, 'PUT', entry)),
  deleteEntry: (splitId, entryId) => done(ask(`${at(splitId)}/entries/${encodeURIComponent(entryId)}`, 'DELETE')),
  receipt: async (splitId, entryId) => (await got(ask<{ image: string }>(`${at(splitId)}/entries/${encodeURIComponent(entryId)}/receipt`)))?.image ?? null,
  preview: (splitId) => got(ask<SplitTransfer[]>(`${at(splitId)}/settlement`)),
  settle: (splitId) => done(ask(`${at(splitId)}/settle`, 'POST')),
  reopen: (splitId) => done(ask(`${at(splitId)}/reopen`, 'POST')),
  paid: (splitId, paymentId, paid) => done(ask(`${at(splitId)}/payments/${paymentId}/paid`, 'POST', { paid })),
  archive: (splitId) => done(ask(`${at(splitId)}/archive`, 'POST')),
  deleteEvent: (splitId) => got(ask<{ deleted: boolean; deleteAt: string | null }>(`${at(splitId)}/delete`, 'POST')),
  keep: (splitId) => done(ask(`${at(splitId)}/delete`, 'DELETE')),
};
