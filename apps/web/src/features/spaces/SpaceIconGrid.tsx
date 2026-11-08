import { IconPicker } from '@/ui/IconPicker';
import { SPACE_ICONS } from './spaceDefaults';

/**
 * The space symbol picker, shared by the create form and the settings
 * screen (#444: the two copies had drifted, and a fix to one of them is a
 * fix to the other by construction). #285 (user): the WHOLE self-hosted
 * font is there (#563: to scroll through as well as to search), and every
 * glyph renders in the picked color so a swatch tap previews its real
 * impact live.
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
  return (
    <IconPicker
      value={icon}
      onChange={onIcon}
      featured={SPACE_ICONS}
      query={query}
      onQuery={onQuery}
      testIdPrefix={testIdPrefix}
      color={color}
      disabled={disabled}
      sleeping={sleeping}
    />
  );
}
