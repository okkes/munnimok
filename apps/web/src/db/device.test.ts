// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetDeviceId, getClock, getDeviceId } from './device';

describe('device identity', () => {
  beforeEach(() => localStorage.clear());

  it('generates a compact id once and keeps it stable', () => {
    const first = getDeviceId();
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(getDeviceId()).toBe(first);
    expect(localStorage.getItem('munni_device_id')).toBe(first);
  });

  it('respects a pre-existing id', () => {
    localStorage.setItem('munni_device_id', 'fixeddevice1');
    expect(getDeviceId()).toBe('fixeddevice1');
  });

  it('#685: a forgotten id is replaced by a new one, and the clock stamps with it from then on', () => {
    const before = getDeviceId();
    const stampedBefore = getClock().now();
    expect(stampedBefore.endsWith(before)).toBe(true);
    forgetDeviceId();
    const after = getDeviceId();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{12}$/);
    expect(getClock().now().endsWith(after)).toBe(true);
  });
});
