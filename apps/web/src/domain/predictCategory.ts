import { CATEGORY_BY_ID } from './categories';
import { KEYWORD_RULES } from './keyword-categories';
import { predictFromMemory } from './merchantMemory';
import type { MerchantMemory } from './merchantMemory';
import type { TxType } from '@/db/types';

/**
 * Keyword-based category prediction for imported bank transactions, ported
 * from apollousa's CategoryByKeyWordPredictor. Runs fully on-device so
 * import works offline.
 *
 * Long keywords (>3 chars) match as substrings; short ones must match a
 * whole word. Longest keyword wins. Rules are filtered by money direction
 * so e.g. income keywords never fire on a debit.
 */
export function predictCategory(text: string, direction: 'credit' | 'debit'): string | null {
  const haystack = text.toLowerCase();
  const words = new Set(haystack.split(/\s+/));

  const candidates: { keyword: string; catId: string }[] = [];
  for (const rule of KEYWORD_RULES) {
    const cat = CATEGORY_BY_ID.get(rule.catId);
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
  txType: TxType;
  source: 'history' | 'history-amount' | 'keyword';
  /** history occurrences backing the prediction (history sources only) */
  evidence?: number;
}

export interface PredictInput {
  memory?: MerchantMemory;
  merchant: string;
  description?: string;
  amountCents: number;
}

/**
 * Layered prediction: the user's own history for this merchant first
 * (same-amount occurrences boosted — subscription behavior), keyword
 * rules as the cold-start fallback. History also carries the learned
 * transaction TYPE (a DEGIRO transfer the user marked as saving stays
 * saving), keywords derive it from the category.
 */
export function predictTx(input: PredictInput): TxPrediction | null {
  if (input.memory) {
    const hit = predictFromMemory(input.memory, input.merchant, input.amountCents);
    if (hit) {
      return {
        catId: hit.catId,
        txType: hit.txType,
        source: hit.amountMatch ? 'history-amount' : 'history',
        evidence: hit.evidence,
      };
    }
  }
  const direction = input.amountCents >= 0 ? 'credit' : 'debit';
  const catId = predictCategory(`${input.merchant} ${input.description ?? ''}`, direction);
  if (!catId) return null;
  const txType = CATEGORY_BY_ID.get(catId)?.txTypes[0] ?? (direction === 'credit' ? 'income' : 'expense');
  return { catId, txType, source: 'keyword' };
}

/**
 * Only predictions the user effectively taught the app skip review:
 * a merchant they confirmed at least twice. Keyword hits and first-time
 * history are applied but flagged — review is the teaching loop.
 */
export const predictionSkipsReview = (prediction: TxPrediction | null): boolean =>
  prediction !== null && prediction.source !== 'keyword' && (prediction.evidence ?? 0) >= 2;
