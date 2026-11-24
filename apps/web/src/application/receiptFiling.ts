import { visibleTransactions, writeTxTransform } from '@/db/joined';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { itemMemoryOf, receiptFiling } from '@/domain/receiptCats';
import { txTitle } from '@/lib/text';
import { logActivity } from './activity';
import { isLinkedTo, spaceReceipts } from './receiptLinks';

// #567: a payment is filed by the lines of a receipt of the same amount once attached; the review flag stays
// runs after an attach or read outside the review (there the card shows the filing, Confirm writes it)
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
  // #648: what a person verified and categorised is theirs — a receipt landing later offers its categories, it does not write them
  if (tx.needsReview === 0 && !!tx.catId && tx.catId !== UNCATEGORIZED_ID) return false;
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
