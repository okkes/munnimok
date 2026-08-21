import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { catName, useCategories } from '@/features/categories/useCategories';
import type { Catalog } from '@/domain/catalog';
import { REIMBURSED_ID } from '@/domain/categories';
import { givenCents, netAmountCents, netCreditCents, partNetCents } from '@/domain/reimbursement';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { txTitle } from '@/lib/text';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/** one compact category row of the peek (module-level for S3776) */
interface PeekCatRow {
  key: string;
  icon: string;
  color: string;
  name: string;
  sub?: string;
  amountText?: string;
}

/** #168 r4 (user): the compact category story — a container lists its
 *  parts, a row-level spread its entries with values, a plain row its
 *  one category; settled Reimbursed bookkeeping stays out of the story */
function peekCatRows(tx: SpaceTx, cats: Catalog, t: TFunc, money: (magnitudeCents: number) => string): PeekCatRow[] {
  const face = (catId: string | undefined) => {
    const cat = cats.byId(catId);
    return {
      icon: cat.icon,
      color: cat.color ?? cats.byId(cat.parentId).color ?? 'var(--m-ink-3)',
      name: catName(cat, t),
    };
  };
  const parts = (tx.splits ?? []).filter((part) => part.catId !== REIMBURSED_ID);
  if (parts.length > 0) {
    return parts.map((part, i) => {
      const own = face(part.catId);
      const spreadNames = (part.cats ?? [])
        .filter((entry) => entry.catId !== REIMBURSED_ID)
        .map((entry) => catName(cats.byId(entry.catId), t))
        .join(' · ');
      return {
        key: part.id ?? `part-${i}`,
        icon: own.icon,
        color: own.color,
        name: part.label ?? `${txTitle(tx)} – ${t('split.partN', { n: i + 1 })}`,
        sub: spreadNames || own.name,
        amountText: money(partNetCents(part)),
      };
    });
  }
  const spread = (tx.cats ?? []).filter((entry) => entry.catId !== REIMBURSED_ID);
  if (spread.length > 1) {
    return spread.map((entry, i) => ({
      key: `${entry.catId}-${i}`,
      ...face(entry.catId),
      amountText: money(entry.amountCents),
    }));
  }
  return [{ key: 'single', ...face(spread[0]?.catId ?? tx.catId) }];
}

/** icon + label + value fact line under the hero */
function PeekFactRow({
  icon,
  label,
  value,
  testId,
}: Readonly<{ icon: string; label: string; value: string; testId?: string }>) {
  return (
    <div className="flex items-center gap-3 border-b border-line-2 px-4 py-3 text-[14px] text-ink last:border-0" data-testid={testId}>
      <Icon name={icon} size={18} color="var(--m-ink-3)" />
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <span className="shrink-0 text-xs text-ink-4">{label}</span>
    </div>
  );
}

/**
 * #168 r4 (user): leaving to the full transaction page lost your place
 * (recurring period sheet, overview drill). This sheet shows the
 * transaction's READ-ONLY face on top of wherever you are — hero
 * amount, facts, categories, note — with ONE door to the full detail.
 * Render it as a SIBLING of any other sheet, never nested.
 */
export function TxPeekSheet({ txId, onClose }: Readonly<{ txId: string | null; onClose: () => void }>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const txs = useSpaceTransactions();
  const accounts = useSpaceAccounts();
  const cats = useCategories();
  const { fmt } = useDisplayMoney();

  const tx = useMemo(() => (txId ? (txs ?? []).find((row) => row.id === txId) : undefined), [txs, txId]);
  const account = tx ? (accounts ?? []).find((a) => a.id === tx.accountId) : undefined;
  const linkedAccount = tx?.linkedAccountId ? (accounts ?? []).find((a) => a.id === tx.linkedAccountId) : undefined;

  // the net truth, exactly like the detail's headline: expenses minus
  // what came back, credits minus what they refunded elsewhere
  const netCents = tx ? (tx.amountCents > 0 ? netCreditCents(tx, givenCents(txs ?? [], tx.id)) : netAmountCents(tx)) : 0;
  const sign = (tx?.amountCents ?? 0) < 0 ? -1 : 1;
  const money = (magnitudeCents: number) => (tx ? fmt(sign * magnitudeCents, tx.currency, { sign: true, date: tx.date }) : '');
  const catRows = tx ? peekCatRows(tx, cats, t, money) : [];
  const fmtDay = new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long' });

  const openFull = () => {
    if (!tx) return;
    onClose();
    void navigate({ to: '/transactions/$txId', params: { txId: tx.id } });
  };

  return (
    <Sheet
      open={txId !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="tall"
    >
      {tx && (
        <div data-testid="tx-peek">
          <div className="flex flex-col items-center pt-2 pb-4 text-center">
            <div className="m-num text-4xl text-ink" data-testid="tx-peek-amount">
              {fmt(netCents, tx.currency, { sign: true, date: tx.date })}
            </div>
            <div className="mt-1.5 text-[15px] font-medium text-ink" data-testid="tx-peek-title">
              {txTitle(tx)}
            </div>
            <div className="mt-0.5 text-[12px] text-ink-3">{fmtDay.format(new Date(tx.date))}</div>
          </div>

          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <PeekFactRow icon="bank-outline" label={t('txform.account')} value={account?.name ?? '—'} testId="tx-peek-account" />
            {linkedAccount && (
              <PeekFactRow icon="bank-transfer" label={t('tx.counterAccount')} value={linkedAccount.name} testId="tx-peek-counter" />
            )}
          </div>

          <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-peek-cats">
            {catRows.map((row) => (
              <div key={row.key} className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0">
                <Icon name={row.icon} size={18} color={row.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{row.name}</span>
                  {row.sub && <span className="block truncate text-[11px] text-ink-4">{row.sub}</span>}
                </span>
                {row.amountText && <span className="m-num shrink-0 text-[13px] text-ink-2">{row.amountText}</span>}
              </div>
            ))}
          </div>

          {tx.notes && (
            <div className="mt-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="tx-peek-note">
              <span className="block text-[11px] text-ink-4">{t('tx.notes')}</span>
              <span className="block text-[13px] whitespace-pre-wrap text-ink-2">{tx.notes}</span>
            </div>
          )}

          <Button className="mt-4 w-full" data-testid="tx-peek-open" onClick={openFull}>
            {t('tx.peekOpenFull')}
            <Icon name="chevron-right" size={16} />
          </Button>
        </div>
      )}
    </Sheet>
  );
}
