import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAV_TABS,
  MAX_NAV_PICKS,
  NAV_FEATURE_IDS,
  NAV_FEATURES,
  SIDE_NAV_GROUPS,
  homeShortcuts,
  labelsFit,
  navUsableFor,
  resolveNavTabs,
  storedNavTabs,
} from './navFeatures';
import { en } from '@/i18n/en';
import { nl } from '@/i18n/nl';
import { tr } from '@/i18n/tr';

const anyone = () => true;

describe('the bar a space shows after Home', () => {
  it('is the default bar while the space never picked one (absent or null)', () => {
    expect(resolveNavTabs(undefined, anyone)).toEqual(['transactions', 'planning', 'portfolio', 'settings']);
    expect(resolveNavTabs(null, anyone)).toEqual([...DEFAULT_NAV_TABS]);
  });

  it('keeps the picked order, and an empty pick leaves Home alone', () => {
    expect(resolveNavTabs(['goals', 'settings', 'transactions'], anyone)).toEqual(['goals', 'settings', 'transactions']);
    expect(resolveNavTabs([], anyone)).toEqual([]);
  });

  it('skips what this build does not know, doubles, and what the identity cannot open', () => {
    // splits live on the server: a profile without an account has none; an account has its own, the demo seeded ones (#538)
    expect(resolveNavTabs(['review', 'goals', 'goals', 42, 'splits'], navUsableFor('offline'))).toEqual(['goals']);
    expect(resolveNavTabs(['splits'], navUsableFor('user'))).toEqual(['splits']);
    expect(resolveNavTabs(['splits'], navUsableFor('demo'))).toEqual(['splits']);
  });

  it('cuts past the cap and reads a damaged value as the default', () => {
    expect(resolveNavTabs([...NAV_FEATURE_IDS], anyone)).toHaveLength(MAX_NAV_PICKS);
    expect(resolveNavTabs('goals', anyone)).toEqual([...DEFAULT_NAV_TABS]);
  });
});

describe('what an edit stores', () => {
  it('keeps the ids this build cannot show behind the visible picks', () => {
    const usable = navUsableFor('offline');
    expect(storedNavTabs(['review', 'goals', 'splits', 'review'], ['budgets', 'goals'], usable)).toEqual(['budgets', 'goals', 'review', 'splits']);
  });

  it('lets a removed feature go', () => {
    expect(storedNavTabs(['goals', 'budgets'], ['budgets'], anyone)).toEqual(['budgets']);
    expect(storedNavTabs(undefined, ['goals'], anyone)).toEqual(['goals']);
  });
});

describe('Home shortcuts', () => {
  it('stand in for the bar-only features the bar dropped', () => {
    expect(homeShortcuts([...DEFAULT_NAV_TABS])).toEqual([]);
    expect(homeShortcuts(['planning', 'goals'])).toEqual(['transactions', 'portfolio']);
  });
});

describe('labels or icons', () => {
  it('keeps the labels only while the widest fits its slot with room on both sides', () => {
    expect(labelsFit(72, [60, 40], 4)).toBe(true);
    expect(labelsFit(64, [60, 40], 4)).toBe(false);
  });
});

describe('the catalogue', () => {
  it('lists every feature in the side panel exactly once, settings at its foot', () => {
    const listed = SIDE_NAV_GROUPS.flatMap((group) => group.ids);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed, 'settings'].sort()).toEqual([...NAV_FEATURE_IDS].sort());
  });

  it('names every entry in all three languages', () => {
    for (const id of NAV_FEATURE_IDS) {
      for (const dict of [en, nl, tr]) expect(dict[NAV_FEATURES[id].labelKey], id).toBeTruthy();
    }
  });
});
