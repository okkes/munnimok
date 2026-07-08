import { v5 as uuidv5 } from 'uuid';
import type { ParsedStatement } from '@/lib/statements/parseStatement';
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

/**
 * May this statement's balance overwrite what the account shows?
 * Both statement balances and manual edits are dated; the newer date
 * wins. An undated existing balance (pre-feature rows, GC snapshots)
 * loses to any dated statement balance — bank truth beats unknown age.
 */
export function statementBalanceWins(
  account: { balanceAsOf?: string },
  stmt: { closingBalanceCents: number | null; balanceAsOf?: string | null },
): boolean {
  if (stmt.closingBalanceCents === null) return false;
  if (!account.balanceAsOf) return true;
  return !!stmt.balanceAsOf && stmt.balanceAsOf >= account.balanceAsOf;
}

async function createStatementAccount(
  repo: Repo,
  spaceId: string,
  accountId: string,
  stmt: ParsedStatement,
  iban: string,
): Promise<void> {
  await repo.upsert('account', spaceId, accountId, {
    name: stmt.accountName ?? `Bank · ${iban.slice(-4)}`,
    // ING CSVs know their account kind; CAMT statements default to checking
    type: stmt.accountType ?? 'checking',
    source: 'camt053',
    currency: stmt.currency,
    balanceCents: stmt.closingBalanceCents ?? 0,
    ...(stmt.balanceAsOf ? { balanceAsOf: stmt.balanceAsOf } : {}),
    iban: stmt.iban,
  });
}

/** returns true when the entry was new (imported), false when it already existed */
async function importEntry(
  repo: Repo,
  db: MunniDB,
  spaceId: string,
  accountId: string,
  iban: string,
  entry: ParsedStatement['entries'][number],
): Promise<boolean> {
  const txId = uuidv5(`tx:${iban}:${entry.ref}`, IMPORT_NS);
  if (await db.transactions.get(txId)) return false;

  const direction = entry.amountCents < 0 ? 'debit' : 'credit';
  const catId = predictCategory(`${entry.counterpartyName ?? ''} ${entry.description}`, direction) ?? UNCATEGORIZED_ID;
  const txType: TxType = CATEGORY_BY_ID.get(catId)?.txTypes[0] ?? (direction === 'credit' ? 'income' : 'expense');
  await repo.upsert('transaction', spaceId, txId, {
    accountId,
    date: entry.date,
    amountCents: entry.amountCents,
    currency: entry.currency,
    merchant: entry.counterpartyName ?? entry.description.slice(0, 40),
    description: entry.description,
    catId,
    txType,
    needsReview: catId === UNCATEGORIZED_ID ? 1 : 0,
    importRef: entry.ref,
  });
  return true;
}

/** Match statements to existing accounts by IBAN (creating where needed) and import entries idempotently. */
export async function importCamtStatements(
  repo: Repo,
  db: MunniDB,
  spaceId: string,
  statements: ParsedStatement[],
): Promise<ImportResult> {
  const existing = await db.accounts.where('spaceId').equals(spaceId).filter((a) => a.deleted === 0).toArray();
  const byIban = new Map(existing.flatMap((a) => (a.iban ? [[normalizeIban(a.iban), a] as const] : [])));

  let imported = 0;
  let skipped = 0;
  const accounts: ImportPlanAccount[] = [];

  for (const stmt of statements) {
    const iban = normalizeIban(stmt.iban);
    const match = byIban.get(iban);
    const accountId = match?.id ?? uuidv5(`acct:${iban}`, IMPORT_NS);
    if (!match) await createStatementAccount(repo, spaceId, accountId, stmt, iban);
    else if (statementBalanceWins(match, stmt))
      await repo.upsert('account', spaceId, accountId, {
        balanceCents: stmt.closingBalanceCents!,
        ...(stmt.balanceAsOf ? { balanceAsOf: stmt.balanceAsOf } : {}),
      });

    let txCount = 0;
    for (const entry of stmt.entries) {
      if (await importEntry(repo, db, spaceId, accountId, iban, entry)) {
        imported++;
        txCount++;
      } else {
        skipped++;
      }
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
