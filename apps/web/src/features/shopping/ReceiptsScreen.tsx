import { useMemo } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useProposedMatches } from '@/application/receiptLinks';
import { useAttachableReceipts } from '@/application/connections';
import { useReceiptOps } from '@/application/receipts';
import { useSpaceTransactions } from '@/application/transactions';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import type { ReactNode } from 'react';
import { ReceiptList } from './ReceiptList';
import type { ReceiptListItem } from './ReceiptList';
import { ReceiptProposalCard } from './ReceiptPickSheet';
import { useLeavingRows } from './leavingRows';
import { useFileByReceipt } from './useFileByReceipt';

export const PROPOSAL_EXIT_MS = 260;

function ExitRow({ leaving, children }: Readonly<{ leaving: boolean; children: ReactNode }>) {
  return (
    <div
      data-leaving={leaving ? '1' : undefined}
      className={`grid transition-[grid-template-rows,opacity] duration-[260ms] ease-in ${leaving ? '[grid-template-rows:0fr] opacity-0' : '[grid-template-rows:1fr]'}`}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="pb-2">{children}</div>
      </div>
    </div>
  );
}

export function ReceiptsScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();

  const inventory = useAttachableReceipts();
  const proposals = useProposedMatches();
  const txs = useSpaceTransactions();
  const receiptOps = useReceiptOps();
  const fileByReceipt = useFileByReceipt();
  const canEdit = useCanEdit(); // #505
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  // an answered match folds away before it leaves the data
  const { rows: toCheck, leave } = useLeavingRows(proposals, PROPOSAL_EXIT_MS);

  // #648: the space's own receipts and those of every feed it reads, each marked by where it lives
  const items = useMemo(
    (): ReceiptListItem[] | undefined =>
      inventory?.rows.map((receipt) => ({
        receipt,
        txIds: inventory.attachedTo.get(receipt.id) ?? [],
        scope: receipt.spaceId === spaceId ? 'space' : 'global',
      })),
    [inventory, spaceId],
  );

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-receipts">
      <AppBar
        title={t('receipts.title')}
        leading={
          <IconButton label={t('action.back')} testId="receipts-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          <IconButton label={t('receipts.connections')} testId="receipts-connections" onClick={() => void navigate({ to: '/connections' })}>
            <Icon name="link-variant" size={20} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <ReceiptList
          items={items}
          linkState
          fallbackCurrency={currency}
          onOpen={(receipt) => void navigate({ to: '/receipts/$receiptId', params: { receiptId: receipt.id } })}
          empty={
            <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="receipts-empty">
              <Icon name="receipt-text-outline" size={34} color="var(--m-ink-4)" />
              <p className="text-[14px] font-medium text-ink-2">{t('receipts.emptyTitle')}</p>
              <p className="text-[12px] text-ink-4">{t('receipts.emptyBody')}</p>
            </div>
          }
        >
          {/* #367 §5.7: receipts whose best match is a reviewed transaction ask first; the answer folds the card away */}
          {/* #505: answering is the space's members' work — a reader sees the receipts, not the questions */}
          {canEdit && toCheck.length > 0 && (
            <div className="mt-3" data-testid="receipts-to-check">
              <div className="m-cap mb-1 px-1">{t('receipts.toCheckTitle')}</div>
              <p className="mb-2 px-1 text-[11px] leading-snug text-ink-4">{t('receipts.toCheckSub')}</p>
              {toCheck.map(({ item: link, leaving }, index) => (
                <ExitRow key={link.id} leaving={leaving}>
                  <ReceiptProposalCard
                    link={link}
                    tx={txs?.find((tx) => tx.id === link.proposedTxId)}
                    currency={currency}
                    ids={{
                      card: `receipt-proposal-${link.id}`,
                      open: `receipt-proposal-open-${link.id}`,
                      tx: `receipt-proposal-tx-${link.id}`,
                      accept: `receipt-proposal-accept-${link.id}`,
                      reject: `receipt-proposal-reject-${link.id}`,
                    }}
                    busy={leaving}
                    onOpenReceipt={() => void navigate({ to: '/receipts/$receiptId', params: { receiptId: link.receiptId } })}
                    onOpenTx={(txId) => void navigate({ to: '/transactions/$txId', params: { txId } })}
                    onAccept={(answered) =>
                      leave(answered, index, async () => {
                        await receiptOps.acceptMatch(answered);
                        if (answered.proposedTxId) await fileByReceipt(answered.proposedTxId);
                      })
                    }
                    onReject={(answered) => leave(answered, index, () => receiptOps.rejectMatch(answered))}
                  />
                </ExitRow>
              ))}
            </div>
          )}
        </ReceiptList>
      </div>
    </div>
  );
}
