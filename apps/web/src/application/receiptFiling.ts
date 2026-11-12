import { visibleTransactions, writeTxTransform } from '@/db/joined';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import { itemMemoryOf, receiptFiling } from '@/domain/receiptCats';
import { txTitle } from '@/lib/text';
import { logActivity } from './activity';
import { isLinkedTo, spaceReceipts } from './receiptLinks';

/**
 * #567 (user): "the moment the receipt is attached to a transaction and
 * the receipt and transaction value are the same" the payment is filed by
 * the receipt's lines. Run after an attach — or a read — made outside the
 * review: there the card shows the filing first and Confirm writes it. The
 * review flag is left as it stands: a payment still to review stays so.
 */
export async function fileByReceipt(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  txId: string,
  known: (catId: string) => boolean,
): Promise<boolean> {
  const links = await spaceReceipts(store, spaceId);
  const link = links.find((row) => isLinkedTo(row, txId));
  const tx = link && (await visibleTransactions(store, spaceId)).find((row) => row.id === txId);
  if (!link || !tx) return false;
  const filing = receiptFiling(tx, link, itemMemoryOf(links), known);
  if (!filing) return false;
  const primary = filing.cats.reduce((best, entry) => (entry.amountCents > best.amountCents ? entry : best), filing.cats[0]);
  await repo.batch(async () => {
    await writeTxTransform(repo, tx, filing.cats.length > 1 ? { cats: filing.cats, catId: primary.catId } : { catId: primary.catId });
    await repo.upsert('receiptLink', spaceId, link.id, { picks: { ...link.picks, [txId]: filing.picks } });
  });
  void logActivity(store, repo, spaceId, 'txCategory', txTitle(tx));
  return true;
}
