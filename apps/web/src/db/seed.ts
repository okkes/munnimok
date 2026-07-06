import { CATEGORY_BY_ID } from '@/domain/categories';
import type { TxType } from './types';
import type { Repo } from './repo';
import { DEMO_ACCOUNTS, DEMO_TXS } from './demo-data';

export const DEMO_SPACE_ID = 'demo_space';
const SEED_FLAG = 'seeded_demo_v1';

const isoDaysAgo = (daysAgo: number): string => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
};

const txTypeFor = (catId: string): TxType => CATEGORY_BY_ID.get(catId)?.txTypes[0] ?? 'expense';

/**
 * Seed the demo identity's database from the bundled dataset (idempotent).
 * Dates are relative to "now" so the demo always looks alive. Logging out
 * of demo deletes the whole database, so the next login reseeds a pristine
 * state — demo changes never leave the device.
 */
export async function seedDemoIfNeeded(repo: Repo): Promise<void> {
  if (await repo.db.meta.get(SEED_FLAG)) return;

  await repo.upsert('space', DEMO_SPACE_ID, DEMO_SPACE_ID, {
    name: 'Demo',
    kind: 'personal',
    currency: 'EUR',
    periodType: 'month',
    periodDay: 1,
  });

  for (const account of DEMO_ACCOUNTS) {
    await repo.upsert('account', DEMO_SPACE_ID, account.id, {
      name: account.name,
      type: account.type as never,
      source: 'manual',
      currency: 'EUR',
      balanceCents: account.balanceCents,
      iban: account.iban,
      bankId: account.bankId,
      color: account.color,
    });
  }

  for (const tx of DEMO_TXS) {
    await repo.upsert('transaction', DEMO_SPACE_ID, tx.id, {
      accountId: tx.account,
      date: isoDaysAgo(tx.daysAgo),
      time: tx.time,
      amountCents: tx.amountCents,
      currency: 'EUR',
      merchant: tx.merchant,
      description: tx.desc,
      catId: tx.cat,
      splits: tx.splits,
      txType: txTypeFor(tx.cat),
      needsReview: tx.needsReview ? 1 : 0,
      reimbursedByTxIds: tx.reimbursements?.map((r) => r.txId),
    });
  }

  await repo.db.meta.put({ key: SEED_FLAG, value: Date.now() });
}
