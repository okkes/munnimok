// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { institutionLogoUrl } from './useInstitutionLogos';

vi.mock('@/app/config', () => ({
  config: { apiUrl: 'http://api.example', logto: { endpoint: '', appId: '', resource: '' }, glitchtipDsn: '', channel: '' },
  logtoConfigured: false,
  publicOrigin: () => window.location.origin,
}));

describe('institutionLogoUrl (#176, #414)', () => {
  beforeEach(() => localStorage.clear());

  it('asks the party for the logo its lookup showed — the relay route on the API origin, the value as a base64url token', () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'u1' }));
    expect(institutionLogoUrl({ provider: 'gocardless', bankId: 'ING_NL' })).toBe('http://api.example/connectors/gocardless/options/institution/SU5HX05M/logo');
    // an Enable Banking "name|country" value carries a pipe and a space: the token keeps the route parameter plain
    expect(institutionLogoUrl({ provider: 'enablebanking', bankId: 'ASN Bank|NL' })).toBe(
      'http://api.example/connectors/enablebanking/options/institution/QVNOIEJhbmt8Tkw/logo',
    );
  });

  it('local-only identities, rows without a party and rows without an institution keep the generic icon (no URL, no network)', () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'demo' }));
    expect(institutionLogoUrl({ provider: 'gocardless', bankId: 'ING_NL' })).toBeUndefined();
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'u1' }));
    expect(institutionLogoUrl({ provider: undefined, bankId: 'ING_NL' })).toBeUndefined();
    expect(institutionLogoUrl({ provider: 'gocardless', bankId: undefined })).toBeUndefined();
    expect(institutionLogoUrl(undefined)).toBeUndefined();
  });
});
