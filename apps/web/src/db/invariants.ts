import type { EntityName } from './types';

// enforced at the one local write path (Repo.write): a violation blocks the write and reaches GlitchTip (UI check missing)
// remote ops are never validated: LWW convergence must not be refused, older rows keep syncing
export class InvariantViolation extends Error {
  constructor(entity: EntityName, entityId: string, problems: readonly string[]) {
    super(`${entity}/${entityId}: ${problems.join('; ')}`);
    this.name = 'InvariantViolation';
  }
}

const TX_TYPES = new Set(['income', 'expense', 'saving', 'transfer', 'debtPayment', 'investment', 'funding', 'adjustment']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const isIntCents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** integer cents and an ISO day; a row stores no type (the view derives it) */
function amountAndDateProblems(row: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!isIntCents(row.amountCents)) problems.push('amountCents must be integer cents');
  if (typeof row.date !== 'string' || !ISO_DAY.test(row.date)) problems.push('date must be ISO yyyy-mm-dd');
  return problems;
}

function splitProblems(
  splits: { catId?: unknown; amountCents?: unknown; txType?: unknown; cats?: unknown }[],
): string[] {
  const problems: string[] = [];
  for (const split of splits) {
    if (typeof split.catId !== 'string' || split.catId.length === 0) problems.push('split without a category');
    if (!isIntCents(split.amountCents) || split.amountCents < 0) problems.push('split amount must be non-negative integer cents');
    // a part's own type must be a known one; sign coherence stays UI-side (parts are magnitudes, the row signs them)
    if (split.txType !== undefined && !(typeof split.txType === 'string' && TX_TYPES.has(split.txType))) {
      problems.push('unknown split txType');
    }
    if (split.cats !== undefined) problems.push(...splitCatProblems(split));
  }
  return problems;
}

/** entries must be sound and sum to the part; a lone entry is legal (#228: a settled part holds only `reimbursed`) */
function splitCatProblems(split: { amountCents?: unknown; cats?: unknown }): string[] {
  if (!Array.isArray(split.cats) || split.cats.length === 0) return ['split cats must hold at least one entry'];
  const problems: string[] = [];
  let sum = 0;
  for (const cat of split.cats as { catId?: unknown; amountCents?: unknown }[]) {
    if (typeof cat.catId !== 'string' || cat.catId.length === 0) problems.push('split cat without a category');
    if (!isIntCents(cat.amountCents) || cat.amountCents < 0) problems.push('split cat amount must be non-negative integer cents');
    else sum += cat.amountCents as number;
  }
  if (problems.length === 0 && sum !== split.amountCents) problems.push('split cats must sum to the part amount');
  return problems;
}

/** #211: the row's partition must be sound and sum to the gross amount, `reimbursed` included; a lone entry is legal */
function rowCatsProblems(row: Record<string, unknown>): string[] {
  if (row.cats === undefined || row.cats === null) return [];
  if (!Array.isArray(row.cats) || row.cats.length === 0) return ['row cats must hold at least one entry'];
  const problems: string[] = [];
  let sum = 0;
  for (const cat of row.cats as { catId?: unknown; amountCents?: unknown }[]) {
    if (typeof cat.catId !== 'string' || cat.catId.length === 0) problems.push('row cat without a category');
    if (!isIntCents(cat.amountCents) || cat.amountCents < 0) problems.push('row cat amount must be non-negative integer cents');
    else sum += cat.amountCents as number;
  }
  if (problems.length === 0 && isIntCents(row.amountCents) && sum !== Math.abs(row.amountCents)) {
    problems.push('row cats must sum to the gross amount');
  }
  return problems;
}

function reimbursementProblems(links: { txId?: unknown; amountCents?: unknown }[]): string[] {
  const problems: string[] = [];
  for (const link of links) {
    if (typeof link.txId !== 'string' || link.txId.length === 0) problems.push('reimbursement without a counterpart');
    if (!isIntCents(link.amountCents) || link.amountCents <= 0) problems.push('reimbursement amount must be positive integer cents');
  }
  return problems;
}

function transactionProblems(row: Record<string, unknown>): string[] {
  const reviewFlagOk = row.needsReview === undefined || row.needsReview === 0 || row.needsReview === 1;
  return [
    ...amountAndDateProblems(row),
    ...rowCatsProblems(row),
    ...splitProblems((row.splits as { catId?: unknown; amountCents?: unknown }[] | null | undefined) ?? []),
    ...reimbursementProblems((row.reimbursements as { txId?: unknown; amountCents?: unknown }[] | null | undefined) ?? []),
    ...(reviewFlagOk ? [] : ['needsReview must be 0 or 1']),
  ];
}

function namedRowProblems(row: Record<string, unknown>): string[] {
  // live rows need a usable name; tombstones keep whatever they had
  if (row.deleted !== 0) return [];
  return typeof row.name === 'string' && row.name.trim().length > 0 ? [] : ['live row without a name'];
}

/** empty when the row is sound; unknown entities pass: rules are opt-in per table */
export function rowProblems(entity: EntityName, row: Record<string, unknown>): string[] {
  if (typeof row.id !== 'string' || row.id.length === 0) return ['row without an id'];
  switch (entity) {
    case 'transaction':
      return transactionProblems(row);
    case 'space':
    case 'category':
      return namedRowProblems(row);
    default:
      return [];
  }
}
