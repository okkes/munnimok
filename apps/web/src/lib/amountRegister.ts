// register-style entry: plain digits fill cents from the right (5 → 0,05 → 5,50); a typed comma promotes them to euros
// operators (arithmetic fields), paste and mid-caret edits fall back to free typing; EU notation, comma decimals

export type AmountEntryMode = 'register' | 'free';

export interface AmountEntry {
  mode: AmountEntryMode;
  text: string;
}

/** more digits than any sane price — further register keys are ignored */
const MAX_DIGITS = 9;

/** the register's digit buffer behind a displayed text: significant
 *  digits only ("0,05" → "5", "0,00" → "", "5,50" → "550") */
const bufferOf = (text: string): string => text.replaceAll(/\D/gu, '').replace(/^0+/u, '');

const registerText = (buffer: string): string => {
  if (buffer.length === 0) return '';
  const padded = buffer.padStart(3, '0');
  return `${padded.slice(0, -2)},${padded.slice(-2)}`;
};

export const focusEntryMode = (text: string): AmountEntryMode =>
  text === '' || /^\d+,\d{2}$/u.test(text) ? 'register' : 'free';

export function nextAmountEntry(mode: AmountEntryMode, prevText: string, raw: string): AmountEntry {
  if (raw === '') return { mode: 'register', text: '' };
  if (mode === 'free') return { mode: 'free', text: raw };
  const appended = raw.length === prevText.length + 1 && raw.startsWith(prevText);
  if (appended) {
    const key = raw.slice(-1);
    if (/\d/u.test(key)) {
      const buffer = bufferOf(prevText) + key;
      if (buffer.length > MAX_DIGITS) return { mode: 'register', text: prevText };
      return { mode: 'register', text: registerText(buffer.replace(/^0+/u, '') || '0') };
    }
    if (key === ',' || key === '.') {
      return { mode: 'free', text: `${bufferOf(prevText) || '0'},` };
    }
    return { mode: 'free', text: raw };
  }
  const shortened = prevText.length === raw.length + 1 && prevText.startsWith(raw);
  if (shortened) {
    return { mode: 'register', text: registerText(bufferOf(prevText).slice(0, -1)) };
  }
  return { mode: 'free', text: raw };
}
