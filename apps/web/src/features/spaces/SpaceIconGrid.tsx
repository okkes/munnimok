import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { SearchField } from '@/ui/SearchField';
import { MDI_NAMES } from '@/generated/mdiNames';
import { SPACE_ICONS } from './spaceDefaults';

/** the glyph color of a tile that cannot be tapped — the muted ink, so a
 *  sleeping picker reads as asleep before a tap finds out (#444) */
export const SLEEPING_GLYPH = 'var(--m-ink-4)';

/**
 * The space symbol picker, shared by the create form and the settings
 * screen (#444: the two copies had drifted, and a fix to one of them is a
 * fix to the other by construction). #285 (user): the search opens the
 * WHOLE self-hosted font (the categories pattern), and every glyph renders
 * in the picked color so a swatch tap previews its real impact live.
 *
 * #444 (user): while a picture is set the tiles are refused — and they
 * LOOK refused: faded, their glyphs dropped to the muted ink, no selection
 * ring. Before, they wore the same face as a live grid and only a tap
 * told the difference.
 */
export function SpaceIconGrid({
  icon,
  onIcon,
  color,
  query,
  onQuery,
  disabled = false,
  sleeping = false,
  testIdPrefix,
}: Readonly<{
  icon: string;
  onIcon: (name: string) => void;
  /** the picked space color — the glyphs preview it */
  color: string;
  query: string;
  onQuery: (next: string) => void;
  /** no tile takes a tap (read-only form, or a picture rules) */
  disabled?: boolean;
  /** a picture rules: nothing here is "selected", the ring stays off */
  sleeping?: boolean;
  /** tiles render as `${testIdPrefix}-<name>`, the search as `${testIdPrefix}-search` */
  testIdPrefix: string;
}>) {
  const { t } = useLang();
  const needle = query.trim().toLowerCase();
  const names: readonly string[] = needle ? MDI_NAMES.filter((n) => n.includes(needle)).slice(0, 60) : SPACE_ICONS;

  return (
    <>
      <SearchField
        testId={`${testIdPrefix}-search`}
        value={query}
        onChange={onQuery}
        placeholder={t('space.iconSearch')}
        height="h-10"
        textSize="text-[13px]"
      />
      <div className="grid max-h-56 grid-cols-6 gap-2 overflow-y-auto" data-testid={`${testIdPrefix}-grid`} data-sleeping={sleeping ? 'true' : undefined}>
        {names.map((name) => (
          <button
            key={name}
            data-testid={`${testIdPrefix}-${name}`}
            title={name}
            disabled={disabled}
            onClick={() => onIcon(name)}
            className={`m-tap flex h-10 items-center justify-center rounded-xl border disabled:cursor-not-allowed disabled:opacity-45 ${
              icon === name && !sleeping ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
            }`}
          >
            <Icon name={name} size={19} color={disabled ? SLEEPING_GLYPH : color} />
          </button>
        ))}
        {needle && names.length === 0 && (
          <p className="col-span-6 py-2 text-center text-[12px] text-ink-4" data-testid={`${testIdPrefix}-none`}>
            {t('space.iconNone')}
          </p>
        )}
      </div>
    </>
  );
}
