import { v5 as uuidv5 } from 'uuid';
import { accountLinkId, canonicalAccountId, feedSpaceId, importAccountId, txMetaId } from '@/domain/feedIds';
import type { ParsedStatement } from '@/lib/statements/parseStatement';
import { predictTx } from '@/domain/predictCategory';
import { cachedCatalog } from '@/sync/catalogSync';
import type { SpaceMemory } from '@/application/prediction';
import { buildSpaceMerchantMemory } from '@/application/prediction';
import { UNCATEGORIZED_ID, isMovementCat } from '@/domain/categories';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import { matchCounterAccount } from '@/domain/counterClue';
import type { ClueAccount } from '@/domain/counterClue';
import { movementCatFor } from '@/domain/txType';
import { walletForAutoLink } from '@/application/defaultAccounts';
import { visibleAccounts, writeTxTransform } from '@/db/joined';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { AccountType } from '@/db/types';

// fixed namespace: the same bank entry always yields the same tx id, so a re-import (or a second device) cannot duplicate
const IMPORT_NS = '5f3c9a70-0d3e-4e0f-9a57-6d2b3a1c8e42';

export interface ImportPlanAccount {
  iban: string;
  accountId: string;
  accountName: string;
  isNew: boolean;
  /** #204: whether this space already carries the account (imports never attach); absent on the merged offline path */
  attached?: boolean;
  txCount: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  accounts: ImportPlanAccount[];
}

const normalizeIban = (iban: string) => iban.replace(/\s/g, '').toUpperCase();

/** both statement balances and manual edits are dated, the newer wins; an undated balance loses to a dated statement */
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
    lastSyncedAt: new Date().toISOString(),
  });
}

function predictEntry(
  memory: SpaceMemory,
  entry: ParsedStatement['entries'][number],
  keywordRules?: readonly { catId: string; keywords: string[] }[],
  sourceAccountType?: AccountType,
): { catId: string; needsReview: 0 | 1 } {
  const prediction = predictTx({
    memory,
    merchant: entry.counterpartyName ?? entry.description.slice(0, 40),
    description: entry.description,
    amountCents: entry.amountCents,
    keywordRules,
    sourceAccountType,
  });
  return {
    catId: prediction?.catId ?? UNCATEGORIZED_ID,
    // every imported row waits in the review with its prediction prefilled, however sure the history is
    needsReview: 1,
  };
}

interface EntryContext {
  repo: Repo;
  store: StorageBackend;
  spaceId: string;
  accountId: string;
  iban: string;
  memory: SpaceMemory;
  keywordRules?: readonly { catId: string; keywords: string[] }[];
  /** #228 r3: the space's tracked accounts — the transfer clue-matcher's pool */
  counterCandidates: readonly ClueAccount[];
  /** one id per statement per run: rollback's unit */
  batchId: string;
  /** uploader display name, frozen at import time */
  importedBy?: string;
}

async function uploaderName(store: StorageBackend): Promise<string | undefined> {
  return ((await store.metaGet('profile'))?.value as { name?: string } | undefined)?.name;
}

// a movement prediction links its counterparty through the write choke: the mirror leg mints, a wrong guess retires it
// #228: a transfer links only a clue-matched account; #546: the ATM pair takes the cash wallet, pot families no default
async function linkPredictedMovement(
  ctx: EntryContext,
  txId: string,
  predicted: { catId: string; needsReview: 0 | 1 },
  feedId: string | undefined,
  matchedId?: string,
): Promise<void> {
  if (!isMovementCat(predicted.catId)) return;
  const family = defaultFamilyFor(predicted.catId);
  if (!family) return;
  const targetId = matchedId ?? (family === 'cash' ? await walletForAutoLink(ctx.store, ctx.repo, ctx.spaceId) : null);
  if (!targetId) return;
  await writeTxTransform(
    ctx.repo,
    { id: txId, spaceId: ctx.spaceId, feedSpaceId: feedId, needsReview: predicted.needsReview },
    { linkedAccountId: targetId },
  ).catch(() => undefined);
}

/** #228: a transfer prediction is real only when the entry names a tracked account; no match stands down to Uncategorized */
function resolveEntryPrediction(
  ctx: EntryContext,
  entry: ParsedStatement['entries'][number],
): { predicted: { catId: string; needsReview: 0 | 1 }; matchedId?: string } {
  // #564: the imported account's type decides the side a suggested movement reads from
  const predicted = predictEntry(ctx.memory, entry, ctx.keywordRules, ctx.counterCandidates.find((a) => a.id === ctx.accountId)?.type);
  if (defaultFamilyFor(predicted.catId) !== 'transfer') return { predicted };
  const match = matchCounterAccount(
    {
      merchant: entry.counterpartyName ?? entry.description.slice(0, 40),
      description: entry.description,
      ...(entry.counterpartyIban ? { counterIban: normalizeIban(entry.counterpartyIban) } : {}),
    },
    ctx.counterCandidates,
    ctx.accountId,
  );
  if (match) {
    return {
      predicted: {
        catId: movementCatFor(match.type, entry.amountCents),
        needsReview: predicted.needsReview,
      },
      matchedId: match.id,
    };
  }
  return {
    predicted: { catId: UNCATEGORIZED_ID, needsReview: 1 },
  };
}

async function importEntry(ctx: EntryContext, entry: ParsedStatement['entries'][number]): Promise<boolean> {
  const txId = uuidv5(`tx:${ctx.iban}:${entry.ref}`, IMPORT_NS);
  if (await ctx.store.get('transaction', txId)) return false;

  const { predicted, matchedId } = resolveEntryPrediction(ctx, entry);
  await ctx.repo.upsert('transaction', ctx.spaceId, txId, {
    accountId: ctx.accountId,
    date: entry.date,
    amountCents: entry.amountCents,
    currency: entry.currency,
    merchant: entry.counterpartyName ?? entry.description.slice(0, 40),
    description: entry.description,
    ...(entry.counterpartyIban ? { counterIban: normalizeIban(entry.counterpartyIban) } : {}),
    ...predicted,
    importRef: entry.ref,
    importBatchId: ctx.batchId,
    ...(ctx.importedBy ? { importedBy: ctx.importedBy } : {}),
  });
  await linkPredictedMovement(ctx, txId, predicted, undefined, matchedId);
  return true;
}

/** injected so the importer stays unit-testable and demo/offline identities can pass nothing */
export interface FeedGateway {
  /** the GRANTED id: the deterministic one, or the caller's personal fallback when someone else owns it (S1) */
  register(preferredFeedId: string, accountRef: string): Promise<string>;
  attach(spaceId: string, feedSpaceId: string, accountId: string, historyFrom?: string, type?: AccountType): Promise<void>;
}

export type ImportProgress = (done: number) => void;

export async function importCamtStatements(
  repo: Repo,
  store: StorageBackend,
  spaceId: string,
  statements: ParsedStatement[],
  feeds?: FeedGateway,
  onProgress?: ImportProgress,
): Promise<ImportResult> {
  // demo/offline identities never sync: raw and transformation stay merged in the current space
  return feeds
    ? importIntoFeeds(repo, store, spaceId, statements, feeds, onProgress)
    : importMerged(repo, store, spaceId, statements, onProgress);
}

/** header-only exports (real ING files include one) parse to an empty statement: never an account */
const emptyStatement = (stmt: ParsedStatement): boolean =>
  !stmt.iban.trim() || (stmt.entries.length === 0 && stmt.closingBalanceCents === null);

/** newest date a statement covers (null for balance-only files): an old export imports fine and leaves a hole after it */
export function statementCoverageEnd(stmt: Pick<ParsedStatement, 'entries' | 'balanceAsOf'>): string | null {
  let end = stmt.balanceAsOf ?? null;
  for (const entry of stmt.entries) {
    if (!end || entry.date > end) end = entry.date;
  }
  return end;
}

async function stampCoverage(
  repo: Repo,
  spaceId: string,
  accountId: string,
  existing: { dataThroughDate?: string } | undefined,
  stmt: ParsedStatement,
): Promise<void> {
  const end = statementCoverageEnd(stmt);
  await repo.upsert('account', spaceId, accountId, {
    lastSyncedAt: new Date().toISOString(),
    // coverage only moves FORWARD: re-importing an old export must not
    // shrink what a newer one already established
    ...(end && (!existing?.dataThroughDate || end > existing.dataThroughDate) ? { dataThroughDate: end } : {}),
  });
}

async function importMerged(
  repo: Repo,
  store: StorageBackend,
  spaceId: string,
  statements: ParsedStatement[],
  onProgress?: ImportProgress,
): Promise<ImportResult> {
  const memory = await buildSpaceMerchantMemory(store, spaceId);
  const importedBy = await uploaderName(store);
  const keywordRules = (await cachedCatalog(store))?.keywords;
  const counterCandidates = await visibleAccounts(store, spaceId);
  const existing = (await store.bySpace('account', spaceId)).filter((a) => a.deleted === 0);
  const byIban = new Map(existing.flatMap((a) => (a.iban ? [[normalizeIban(a.iban), a] as const] : [])));

  let imported = 0;
  let skipped = 0;
  const accounts: ImportPlanAccount[] = [];

  for (const stmt of statements) {
    if (emptyStatement(stmt)) continue;
    const iban = normalizeIban(stmt.iban);
    const match = byIban.get(iban);
    const accountId = match?.id ?? uuidv5(`acct:${iban}`, IMPORT_NS);
    if (!match) await createStatementAccount(repo, spaceId, accountId, stmt, iban);
    else if (statementBalanceWins(match, stmt))
      await repo.upsert('account', spaceId, accountId, {
        balanceCents: stmt.closingBalanceCents!,
        ...(stmt.balanceAsOf ? { balanceAsOf: stmt.balanceAsOf } : {}),
      });
    await stampCoverage(repo, spaceId, accountId, match, stmt);

    let txCount = 0;
    const batchId = crypto.randomUUID();
    for (const entry of stmt.entries) {
      if (await importEntry({ repo, store, spaceId, accountId, iban, memory, keywordRules, counterCandidates, batchId, importedBy }, entry)) {
        imported++;
        txCount++;
      } else {
        skipped++;
      }
      onProgress?.(imported + skipped);
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

// #204: importing never attaches: joining a space is an explicit step; only an already attached account refreshes its link
async function refreshExistingAttachment(
  repo: Repo,
  store: StorageBackend,
  feeds: FeedGateway,
  spaceId: string,
  feedId: string,
  accountId: string,
): Promise<boolean> {
  const linkId = accountLinkId(spaceId, feedId);
  const existingLink = await store.get('accountLink', linkId);
  if (existingLink?.deleted !== 0) return false;
  if (existingLink.archived) return false;
  const historyFrom =
    existingLink.historyFrom ?? (await store.get('space', spaceId))?.historyStartDate ?? isoMonthsAgo(DEFAULT_HISTORY_MONTHS);
  // the link's own type, else the account row's: the server keeps a type on every link
  const type = existingLink.type ?? (await store.get('account', accountId))?.type;
  await feeds.attach(spaceId, feedId, accountId, historyFrom, type);
  await repo.upsert('accountLink', spaceId, linkId, {
    feedSpaceId: feedId,
    accountId,
    historyFrom,
    ...(type ? { type } : {}),
  });
  return true;
}

/** #311: a bank-fed row owning the canonical `acct:{iban}` id makes the import keep its own account */
async function importTargetAccountId(store: StorageBackend, feedId: string, iban: string): Promise<string> {
  const canonicalId = canonicalAccountId(iban);
  const canonical = await store.get('account', canonicalId);
  const bankOwnsCanonical = canonical?.spaceId === feedId && canonical.deleted === 0 && canonical.source === 'connector';
  return bankOwnsCanonical ? importAccountId(iban) : canonicalId;
}

// raw facts go once into the account's feed space; the space gets the txMeta overlay, an accountLink only if attached (#204)
async function importIntoFeeds(
  repo: Repo,
  store: StorageBackend,
  spaceId: string,
  statements: ParsedStatement[],
  feeds: FeedGateway,
  onProgress?: ImportProgress,
): Promise<ImportResult> {
  const memory = await buildSpaceMerchantMemory(store, spaceId);
  const importedBy = await uploaderName(store);
  const keywordRules = (await cachedCatalog(store))?.keywords;
  const counterCandidates = await visibleAccounts(store, spaceId);
  let imported = 0;
  let skipped = 0;
  const accounts: ImportPlanAccount[] = [];

  for (const stmt of statements) {
    if (emptyStatement(stmt)) continue;
    const iban = normalizeIban(stmt.iban);
    const feedId = await feeds.register(feedSpaceId(iban), iban);
    const accountId = await importTargetAccountId(store, feedId, iban);

    const account = await store.get('account', accountId);
    if (account?.spaceId !== feedId) await createStatementAccount(repo, feedId, accountId, stmt, iban);
    else if (statementBalanceWins(account, stmt))
      await repo.upsert('account', feedId, accountId, {
        balanceCents: stmt.closingBalanceCents!,
        ...(stmt.balanceAsOf ? { balanceAsOf: stmt.balanceAsOf } : {}),
      });
    // coverage only moves forward, so a just-recreated row is safe here
    await stampCoverage(repo, feedId, accountId, account, stmt);

    let txCount = 0;
    const batchId = crypto.randomUUID();
    for (const entry of stmt.entries) {
      if (await importFeedEntry({ repo, store, spaceId, accountId, iban, memory, keywordRules, counterCandidates, batchId, importedBy }, feedId, entry)) {
        imported++;
        txCount++;
      } else {
        skipped++;
      }
      onProgress?.(imported + skipped);
    }

    const attached = await refreshExistingAttachment(repo, store, feeds, spaceId, feedId, accountId);

    accounts.push({
      iban: stmt.iban,
      accountId,
      accountName: account?.name ?? `Bank · ${iban.slice(-4)}`,
      isNew: !account,
      attached,
      txCount,
    });
  }

  return { imported, skipped, accounts };
}

async function importFeedEntry(
  ctx: EntryContext,
  feedId: string,
  entry: ParsedStatement['entries'][number],
): Promise<boolean> {
  const txId = uuidv5(`tx:${ctx.iban}:${entry.ref}`, IMPORT_NS);
  if (await ctx.store.get('transaction', txId)) return false;

  await ctx.repo.upsert('transaction', feedId, txId, {
    accountId: ctx.accountId,
    date: entry.date,
    amountCents: entry.amountCents,
    currency: entry.currency,
    merchant: entry.counterpartyName ?? entry.description.slice(0, 40),
    description: entry.description,
    ...(entry.counterpartyIban ? { counterIban: normalizeIban(entry.counterpartyIban) } : {}),
    importRef: entry.ref,
    importBatchId: ctx.batchId,
    ...(ctx.importedBy ? { importedBy: ctx.importedBy } : {}),
  });

  const { predicted, matchedId } = resolveEntryPrediction(ctx, entry);
  await ctx.repo.upsert('txMeta', ctx.spaceId, txMetaId(ctx.spaceId, txId), {
    txId,
    ...predicted,
  });
  await linkPredictedMovement(ctx, txId, predicted, feedId, matchedId);
  return true;
}
