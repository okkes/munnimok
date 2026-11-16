import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { linkAsEntry } from '@/application/receiptLinks';
import { catName, useCategories } from '@/features/categories/useCategories';
import { partyName } from '@/features/connectors/logos';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';
import { fmtCents } from '@/lib/money';
import { txTitle } from '@/lib/text';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { ReceiptPeekSheet } from './ReceiptPeekSheet';
import { filterReceipts, receiptFilter, receiptParties } from './receiptPick';

/** the sheet only reports picks: the review stages one for its confirm, the detail and the bulk walk link or swap at once */
export interface ReceiptPickSheetProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  title: string;
  testIdPrefix: string;
  /** the suggestion rows' own prefix when it is not `<testIdPrefix>-pick` (the detail's rows stay `receipt-pick-<id>`) */
  pickTestIdPrefix?: string;
  proposal?: ReceiptLinkRow;
  /** behind a full-height sheet the transaction is out of sight, so the card shows both rows to compare */
  proposalTx?: SpaceTx;
  candidates: readonly ReceiptRow[];
  all: readonly ReceiptRow[];
  selectedId: string | null;
  /** the receipt already attached to the transaction — its look offers no second attach */
  attachedId?: string | null;
  noneSelected?: boolean;
  /** the None option is on offer at all (the detail hides it until a receipt is attached) */
  showNone?: boolean;
  currency: string;
  // the OTHER transactions a receipt is attached to, by receipt id: the row says so and stays pickable
  // (several payments, one receipt)
  attachedTo?: ReadonlyMap<string, readonly string[]>;
  describeTx?: (txId: string) => string | undefined;
  onAccept: (link: ReceiptLinkRow) => void;
  onReject: (link: ReceiptLinkRow) => void;
  onPick: (row: ReceiptRow | null) => void;
  context?: ReactNode;
  children?: ReactNode;
}

type Lang = ReturnType<typeof useLang>['lang'];

/** a receipt's day as the picker shows it — with the year, since the whole history is listed */
const fmtReceiptDay = (iso: string, lang: Lang): string =>
  new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

const sourceIcon = (receipt: Pick<ReceiptRow, 'source'>): string => (receipt.source === 'photo' ? 'camera-outline' : 'storefront-outline');

function ProposalRow({
  icon,
  color,
  title,
  sub,
  amount,
  testId,
  onOpen,
}: Readonly<{ icon: string; color: string; title: string; sub: string; amount: string; testId: string; onOpen?: () => void }>) {
  const inner = (
    <>
      <Icon name={icon} size={18} color={color} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{title}</span>
        <span className="block truncate text-[11px] text-ink-4">{sub}</span>
      </span>
      <span className="m-num shrink-0 text-[13px] font-semibold text-ink">{amount}</span>
      {onOpen && <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />}
    </>
  );
  const shape = 'flex w-full items-center gap-3 px-4 py-3 text-left';
  if (!onOpen) {
    return (
      <div className={shape} data-testid={testId}>
        {inner}
      </div>
    );
  }
  return (
    <button data-testid={testId} onClick={onOpen} className={`m-tap ${shape} border-none bg-transparent`}>
      {inner}
    </button>
  );
}

function TxProposalRow({ tx, currency, testId, onOpen }: Readonly<{ tx: SpaceTx; currency: string; testId: string; onOpen?: (txId: string) => void }>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const cat = cats.byId(tx.catId);
  const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
  return (
    <ProposalRow
      icon={cat.icon}
      color={cat.color ?? parent?.color ?? 'var(--m-ink-3)'}
      title={txTitle(tx)}
      sub={`${fmtReceiptDay(tx.date, lang)} · ${catName(cat, t)}`}
      amount={fmtCents(tx.amountCents, tx.currency || currency, lang)}
      testId={testId}
      onOpen={onOpen && (() => onOpen(tx.id))}
    />
  );
}

export function ReceiptProposalCard({
  link,
  tx,
  currency,
  ids,
  onAccept,
  onReject,
  onOpenReceipt,
  onOpenTx,
  busy = false,
  className = '',
}: Readonly<{
  link: ReceiptLinkRow;
  tx?: SpaceTx;
  currency: string;
  /** the card's testids; `open` and `tx` default to `<card>-open` / `<card>-tx` */
  ids: { card: string; accept: string; reject: string; open?: string; tx?: string };
  onAccept: (link: ReceiptLinkRow) => void;
  onReject: (link: ReceiptLinkRow) => void;
  onOpenReceipt?: () => void;
  onOpenTx?: (txId: string) => void;
  busy?: boolean;
  className?: string;
}>) {
  const { t, lang } = useLang();
  const items = link.items?.length ? ` · ${link.items.length} ${t('receipt.items')}` : '';
  return (
    <div className={`overflow-hidden rounded-card border border-line bg-surface ${className}`} data-testid={ids.card}>
      <ProposalRow
        icon="storefront-outline"
        color="var(--m-accent-deep)"
        title={link.merchant ?? partyName(link.source)}
        sub={`${t('receipts.proposedBadge')} · ${fmtReceiptDay(link.date, lang)}${items}`}
        amount={fmtCents(link.totalCents, currency, lang)}
        testId={ids.open ?? `${ids.card}-open`}
        onOpen={onOpenReceipt}
      />
      {tx && (
        <>
          <div className="mx-4 border-t border-line-2" />
          <TxProposalRow tx={tx} currency={currency} testId={ids.tx ?? `${ids.card}-tx`} onOpen={onOpenTx} />
        </>
      )}
      <div className="flex gap-2 px-4 pb-3 pl-[46px]">
        <Button size="sm" data-testid={ids.accept} disabled={busy} onClick={() => onAccept(link)}>
          {t('receipts.accept')}
        </Button>
        <Button size="sm" variant="outline" data-testid={ids.reject} disabled={busy} onClick={() => onReject(link)}>
          {t('receipts.reject')}
        </Button>
      </div>
    </div>
  );
}

function ReceiptPickRow({
  receipt,
  selected,
  peeked,
  currency,
  note,
  pickTestId,
  onLook,
}: Readonly<{
  receipt: ReceiptRow;
  selected: boolean;
  /** lit while its peek sheet is open; the light fades out over 600 ms once that closes (user 2026-10-09) */
  peeked: boolean;
  currency: string;
  note?: string;
  pickTestId: string;
  onLook: () => void;
}>) {
  const { t, lang } = useLang();
  const items = receipt.items?.length ? ` · ${receipt.items.length} ${t('receipt.items')}` : '';
  return (
    <div
      data-testid={`${pickTestId}-row`}
      data-peeked={peeked ? '1' : undefined}
      className={`flex items-center border-b border-line-2 transition-colors last:border-0 ${peeked ? 'bg-accent-soft duration-0' : 'duration-[600ms]'}`}
    >
      <button
        data-testid={pickTestId}
        aria-pressed={selected}
        onClick={onLook}
        className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3 text-left"
      >
        <Icon name={selected ? 'check-circle' : sourceIcon(receipt)} size={16} color={selected ? 'var(--m-accent)' : 'var(--m-ink-3)'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{receipt.merchant ?? partyName(receipt.source)}</span>
          <span className="block text-[11px] text-ink-4">{`${fmtReceiptDay(receipt.date, lang)}${items}`}</span>
          {note && (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-warning" data-testid={`${pickTestId}-attached`}>
              <Icon name="link-variant" size={11} />
              <span className="min-w-0 truncate">{note}</span>
            </span>
          )}
        </span>
        <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(receipt.totalCents, currency, lang)}</span>
        <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
      </button>
    </div>
  );
}

function ReceiptNoneOption({ testId, selected, onPick }: Readonly<{ testId: string; selected: boolean; onPick: () => void }>) {
  const { t } = useLang();
  return (
    <button
      data-testid={testId}
      aria-pressed={selected}
      onClick={onPick}
      className="m-tap flex w-full items-center gap-3 rounded-card border border-dashed border-line bg-transparent px-4 py-2.5 text-left text-[13px] text-ink-2"
    >
      <Icon name={selected ? 'check-circle' : 'close-circle-outline'} size={16} color={selected ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
      {t('review.receiptNoneOption')}
    </button>
  );
}

export function ReceiptPickSheet({
  open,
  onOpenChange,
  title,
  testIdPrefix,
  pickTestIdPrefix,
  proposal,
  proposalTx,
  candidates,
  all,
  selectedId,
  attachedId = null,
  noneSelected = false,
  showNone = true,
  currency,
  attachedTo,
  describeTx,
  onAccept,
  onReject,
  onPick,
  context,
  children,
}: Readonly<ReceiptPickSheetProps>) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [party, setParty] = useState<string | null>(null);
  // #496: a row opens the receipt over the list; the receipt outlives the close flag so the peek never empties mid-slide
  const [peeked, setPeeked] = useState<ReceiptRow | null>(null);
  const [peekOpen, setPeekOpen] = useState(false);
  useEffect(() => {
    if (!open) setPeekOpen(false);
  }, [open]);
  const parties = useMemo(() => receiptParties(all), [all]);
  const listed = useMemo(() => filterReceipts(all, query, party).slice(0, 100), [all, query, party]);
  const suggested = useMemo(() => candidates.filter(receiptFilter(query, party)), [candidates, query, party]);
  const id = (suffix: string): string => `${testIdPrefix}-${suffix}`;
  const pickPrefix = pickTestIdPrefix ?? id('pick');
  const attachedNote = (receiptId: string): string | undefined => {
    const others = attachedTo?.get(receiptId);
    if (!others?.length) return undefined;
    const face = others.length === 1 ? describeTx?.(others[0]) : undefined;
    return face ? t('receipt.attachedTo', { tx: face }) : t('receipt.attachedToN', { n: others.length });
  };
  const look = (row: ReceiptRow) => {
    setPeeked(row);
    setPeekOpen(true);
  };
  /** "Attach this one" in the peek: the pick lands like a tap on None does — the host closes the picker */
  const attach = (row: ReceiptRow) => {
    setPeekOpen(false);
    onPick(row);
  };
  // a receipt sits in the suggestions AND the full list: each list's rows carry their own prefix
  const rows = (list: readonly ReceiptRow[], rowPrefix: string) =>
    list.map((r) => (
      <ReceiptPickRow
        key={r.id}
        receipt={r}
        selected={selectedId === r.id}
        peeked={peekOpen && peeked?.id === r.id}
        currency={currency}
        note={attachedNote(r.id)}
        pickTestId={`${rowPrefix}-${r.id}`}
        onLook={() => look(r)}
      />
    ));
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={title} size="full">
        <div className="flex flex-col gap-3 pt-1" data-testid={id('sheet')}>
          {context}
          {proposal && (
            <ReceiptProposalCard
              link={proposal}
              tx={proposalTx}
              currency={currency}
              ids={{ card: id('proposal'), accept: id('accept'), reject: id('reject') }}
              onAccept={onAccept}
              onReject={onReject}
              onOpenReceipt={() => look(linkAsEntry(proposal).data)}
            />
          )}
          {showNone && <ReceiptNoneOption testId={id('none')} selected={noneSelected} onPick={() => onPick(null)} />}
          {/* nothing fetched yet (a photo-only person): no search over an empty list */}
          {all.length > 0 && (
            <>
              <SearchField testId={id('search')} value={query} onChange={setQuery} placeholder={t('review.receiptSearch')} />
              {parties.length > 1 && (
                <div className="flex flex-wrap gap-2" data-testid={id('parties')}>
                  <Chip testId={id('party-all')} selected={party === null} onClick={() => setParty(null)}>
                    {t('review.receiptEvery')}
                  </Chip>
                  {parties.map((p) => (
                    <Chip key={p.source} testId={id(`party-${p.source}`)} selected={party === p.source} onClick={() => setParty((v) => (v === p.source ? null : p.source))}>
                      {p.label}
                    </Chip>
                  ))}
                </div>
              )}
            </>
          )}
          {suggested.length > 0 && (
            <>
              <div className="m-cap px-1">{proposal ? t('review.receiptPick') : t('receipt.suggested')}</div>
              <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`${pickPrefix}-list`}>
                {rows(suggested, pickPrefix)}
              </div>
            </>
          )}
          {children}
          {all.length > 0 && (
            <>
              <div className="m-cap px-1">
                {t('review.receiptAll')} · {listed.length}
              </div>
              {listed.length > 0 ? (
                <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={id('all-list')}>
                  {rows(listed, id('all'))}
                </div>
              ) : (
                <p className="px-1 py-4 text-center text-[12px] text-ink-4" data-testid={id('all-empty')}>
                  {t('review.receiptNoneFound')}
                </p>
              )}
            </>
          )}
        </div>
      </Sheet>
      <ReceiptPeekSheet
        open={open && peekOpen}
        onOpenChange={setPeekOpen}
        receipt={peeked}
        currency={currency}
        onPick={peeked && peeked.id !== attachedId ? attach : undefined}
        testIdPrefix={id('peek')}
      />
    </>
  );
}
