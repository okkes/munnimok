import { parseCamt053 } from '@/lib/camt053/parse';
import { parseIngCreditcardCsv, parseIngCurrentCsv, parseIngSavingsCsv } from './ing';
import type { ParsedStatement } from './ing';

export type { ParsedStatement };

/**
 * One entry point for every statement format the app understands.
 * Transactions arrive from all over in different shapes — this module
 * normalizes them into the same ParsedStatement, so the importer,
 * dedupe ids and screens never care where a file came from.
 *
 * Detection is content-based (header sniffing), not extension-based:
 * banks are creative with file names.
 */
export function parseStatement(content: string, fileName?: string): ParsedStatement[] {
  const head = content.slice(0, 400);

  if (head.trimStart().startsWith('<')) {
    return parseCamt053(content); // CAMT.053 XML (ASN, SNS, Rabo, ING business…)
  }
  if (head.includes('"Kaartnummer"')) {
    return parseIngCreditcardCsv(content, fileName);
  }
  if (head.includes('"Saldo na mutatie"')) {
    return parseIngSavingsCsv(content);
  }
  if (head.includes('"Naam / Omschrijving"') && head.includes('"Tegenrekening"')) {
    return parseIngCurrentCsv(content);
  }
  throw new Error('Unsupported statement format');
}
