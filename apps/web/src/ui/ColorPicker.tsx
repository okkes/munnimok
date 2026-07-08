import { useRef } from 'react';
import { Icon } from './Icon';

interface ColorPickerProps {
  colors: readonly string[];
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  /** swatches render as `${testIdPrefix}-<hex-without-#>`, the wheel as `${testIdPrefix}-custom` */
  testIdPrefix: string;
  /** localized label for the custom-color wheel */
  customLabel: string;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Preset swatches plus a rainbow wheel that opens the platform's native
 * color picker — presets keep new users on the palette, the wheel lets
 * anyone pick an exact brand/preference color. A custom pick shows as
 * the wheel swatch filled with that color.
 */
export function ColorPicker({ colors, value, onChange, disabled, testIdPrefix, customLabel }: Readonly<ColorPickerProps>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const customActive = !colors.includes(value);

  return (
    <div className="relative flex flex-wrap gap-2">
      {colors.map((c) => (
        <button
          key={c}
          aria-label={c}
          data-testid={`${testIdPrefix}-${c.slice(1)}`}
          disabled={disabled}
          onClick={() => onChange(c)}
          className={`m-tap h-8 w-8 rounded-full border-2 ${value === c ? 'border-ink' : 'border-transparent'}`}
          style={{ background: c }}
        />
      ))}
      <button
        aria-label={customLabel}
        title={customLabel}
        data-testid={`${testIdPrefix}-custom`}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={`m-tap flex h-8 w-8 items-center justify-center rounded-full border-2 ${
          customActive ? 'border-ink' : 'border-transparent'
        }`}
        style={
          customActive
            ? { background: value }
            : { background: 'conic-gradient(#e74c3c, #f39c12, #27ae60, #3498db, #9b59b6, #e74c3c)' }
        }
      >
        {!customActive && <Icon name="plus" size={14} color="#fff" />}
      </button>
      {/* visually hidden but clickable native input — the platform picker
          (wheel on iOS, palette dialog on desktop) does the heavy lifting */}
      <input
        ref={inputRef}
        type="color"
        tabIndex={-1}
        aria-hidden
        data-testid={`${testIdPrefix}-custom-input`}
        value={HEX_RE.test(value) ? value : '#08372b'}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="absolute h-0 w-0 border-0 p-0 opacity-0"
      />
    </div>
  );
}
