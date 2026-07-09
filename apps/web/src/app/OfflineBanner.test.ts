import { describe, expect, it } from 'vitest';
import { resolveOfflineReason } from './OfflineBanner';

describe('resolveOfflineReason', () => {
  it('is silent for local-only identities (no engine) — offline mode is a choice', () => {
    expect(resolveOfflineReason(false, false, 'offline')).toBeNull();
    expect(resolveOfflineReason(false, true, 'error')).toBeNull();
  });

  it('reports no-network the moment connectivity is gone, before sync fails', () => {
    expect(resolveOfflineReason(true, false, 'idle')).toBe('no-network');
    expect(resolveOfflineReason(true, false, 'error')).toBe('no-network');
  });

  it('reports unreachable when the network is up but sync cannot reach the server', () => {
    expect(resolveOfflineReason(true, true, 'offline')).toBe('unreachable');
    expect(resolveOfflineReason(true, true, 'error')).toBe('unreachable');
  });

  it('stays hidden while syncing works', () => {
    expect(resolveOfflineReason(true, true, 'idle')).toBeNull();
    expect(resolveOfflineReason(true, true, 'syncing')).toBeNull();
  });
});
