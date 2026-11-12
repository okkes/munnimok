import { netPositions, settlementPlan } from '@/domain/splitLedger';
import type {
  SplitDetail,
  SplitEntry,
  SplitEntryDraft,
  SplitFriendInvite,
  SplitJoinRequest,
  SplitLink,
  SplitMember,
  SplitPayment,
  SplitsApi,
  SplitShare,
  SplitStatus,
  SplitSummary,
} from '@/application/splitsApi';

/**
 * #538 (user): the demo shows splits too — running, planned, being settled
 * and archived, with enough in them to understand the feature — although
 * it has no account and no server. This stand-in keeps them in the page's
 * memory: what the visitor changes stays on the device and is gone with
 * the tab. The arithmetic is the app's own ledger; the fewest-payments
 * search is the server's, so here the plan pairs largest with largest.
 */

const ME = 'demo-me';
const SAM = 'demo-sam';
const NOOR = 'demo-noor';
const DAAN = 'demo-daan';
const LISA = 'demo-lisa';
const NAMES: Record<string, string> = { [ME]: 'You', [SAM]: 'Sam', [NOOR]: 'Noor', [DAAN]: 'Daan', [LISA]: 'Lisa' };

interface DemoSplit {
  id: string;
  name: string;
  currency: string;
  status: SplitStatus;
  picture: string | null;
  startDate: string | null;
  endDate: string | null;
  deleteAt: string | null;
  attachedEventId: string | null;
  members: { userId: string; role: 'owner' | 'contributor'; state: 'active' | 'left' | 'removed' }[];
  entries: SplitEntry[];
  payments: SplitPayment[];
  requests: SplitJoinRequest[];
  friendInvites: SplitFriendInvite[];
  link: SplitLink | null;
  receipts: Record<string, string>;
}

const day = (offset: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const equal = (cents: number, among: readonly string[]): SplitShare[] => {
  const base = Math.floor(cents / among.length);
  const odd = cents - base * among.length;
  return among.map((userId, index) => ({ userId, cents: base + (index < odd ? 1 : 0) }));
};

let serial = 0;
const expense = (description: string, cents: number, paidBy: string, daysAgo: number, shares: SplitShare[], more: Partial<SplitEntry> = {}): SplitEntry => ({
  id: `demo-entry-${++serial}`,
  kind: 'expense',
  paidByUserId: paidBy,
  description,
  amountCents: cents,
  date: day(-daysAgo),
  shareMode: 'equal',
  shares,
  originalCurrency: null,
  originalCents: null,
  hasReceipt: false,
  sourceTxId: null,
  sourceSpaceId: null,
  createdBy: paidBy,
  canEdit: true,
  ...more,
});

function seed(): DemoSplit[] {
  serial = 0;
  const ski = [ME, SAM, NOOR, DAAN];
  const city = [ME, SAM, LISA];
  const base = { deleteAt: null, attachedEventId: null, requests: [], friendInvites: [], link: null, receipts: {} };
  return [
    {
      ...base,
      id: 'demo-split-ski',
      name: 'Wintersport Val Thorens',
      currency: 'EUR',
      status: 'open',
      picture: '/events/winter.jpg',
      startDate: day(-4),
      endDate: day(3),
      members: ski.map((userId) => ({ userId, role: userId === ME ? 'owner' : 'contributor', state: 'active' })),
      entries: [
        expense('Chalet', 124_000, ME, 20, equal(124_000, ski)),
        expense('Ski passes', 98_400, SAM, 4, equal(98_400, ski)),
        expense('Groceries Carrefour', 18_640, NOOR, 4, equal(18_640, ski)),
        expense('Fondue night', 21_280, DAAN, 3, [{ userId: ME, cents: 5320, pct: 25 }, { userId: SAM, cents: 5320, pct: 25 }, { userId: NOOR, cents: 5320, pct: 25 }, { userId: DAAN, cents: 5320, pct: 25 }], { shareMode: 'percent' }),
        expense('Ski lessons Noor & Daan', 16_000, ME, 2, [{ userId: NOOR, cents: 8000 }, { userId: DAAN, cents: 8000 }], { shareMode: 'exact' }),
        expense('Fuel and tolls', 23_150, SAM, 5, equal(23_150, ski)),
        expense('Souvenirs Zurich airport', 5240, ME, 1, equal(5240, [ME, SAM]), { originalCurrency: 'CHF', originalCents: 4900 }),
      ],
      payments: [],
      requests: [{ id: 'demo-request-1', userId: LISA, displayName: 'Lisa', picture: null, createdAt: new Date().toISOString() }],
      link: { token: 'demo-link-ski', expiresAt: null, maxUses: 6, uses: 3, needsApproval: true },
    },
    {
      ...base,
      id: 'demo-split-antwerp',
      name: 'Weekend Antwerpen',
      currency: 'EUR',
      status: 'open',
      picture: '/events/city.jpg',
      startDate: day(21),
      endDate: day(23),
      members: [{ userId: LISA, role: 'owner', state: 'active' }, { userId: ME, role: 'contributor', state: 'active' }, { userId: SAM, role: 'contributor', state: 'active' }],
      entries: [expense('Hotel deposit', 24_000, LISA, 2, equal(24_000, city))],
      payments: [],
    },
    {
      ...base,
      id: 'demo-split-festival',
      name: 'Lowlands',
      currency: 'EUR',
      status: 'settled',
      picture: '/events/concert.jpg',
      startDate: day(-80),
      endDate: day(-77),
      members: [ME, SAM, NOOR].map((userId) => ({ userId, role: userId === SAM ? 'owner' : 'contributor', state: 'active' })),
      entries: [
        expense('Tickets', 89_700, SAM, 120, equal(89_700, [ME, SAM, NOOR])),
        expense('Camping gear', 14_250, NOOR, 82, equal(14_250, [ME, SAM, NOOR])),
        expense('Food and drinks', 21_300, ME, 78, equal(21_300, [ME, SAM, NOOR])),
      ].map((entry) => ({ ...entry, canEdit: false })),
      payments: [
        { id: 'demo-pay-1', fromUserId: NOOR, toUserId: SAM, amountCents: 27_500, paidAt: new Date(Date.now() - 5 * 86_400_000).toISOString() },
        { id: 'demo-pay-2', fromUserId: ME, toUserId: SAM, amountCents: 20_450, paidAt: null },
      ],
    },
    {
      ...base,
      id: 'demo-split-barcelona',
      name: 'Barcelona 2025',
      currency: 'EUR',
      status: 'archived',
      picture: '/events/beach.jpg',
      startDate: day(-420),
      endDate: day(-414),
      members: [ME, DAAN].map((userId) => ({ userId, role: userId === ME ? 'owner' : 'contributor', state: 'active' })),
      entries: [
        expense('Apartment', 68_000, ME, 430, equal(68_000, [ME, DAAN])),
        expense('Tapas and drinks', 19_460, DAAN, 416, equal(19_460, [ME, DAAN])),
      ].map((entry) => ({ ...entry, canEdit: false })),
      payments: [{ id: 'demo-pay-3', fromUserId: DAAN, toUserId: ME, amountCents: 24_270, paidAt: new Date(Date.now() - 400 * 86_400_000).toISOString() }],
    },
  ];
}

let splits: DemoSplit[] = seed();

/** tests start from the seed again */
export function resetDemoSplits(): void {
  splits = seed();
}

const find = (splitId: string): DemoSplit | undefined => splits.find((split) => split.id === splitId);
const meIn = (split: DemoSplit) => split.members.find((member) => member.userId === ME);
const ledger = (split: DemoSplit) => netPositions(split.entries, split.members.map((member) => member.userId));

function summary(split: DemoSplit): SplitSummary {
  const me = meIn(split);
  return {
    id: split.id,
    name: split.name,
    currency: split.currency,
    status: split.status,
    role: me?.role ?? 'contributor',
    state: me?.state ?? 'active',
    picture: split.picture,
    startDate: split.startDate,
    endDate: split.endDate,
    attachedSpaceId: null,
    attachedEventId: split.attachedEventId,
    memberCount: split.members.filter((member) => member.state === 'active').length,
    entryCount: split.entries.length,
    totalCents: split.entries.filter((entry) => entry.kind === 'expense').reduce((sum, entry) => sum + entry.amountCents, 0),
    myBalanceCents: ledger(split).get(ME) ?? 0,
    deleteAt: split.deleteAt,
  };
}

function detail(split: DemoSplit): SplitDetail {
  const owner = meIn(split)?.role === 'owner';
  const members: SplitMember[] = split.members.map((member) => ({ ...member, displayName: member.userId === ME ? null : NAMES[member.userId], picture: null, isMe: member.userId === ME }));
  return {
    split: summary(split),
    members,
    entries: [...split.entries].sort((a, b) => b.date.localeCompare(a.date)),
    payments: split.payments,
    requests: owner ? split.requests : null,
    friendInvites: owner ? split.friendInvites : null,
  };
}

/** a draft's shares as cents: percentages and "equally" worked out the way the server does */
function sharesOf(draft: SplitEntryDraft, members: readonly string[]): SplitShare[] {
  if (draft.shareMode === 'exact') return draft.shares.map((share) => ({ userId: share.userId, cents: share.cents ?? 0 }));
  const among = draft.shares.length > 0 ? draft.shares.map((share) => share.userId) : members;
  if (draft.shareMode === 'equal') return equal(draft.amountCents, among);
  const exact = draft.shares.map((share) => (draft.amountCents * (share.pct ?? 0)) / 100);
  const cents = exact.map(Math.floor);
  let left = draft.amountCents - cents.reduce((a, b) => a + b, 0);
  for (const index of exact.map((value, i) => ({ frac: value - Math.floor(value), i })).sort((a, b) => b.frac - a.frac).map((x) => x.i)) {
    if (left <= 0) break;
    cents[index] += 1;
    left -= 1;
  }
  return draft.shares.map((share, i) => ({ userId: share.userId, cents: cents[i], pct: share.pct }));
}

const entryOf = (draft: SplitEntryDraft, split: DemoSplit): SplitEntry => ({
  id: draft.id,
  kind: draft.kind,
  paidByUserId: draft.paidByUserId,
  description: draft.description,
  amountCents: draft.amountCents,
  date: draft.date,
  shareMode: draft.shareMode,
  shares: sharesOf(draft, split.members.filter((member) => member.state === 'active').map((member) => member.userId)),
  originalCurrency: draft.originalCurrency ?? null,
  originalCents: draft.originalCents ?? null,
  hasReceipt: !!draft.receipt,
  sourceTxId: draft.sourceTxId ?? null,
  sourceSpaceId: draft.sourceSpaceId ?? null,
  createdBy: ME,
  canEdit: true,
});

/** the change, when the event exists and is the visitor's to change that way */
const change = async (splitId: string, ownerOnly: boolean, apply: (split: DemoSplit) => void): Promise<boolean> => {
  const split = find(splitId);
  if (!split || (ownerOnly && meIn(split)?.role !== 'owner')) return false;
  apply(split);
  return true;
};

const closeDoors = (split: DemoSplit): void => {
  split.link = null;
  split.requests = [];
  split.friendInvites = split.friendInvites.filter((invite) => invite.status !== 'pending');
};

export const demoSplits: SplitsApi = {
  list: async () => splits.map(summary),
  get: async (splitId) => {
    const split = find(splitId);
    return split ? detail(split) : 'gone';
  },
  create: async (id, facts) => {
    splits = [
      { id, ...facts, status: 'open', deleteAt: null, attachedEventId: null, members: [{ userId: ME, role: 'owner', state: 'active' }], entries: [], payments: [], requests: [], friendInvites: [], link: null, receipts: {} },
      ...splits,
    ];
    return true;
  },
  update: (splitId, facts) => change(splitId, true, (split) => Object.assign(split, facts)),
  attach: (splitId, wiring) =>
    change(splitId, false, (split) => {
      split.attachedEventId = wiring.eventId ?? null;
    }),
  leave: async (splitId) => {
    splits = splits.filter((split) => split.id !== splitId);
    return true;
  },
  promote: (splitId, userId) =>
    change(splitId, true, (split) => {
      const member = split.members.find((m) => m.userId === userId);
      if (member) member.role = 'owner';
    }),
  removeMember: (splitId, userId) =>
    change(splitId, true, (split) => {
      const member = split.members.find((m) => m.userId === userId);
      if (member) Object.assign(member, { state: 'removed', role: 'contributor' });
    }),
  link: async (splitId) => find(splitId)?.link ?? { token: null, expiresAt: null, maxUses: 0, uses: 0, needsApproval: false },
  newLink: async (splitId, options) => {
    const split = find(splitId);
    if (!split) return null;
    split.link = {
      token: `demo-link-${Date.now()}`,
      expiresAt: options.validDays ? new Date(Date.now() + options.validDays * 86_400_000).toISOString() : null,
      maxUses: options.maxUses ?? 0,
      uses: 0,
      needsApproval: options.needsApproval ?? false,
    };
    return split.link;
  },
  endLink: (splitId) =>
    change(splitId, true, (split) => {
      split.link = null;
    }),
  // nobody can follow a link into a browser tab's memory
  peek: async () => 'gone',
  accept: async () => 'gone',
  answerRequest: (splitId, requestId, approve) =>
    change(splitId, true, (split) => {
      const asked = split.requests.find((request) => request.id === requestId);
      split.requests = split.requests.filter((request) => request.id !== requestId);
      if (asked && approve) split.members.push({ userId: asked.userId, role: 'contributor', state: 'active' });
    }),
  // the demo has no friends to ask
  inviteFriend: async () => false,
  cancelFriendInvite: (splitId, inviteId) =>
    change(splitId, true, (split) => {
      split.friendInvites = split.friendInvites.filter((invite) => invite.id !== inviteId);
    }),
  invitations: async () => [],
  answerInvitation: async () => false,
  addEntry: (splitId, draft) =>
    change(splitId, false, (split) => {
      split.entries.push(entryOf(draft, split));
      if (draft.receipt) split.receipts[draft.id] = draft.receipt;
    }),
  changeEntry: (splitId, draft) =>
    change(splitId, false, (split) => {
      const kept = draft.receipt ?? split.receipts[draft.id];
      split.entries = split.entries.map((entry) => (entry.id === draft.id ? { ...entryOf({ ...draft, receipt: kept }, split), createdBy: entry.createdBy } : entry));
      if (kept) split.receipts[draft.id] = kept;
      else delete split.receipts[draft.id];
    }),
  deleteEntry: (splitId, entryId) =>
    change(splitId, false, (split) => {
      split.entries = split.entries.filter((entry) => entry.id !== entryId);
    }),
  receipt: async (splitId, entryId) => find(splitId)?.receipts[entryId] ?? null,
  preview: async (splitId) => {
    const split = find(splitId);
    return split ? settlementPlan(ledger(split)).map((transfer) => ({ fromUserId: transfer.fromUserId, toUserId: transfer.toUserId, amountCents: transfer.cents })) : null;
  },
  settle: (splitId) =>
    change(splitId, true, (split) => {
      const plan = settlementPlan(ledger(split));
      split.payments = plan.map((transfer, index) => ({ id: `${split.id}-pay-${index}`, fromUserId: transfer.fromUserId, toUserId: transfer.toUserId, amountCents: transfer.cents, paidAt: null }));
      split.status = plan.length === 0 ? 'archived' : 'settled';
      split.entries = split.entries.map((entry) => ({ ...entry, canEdit: false }));
      closeDoors(split);
    }),
  reopen: (splitId) =>
    change(splitId, true, (split) => {
      for (const paid of split.payments.filter((payment) => payment.paidAt)) {
        split.entries.push({ ...expense('settlement', paid.amountCents, paid.fromUserId, 0, [{ userId: paid.toUserId, cents: paid.amountCents }], { shareMode: 'exact' }), kind: 'settlement' });
      }
      split.payments = [];
      split.status = 'open';
      split.entries = split.entries.map((entry) => ({ ...entry, canEdit: true }));
    }),
  paid: (splitId, paymentId, paid) =>
    change(splitId, false, (split) => {
      split.payments = split.payments.map((payment) => (payment.id === paymentId ? { ...payment, paidAt: paid ? new Date().toISOString() : null } : payment));
      if (split.payments.every((payment) => payment.paidAt)) split.status = 'archived';
    }),
  archive: (splitId) =>
    change(splitId, true, (split) => {
      split.status = 'archived';
      closeDoors(split);
    }),
  deleteEvent: async (splitId) => {
    const split = find(splitId);
    if (!split || meIn(split)?.role !== 'owner') return null;
    if (split.members.filter((member) => member.state === 'active').length <= 1) {
      splits = splits.filter((other) => other.id !== splitId);
      return { deleted: true, deleteAt: null };
    }
    split.deleteAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    return { deleted: false, deleteAt: split.deleteAt };
  },
  keep: (splitId) =>
    change(splitId, true, (split) => {
      split.deleteAt = null;
    }),
};
