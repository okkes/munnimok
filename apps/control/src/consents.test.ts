import { describe, expect, it } from 'vitest';
import { consentState, groupBySource, sourceOf } from './consents';

describe('the consents of an aggregator, read per environment', () => {
  it('a return origin names munni’s environment, this computer, or the host it was', () => {
    expect(sourceOf('https://munni-prod-nas.example.com')).toEqual({ key: 'https://munni-prod-nas.example.com', label: 'prod · nas', host: 'munni-prod-nas.example.com' });
    expect(sourceOf('https://munni-dev2-lcl-lab.192-168-1-5.sslip.io').label).toBe('dev2 · lcl');
    expect(sourceOf('http://127.0.0.1:8380').label).toBe('this computer');
    expect(sourceOf('https://bank-sandbox.example.org').label).toBe('bank-sandbox.example.org');
    expect(sourceOf('not a url').label).toBe('not a url');
    expect(sourceOf(null)).toEqual({ key: 'unattributed', label: 'unattributed', host: null });
  });

  it('groups by origin: named environments by name, unattributed last', () => {
    const groups = groupBySource([
      { id: 'a', status: 'LN', origin: null, accountCount: 0 },
      { id: 'b', status: 'LN', origin: 'https://munni-prod-nas.example.com', accountCount: 1 },
      { id: 'c', status: 'EX', origin: 'https://munni-dev-nas.example.com', accountCount: 0 },
      { id: 'd', status: 'LN', origin: 'https://munni-prod-nas.example.com', accountCount: 2 },
    ]);
    expect(groups.map((g) => [g.source.label, g.consents.map((c) => c.id)])).toEqual([
      ['dev · nas', ['c']],
      ['prod · nas', ['b', 'd']],
      ['unattributed', ['a']],
    ]);
  });

  it('a consent is in force, a leftover, or still being given — a sign-in left unfinished for a day is a leftover', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(consentState({ status: 'LN' }, now)).toEqual({ word: 'linked — in force', leftover: false });
    expect(consentState({ status: 'RJ' }, now).leftover).toBe(true);
    expect(consentState({ status: 'SU' }, now).leftover).toBe(true);
    expect(consentState({ status: 'GA', createdAt: '2026-11-08T11:00:00Z' }, now)).toEqual({ word: 'GA — being given right now', leftover: false });
    expect(consentState({ status: 'GA', createdAt: '2026-11-06T11:00:00Z' }, now).leftover).toBe(true);
    expect(consentState({ status: 'UA', createdAt: null }, now).leftover).toBe(true);
  });
});
