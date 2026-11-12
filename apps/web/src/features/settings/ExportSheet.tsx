import { useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { shareNativeFile } from '@/lib/platform';
import { visibleAccounts, visibleTransactions } from '@/db/joined';
import { buildCatalog, visibleCategoryRows } from '@/domain/catalog';
import { delimiterForLang, exportWindow, serializeCsv, toCsvRows } from '@/domain/exportCsv';
import type { ExportRange } from '@/domain/exportCsv';
import { catName } from '@/features/categories/useCategories';
import { localToday } from '@/application/recurring';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { InfoHint } from '@/ui/InfoHint';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

type Format = 'csv' | 'json';

/** Blob download without leaving the page — nothing is uploaded anywhere.
 * Native shell (§5): the OS share sheet instead, so the export can go
 * straight to Files/mail; the download stays the web/PWA path. */
async function deliver(name: string, content: string, mime: string): Promise<'saved' | 'dismissed' | 'failed'> {
  const native = await shareNativeFile(name, content);
  if (native === 'shared') return 'saved';
  if (native !== 'unavailable') return native;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return 'saved';
}

/** Global settings → Export data (csv-export design): fully client-side. */
export function ExportSheet({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t, lang } = useLang();
  const { store, spaceId } = useData();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set([spaceId]));
  const [range, setRange] = useState<ExportRange>('year');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [format, setFormat] = useState<Format>('csv');
  const [empty, setEmpty] = useState(false);
  const [failed, setFailed] = useState(false);
  // #195: tappable — an invalid tap names the blocker
  const [attempted, setAttempted] = useState(false);
  const dateBad = range === 'custom' && (!from || !to);
  const close = (next: boolean) => {
    if (!next) setAttempted(false);
    onOpenChange(next);
  };

  const spaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), [], []);
  const everySpace = spaces.length > 0 && spaces.every((s) => picked.has(s.id));

  const toggleSpace = (id: string) => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    // an export of no space is nothing: the last tick stays
    if (next.size > 0) setPicked(next);
  };

  const run = async () => {
    setEmpty(false);
    setFailed(false);
    const today = localToday();
    const allCats = (await store.allRows('category')).filter((c) => c.deleted === 0);
    const chosen = spaces.filter((s) => picked.has(s.id));

    const perSpace = await Promise.all(
      chosen.map(async (space) => {
        const window = exportWindow(range, space, today, { from, to });
        const txs = (await visibleTransactions(store, space.id)).filter(
          (item) => !window || (item.date >= window.from && item.date <= window.to),
        );
        const accounts = await visibleAccounts(store, space.id);
        const recurrings = (await store.bySpace('recurring', space.id)).filter((r) => r.deleted === 0);
        const events = (await store.bySpace('event', space.id)).filter((e) => e.deleted === 0);
        return { space, window, txs, accounts, recurrings, events };
      }),
    );
    if (perSpace.every((entry) => entry.txs.length === 0)) {
      setEmpty(true);
      return;
    }
    // spaces with different periods share no single window to name the file after
    const windows = new Set(perSpace.map(({ window }) => (window ? `${window.from}--${window.to}` : 'all')));
    const rangeLabel = windows.size === 1 ? [...windows][0] : 'period';

    let outcome: Awaited<ReturnType<typeof deliver>>;
    if (format === 'json') {
      const payload = perSpace.map(({ space, txs, accounts }) => ({
        space: { id: space.id, name: space.name, currency: space.currency },
        accounts,
        transactions: txs,
      }));
      outcome = await deliver(`munni-${rangeLabel}-${today}.json`, JSON.stringify(payload, null, 2), 'application/json');
    } else {
      const rows: string[][] = [];
      for (const { space, txs, accounts, recurrings, events } of perSpace) {
        const visible = visibleCategoryRows(spaces, allCats, space.id);
        const catalog = buildCatalog(visible.rows, visible.sharedScope, visible.hiddenMains);
        const spaceRows = toCsvRows(txs, {
          accounts,
          catalog,
          catName: (cat) => catName(cat, t),
          typeName: (type) => t(`tx.type.${type}`),
          recurrings,
          events,
          spaceId: space.id,
          spaceName: chosen.length > 1 ? space.name : undefined,
        });
        // one shared header row for the whole file
        rows.push(...(rows.length === 0 ? spaceRows : spaceRows.slice(1)));
      }
      outcome = await deliver(`munni-${rangeLabel}-${today}.csv`, serializeCsv(rows, delimiterForLang(lang)), 'text/csv;charset=utf-8');
    }
    // a share sheet that was closed saved nothing: the export stays open
    if (outcome === 'saved') close(false);
    else setFailed(outcome === 'failed');
  };

  const rangeChip = (value: ExportRange, label: string) => (
    <Chip key={value} testId={`export-range-${value}`} selected={range === value} onClick={() => setRange(value)}>
      {label}
    </Chip>
  );

  return (
    <Sheet open={open} onOpenChange={close} title={t('settings.exportData')} size="tall">
      <div className="flex flex-col gap-3 pt-1" data-testid="export-sheet">
        {/* #283: the nothing-is-uploaded note folds behind a hint on the
            first caption row — the paragraph shouted over the form */}
        <div className="m-cap flex flex-wrap items-center gap-1.5 px-1">
          {t('export.scope')}
          <InfoHint text={t('export.note')} testId="export-hint" />
        </div>
        <div className="flex flex-wrap gap-2">
          {spaces.length > 1 && (
            <Chip
              testId="export-scope-all"
              selected={everySpace}
              onClick={() => setPicked(new Set(everySpace ? [spaceId] : spaces.map((s) => s.id)))}
            >
              {t('export.scopeAll')}
            </Chip>
          )}
          {spaces.map((space) => (
            <Chip key={space.id} testId={`export-space-${space.id}`} selected={picked.has(space.id)} onClick={() => toggleSpace(space.id)}>
              {space.name}
            </Chip>
          ))}
        </div>

        <div className="m-cap px-1">{t('export.range')}</div>
        <div className="flex flex-wrap gap-2">
          {rangeChip('period', t('export.rangePeriod'))}
          {rangeChip('year', t('export.rangeYear'))}
          {rangeChip('all', t('export.rangeAll'))}
          {rangeChip('custom', t('export.rangeCustom'))}
        </div>
        {range === 'custom' && (
          <>
            <div className="flex gap-2">
              <input
                data-testid="export-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-invalid={attempted && !from}
                className={`h-11 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none${blockerRing(attempted && !from)}`}
              />
              <input
                data-testid="export-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-invalid={attempted && !to}
                className={`h-11 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none${blockerRing(attempted && !to)}`}
              />
            </div>
            {/* #195 r2 (user): the blocker sits AT the field */}
            <FormBlockerNote show={attempted && dateBad} text={t('form.needDate')} testId="export-run-blocker" />
          </>
        )}

        <div className="m-cap px-1">{t('export.format')}</div>
        <div className="flex gap-2">
          <Chip testId="export-format-csv" selected={format === 'csv'} onClick={() => setFormat('csv')}>
            CSV
          </Chip>
          <Chip testId="export-format-json" selected={format === 'json'} onClick={() => setFormat('json')}>
            JSON
          </Chip>
        </div>

        {empty && (
          <p className="text-[12px] text-warning" data-testid="export-empty">
            {t('export.empty')}
          </p>
        )}
        {failed && (
          <p className="text-[12px] text-warning" data-testid="export-failed">
            {t('export.failed')}
          </p>
        )}
        <Button
          data-testid="export-run"
          onClick={() => {
            if (dateBad) {
              setAttempted(true);
              return;
            }
            void run();
          }}
        >
          {t('export.download')}
        </Button>
      </div>
    </Sheet>
  );
}
