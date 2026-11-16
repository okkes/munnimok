import { IconPicker } from '@/ui/IconPicker';
import { SPACE_ICONS } from './spaceDefaults';

// shared by the create form and the settings screen (#444: the two copies had drifted); every glyph renders in
// the picked color so a swatch tap previews live (#285); while a picture is set the tiles are refused AND look it (#444)
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
