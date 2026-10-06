import { describe, expect, it } from 'vitest';
import { ago, minutes, shortId, tierOf, when } from './format';

describe('format', () => {
  it('ago reads freshness in the unit a glance needs', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(ago(null, now)).toBe('—');
    expect(ago('nonsense', now)).toBe('—');
    expect(ago('2026-10-06T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-10-06T11:45:00Z', now)).toBe('15 min ago');
    expect(ago('2026-10-06T07:00:00Z', now)).toBe('5 h ago');
    expect(ago('2026-10-01T12:00:00Z', now)).toBe('5 d ago');
  });

  it('when, shortId, minutes and the tier labels', () => {
    expect(when(undefined)).toBe('—');
    expect(when('2026-10-06T12:00:00Z')).not.toBe('—');
    expect(shortId('agt_0123456789abcdef')).toBe('agt_01234567…');
    expect(shortId('short')).toBe('short');
    expect(minutes(45)).toBe('45 min');
    expect(minutes(60)).toBe('1 h');
    expect(minutes(90)).toBe('1 h 30 min');
    expect(minutes(2880)).toBe('2 d');
    expect(tierOf('browser_persistent')).toBe('T4 · browser persistent');
    expect(tierOf('something-new')).toBe('something-new');
    expect(tierOf(undefined)).toBe('—');
  });
});
