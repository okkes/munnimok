import { serverSplits } from '@/application/splitsApi';
import type { SplitDetail } from '@/application/splitsApi';

export interface SettlementCandidate {
  cents: number;
  splitId: string;
  splitName: string;
  /** who settled (their display name, or null for unnamed accounts) */
  fromName: string | null;
}

/**
 * Money a split says is coming MY way (SP5, design: "when the actual bank
 * transfer shows up in B's feed, review suggests linking it"): a payment
 * a member recorded to me while the split runs, and — once it is settled —
 * every payment of the plan that names me as its receiver and is not
 * marked paid yet. Splits are online-only — any failure returns [] and
 * review simply shows no suggestion.
 */
export async function fetchSettlementCandidates(): Promise<SettlementCandidate[]> {
  const splits = (await serverSplits.list()) ?? [];
  const candidates: SettlementCandidate[] = [];
  for (const split of splits.filter((s) => s.status !== 'archived')) {
    const detail = await serverSplits.get(split.id);
    if (detail && detail !== 'gone') candidates.push(...comingMyWay(detail));
  }
  return candidates;
}

function comingMyWay(detail: SplitDetail): SettlementCandidate[] {
  const me = detail.members.find((member) => member.isMe)?.userId;
  if (!me) return [];
  const from = (userId: string, cents: number): SettlementCandidate => ({
    cents,
    splitId: detail.split.id,
    splitName: detail.split.name,
    fromName: detail.members.find((member) => member.userId === userId)?.displayName ?? null,
  });
  // a payment to me: I'm the sole share holder and not the payer
  const recorded = detail.entries.filter((entry) => entry.kind === 'settlement' && entry.paidByUserId !== me && entry.shares.length === 1 && entry.shares[0].userId === me);
  const planned = detail.payments.filter((payment) => payment.toUserId === me && !payment.paidAt);
  return [...recorded.map((entry) => from(entry.paidByUserId, entry.amountCents)), ...planned.map((payment) => from(payment.fromUserId, payment.amountCents))];
}
