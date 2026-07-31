import { visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { kindOf } from '@/domain/txKind';
import { matchTransferPairs } from '@/domain/transferMatch';
import type { TransferLeg } from '@/domain/transferMatch';

/**
 * Pair the two legs of a transfer across EVERYTHING this device sees —
 * the union of all spaces' visible transactions. That deliberately spans
 * spaces: the family case sends money from a private-space account to a
 * joint account attached only to the shared space; neither space sees
 * both legs, the union does. Each leg's peer id is written through its
 * OWN space's transform path (overlay for feed rows), so members who
 * cannot see the other space simply see an unpaired transfer.
 *
 * Idempotent and conservative (PayPal-matcher rules): peered rows never
 * re-enter, ambiguity leaves legs alone. Second pass: an out-leg whose
 * linkedAccountId deliberately names an account may claim that account's
 * RAW income twin (untyped bank row) — the "picture only updated half"
 * case — typing it as the mirror in the same stroke.
 */
export async function linkTransferPairs(store: StorageBackend, repo: Repo): Promise<number> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
  const byId = new Map<string, SpaceTx>();
  for (const space of spaces) {
    for (const tx of await visibleTransactions(store, space.id)) {
      // the same feed row can be visible in several spaces — first view
      // wins; the peer link is about the EVENT, not the viewing space
      if (!byId.has(tx.id)) byId.set(tx.id, tx);
    }
  }
  const all = [...byId.values()];
  const asLeg = (tx: SpaceTx): TransferLeg => ({
    id: tx.id,
    accountId: tx.accountId,
    amountCents: tx.amountCents,
    date: tx.date,
    linkedAccountId: tx.linkedAccountId,
    transferPeerId: tx.transferPeerId,
  });

  const typed = all.filter((tx) => kindOf(tx.txType) === 'transfer');
  const pairs = matchTransferPairs(typed.map(asLeg));
  let linked = 0;
  for (const [outId, incId] of pairs) {
    await writePair(repo, byId.get(outId), byId.get(incId), {});
    linked++;
  }

  // pass 2: deliberate out-legs claim their raw income twin
  const paired = new Set<string>([...pairs.keys(), ...pairs.values()]);
  const rawIncomes = all.filter((tx) => tx.amountCents > 0 && tx.txType === 'income' && !tx.linkedAccountId && !tx.transferPeerId && !paired.has(tx.id));
  const openOuts = typed.filter((tx) => tx.amountCents < 0 && !!tx.linkedAccountId && !tx.transferPeerId && !paired.has(tx.id));
  for (const out of openOuts) {
    const twins = rawIncomes.filter(
      (inc) =>
        !paired.has(inc.id) &&
        inc.accountId === out.linkedAccountId &&
        inc.amountCents === Math.abs(out.amountCents) &&
        Math.abs(Date.parse(inc.date) - Date.parse(out.date)) <= 2 * 86_400_000,
    );
    if (twins.length !== 1) continue; // none, or ambiguous — a human's call
    const twin = twins[0];
    paired.add(out.id);
    paired.add(twin.id);
    // the twin becomes the typed mirror: same family member, pointing
    // back, settled — exactly what a manual link would have produced
    await writePair(repo, out, twin, { txType: out.txType, linkedAccountId: out.accountId, needsReview: 0 });
    linked++;
  }
  return linked;
}

async function writePair(repo: Repo, out: SpaceTx | undefined, inc: SpaceTx | undefined, incExtra: Parameters<typeof writeTxTransform>[2]): Promise<void> {
  if (!out || !inc) return;
  await writeTxTransform(repo, out, { transferPeerId: inc.id });
  await writeTxTransform(repo, inc, { ...incExtra, transferPeerId: out.id });
}
