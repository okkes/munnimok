import { useSyncExternalStore } from 'react';
import type { ReceiptItem } from '@/db/types';
import { apiFetch } from '@/lib/api';

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

/** 'yes' once agreed, 'no' once switched off, null before either; a one-time notice names the provider */
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
    // "no" ends the standing order too: nothing is sent on its own after it
    if (choice === 'no') localStorage.removeItem(AUTO_READ_KEY);
  } catch {
    // a private window keeps nothing: the notice simply comes again
  }
}

const AUTO_READ_KEY = 'munni_receipt_auto_read';

/** #648: a photo is read as soon as it is taken, without the button; only ever on with the consent given */
export function receiptAutoRead(): boolean {
  try {
    return localStorage.getItem(AUTO_READ_KEY) === 'yes' && receiptAiChoice() === 'yes';
  } catch {
    return false;
  }
}

export function setReceiptAutoRead(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_READ_KEY, 'yes');
    else localStorage.removeItem(AUTO_READ_KEY);
  } catch {
    // a private window keeps nothing: the photo then waits for the button
  }
}

// the photos just taken on this device; the read door that shows one of them starts by itself, once
const fresh = new Set<string>();
const watchers = new Set<() => void>();
const changed = () => watchers.forEach((watcher) => watcher());

/** a photo was just taken as this receipt (or link): with the standing order on, it is read where it is shown next */
export function markFreshPhoto(id: string): void {
  if (!receiptAutoRead()) return;
  fresh.add(id);
  changed();
}

export function takeFreshPhoto(id: string): boolean {
  const taken = fresh.delete(id);
  if (taken) changed();
  return taken;
}

/** a door already on screen when its photo is marked learns of it: the row can land before the mark does */
export function useFreshPhoto(id: string | undefined): boolean {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    () => !!id && fresh.has(id),
  );
}
