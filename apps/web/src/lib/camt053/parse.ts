/**
 * CAMT.053 (ISO 20022 bank-to-customer statement) parser. Runs entirely
 * in the browser via DOMParser — bank files never leave the device and
 * import works in offline mode. Field mapping follows apollousa's
 * CAMT053Model.cs (camt.053.001.02, as exported by ING/ABN/…).
 */

export interface CamtEntry {
  /** signed integer cents; DBIT = negative */
  amountCents: number;
  currency: string;
  /** yyyy-mm-dd booking date */
  date: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  /** unstructured remittance info + extra references, for categorization */
  description: string;
  /** bank-side reference for idempotent import (AcctSvcrRef / EndToEndId) */
  ref: string;
}

export interface CamtStatement {
  iban: string;
  currency: string;
  /** closing booked balance (CLBD) in cents, if present */
  closingBalanceCents: number | null;
  entries: CamtEntry[];
}

const text = (parent: Element | null, ...path: string[]): string | undefined => {
  let el: Element | null = parent;
  for (const name of path) {
    if (!el) return undefined;
    el = Array.from(el.children).find((c) => c.localName === name) ?? null;
  }
  return el?.textContent?.trim() || undefined;
};

const children = (parent: Element, name: string): Element[] =>
  Array.from(parent.children).filter((c) => c.localName === name);

const toCents = (amount: string | undefined): number | null => {
  if (!amount) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

export function parseCamt053(xml: string): CamtStatement[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  const root = doc.documentElement;
  if (root.localName !== 'Document') throw new Error('Not a CAMT.053 document');
  const bkToCstmr = children(root, 'BkToCstmrStmt')[0];
  if (!bkToCstmr) throw new Error('Not a CAMT.053 document');

  return children(bkToCstmr, 'Stmt').map((stmt) => {
    const iban = text(stmt, 'Acct', 'Id', 'IBAN') ?? '';
    const currency = text(stmt, 'Acct', 'Ccy') ?? 'EUR';

    // closing booked balance
    let closingBalanceCents: number | null = null;
    for (const bal of children(stmt, 'Bal')) {
      if (text(bal, 'Tp', 'CdOrPrtry', 'Cd') !== 'CLBD') continue;
      const cents = toCents(text(bal, 'Amt'));
      if (cents === null) continue;
      closingBalanceCents = text(bal, 'CdtDbtInd') === 'DBIT' ? -cents : cents;
    }

    const entries: CamtEntry[] = [];
    for (const ntry of children(stmt, 'Ntry')) {
      const amtEl = children(ntry, 'Amt')[0];
      const cents = toCents(amtEl?.textContent?.trim());
      if (cents === null) continue;
      const debit = text(ntry, 'CdtDbtInd') === 'DBIT';
      const date = text(ntry, 'BookgDt', 'Dt') ?? text(ntry, 'ValDt', 'Dt') ?? '';

      const txDtls = children(ntry, 'NtryDtls').flatMap((d) => children(d, 'TxDtls'))[0] ?? null;
      const relatedParty = debit ? 'Cdtr' : 'Dbtr';
      const counterpartyName = text(txDtls, 'RltdPties', relatedParty, 'Nm');
      const counterpartyIban = text(txDtls, `RltdPties`, `${relatedParty}Acct`, 'Id', 'IBAN');

      const remittance = txDtls
        ? children(txDtls, 'RmtInf')
            .flatMap((r) => children(r, 'Ustrd'))
            .map((u) => u.textContent?.trim() ?? '')
            .filter(Boolean)
            .join(' ')
        : '';
      const addtlInfo = text(ntry, 'AddtlNtryInf') ?? '';
      const description = [remittance, addtlInfo].filter(Boolean).join(' ').trim();

      const ref =
        text(ntry, 'AcctSvcrRef') ??
        text(txDtls, 'Refs', 'AcctSvcrRef') ??
        text(txDtls, 'Refs', 'EndToEndId') ??
        `${date}:${cents}:${counterpartyName ?? ''}:${description.slice(0, 40)}`;

      entries.push({
        amountCents: debit ? -cents : cents,
        currency: amtEl?.getAttribute('Ccy') ?? currency,
        date,
        counterpartyName,
        counterpartyIban,
        description,
        ref,
      });
    }

    return { iban, currency, closingBalanceCents, entries };
  });
}
