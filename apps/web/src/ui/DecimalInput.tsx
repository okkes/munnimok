import type { InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'inputMode' | 'value' | 'onChange' | 'step' | 'min' | 'max'> & {
  value: string;
  onValue: (text: string) => void;
};

/** what a number field let through, plus the comma */
export const decimalText = (raw: string): string => raw.replaceAll(/[^\d.,]/gu, '');

/**
 * A number field hands the page nothing when the decimal sign is not the one it expects, and a phone
 * keypad offers only its region's own: a text field that asks for the keypad takes both.
 */
export function DecimalInput({ value, onValue, ...rest }: Readonly<Props>) {
  return <input {...rest} type="text" inputMode="decimal" value={value} onChange={(e) => onValue(decimalText(e.target.value))} />;
}
