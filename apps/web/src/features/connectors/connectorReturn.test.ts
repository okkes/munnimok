// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetReturn, pendingReturnFor, rememberReturn, returnCodeOf } from './connectorReturn';

const KEY = 'munni_connector_return';
const pending = { provider: 'gocardless', sessionId: 'ses_1', challengeId: 'ch_1', code: 'REF-1', connectionId: 'conn-1', reconnect: false };

describe('connectorReturn — what the return page needs, written down before the party opens (§15)', () => {
  beforeEach(() => localStorage.clear());

  it('remembers the return, finds it by the code the party echoes, and forgets it', () => {
    rememberReturn(pending);
    expect(pendingReturnFor('REF-1')).toMatchObject(pending);
    expect(pendingReturnFor('REF-1')?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // another party's reference is not this return; a query without one gets the only return there is
    expect(pendingReturnFor('REF-2')).toBeNull();
    expect(pendingReturnFor(null)).toMatchObject(pending);
    forgetReturn();
    expect(pendingReturnFor('REF-1')).toBeNull();
  });

  it('reads the reference a bank echoes: GoCardless’s ref before Enable Banking’s state', () => {
    expect(returnCodeOf(new URLSearchParams('ref=REF-1&code=c'))).toBe('REF-1');
    expect(returnCodeOf(new URLSearchParams('state=ST-9&code=c'))).toBe('ST-9');
    expect(returnCodeOf(new URLSearchParams('ref=REF-1&state=ST-9'))).toBe('REF-1');
    expect(returnCodeOf(new URLSearchParams(''))).toBeNull();
  });

  it('ignores a broken or half-written entry instead of answering with it', () => {
    localStorage.setItem(KEY, '{');
    expect(pendingReturnFor('REF-1')).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ provider: 'gocardless', code: 'REF-1' }));
    expect(pendingReturnFor('REF-1')).toBeNull();
  });
});
