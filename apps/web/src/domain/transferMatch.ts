// a transfer is one event with two legs: same |amount|, opposite signs, different accounts, dates within 2 days link
// conservative like the PayPal matcher: a tie leaves the legs unlinked for a human
// a leg whose linkedAccountId names the other's account is the strongest signal and wins ties

export interface TransferLeg {
  id: string;
  accountId: string;
  amountCents: number;
  date: string;
  linkedAccountId?: string;
  transferPeerId?: string;
}

const DAY_MS = 86_400_000;

const daysApart = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

const compatible = (out: TransferLeg, inc: TransferLeg, windowDays: number): boolean =>
  out.accountId !== inc.accountId &&
  Math.abs(out.amountCents) === inc.amountCents &&
  daysApart(out.date, inc.date) <= windowDays;

/** a leg pointing its linkedAccountId at the other leg's account is the strongest pairing signal */
const pointsAt = (a: TransferLeg, b: TransferLeg): boolean =>
  a.linkedAccountId === b.accountId || b.linkedAccountId === a.accountId;

/** outgoingId → incomingId; each incoming leg is consumed once; legs with a transferPeerId never take part */
export function matchTransferPairs(legs: readonly TransferLeg[], windowDays = 2): Map<string, string> {
  const fresh = legs.filter((l) => !l.transferPeerId);
  const outgoing = fresh.filter((l) => l.amountCents < 0).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const incoming = fresh.filter((l) => l.amountCents > 0);
  const taken = new Set<string>();
  const pairs = new Map<string, string>();

  for (const out of outgoing) {
    const candidates = incoming.filter((inc) => !taken.has(inc.id) && compatible(out, inc, windowDays));
    if (candidates.length === 0) continue;
    const pointed = candidates.filter((inc) => pointsAt(out, inc));
    let pick: TransferLeg | undefined;
    if (pointed.length === 1) {
      pick = pointed[0];
    } else if (pointed.length === 0) {
      // nearest date wins only when it wins ALONE; ambiguity is a human's call, like the PayPal matcher's rung 3
      const sorted = [...candidates].sort((a, b) => daysApart(out.date, a.date) - daysApart(out.date, b.date));
      if (sorted.length === 1 || daysApart(out.date, sorted[0].date) < daysApart(out.date, sorted[1].date)) {
        pick = sorted[0];
      }
    }
    // pointed.length > 1: two deliberate links tie — leave for review
    if (!pick) continue;
    taken.add(pick.id);
    pairs.set(out.id, pick.id);
  }
  return pairs;
}
