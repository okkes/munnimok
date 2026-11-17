import { serverSplits } from '@/application/splitsApi';
import type { SplitDetail } from '@/application/splitsApi';

export interface SettlementCandidate {
  cents: number;
  splitId: string;
  splitName: string;
  fromName: string | null;
}

// money a split says is coming my way: payments recorded to me, and once settled the unpaid plan payments naming me
// (SP5); splits are online-only: any failure returns [] and review shows no suggestion
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
