import type { CamtEntry, CamtStatement } from '@/lib/camt053/parse';
import { euAmountToCents, normalizeDate, parseCsv } from './csv';

/**
 * ING CSV exports (ING offers no CAMT.053 to consumers). Three shapes:
 *
 * - current account (comma-separated, dates as yyyymmdd):
 *   "Datum","Naam / Omschrijving","Rekening","Tegenrekening","Code",
 *   "Af Bij","Bedrag (EUR)","Mutatiesoort","Mededelingen"
 * - savings (semicolon, balance column, account nr like "V 286-81505"):
 *   "Datum";"Omschrijving";"Rekening";"Rekening naam";"Tegenrekening";
 *   "Af Bij";"Bedrag";"Valuta";"Mutatiesoort";"Mededelingen";"Saldo na mutatie"
 * - credit card (semicolon, masked card number):
 *   "Datum";"Naam / Omschrijving";"Mutatiesoort";"Af Bij";"Bedrag (EUR)";
 *   "Mededelingen";"Kaartnummer"
 *
 * None of them carry a bank transaction id, so the dedupe ref is
 * synthesized deterministically: identical rows on the same day get a
 * stable ordinal, and files are normalized oldest-first before
 * numbering. Overlapping exports of the same account therefore produce
 * identical refs and re-imports skip cleanly.
 */

export interface ParsedStatement extends CamtStatement {
  /** checking | savings | credit — drives the created account's type */
  accountType?: 'checking' | 'savings' | 'credit';
  accountName?: string;
}

const sign = (afBij: string): 1 | -1 => (afBij.trim().toLowerCase() === 'bij' ? 1 : -1);

/** simple stable string hash for the synthetic ref */
function tinyHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0; // NOSONAR(S3776) djb2
  return h.toString(36);
}

interface RawEntry {
  date: string;
  amountCents: number;
  counterpartyName?: string;
  counterpartyIban?: string;
  description: string;
}

/** assigns deterministic refs (date + content hash + per-day ordinal) */
function toEntries(raws: RawEntry[]): CamtEntry[] {
  const sorted = [...raws].sort((a, b) => a.date.localeCompare(b.date));
  const ordinals = new Map<string, number>();
  return sorted.map((raw) => {
    const key = `${raw.date}:${raw.amountCents}:${tinyHash(`${raw.counterpartyName ?? ''}|${raw.description}`)}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    return {
      amountCents: raw.amountCents,
      currency: 'EUR',
      date: raw.date,
      counterpartyName: raw.counterpartyName,
      counterpartyIban: raw.counterpartyIban,
      description: raw.description,
      ref: `ing:${key}:${ordinal}`,
    };
  });
}

const headerIndex = (header: string[], name: string): number => header.findIndex((h) => h.trim() === name);

/** ING current account (comma CSV, yyyymmdd dates) */
export function parseIngCurrentCsv(content: string): ParsedStatement[] {
  const rows = parseCsv(content, ',');
  const header = rows[0];
  const col = {
    date: headerIndex(header, 'Datum'),
    name: headerIndex(header, 'Naam / Omschrijving'),
    account: headerIndex(header, 'Rekening'),
    counter: headerIndex(header, 'Tegenrekening'),
    afBij: headerIndex(header, 'Af Bij'),
    amount: headerIndex(header, 'Bedrag (EUR)'),
    kind: headerIndex(header, 'Mutatiesoort'),
    memo: headerIndex(header, 'Mededelingen'),
  };
  const iban = rows[1]?.[col.account]?.trim() ?? '';
  const raws: RawEntry[] = [];
  for (const row of rows.slice(1)) {
    const date = normalizeDate(row[col.date] ?? '');
    const cents = euAmountToCents(row[col.amount] ?? '');
    if (!date || cents === null) continue;
    raws.push({
      date,
      amountCents: sign(row[col.afBij] ?? '') * cents,
      counterpartyName: row[col.name]?.trim() || undefined,
      counterpartyIban: row[col.counter]?.trim() || undefined,
      description: [row[col.kind]?.trim(), row[col.memo]?.trim()].filter(Boolean).join(' · '),
    });
  }
  return [{ iban, currency: 'EUR', closingBalanceCents: null, entries: toEntries(raws), accountType: 'checking' }];
}

/** ING savings (semicolon CSV, running balance) */
export function parseIngSavingsCsv(content: string): ParsedStatement[] {
  const rows = parseCsv(content, ';');
  const header = rows[0];
  const col = {
    date: headerIndex(header, 'Datum'),
    description: headerIndex(header, 'Omschrijving'),
    account: headerIndex(header, 'Rekening'),
    accountName: headerIndex(header, 'Rekening naam'),
    counter: headerIndex(header, 'Tegenrekening'),
    afBij: headerIndex(header, 'Af Bij'),
    amount: headerIndex(header, 'Bedrag'),
    currency: headerIndex(header, 'Valuta'),
    memo: headerIndex(header, 'Mededelingen'),
    balance: headerIndex(header, 'Saldo na mutatie'),
  };
  const accountRef = rows[1]?.[col.account]?.trim() ?? '';
  const accountName = rows[1]?.[col.accountName]?.trim() || undefined;
  const raws: RawEntry[] = [];
  let closing: { date: string; cents: number } | null = null;
  for (const row of rows.slice(1)) {
    const date = normalizeDate(row[col.date] ?? '');
    const cents = euAmountToCents(row[col.amount] ?? '');
    if (!date || cents === null) continue;
    const balanceCents = euAmountToCents(row[col.balance] ?? '');
    if (balanceCents !== null && (!closing || date > closing.date)) closing = { date, cents: balanceCents };
    raws.push({
      date,
      amountCents: sign(row[col.afBij] ?? '') * cents,
      counterpartyIban: row[col.counter]?.trim() || undefined,
      description: [row[col.description]?.trim(), row[col.memo]?.trim()].filter(Boolean).join(' · '),
      counterpartyName: row[col.description]?.trim() || undefined,
    });
  }
  return [
    {
      iban: accountRef, // not an IBAN, but the stable account reference
      currency: rows[1]?.[col.currency]?.trim() || 'EUR',
      closingBalanceCents: closing?.cents ?? null,
      entries: toEntries(raws),
      accountType: 'savings',
      accountName,
    },
  ];
}

/** ING credit card (semicolon CSV, masked card number as account ref) */
export function parseIngCreditcardCsv(content: string, fileName?: string): ParsedStatement[] {
  const rows = parseCsv(content, ';');
  const header = rows[0];
  const col = {
    date: headerIndex(header, 'Datum'),
    name: headerIndex(header, 'Naam / Omschrijving'),
    kind: headerIndex(header, 'Mutatiesoort'),
    afBij: headerIndex(header, 'Af Bij'),
    amount: headerIndex(header, 'Bedrag (EUR)'),
    memo: headerIndex(header, 'Mededelingen'),
    card: headerIndex(header, 'Kaartnummer'),
  };
  // card number appears on charges only; fall back to the export's file name
  const card =
    rows.slice(1).find((row) => row[col.card]?.trim())?.[col.card]?.trim() ??
    /Creditcard_(\d+)/.exec(fileName ?? '')?.[1] ??
    'ING-CREDITCARD';
  const raws: RawEntry[] = [];
  for (const row of rows.slice(1)) {
    const date = normalizeDate(row[col.date] ?? '');
    const cents = euAmountToCents(row[col.amount] ?? '');
    if (!date || cents === null) continue;
    raws.push({
      date,
      amountCents: sign(row[col.afBij] ?? '') * cents,
      counterpartyName: row[col.name]?.trim() || undefined,
      description: [row[col.kind]?.trim(), row[col.memo]?.trim()].filter(Boolean).join(' · '),
    });
  }
  return [
    {
      iban: card.replaceAll(/[^0-9A-Za-z]/g, ''), // stable normalized card ref
      currency: 'EUR',
      closingBalanceCents: null,
      entries: toEntries(raws),
      accountType: 'credit',
      accountName: 'ING Creditcard',
    },
  ];
}
