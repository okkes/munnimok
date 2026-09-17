import { describe, expect, it } from 'vitest';
import { kindOf, standardTypeFor } from './txKind';
import type { TxType } from '@/db/types';

const EVERY_TYPE: TxType[] = ['expense', 'income', 'saving', 'transfer', 'debtPayment', 'investment', 'funding', 'adjustment'];

describe('txKind', () => {
  it('collapses every technical type into exactly one kind', () => {
    expect(kindOf('expense')).toBe('standard');
    expect(kindOf('income')).toBe('standard');
    expect(kindOf('transfer')).toBe('transfer');
    expect(kindOf('saving')).toBe('transfer');
    expect(kindOf('debtPayment')).toBe('transfer');
    expect(kindOf('investment')).toBe('transfer');
    // funding derives from a funding-pot counterparty (#152) and reads
    // as standard here — the story lives on the category
    expect(kindOf('funding')).toBe('standard');
    expect(kindOf('adjustment')).toBe('adjustment');
    // the mapping must stay total — a new TxType without a kind is a bug
    for (const type of EVERY_TYPE) expect(['standard', 'transfer', 'adjustment']).toContain(kindOf(type));
  });

  it('standard resolves by sign', () => {
    expect(standardTypeFor(-500)).toBe('expense');
    expect(standardTypeFor(500)).toBe('income');
    expect(standardTypeFor(0)).toBe('income');
  });
});
