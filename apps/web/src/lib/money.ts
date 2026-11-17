import type { Lang } from '@/i18n';

const LOCALE: Record<Lang, string> = { en: 'en-IE', nl: 'nl-NL', tr: 'tr-TR' };

export function parseCents(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  if (s.includes(',')) s = s.replaceAll('.', '').replace(',', '.');
  const value = Number(s);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

// recursive-descent, never eval; with a comma present dots are thousand separators; null when not an expression or /0
export function evalAmountCents(input: string): number | null {
  let s = input.trim();
  if (!s) return null;
  if (s.includes(',')) s = s.replaceAll('.', '').replace(',', '.');
  if (!/^[\d.+\-*/() ]+$/.test(s)) return null;
  let pos = 0;
  const peek = () => s[pos];
  const eat = () => s[pos++];
  const skip = () => {
    while (s[pos] === ' ') pos++;
  };
  // eslint-disable-next-line sonarjs/cognitive-complexity
  const parsePrimary = (): number => {
    skip();
    if (peek() === '(') {
      eat();
      const inner = parseSum();
      skip();
      if (peek() !== ')') throw new Error('unbalanced');
      eat();
      return inner;
    }
    if (peek() === '-') {
      eat();
      return -parsePrimary();
    }
    const start = pos;
    while (/[\d.]/.test(s[pos] ?? '')) pos++;
    if (pos === start) throw new Error('number expected');
    const value = Number(s.slice(start, pos));
    if (!Number.isFinite(value)) throw new Error('bad number');
    return value;
  };
  const parseProduct = (): number => {
    let value = parsePrimary();
    for (;;) {
      skip();
      const op = peek();
      if (op !== '*' && op !== '/') return value;
      eat();
      const rhs = parsePrimary();
      if (op === '/' && rhs === 0) throw new Error('division by zero');
      value = op === '*' ? value * rhs : value / rhs;
    }
  };
  const parseSum = (): number => {
    let value = parseProduct();
    for (;;) {
      skip();
      const op = peek();
      if (op !== '+' && op !== '-') return value;
      eat();
      const rhs = parseProduct();
      value = op === '+' ? value + rhs : value - rhs;
    }
  };
  try {
    const result = parseSum();
    skip();
    if (pos !== s.length) return null;
    return Number.isFinite(result) ? Math.round(result * 100) : null;
  } catch {
    return null;
  }
}

/** #254: 'XXX' is ISO-4217's "no currency": wallets (PayPal) without one render the bare amount, not "XXX 12.34" */
export function fmtCents(cents: number, currency: string, lang: Lang, opts?: { sign?: boolean }): string {
  const noCurrency = !currency || currency === 'XXX';
  const formatted = new Intl.NumberFormat(
    LOCALE[lang],
    noCurrency
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : // #150: bare symbol: en-IE spells USD as "US$1.00", the prefix reads as noise in-app
        { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 },
  ).format(cents / 100);
  if (opts?.sign && cents > 0) return `+${formatted}`;
  return formatted;
}

export function fmtSignedPct(pct: number, decimals = 1): string {
  const v = pct.toFixed(decimals);
  return pct > 0 ? `+${v}%` : `${v}%`;
}
