import { CATEGORY_BY_ID, REIMBURSED_ID } from './categories';
import { ALL_KEYWORD_RULES } from './keyword-extras';
import type { KeywordRule } from './keyword-categories';
import { predictFromMemory } from './merchantMemory';
import type { MerchantMemory } from './merchantMemory';
import { accountStamp, fitToMatrix } from './txType';
import type { AccountType } from '@/db/types';

// runs on-device so import works offline; rules are filtered by money direction
// onboarding's country picks the keyword language; only Dutch sets exist, unknown countries fall back to them
const COUNTRY_KEYWORD_LANG: Record<string, string> = { NL: 'nl', BE: 'nl' };
const FALLBACK_KEYWORD_LANG = 'nl';

let activeRules: readonly KeywordRule[] = ALL_KEYWORD_RULES;

export function setPredictionCountry(country?: string): void {
  const keywordLang = COUNTRY_KEYWORD_LANG[country?.toUpperCase() ?? ''] ?? FALLBACK_KEYWORD_LANG;
  const filtered = ALL_KEYWORD_RULES.filter((r) => r.lang === keywordLang);
  activeRules = filtered.length ? filtered : ALL_KEYWORD_RULES.filter((r) => r.lang === FALLBACK_KEYWORD_LANG);
}

export function predictCategory(
  text: string,
  direction: 'credit' | 'debit',
  rules: readonly { catId: string; keywords: string[] }[] = activeRules,
  catById: { get: (id: string) => { direction: 'credit' | 'debit' | 'both' } | undefined } = CATEGORY_BY_ID,
): string | null {
  const haystack = text.toLowerCase();
  const words = new Set(haystack.split(/\s+/));

  const candidates: { keyword: string; catId: string }[] = [];
  for (const rule of rules) {
    const cat = catById.get(rule.catId);
    if (!cat) continue;
    if (cat.direction !== 'both' && cat.direction !== direction) continue;
    for (const keyword of rule.keywords) candidates.push({ keyword, catId: rule.catId });
  }
  candidates.sort((a, b) => b.keyword.length - a.keyword.length);

  for (const { keyword, catId } of candidates) {
    const hit = keyword.length > 3 ? haystack.includes(keyword) : words.has(keyword);
    if (hit) return catId;
  }
  return null;
}

export interface TxPrediction {
  catId: string;
  source: 'history' | 'history-amount' | 'keyword';
  evidence?: number;
  /** #161: the pct spread the user keeps confirming (own space only) */
  cats?: { catId: string; pct: number }[];
  /** #161: the event the recent charges joined (own space only) */
  eventId?: string;
}

/** #161: the own space answers first, other spaces are the fallback */
export interface LayeredMemory {
  own: MerchantMemory;
  others: MerchantMemory;
}

export interface PredictInput {
  memory?: LayeredMemory;
  merchant: string;
  /** the user's rename; keyword matching reads it too */
  titleOverride?: string;
  description?: string;
  amountCents: number;
  /** operator-published rules (catalog document), merged in front of the bundled set so they win ties */
  keywordRules?: readonly { catId: string; keywords: string[] }[];
  /** #564: the memory reads this account type's own ledger only; a special category obeys the picker's matrix */
  sourceAccountType?: AccountType;
}

// the prediction is a CATEGORY (plus a learned spread or event); the row's type derives from it at the join
function memoryPrediction(memory: LayeredMemory, input: PredictInput): TxPrediction | null {
  const ledger = accountStamp(input.sourceAccountType);
  const hit =
    predictFromMemory(memory.own, input.merchant, input.amountCents, ledger) ??
    predictFromMemory(memory.others, input.merchant, input.amountCents, ledger);
  if (!hit) return null;
  const catId = fitToMatrix(hit.catId, input.sourceAccountType, input.amountCents >= 0 ? 'credit' : 'debit');
  if (!catId) return null;
  return {
    catId,
    source: hit.amountMatch ? 'history-amount' : 'history',
    evidence: hit.evidence,
    ...(hit.cats ? { cats: hit.cats } : {}),
    ...(hit.eventId ? { eventId: hit.eventId } : {}),
  };
}

export function predictTx(input: PredictInput): TxPrediction | null {
  const prediction = predictTxRaw(input);
  // settlement bookkeeping is never a prediction: `reimbursed` arrives only through an actual reimbursement link
  return prediction?.catId === REIMBURSED_ID ? null : prediction;
}

function predictTxRaw(input: PredictInput): TxPrediction | null {
  if (input.memory) {
    const remembered = memoryPrediction(input.memory, input);
    if (remembered) return remembered;
  }
  const direction = input.amountCents >= 0 ? 'credit' : 'debit';
  const keyword = predictCategory(
    `${input.merchant} ${input.titleOverride ?? ''} ${input.description ?? ''}`,
    direction,
    input.keywordRules ? [...input.keywordRules, ...activeRules] : activeRules,
  );
  const catId = keyword ? fitToMatrix(keyword, input.sourceAccountType, direction) : null;
  if (!catId) return null;
  return { catId, source: 'keyword' };
}

// no prediction skips the review: every transaction passes the deck prefilled, and only the person takes it out
