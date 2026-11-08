import type { ReactNode } from 'react';
import { LOCALES, useLang } from '@/i18n';
import type { SpaceTx } from '@/application/transactions';
import { useSpaceAccount } from '@/application/transactions';
import { useEvents } from '@/application/events';
import type { TxSplit } from '@/db/types';
import { partNetCents } from '@/domain/reimbursement';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { cleanBankText, txTitle } from '@/lib/text';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TX_TYPE_VISUAL } from './TxTypeSheet';

/**
 * #570 (user): a transaction looked at before it is chosen — the detail
 * screen's facts (money, day, category, type, account, counterparty,
 * event, note, bank text) without any of its edit doors, and the one
 * action the host offers at the bottom.
 */
export function TxPeekSheet({
  tx,
  part,
  onClose,
  action,
}: Readonly<{
  tx: SpaceTx | null;
  /** a split's part: the peek shows the part's own money and category */
  part?: TxSplit;
  onClose: () => void;
  action?: ReactNode;
}>) {
  return (
    <Sheet open={!!tx} onOpenChange={(open) => !open && onClose()} title={tx ? txTitle(tx) : undefined} size="form" footer={tx ? action : undefined}>
      {tx && <TxPeekBody tx={tx} part={part} />}
    </Sheet>
  );
}

function TxPeekBody({ tx, part }: Readonly<{ tx: SpaceTx; part?: TxSplit }>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const events = useEvents();
  const account = useSpaceAccount(tx.accountId);
  const { fmt } = useDisplayMoney();
  const sign = tx.amountCents < 0 ? -1 : 1;
  const amountCents = part ? sign * partNetCents(part) : tx.amountCents;
  const cat = cats.byId(part ? part.catId : tx.catId);
  const catColor = cat.color ?? cats.byId(cat.parentId ?? '').color;
  const txType = part?.txType ?? tx.txType;
  const eventId = part?.eventId ?? tx.eventId;
  const event = eventId ? events?.find((e) => e.id === eventId) : undefined;
  const notes = part?.notes ?? tx.notes;
  const factRow = (label: string, value: string, icon: string, color?: string) => (
    <div className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
      <Icon name={icon} size={18} color={color ?? 'var(--m-ink-3)'} />
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{value}</span>
      <span className="text-xs text-ink-4">{label}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-3 pt-1" data-testid="tx-peek">
      <div className="m-num text-center text-[26px] text-ink" data-testid="tx-peek-amount">
        {fmt(amountCents, tx.currency, { sign: true, date: tx.date })}
      </div>
      <p className="text-center text-[12px] text-ink-4">
        {new Date(tx.date).toLocaleDateString(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </p>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {factRow(t('screen.categories'), catName(cat, t), cat.icon, catColor)}
        {factRow(t('tx.type'), t(`tx.type.${txType}`), TX_TYPE_VISUAL[txType].icon, TX_TYPE_VISUAL[txType].color)}
        {account && factRow(t('txform.account'), account.name, 'bank-outline')}
        {tx.counterIban && factRow(t('tx.counterparty'), tx.counterIban, 'swap-horizontal')}
        {event && factRow(t('events.linkTitle'), event.name, 'party-popper')}
      </div>
      {notes && (
        <p className="rounded-xl bg-surface px-3 py-2.5 text-[13px] break-words text-ink-2" data-testid="tx-peek-notes">
          {notes}
        </p>
      )}
      {tx.description && (
        <p className="rounded-xl bg-bg-2 px-3 py-2.5 font-mono text-[11px] break-words text-ink-3">{cleanBankText(tx.description)}</p>
      )}
    </div>
  );
}
