import { describe, expect, it } from 'vitest';
import { bandEditable, bandEligible, bandIncludes, bandModeOf } from './balanceBand';
import type { AccountRow } from '@/db/types';

const acct = (id: string, type: AccountRow['type']) => ({ id, type });

describe('balance band modes', () => {
  it('defaults to net worth (the pre-config behavior)', () => {
    expect(bandModeOf(undefined)).toBe('networth');
    expect(bandModeOf({})).toBe('networth');
    expect(bandModeOf({ balanceBandMode: 'cash' })).toBe('cash');
  });

  it('#142: the premade modes are fixed formulas', () => {
    expect(bandIncludes('cash', acct('a', 'checking'), {})).toBe(true);
    expect(bandIncludes('cash', acct('a', 'loan'), {})).toBe(false);
    expect(bandIncludes('networth', acct('l', 'loan'), {})).toBe(true);
    expect(bandEligible('spendable', acct('a', 'checking'))).toBe(false);
  });

  it('#142: only Picked accounts is editable, and it reads its explicit include list', () => {
    expect(bandEditable('networth')).toBe(false);
    expect(bandEditable('cash')).toBe(false);
    expect(bandEditable('spendable')).toBe(false);
    expect(bandEditable('custom')).toBe(true);
    expect(bandIncludes('custom', acct('a', 'checking'), {})).toBe(false);
    expect(bandIncludes('custom', acct('a', 'checking'), { balanceBandAccounts: ['a'] })).toBe(true);
  });
});
