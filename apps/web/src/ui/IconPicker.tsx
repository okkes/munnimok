import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { MDI_NAMES } from '@/generated/mdiNames';
import { Icon } from './Icon';
import { SearchField } from './SearchField';

/** the glyph colour of a tile that cannot be tapped — a sleeping picker reads as asleep before a tap finds out (#444) */
export const SLEEPING_GLYPH = 'var(--m-ink-4)';

const COLS = 6;
const TILE = 44;
const GAP = 8;
const PITCH = TILE + GAP;
/** rows drawn past the visible window on both sides */
const OVERSCAN = 3;
/** rows drawn before the box is measured — and where nothing lays out (tests) */
const UNMEASURED_ROWS = 12;

type GridRow = { kind: 'icons'; names: readonly string[] } | { kind: 'caption' };

const chunk = (names: readonly string[]): GridRow[] => {
  const rows: GridRow[] = [];
  for (let i = 0; i < names.length; i += COLS) rows.push({ kind: 'icons', names: names.slice(i, i + COLS) });
  return rows;
};

/** "credit card" finds credit-card: the font names its glyphs with hyphens */
export const iconNeedle = (query: string): string => query.trim().toLowerCase().replaceAll(/\s+/g, '-');

/** every glyph whose name holds the needle: the exact name, then names that start with it, then a word that does, then the rest */
export function searchIcons(needle: string): string[] {
  const exact: string[] = [];
  const starts: string[] = [];
  const word: string[] = [];
  const rest: string[] = [];
  for (const name of MDI_NAMES) {
    const at = name.indexOf(needle);
    if (at < 0) continue;
    if (name === needle) exact.push(name);
    else if (at === 0) starts.push(name);
    else if (name[at - 1] === '-') word.push(name);
    else rest.push(name);
  }
  return [...exact, ...starts, ...word, ...rest];
}

interface IconPickerProps {
  value: string;
  onChange: (name: string) => void;
  /** the screen's own suggestions, shown first */
  featured: readonly string[];
  /** the search text — the host owns it, so a fresh form starts unsearched */
  query: string;
  onQuery: (next: string) => void;
  /** tiles are `${testIdPrefix}-<name>`, the search `${testIdPrefix}-search` */
  testIdPrefix: string;
  /** the glyphs preview this colour (a space's pick); the ink otherwise */
  color?: string;
  /** #389: icons a sibling already wears — shown, asleep and refused */
  taken?: ReadonlySet<string>;
  /** no tile takes a tap (a read-only form, a picture rules) */
  disabled?: boolean;
  /** nothing reads as selected (a picture rules) */
  sleeping?: boolean;
}

/**
 * #563 (user): every icon picker lets the person browse the WHOLE font, not
 * only a curated handful or what a search finds — the screen's suggestions
 * lead, then all 7k+ glyphs follow under a caption. Only the rows in view
 * render (fixed row pitch, a window with overscan), so the full list costs
 * no more than the old grid. A search ranks exact and leading matches first.
 */
export function IconPicker({ value, onChange, featured, query, onQuery, testIdPrefix, color, taken, disabled = false, sleeping = false }: Readonly<IconPickerProps>) {
  const { t } = useLang();
  const needle = iconNeedle(query);
  // the current pick leads the browse view — fixed while browsing, so a tap never reshuffles the grid under the finger
  const [pinned, setPinned] = useState(value);
  const wasSearching = useRef(needle !== '');
  useEffect(() => {
    if (wasSearching.current && !needle) setPinned(value);
    wasSearching.current = needle !== '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle]);
  // an icon the host sets itself is no tap: an edit form loads its row after the picker mounted, and that icon must lead like the one it opened with
  const tapped = useRef(value);
  useLayoutEffect(() => {
    if (value === tapped.current) return;
    tapped.current = value;
    setPinned(value);
  }, [value]);

  const lead = useMemo(() => (pinned && !featured.includes(pinned) ? [pinned, ...featured] : [...featured]), [pinned, featured]);
  const rows = useMemo<GridRow[]>(() => {
    if (needle) return chunk(searchIcons(needle));
    const shown = new Set(lead);
    return [...chunk(lead), { kind: 'caption' }, ...chunk(MDI_NAMES.filter((name) => !shown.has(name)))];
  }, [needle, lead]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setView((prev) => (prev.height === el.clientHeight ? prev : { ...prev, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // a new search starts at its best match
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = 0;
    setView((prev) => (prev.top === 0 ? prev : { ...prev, top: 0 }));
  }, [needle]);

  const span = view.height > 0 ? Math.ceil(view.height / PITCH) + OVERSCAN * 2 : UNMEASURED_ROWS;
  const first = Math.max(0, Math.min(rows.length - span, Math.floor(view.top / PITCH) - OVERSCAN));
  const last = Math.min(rows.length, first + span);
  const glyph = (name: string) => {
    if (disabled) return SLEEPING_GLYPH;
    return color ?? (value === name && !sleeping ? 'var(--m-accent-deep)' : 'var(--m-ink-2)');
  };

  return (
    <>
      <SearchField testId={`${testIdPrefix}-search`} value={query} onChange={onQuery} placeholder={t('cats.iconSearch')} height="h-10" textSize="text-[13px]" />
      <div
        ref={scrollerRef}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          setView((prev) => (prev.top === top ? prev : { ...prev, top }));
        }}
        data-testid={`${testIdPrefix}s`}
        data-sleeping={sleeping ? 'true' : undefined}
        // a list scroller of its own: the sheet never takes this gesture for a drag
        data-sheet-no-drag=""
        className="max-h-56 overflow-y-auto overscroll-contain"
      >
        {rows.length === 0 ? (
          <p className="py-2 text-center text-[12px] text-ink-4" data-testid={`${testIdPrefix}-none`}>
            {t('cats.iconNone')}
          </p>
        ) : (
          <div className="relative" style={{ height: rows.length * PITCH - GAP }}>
            {rows.slice(first, last).map((row, i) => {
              const top = (first + i) * PITCH;
              if (row.kind === 'caption') {
                return (
                  <div key="caption" className="m-cap absolute inset-x-0 flex items-end px-1 pb-1" style={{ top, height: TILE }} data-testid={`${testIdPrefix}-all`}>
                    {t('ui.iconsAll')}
                  </div>
                );
              }
              return (
                <div key={row.names[0]} className="absolute inset-x-0 grid grid-cols-6 gap-2" style={{ top, height: TILE }}>
                  {row.names.map((name) => {
                    const refused = !!taken?.has(name);
                    const selected = value === name && !sleeping;
                    return (
                      <button
                        key={name}
                        type="button"
                        data-testid={`${testIdPrefix}-${name}`}
                        data-taken={refused ? '1' : undefined}
                        title={name}
                        aria-pressed={selected}
                        disabled={disabled || refused}
                        onClick={() => {
                          tapped.current = name;
                          onChange(name);
                        }}
                        className={`m-tap flex h-11 items-center justify-center rounded-xl border disabled:cursor-not-allowed ${
                          selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
                        } ${refused ? 'opacity-30' : 'disabled:opacity-45'}`}
                      >
                        <Icon name={name} size={20} color={glyph(name)} />
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
