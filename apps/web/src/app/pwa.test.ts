// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

let registered: { onNeedRefresh?: () => void } | null = null;
const updateSpy = vi.fn();

// aliased to the stub in vitest.config; mocked here for observability
vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn((options: { onNeedRefresh?: () => void }) => {
    registered = options;
    return updateSpy;
  }),
}));

import { initPwa, usePwa } from './pwa';

describe('pwa update store', () => {
  beforeEach(() => {
    usePwa.setState({ needRefresh: false, update: () => undefined });
    registered = null;
    updateSpy.mockClear();
  });

  it('starts idle; dismiss clears the flag', () => {
    expect(usePwa.getState().needRefresh).toBe(false);
    usePwa.setState({ needRefresh: true });
    usePwa.getState().dismiss();
    expect(usePwa.getState().needRefresh).toBe(false);
  });

  it('service-worker refresh signal raises the flag and wires update()', () => {
    initPwa();
    expect(registered).toBeTruthy();
    registered!.onNeedRefresh!();
    expect(usePwa.getState().needRefresh).toBe(true);
    usePwa.getState().update();
    expect(updateSpy).toHaveBeenCalledWith(true);
  });
});
