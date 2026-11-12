import { useEffect, useMemo, useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { visibleTransactions } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import { fmtCents } from '@/lib/money';
import { txTitle } from '@/lib/text';
import { Chip } from '@/ui/primitives';
import { ScrollRow } from '@/ui/ScrollRow';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import type { EntrySeed } from './SplitEntrySheet';

const SHOWN = 60;

interface Found {
  tx: SpaceTx;
  spaceName: string;
}

/**
 * #538 (user): a payment from any of the person's spaces becomes a split
 * expense — searched across all of them by what it was, what it cost or
 * its day, narrowed to one space on a tap. The space's own view is read
 * (bank-fed and imported payments included). Only the person sees this
 * list; what lands in the split is a copy of title, amount and day, and
 * the next sheet asks who paid and who shares.
 */
export function SplitTxPickSheet({
  open,
  onOpenChange,
  splitId,
  taken,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  splitId: string;
  /** the payments this person already added to the split */
  taken: ReadonlySet<string>;
  onPick: (seed: EntrySeed) => void;
}>) {
  const { t, lang } = useLang();
  const { store } = useData();
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [rows, setRows] = useState<Found[] | null>(null);
  const [spaceFilter, setSpaceFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setRows(null);
    void (async () => {
      const mine = (await store.allRows('space')).filter((space) => space.deleted === 0);
      const found: Found[] = [];
      for (const space of mine) {
        for (const tx of await visibleTransactions(store, space.id)) {
          if (tx.amountCents < 0 && tx.pending !== 1) found.push({ tx, spaceName: space.name });
        }
      }
      found.sort((a, b) => b.tx.date.localeCompare(a.tx.date));
      if (stale) return;
      setSpaces(mine.map((space) => ({ id: space.id, name: space.name })));
      setRows(found);
    })();
    return () => {
      stale = true;
    };
  }, [open, store]);

  const dayOf = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const amountNeedle = needle.replace(',', '.');
    return (rows ?? [])
      .filter(({ tx }) => !spaceFilter || tx.spaceId === spaceFilter)
      .filter(
        ({ tx }) =>
          !needle ||
          txTitle(tx).toLowerCase().includes(needle) ||
          (tx.description ?? '').toLowerCase().includes(needle) ||
          (Math.abs(tx.amountCents) / 100).toFixed(2).includes(amountNeedle) ||
          tx.date.includes(needle) ||
          dayOf(tx.date).toLowerCase().includes(needle),
      )
      .slice(0, SHOWN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, spaceFilter, query, lang]);

  const pick = ({ tx }: Found) => {
    onPick({ description: txTitle(tx), amountCents: Math.abs(tx.amountCents), date: tx.date, currency: tx.currency, sourceTxId: tx.id, sourceSpaceId: tx.spaceId });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('splits.fromTx')} size="full" steady>
      <div className="flex flex-col gap-2 pt-1" data-testid="split-tx-sheet">
        <p className="px-1 text-[12px] leading-snug text-ink-4">{t('splits.fromTxSub')}</p>
        <SearchField testId="split-tx-search" value={query} onChange={setQuery} placeholder={t('splits.searchTx')} />
        {spaces.length > 1 && (
          <ScrollRow testId="split-tx-spaces">
            <Chip selected={spaceFilter === null} onClick={() => setSpaceFilter(null)} testId="split-tx-space-all">
              {t('splits.allSpaces')}
            </Chip>
            {spaces.map((space) => (
              <Chip key={space.id} selected={spaceFilter === space.id} onClick={() => setSpaceFilter(space.id)} testId={`split-tx-space-${space.id}`}>
                {space.name}
              </Chip>
            ))}
          </ScrollRow>
        )}
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {rows === null && <p className="px-4 py-6 text-center text-[13px] text-ink-4">…</p>}
          {rows !== null && shown.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-ink-4" data-testid="split-tx-none">
              {t('splits.noTxFound')}
            </p>
          )}
          {shown.map((found) => {
            const { tx } = found;
            // in this split already — by this person, or by someone they share the space with
            const here = taken.has(tx.id) || tx.splitRef?.splitId === splitId;
            return (
              <button
                key={`${tx.spaceId}:${tx.id}`}
                data-testid={`split-tx-${tx.id}`}
                disabled={here}
                onClick={() => pick(found)}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-2.5 text-left last:border-0 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{txTitle(tx)}</span>
                  <span className="block truncate text-[11px] text-ink-4">
                    {[dayOf(tx.date), spaces.length > 1 ? found.spaceName : '', tx.splitRef ? t('splits.inSplit', { name: tx.splitRef.name }) : ''].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="m-num shrink-0 text-[14px] font-semibold text-ink">{fmtCents(Math.abs(tx.amountCents), tx.currency, lang)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
