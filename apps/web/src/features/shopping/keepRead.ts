import type { ReceiptOps } from '@/application/receipts';
import type { ReceiptEntry } from '@/application/receiptLinks';
import type { ReceiptReadOutcome } from './ReceiptAiRead';

/** what a reader made of a photo lands on the receipt it is of: the person's own row, or the link in a space */
export async function keepRead(ops: ReceiptOps, fileByReceipt: (txId: string) => Promise<boolean>, entry: ReceiptEntry, outcome: ReceiptReadOutcome): Promise<void> {
  if (!entry.linkId) {
    const { totalCents, ...found } = outcome;
    // a reading that found no total leaves a typed one alone
    await ops.setOwnFacts(entry.data.id, totalCents > 0 ? { ...found, totalCents } : found);
    return;
  }
  await ops.setRead(entry.linkId, outcome);
  // now that the lines are known, a payment of the same amount is filed by them
  for (const txId of entry.txIds ?? []) await fileByReceipt(txId);
}
