// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { parseCamt053 } from './parse';
import { predictCategory } from '@/domain/predictCategory';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG001</MsgId><CreDtTm>2026-07-01T00:30:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-1</Id>
      <Acct><Id><IBAN>NL69INGB0123456789</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">1234.56</Amt><CdtDbtInd>CRDT</CdtDbtInd>
      </Bal>
      <Ntry>
        <Amt Ccy="EUR">42.10</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-06-28</Dt></BookgDt>
        <AcctSvcrRef>REF-001</AcctSvcrRef>
        <NtryDtls><TxDtls>
          <RltdPties>
            <Cdtr><Nm>Albert Heijn 1350</Nm></Cdtr>
            <CdtrAcct><Id><IBAN>NL00AHOL0000000001</IBAN></Id></CdtrAcct>
          </RltdPties>
          <RmtInf><Ustrd>AH 1350 AMSTERDAM Betaalautomaat</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">2200.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-06-25</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>E2E-777</EndToEndId></Refs>
          <RltdPties><Dbtr><Nm>Werkgever BV</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>SALARIS JUNI 2026</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe('parseCamt053', () => {
  it('parses account, closing balance and entries', () => {
    const [stmt] = parseCamt053(FIXTURE);
    expect(stmt.iban).toBe('NL69INGB0123456789');
    expect(stmt.currency).toBe('EUR');
    expect(stmt.closingBalanceCents).toBe(123456); // CLBD, not OPBD
    expect(stmt.entries).toHaveLength(2);
  });

  it('maps debit entry with counterparty and reference', () => {
    const [stmt] = parseCamt053(FIXTURE);
    const debit = stmt.entries[0];
    expect(debit).toMatchObject({
      amountCents: -4210,
      currency: 'EUR',
      date: '2026-06-28',
      counterpartyName: 'Albert Heijn 1350',
      counterpartyIban: 'NL00AHOL0000000001',
      ref: 'REF-001',
    });
    expect(debit.description).toContain('AH 1350');
  });

  it('maps credit entry, falling back to EndToEndId for ref', () => {
    const [stmt] = parseCamt053(FIXTURE);
    const credit = stmt.entries[1];
    expect(credit).toMatchObject({
      amountCents: 220000,
      counterpartyName: 'Werkgever BV',
      ref: 'E2E-777',
    });
  });

  it('rejects non-CAMT xml', () => {
    expect(() => parseCamt053('<foo/>')).toThrow();
  });
});

describe('predictCategory on parsed entries', () => {
  it('categorizes a Dutch grocery debit', () => {
    const [stmt] = parseCamt053(FIXTURE);
    const debit = stmt.entries[0];
    const catId = predictCategory(`${debit.counterpartyName} ${debit.description}`, 'debit');
    expect(catId).toBe('groceries');
  });

  it('categorizes a Dutch salary credit', () => {
    const [stmt] = parseCamt053(FIXTURE);
    const credit = stmt.entries[1];
    const catId = predictCategory(`${credit.counterpartyName} ${credit.description}`, 'credit');
    expect(catId).toBe('salary');
  });

  it('income keywords never fire on debits', () => {
    expect(predictCategory('SALARIS JUNI', 'debit')).not.toBe('salary');
  });

  it('returns null when nothing matches', () => {
    expect(predictCategory('xyzzy qwerty', 'debit')).toBeNull();
  });
});
