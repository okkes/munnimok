import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useReceiptOps } from '@/application/receipts';
import { connectorsAvailable, useStoreConnMetas } from '@/application/connections';
import { globalAsEntry, linkAsEntry, spaceReceipts } from '@/application/receiptLinks';
import type { ReceiptEntry } from '@/application/receiptLinks';
import { myStoreFeedId } from '@/application/storeFeed';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { candidateLadder, parseReceiptText } from '@/domain/storeReceipts';
import { apiFetch } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';
import { ReceiptBody, receiptTitle } from './ReceiptBody';
import type { ReceiptRow } from '@/db/types';
import type { StorageBackend } from '@/db/backend';

/** where a receipt is looked at from: a space (links, matching) or the connections hub (the party's own list) */
export type ReceiptScope = 'space' | 'global';

const globalRow = async (store: StorageBackend, receiptId: string): Promise<ReceiptRow | undefined> => {
  const feedId = myStoreFeedId();
  if (!feedId) return undefined;
  return (await store.bySpace('receipt', feedId)).find((r) => r.deleted === 0 && r.id === receiptId);
};

/** the receipt as the scope sees it: a space's link first, else the owner's global row; null when gone */
async function findEntry(store: StorageBackend, scope: ReceiptScope, spaceId: string, receiptId: string): Promise<ReceiptEntry | null> {
  if (scope === 'space') {
    const link = (await spaceReceipts(store, spaceId)).find((l) => (l.receiptId ?? l.id) === receiptId);
    if (link) return linkAsEntry(link);
  }
  const row = await globalRow(store, receiptId);
  return row ? globalAsEntry(row) : null;
}

/**
 * One receipt, full screen (user request 2026-10-02: the sheet was
 * cramped). From a space it carries the matching: the transaction it
 * proves, or the ladder to link it; from the connections hub it is the
 * party's document as fetched — no matched/unmatched, no linking, which
 * are a space's business.
 */
export function ReceiptScreen({
  scope,
  receiptId,
  contextTxId,
}: Readonly<{
  scope: ReceiptScope;
  receiptId: string;
  /** the transaction the screen was opened FROM — its own row is noise there */
  contextTxId?: string;
}>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const txs = useSpaceTransactions();
  const metas = useStoreConnMetas();
  const receiptOps = useReceiptOps();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const entry = useQuery(store, async () => findEntry(store, scope, spaceId, receiptId), [scope, spaceId, receiptId]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [ocrState, setOcrState] = useState<'idle' | 'busy' | 'failed'>('idle');

  const receipt = entry?.data ?? null;

  useEffect(() => {
    setConfirmDelete(false);
    setPicking(false);
    setShowMore(false);
    setOcrState('idle');
  }, [receipt?.id]);

  const currency = receipt?.currency ?? space?.currency ?? 'EUR';
  const back = () => window.history.back();
  /** after a delete there is nothing to come back to: the place the receipt was opened from, by name */
  const leave = () => {
    if (contextTxId) void navigate({ to: '/transactions/$txId', params: { txId: contextTxId } });
    else void navigate({ to: scope === 'global' ? '/connections/receipts' : '/receipts' });
  };

  // every transaction the receipt proves (user 2026-10-08: several payments, one receipt); the one the screen was
  // opened FROM stays out of the list — pointing back at it is noise
  const linkedIds = scope === 'space' ? (entry?.txIds ?? []) : [];
  const linkedTxId = linkedIds[0];
  const linkedTxs = linkedIds
    .filter((id) => id !== contextTxId)
    .map((id) => txs?.find((tx) => tx.id === id))
    .filter((tx): tx is SpaceTx => !!tx);
  // opened from one of its transactions while others hold it too: the delete lets go of that one only
  const detachOne = !!contextTxId && linkedIds.length > 1 && linkedIds.includes(contextTxId);
  const ladder = receipt && scope === 'space' ? candidateLadder(receipt, txs ?? []) : { primary: [], more: [] };
  const candidates = () => (showMore ? [...ladder.primary, ...ladder.more] : ladder.primary);
  const photoBorn = entry?.kind === 'link' && entry.data.source === 'photo';
  const connection = receipt?.instanceId ? metas?.find((m) => m.id === receipt.instanceId) : undefined;

  const readItems = async () => {
    if (!receipt?.image || !entry?.linkId) return;
    setOcrState('busy');
    try {
      const response = await apiFetch('/ocr/receipt', { method: 'POST', body: JSON.stringify({ image: receipt.image }) });
      if (!response.ok) {
        setOcrState('failed');
        return;
      }
      const { text } = (await response.json()) as { text: string };
      const items = parseReceiptText(text);
      if (items.length === 0) {
        setOcrState('failed');
        return;
      }
      await receiptOps.setItems(entry.linkId, items);
      setOcrState('idle');
    } catch {
      setOcrState('failed');
    }
  };

  /** the delete button's word: one transaction's hold, a store receipt's unlink, or a delete */
  const deleteLabel = (): string => {
    if (detachOne) return t('receipt.detachOne');
    // a store receipt's link "deletes" by unlinking — the wording must say so
    if (entry?.kind === 'link' && !photoBorn) return t('receipt.unlink');
    return t('action.delete');
  };

  const removeReceipt = async () => {
    if (!entry) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    // each kind deletes in its own store: drop the photo, unlink the
    // store snapshot, or drop the global receipt — from ONE transaction
    // when others hold the receipt too (user 2026-10-08)
    if (entry.kind === 'global') await receiptOps.removeGlobalReceipt(entry.data.id);
    else if (entry.linkId) {
      const txId = detachOne ? contextTxId : undefined;
      await (photoBorn ? receiptOps.remove(entry.linkId, txId) : receiptOps.unlinkReceipt(entry.linkId, txId));
    }
    leave();
  };

  const title = receipt ? receiptTitle(receipt, t) : t('receipt.title');

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-receipt">
      <AppBar
        title={title}
        leading={
          <IconButton label={t('action.back')} testId="receipt-back" onClick={back}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {entry === null && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="receipt-missing">
            <Icon name="receipt-text-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[13px] text-ink-4">{t('receipt.missing')}</p>
          </div>
        )}
        {entry && receipt && (
          <div className="flex flex-col gap-3 pt-1">
            {/* the head, the picture, the items and the invoices — shared with the picker's peek (user 2026-10-09);
                keyed so another receipt under the same screen starts with its invoice sheet closed */}
            <ReceiptBody key={receipt.id} receipt={receipt} currency={currency} connectionName={connection?.displayName} />

            {scope === 'space' ? (
              <>
                {/* the transactions this receipt proves — the one the screen was opened
                    from left out (self-reference); each row opens its transaction */}
                {linkedTxs.length > 0 && (
                  <div>
                    <div className="m-cap mb-1 px-1">{t(linkedTxs.length > 1 ? 'receipt.linkedTitleN' : 'receipt.linkedTitle')}</div>
                    <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3" data-testid="receipt-linked-tx">
                      {linkedTxs.map((tx) => (
                        <div key={tx.id} data-testid={`receipt-linked-${tx.id}`}>
                          <TxRow tx={tx} showDate onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!linkedTxId && (
                  <>
                    <Button variant="outline" className="w-full" data-testid="receipt-link-tx" onClick={() => setPicking((v) => !v)}>
                      {t('receipts.pickTx')}
                    </Button>
                    {picking && (
                      <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3" data-testid="receipt-candidates">
                        {candidates().map((tx) => (
                          <TxRow
                            key={tx.id}
                            tx={tx}
                            showDate
                            onClick={() => {
                              void receiptOps.linkReceipt(receipt, tx.id);
                              setPicking(false);
                            }}
                          />
                        ))}
                        {!showMore && ladder.more.length > 0 && (
                          <button
                            data-testid="receipt-show-more"
                            onClick={() => setShowMore(true)}
                            className="m-tap flex w-full items-center justify-center gap-1 border-none bg-transparent py-2.5 text-[13px] font-medium text-accent-deep"
                          >
                            {t('receipts.showMore', { n: ladder.more.length })}
                            <Icon name="chevron-down" size={15} />
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
                {photoBorn && !receipt.items?.length && connectorsAvailable() && (
                  <>
                    <Button variant="outline" className="w-full" data-testid="receipt-read-items" disabled={ocrState === 'busy'} onClick={() => void readItems()}>
                      {t('receipt.readItems')}
                    </Button>
                    {ocrState === 'failed' && (
                      <p className="text-center text-[12px] text-ink-4" data-testid="receipt-read-failed">
                        {t('receipt.readFailed')}
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="px-1 text-[11px] leading-snug text-ink-4" data-testid="receipt-space-hint">
                {t('receipt.spaceHint')}
              </p>
            )}

            <Button variant="danger" className="w-full" data-testid="receipt-delete" onClick={() => void removeReceipt()}>
              {confirmDelete ? t('action.confirm') : deleteLabel()}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
