import { v5 as uuidv5 } from 'uuid';
import type { CamtStatement } from '@/lib/camt053/parse';
import { predictCategory } from '@/domain/predictCategory';
import { CATEGORY_BY_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import type { Repo } from '@/db/repo';
import type { MunniDB } from '@/db/schema';
import type { TxType } from '@/db/types';

// Fixed namespace so the same bank entry always yields the same tx id —
// importing the same file twice (or on two devices) cannot duplicate.
const IMPORT_NS = '5f3c9a70-0d3e-4e0f-9a57-6d2b3a1c8e42';

export interface ImportPlanAccount {
  iban: string;
  accountId: string;
  accountName: string;
  isNew: boolean;
  txCount: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  accounts: ImportPlanAccount[];
}

const normalizeIban = (iban: string) => iban.replace(/\s/g, '').toUpperCase();

/** Match statements to existing accounts by IBAN (creating where needed) and import entries idempotently. */
export async function importCamtStatements(
  repo: Repo,
  db: MunniDB,
  spaceId: string,
  statements: CamtStatement[],
): Promise<ImportResult> {
  const existing = await db.accounts.where('spaceId').equals(spaceId).filter((a) => a.deleted === 0).toArray();
  const byIban = new Map(existing.filter((a) => a.iban).map((a) => [normalizeIban(a.iban!), a]));

  let imported = 0;
  let skipped = 0;
  const accounts: ImportPlanAccount[] = [];

  for (const stmt of statements) {
    const iban = normalizeIban(stmt.iban);
    const match = byIban.get(iban);
    const accountId = match?.id ?? uuidv5(`acct:${iban}`, IMPORT_NS);

    if (!match) {
      await repo.upsert('account', spaceId, accountId, {
        name: `Bank · ${iban.slice(-4)}`,
        type: 'checking',
        source: 'camt053',
        currency: stmt.currency,
        balanceCents: stmt.closingBalanceCents ?? 0,
        iban: stmt.iban,
      });
    } else if (stmt.closingBalanceCents !== null) {
      await repo.upsert('account', spaceId, accountId, { balanceCents: stmt.closingBalanceCents });
    }

    let txCount = 0;
    for (const entry of stmt.entries) {
      const txId = uuidv5(`tx:${iban}:${entry.ref}`, IMPORT_NS);
      if (await db.transactions.get(txId)) {
        skipped++;
        continue;
      }
      const direction = entry.amountCents < 0 ? 'debit' : 'credit';
      const catId =
        predictCategory(`${entry.counterpartyName ?? ''} ${entry.description}`, direction) ?? UNCATEGORIZED_ID;
      const txType: TxType =
        CATEGORY_BY_ID.get(catId)?.txTypes[0] ?? (direction === 'credit' ? 'income' : 'expense');
      await repo.upsert('transaction', spaceId, txId, {
        accountId,
        date: entry.date,
        amountCents: entry.amountCents,
        currency: entry.currency,
        merchant: entry.counterpartyName ?? entry.description.slice(0, 40) ?? '—',
        description: entry.description,
        catId,
        txType,
        needsReview: catId === UNCATEGORIZED_ID ? 1 : 0,
        importRef: entry.ref,
      });
      imported++;
      txCount++;
    }

    accounts.push({
      iban: stmt.iban,
      accountId,
      accountName: match?.name ?? `Bank · ${iban.slice(-4)}`,
      isNew: !match,
      txCount,
    });
  }

  return { imported, skipped, accounts };
}
