import type { ReceiptItem } from '@/db/types';
import { apiFetch } from '@/lib/api';

/** a category the reader may file a line under */
export interface ReadCategory {
  id: string;
  name: string;
}

/** one line as the API hands it back: checked there, in whole cents */
export interface ReadLine {
  name: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
  kind: 'item' | 'discount' | 'deposit' | 'fee';
  categoryId: string | null;
}

export interface ReadReceipt {
  merchant: string | null;
  date: string | null;
  currency: string | null;
  totalCents: number;
  lines: ReadLine[];
  /** the lines add up to the total */
  reconciled: boolean;
}

/**
 * ok; limited = this person's reads for today are used up; capped = the
 * month's for everybody; unreadable = the reader made no receipt of the
 * photo; unavailable = no answer to give.
 */
export type ReceiptReadState = 'ok' | 'limited' | 'capped' | 'unreadable' | 'unavailable';

export interface ReceiptReadReply {
  state: ReceiptReadState;
  receipt: ReadReceipt | null;
  /** limited and capped: when reading is back (ISO) */
  until: string | null;
}

const UNAVAILABLE: ReceiptReadReply = { state: 'unavailable', receipt: null, until: null };

/** #567: the photos go to munni's API, which has a vision model read them and checks every figure itself */
export async function readReceiptPhotos(images: readonly string[], categories: readonly ReadCategory[]): Promise<ReceiptReadReply> {
  const res = await apiFetch('/receipts/read', { method: 'POST', body: JSON.stringify({ images, categories }) }).catch(() => null);
  if (!res?.ok) return UNAVAILABLE;
  return (await res.json()) as ReceiptReadReply;
}

/** the reader's lines as the receipt keeps them: a plain product carries no kind, a single piece no quantity */
export function itemsFromRead(receipt: ReadReceipt): ReceiptItem[] {
  return receipt.lines.map((line) => ({
    name: line.name,
    ...(line.quantity === 1 ? {} : { qty: line.quantity, unitCents: line.unitCents }),
    totalCents: line.totalCents,
    ...(line.kind === 'item' ? {} : { kind: line.kind }),
    ...(line.categoryId ? { catId: line.categoryId } : {}),
  }));
}

const CONSENT_KEY = 'munni_receipt_ai';

/**
 * The person's say on this device (user 2026-11-11: a one-time notice
 * that names the provider, and a switch to turn it off again): 'yes' once
 * they agreed, 'no' once they switched it off, null before either.
 */
export function receiptAiChoice(): 'yes' | 'no' | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'yes' || value === 'no' ? value : null;
  } catch {
    return null;
  }
}

export function setReceiptAiChoice(choice: 'yes' | 'no'): void {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // a private window keeps nothing: the notice simply comes again
  }
}
