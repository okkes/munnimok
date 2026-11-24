import type { ReceiptOps } from '@/application/receipts';
import type { ReceiptEntry } from '@/application/receiptLinks';
import type { ReceiptReadOutcome } from './ReceiptAiRead';
import { readingAddsUp, receiptPhotoCleanup } from './receiptAi';

/** what a reader made of a photo lands on the receipt itself (#648): it is read once, for everyone who reads the receipt */
export async function keepRead(ops: ReceiptOps, fileByReceipt: (txId: string) => Promise<boolean>, entry: ReceiptEntry, outcome: ReceiptReadOutcome): Promise<void> {
  // a reading that found no total leaves a typed one alone
  await ops.setRead(entry.data, outcome);
  // now that the lines are known, a payment of the same amount is filed by them
  for (const txId of entry.txIds ?? []) await fileByReceipt(txId);
  // #648: with that standing order, a reading that adds up needs its photo no longer
  if (receiptPhotoCleanup() === 'certain' && readingAddsUp(outcome)) await ops.removePhoto(entry.data);
}
