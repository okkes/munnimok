import { afterEach, describe, expect, it, vi } from 'vitest';

describe('lab config', () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as { __MUNNI_CONFIG__?: unknown }).__MUNNI_CONFIG__;
  });

  it('prefers the runtime overlay over the baked env; an empty overlay value means "not set"', async () => {
    (globalThis as { __MUNNI_CONFIG__?: unknown }).__MUNNI_CONFIG__ = { API_URL: 'https://api.overlay', LOGTO_APP_ID: '' };
    const { config, glitchtipDsn } = await import('./config');
    expect(config.apiUrl).toBe('https://api.overlay');
    expect(config.logtoAppId).toBe(import.meta.env.VITE_LOGTO_APP_ID ?? '');
    expect(typeof glitchtipDsn).toBe('string');
  });

  it('falls back to localhost without any configuration', async () => {
    const { config } = await import('./config');
    expect(config.apiUrl).toMatch(/^http/);
  });
});
