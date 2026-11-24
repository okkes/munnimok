import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useQuery } from '@/db/useQuery';
import { useReceiptFile } from '@/application/receiptFiles';
import { useReceiptOps } from '@/application/receipts';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { connectorsAvailable, useStoreConnMetas } from '@/application/connections';
import { globalAsEntry, includedFeeds, joinReceipt, linkAsEntry, paymentsHolding } from '@/application/receiptLinks';
import type { ReceiptEntry } from '@/application/receiptLinks';
import { myScansFeedId } from '@/application/storeFeed';
import { receiptLinkId } from '@/domain/feedIds';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { candidateLadder, parseReceiptText } from '@/domain/storeReceipts';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';
import { ReceiptAiRead } from './ReceiptAiRead';
import { CategoriseDoor, PhotoCleanupDoor, ShareScansDoor } from './ReceiptDoors';
import { uncategorisedNames } from '@/domain/receiptCats';
import { ReceiptFacts } from './ReceiptFacts';
import { keepRead } from './keepRead';
import { useFileByReceipt } from './useFileByReceipt';
import { ReceiptBody, receiptTitle } from './ReceiptBody';
import type { StorageBackend } from '@/db/backend';

// born: the space's own (a photo taken on a transaction); own: a scan seen without a link here;
// linked: a scan this space put on a transaction, or is asked about (#567)
const photoKind = (entry: ReceiptEntry | null | undefined, spaceId: string): 'born' | 'own' | 'linked' | null => {
  if (entry?.data.source !== 'photo') return null;
  if (entry.data.spaceId === spaceId) return 'born';
  return entry.kind === 'global' ? 'own' : 'linked';
};

/** a link lets go of its payment(s) where the space may be changed; the receipt itself is deleted by its owner, where no
 *  link stands in front of it — from their own list, in the space that made it, or where the space does not read it */
const mayRemove = (at: { linked: boolean; mine: boolean; spaceLocked: boolean; outside: boolean }): boolean => {
  if (at.linked) return !at.spaceLocked;
  return at.mine && (at.outside || !at.spaceLocked);
};

/** where a receipt is looked at from: a space (links, matching) or the connections hub (the party's own list) */
export type ReceiptScope = 'space' | 'global';

/** the receipt where it lives, with what this space decided about it when it is looked at from a space */
async function findEntry(store: StorageBackend, scope: ReceiptScope, spaceId: string, receiptId: string): Promise<ReceiptEntry | null> {
  const receipt = await store.get('receipt', receiptId);
  if (receipt?.deleted !== 0) return null;
  if (scope === 'space') {
    const link = await store.get('receiptLink', receiptLinkId(spaceId, receiptId));
    if (link?.deleted === 0) return linkAsEntry(joinReceipt(link, receipt));
  }
  return globalAsEntry(receipt);
}

// from a space it carries the matching; from the connections hub it is the party's document as fetched,
// with no linking (a space's business)
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
  const fileByReceipt = useFileByReceipt();
  // #505: a space's receipt is its members' to link, read or remove; a connection's own receipt stays the person's
  const spaceLocked = !useCanEdit() && scope === 'space';
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const entry = useQuery(store, async () => findEntry(store, scope, spaceId, receiptId), [scope, spaceId, receiptId]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // #648: a receipt that goes takes itself off every payment it is on — said before it happens
  const [impact, setImpact] = useState(0);
  const [picking, setPicking] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [ocrState, setOcrState] = useState<'idle' | 'busy' | 'failed'>('idle');
  // #567: where the environment has a vision model read receipts, that takes the old text reading's place
  const aiReader = useQuery(store, async () => (await getApiCapabilities()).receiptAi === true, [spaceId]) === true;

  const receipt = entry?.data ?? null;
  const picture = useReceiptFile(receipt?.imageId);
  const feedId = receipt?.spaceId;
  // #648: a receipt is put on a payment only in a space that holds it or reads the feed it lives in
  const inSpace = useQuery(store, async () => !feedId || feedId === spaceId || (await includedFeeds(store, spaceId)).has(feedId), [spaceId, feedId]);
  // the receipt is whose feed (or space) it lives in: only they change or delete it
  const mine = !!receipt && receiptOps.canEdit(receipt);
  const spaceOwn = receipt?.spaceId === spaceId;

  useEffect(() => {
    setConfirmDelete(false);
    setImpact(0);
    setPicking(false);
    setShowMore(false);
    setOcrState('idle');
  }, [receipt?.id]);

  const currency = receipt?.currency ?? space?.currency ?? 'EUR';
  const back = () => window.history.back();
  const leave = () => {
    if (contextTxId) void navigate({ to: '/transactions/$txId', params: { txId: contextTxId } });
    else void navigate({ to: scope === 'global' ? '/connections/receipts' : '/receipts' });
  };

  // every transaction the receipt proves; the one the screen was opened FROM stays out — pointing back is noise
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
  const photo = photoKind(entry, spaceId);
  const photoBorn = photo === 'born';
  // what a reader finds is written to the receipt itself: only who may write it has it read
  const readable = photo !== null && mine;
  const connection = receipt?.instanceId ? metas?.find((m) => m.id === receipt.instanceId) : undefined;
  // a scan of mine looked at from a space that does not read my scans: it is shared before it is used there
  const unshared = scope === 'space' && inSpace === false && !!receipt && receipt.spaceId === myScansFeedId();
  const deletes = mayRemove({ linked: entry?.kind === 'link', mine, spaceLocked, outside: scope === 'global' || spaceOwn || inSpace === false });
  const photoRemovable = photo !== null && mine && !!receipt?.imageId && !!receipt.items?.length;
  const toCategorise = !!receipt && receipt.source !== 'photo' && mine && aiReader && uncategorisedNames(receipt).length > 0;

  const readItems = async () => {
    if (!picture || !receipt) return;
    setOcrState('busy');
    try {
      const response = await apiFetch('/ocr/receipt', { method: 'POST', body: JSON.stringify({ image: picture }) });
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
      await receiptOps.setItems(receipt, items);
      setOcrState('idle');
    } catch {
      setOcrState('failed');
    }
  };

  const deleteLabel = (): string => {
    if (detachOne) return t('receipt.detachOne');
    // a receipt from a feed "deletes" here by unlinking — the wording must say so
    if (entry?.kind === 'link' && !spaceOwn) return t('receipt.unlink');
    return t('action.delete');
  };

  const removeReceipt = async () => {
    if (!entry) return;
    if (!confirmDelete) {
      if (entry.kind === 'global') setImpact(await paymentsHolding(store, (link) => link.receiptId === entry.data.id));
      setConfirmDelete(true);
      return;
    }
    // a link lets go (from ONE transaction when others hold the receipt too) and the space's own receipt goes with
    // its last one; without a link it is the receipt itself that is deleted, for everyone who read it
    if (entry.kind === 'global') await receiptOps.removeReceipt(entry.data);
    else if (entry.linkId) {
      const txId = detachOne ? contextTxId : undefined;
      await (spaceOwn ? receiptOps.remove(entry.linkId, txId) : receiptOps.unlinkReceipt(entry.linkId, txId));
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
            {/* shared with the picker's peek; keyed so another receipt starts with its invoice sheet closed */}
            <ReceiptBody key={receipt.id} receipt={receipt} currency={currency} connectionName={connection?.displayName} />

            {scope === 'space' && linkedTxs.length > 0 && (
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
            {/* #567: a receipt kept without a transaction: facts typed here or read below, it waits for the payment it fits */}
            {photo === 'own' && mine && (
              <>
                <ReceiptFacts
                  key={`${receipt.date}:${receipt.totalCents}:${receipt.merchant ?? ''}`}
                  receipt={receipt}
                  onSave={(facts) => receiptOps.setOwnFacts(receipt, facts)}
                />
                {receipt.totalCents > 0 && (
                  <p className="px-1 text-[11px] leading-snug text-ink-4" data-testid="receipt-waiting">
                    {t('receipt.waiting')}
                  </p>
                )}
              </>
            )}
            {scope === 'space' && (
              <>
                <ReadOnlyNote testId="receipt-readonly-note" />
                {unshared && !spaceLocked && <ShareScansDoor key={receipt.id} spaceId={spaceId} spaceName={space?.name ?? ''} />}
                {!linkedTxId && !spaceLocked && inSpace && (
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
                              void receiptOps.linkReceipt(receipt, tx.id).then(() => fileByReceipt(tx.id));
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
              </>
            )}
            {readable && aiReader && picture && (
              <ReceiptAiRead
                images={[picture]}
                hasItems={!!receipt.items?.length}
                freshId={entry.linkId ?? receipt.id}
                onRead={(outcome) => keepRead(receiptOps, fileByReceipt, entry, outcome)}
              />
            )}
            {scope === 'space' && photoBorn && !spaceLocked && !aiReader && !receipt.items?.length && connectorsAvailable() && (
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
            {toCategorise && <CategoriseDoor key={receipt.id} receipt={receipt} />}
            {photoRemovable && <PhotoCleanupDoor key={receipt.id} receipt={receipt} />}
            {photo !== null && !receipt.imageId && (
              <p className="px-1 text-[11px] leading-snug text-ink-4" data-testid="receipt-photo-gone">
                {t('receipt.photo.gone')}
              </p>
            )}
            {scope === 'global' && (
              <p className="px-1 text-[11px] leading-snug text-ink-4" data-testid="receipt-space-hint">
                {t('receipt.spaceHint')}
              </p>
            )}

            {deletes && confirmDelete && impact > 0 && (
              <p className="px-1 text-[12px] leading-snug text-ink-3" data-testid="receipt-delete-impact">
                {t(impact === 1 ? 'receipt.onPaymentsOne' : 'receipt.onPaymentsN', { n: impact })}
              </p>
            )}
            {deletes && (
              <Button variant="danger" className="w-full" data-testid="receipt-delete" onClick={() => void removeReceipt()}>
                {confirmDelete ? t('action.confirm') : deleteLabel()}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
