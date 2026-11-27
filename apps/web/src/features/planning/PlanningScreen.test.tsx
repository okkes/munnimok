// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { DEMO_SPACE_ID } from '@/db/seed';
import { planId } from '@/domain/planning';
import { HlcClock } from '@/sync/hlc';
import { renderApp } from '@/test/harness';

/** a day of the current month, clamped so it exists in every month — inside the demo space's monthly period */
const thisMonth = (day: number): string => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), Math.min(day, 28));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** rows the lean demo lacks, written once the boot chain has settled (the db.close trap) */
async function seedDemo(write: (repo: Repo) => Promise<void>) {
  const first = renderApp('/planning');
  await screen.findByTestId('screen-planning');
  await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
  const db = new MunniDB('munni_demo');
  await write(new Repo(new DexieBackend(db), new HlcClock('seed-plan'), { trackOutbox: false }));
  db.close();
  first.unmount();
}

const monthStart = (offset: number): string => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

async function seedPaidRecurring() {
  const first = renderApp('/planning');
  await screen.findByTestId('screen-planning');
  // the boot chain must settle before this handle's writes (db.close trap)
  await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
  const db = new MunniDB('munni_demo');
  const repo = new Repo(new DexieBackend(db), new HlcClock('seed-plan-rec'), { trackOutbox: false });
  await repo.upsert('recurring', DEMO_SPACE_ID, 'rec_plan', {
    name: 'Streamo',
    kind: 'subscription',
    amountCents: 1599,
    every: 'month',
    dueDay: 7,
    active: 1,
    logo: 'brands/netflix.svg',
  });
  await repo.upsert('transaction', DEMO_SPACE_ID, 'str_plan', {
    accountId: 'demo_main',
    date: thisMonth(new Date().getDate()),
    amountCents: -1599,
    currency: 'EUR',
    merchant: 'STREAMO',
    catId: 'subs',
    needsReview: 0,
    recurringId: 'rec_plan',
  });
  db.close();
  first.unmount();
}

// lean demo: checking €3,420.55 + the cash wallet make the pool; this month has consumption spending under €1,000
// and no housing spending
async function startEmptyPlan() {
  renderApp('/planning');
  await screen.findByTestId('screen-planning');
  fireEvent.click(await screen.findByTestId('plan-start-empty'));
  await screen.findByTestId('plan-header');
}

async function addHousingSubject(target: string) {
  fireEvent.click(screen.getByTestId('plan-segment-add-expenses'));
  await screen.findByTestId('plan-editor');
  fireEvent.change(screen.getByTestId('plan-editor-name'), { target: { value: 'Housing' } });
  fireEvent.click(screen.getByTestId('plan-editor-cat-housing'));
  fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: target } });
  fireEvent.click(screen.getByTestId('plan-editor-save'));
  await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
}

describe('Planning (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('starts an empty plan: the pool is left to give, a subject takes a target and fills from it', async () => {
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    const before = screen.getByTestId('plan-toallocate').textContent;
    expect(screen.getByTestId('plan-ahead-count').textContent).toBe('0/3');

    await addHousingSubject('100');
    const row = await screen.findByText('Housing');
    expect(row).toBeTruthy();
    // no housing spending this month: the subject only needs its target
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Needs/));
    fireEvent.click(screen.getByTestId('plan-segment-fundall-expenses'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Funded/));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toBe(before));
  }, 20_000);

  it('#455: what a cashed-out goal bought sits under Goals as the goal itself — its category is not asked to answer for it', async () => {
    await seedDemo(async (repo) => {
      await repo.upsert('transaction', DEMO_SPACE_ID, 'bike_buy', {
        accountId: 'demo_main',
        date: thisMonth(new Date().getDate()),
        amountCents: -77_700,
        currency: 'EUR',
        merchant: 'Fietsenwinkel',
        catId: 'housingRent',
        needsReview: 0,
      });
      await repo.upsert('goal', DEMO_SPACE_ID, 'g_bike', {
        name: 'Bike',
        targetCents: 80_000,
        allocatedCents: 0,
        archived: 1,
        cashOut: { date: thisMonth(1), txIds: [], purchaseTxIds: ['bike_buy'] },
      });
    });
    await startEmptyPlan();
    const row = await screen.findByTestId('plan-goal-bought-g_bike', {}, { timeout: 5000 });
    expect(row.textContent).toContain('Bike');
    expect(row.textContent).toMatch(/€777[.,]00/);
    expect(screen.getByTestId('plan-segment-goals').contains(row)).toBe(true);
    expect(screen.queryByTestId('plan-segment-empty-goals')).toBeNull();
    expect((await screen.findByTestId('plan-segment-unplanned')).textContent).not.toMatch(/777/);
  }, 20_000);

  it('a Needs chip funds its subject to the target with one tap; beyond the pool it asks once, then not again today', async () => {
    await startEmptyPlan();
    await addHousingSubject('500');
    const chip = (await screen.findAllByTestId(/^plan-subject-need-/))[0];
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Funded/));
    expect(screen.queryByTestId('plan-overbudget-confirm')).toBeNull(); // the demo pool covers 500

    // a category without spending this month reads Needs (a subject with spending is born unfunded: Over by)
    fireEvent.click(screen.getByText('Housing'));
    await screen.findByTestId('plan-sheet');
    fireEvent.click(screen.getByTestId('plan-fund-edit'));
    await screen.findByTestId('plan-editor');
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: '9999999' } });
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    fireEvent.click((await screen.findAllByTestId(/^plan-subject-need-/))[0]);
    await screen.findByTestId('plan-overbudget-confirm');
    fireEvent.click(screen.getByTestId('plan-overbudget-confirm'));
    await waitFor(() => expect(screen.queryByTestId(/^plan-subject-need-/)).toBeNull());
    expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/-/);
    fireEvent.click(screen.getByTestId('plan-withdraw-all'));
    fireEvent.click(await screen.findByTestId('plan-withdraw-confirm-confirm'));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toMatch(/-/));
    const before = screen.getAllByTestId(/^plan-subject-need-/).length;
    expect(before).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByTestId(/^plan-subject-need-/)[0]);
    // a closed Sheet keeps its children, so the confirm button's absence proves nothing: the funding going through does
    await waitFor(() => expect(screen.queryAllByTestId(/^plan-subject-need-/)).toHaveLength(before - 1));
  }, 30_000);

  it('Fund all funds every subject of the segment to its target', async () => {
    await startEmptyPlan();
    await addHousingSubject('500');
    fireEvent.click(screen.getByTestId('plan-segment-add-expenses'));
    await screen.findByTestId('plan-editor');
    fireEvent.change(screen.getByTestId('plan-editor-name'), { target: { value: 'Food' } });
    fireEvent.click(screen.getByTestId('plan-editor-cat-consumption'));
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    await screen.findByTestId('plan-segment-fundall-expenses');
    fireEvent.click(screen.getByTestId('plan-segment-fundall-expenses'));
    await waitFor(() => expect(screen.queryByTestId(/^plan-subject-need-/)).toBeNull());
    expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Needs/);
  }, 20_000);

  // pool rule: the head reads what the period started with, so a subject planned mid-period is born unfunded

  it('an unplanned main opens its sheet; Plan it makes a subject born unfunded whose spending reads Over by until the Spent chip funds it', async () => {
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    const before = screen.getByTestId('plan-toallocate').textContent;
    const row = (await screen.findAllByTestId(/^plan-unplanned-(?!sheet|plan)/))[0];
    const mainId = row.getAttribute('data-testid')!.replace('plan-unplanned-', '');
    fireEvent.click(row);
    await screen.findByTestId('plan-unplanned-sheet');
    expect(screen.getByTestId('plan-unplanned-sheet-spent').textContent).toMatch(/€[1-9]/);
    expect(screen.getByTestId('plan-unplanned-sheet-hint').textContent).toMatch(/already counts in the pool/);
    fireEvent.click(screen.getByTestId('plan-unplanned-plan'));
    await screen.findByTestId('plan-editor');
    expect((screen.getByTestId('plan-editor-target') as HTMLInputElement).value).toMatch(/[1-9]/);
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId(`plan-unplanned-${mainId}`)).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Over by/));
    expect(screen.getByTestId('plan-toallocate').textContent).toBe(before);

    fireEvent.click(screen.getAllByTestId(/^plan-subject-(?!need-|status-|funded-|orphan-|logo-|bar-|overlap-|inpool-)/)[0]);
    await screen.findByTestId('plan-sheet');
    // #692: the subject's own page — nothing funded yet, so all that was spent is beyond the funding
    expect(screen.getByTestId('screen-plan-subject')).toBeTruthy();
    expect(screen.queryByTestId('plan-header')).toBeNull();
    expect(screen.getByTestId('plan-page-second').textContent).toMatch(/Overspent€[1-9]/);
    expect(screen.getByTestId('plan-page-spent').textContent).toMatch(/Spent€[1-9]/);
    // nothing changed yet: nothing to save, nothing to give back, and the pool still has money so it pays
    expect(screen.getByTestId('plan-fund-save')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('plan-fund-empty')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('plan-fund-cover')).toHaveProperty('disabled', true);
    const poolBefore = screen.getByTestId('plan-page-pool').textContent;
    fireEvent.click(screen.getByTestId('plan-fund-fill'));
    // a draft: the page shows what the pool would be left with, the plan is untouched until Save changes
    expect(screen.getByTestId('plan-page-pool').textContent).not.toBe(poolBefore);
    expect(screen.getByTestId('plan-page-second').textContent).toMatch(/Not funded€0/);
    expect(screen.getByTestId('plan-fund-fill')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-sheet')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Over by/));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toBe(before));
  }, 25_000);

  it('#670: a subject that holds more than it spent offers Spent, and one tap sets it back to what it used', async () => {
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    fireEvent.click((await screen.findAllByTestId(/^plan-unplanned-(?!sheet|plan)/))[0]);
    await screen.findByTestId('plan-unplanned-sheet');
    fireEvent.click(screen.getByTestId('plan-unplanned-plan'));
    await screen.findByTestId('plan-editor');
    const spent = (screen.getByTestId('plan-editor-target') as HTMLInputElement).value;
    // a target above the spending, and well inside what the pool can give
    const target = (Number(spent) + 50).toFixed(2);
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: target } });
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());

    const openSubject = async () => {
      fireEvent.click((await screen.findAllByTestId(/^plan-subject-(?!need-|status-|funded-|orphan-|logo-|bar-|overlap-|inpool-)/))[0]);
      await screen.findByTestId('plan-sheet');
    };
    await openSubject();
    fireEvent.click(screen.getByTestId('plan-fund-fill'));
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-sheet')).toBeNull());

    // funded to its target, above what it spent: the way back is one chip
    await openSubject();
    await waitFor(() => expect((screen.getByTestId('plan-fund-input') as HTMLInputElement).value).toBe(target));
    fireEvent.click(screen.getByTestId('plan-fund-chip-spent'));
    expect((screen.getByTestId('plan-fund-input') as HTMLInputElement).value).toBe(spent);
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-sheet')).toBeNull());

    // it now holds exactly what it spent, so the chip has nothing left to offer
    await openSubject();
    await waitFor(() => expect((screen.getByTestId('plan-fund-input') as HTMLInputElement).value).toBe(spent));
    expect(screen.queryByTestId('plan-fund-chip-spent')).toBeNull();
  }, 25_000);

  it('#613 #618: Back to the pool empties a subject in one tap, and the history names the subject and the amounts', async () => {
    await startEmptyPlan();
    const before = screen.getByTestId('plan-toallocate').textContent;
    await addHousingSubject('500');
    const openSubject = async () => {
      fireEvent.click((await screen.findAllByTestId(/^plan-subject-(?!need-|status-|funded-|orphan-|logo-|bar-|overlap-|inpool-)/))[0]);
      await screen.findByTestId('plan-sheet');
    };
    await openSubject();
    expect(screen.getByTestId('plan-fund-empty')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('plan-fund-input'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-sheet')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toBe(before));

    await openSubject();
    fireEvent.click(await screen.findByTestId('plan-fund-empty'));
    expect((screen.getByTestId('plan-fund-input') as HTMLInputElement).value).toBe('0.00');
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-sheet')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toBe(before));

    fireEvent.click(screen.getAllByTestId('tab-home')[0]);
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-notifications'));
    fireEvent.click(await screen.findByTestId('notif-tab-activity'));
    const list = await screen.findByTestId('history-list');
    await waitFor(() => expect(list.textContent).toContain('You took €500.00 back from Housing'));
    expect(list.textContent).toContain('You set aside €500.00 for Housing (was €0.00)');
    expect(list.textContent).toContain('You added Housing to the plan');
  }, 25_000);

  it('#614: the bell says a plan is in the red, and stops saying it once the plan is out of it', async () => {
    await startEmptyPlan();
    fireEvent.click((await screen.findAllByTestId(/^plan-unplanned-(?!sheet|plan)/))[0]);
    await screen.findByTestId('plan-unplanned-sheet');
    fireEvent.click(screen.getByTestId('plan-unplanned-plan'));
    await screen.findByTestId('plan-editor');
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Over by/));

    const redRow = () => [...document.querySelectorAll('[data-testid^="notif-inbox-"]')].find((el) => el.textContent?.includes('In the red in your plan'));
    const openBell = async () => {
      fireEvent.click(screen.getAllByTestId('tab-home')[0]);
      await screen.findByTestId('screen-home');
      fireEvent.click(screen.getByTestId('home-notifications'));
      await screen.findByTestId('notif-tab-notifications');
    };
    cleanup();
    renderApp('/planning');
    await screen.findByTestId('plan-header');
    await openBell();
    await waitFor(() => expect(redRow()).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getAllByTestId('tab-planning')[0]);
    await screen.findByTestId('plan-header');
    fireEvent.click((await screen.findAllByTestId(/^plan-subject-(?!need-|status-|funded-|orphan-|logo-|bar-|overlap-|inpool-)/))[0]);
    await screen.findByTestId('plan-sheet');
    fireEvent.click(screen.getByTestId('plan-fund-fill'));
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Over by/));

    await openBell();
    await waitFor(() => expect(redRow()).toBeUndefined());
  }, 30_000);

  // Plan it leaves the head unchanged: the money only moves from Unplanned into the subject

  it('a paid recurring cost is an Unplanned row with its logo; Plan it adds the mirrored subject and the head does not move', async () => {
    await seedPaidRecurring();
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    const row = await screen.findByTestId('plan-unplanned-recurring-rec_plan');
    expect(row.textContent).toMatch(/Streamo/);
    expect(row.textContent).toMatch(/Recurring cost/);
    expect(row.textContent).toMatch(/15\.99/);
    expect(screen.getByTestId('plan-unplanned-logo-rec_plan').querySelector('img')?.getAttribute('src')).toBe('brands/netflix.svg');
    const before = screen.getByTestId('plan-toallocate').textContent;
    const startedBefore = screen.getByTestId('plan-pool-line').textContent;
    expect(startedBefore).toMatch(/Started with/);

    fireEvent.click(row);
    await screen.findByTestId('plan-unplanned-sheet');
    expect(screen.getByTestId('plan-unplanned-sheet-spent').textContent).toMatch(/15\.99/);
    expect(screen.getByTestId('plan-unplanned-sheet-hint').textContent).toMatch(/Recurring costs segment/);
    fireEvent.click(screen.getByTestId('plan-unplanned-plan'));
    await waitFor(() => expect(screen.queryByTestId('plan-unplanned-recurring-rec_plan')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-recurring').textContent).toMatch(/Streamo/));
    expect(screen.getAllByTestId(/^plan-subject-logo-/)).toHaveLength(1);
    expect(screen.getByTestId('plan-segment-recurring').textContent).toMatch(/Over by/);
    expect(screen.getByTestId('plan-toallocate').textContent).toBe(before);
    expect(screen.getByTestId('plan-pool-line').textContent).toBe(startedBefore);
  }, 30_000);

  it('Start over removes the plan after a confirm and the start screen comes back; starting again finds the money in the pool and the spending under Unplanned (#557)', async () => {
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    const before = screen.getByTestId('plan-toallocate').textContent;
    const row = (await screen.findAllByTestId(/^plan-unplanned-(?!sheet|plan)/))[0];
    const mainId = row.getAttribute('data-testid')!.replace('plan-unplanned-', '');
    fireEvent.click(row);
    fireEvent.click(await screen.findByTestId('plan-unplanned-plan'));
    await screen.findByTestId('plan-editor');
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId(`plan-unplanned-${mainId}`)).toBeNull());
    await addHousingSubject('100');
    fireEvent.click(await screen.findByTestId('plan-segment-fundall-expenses'));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toBe(before));

    fireEvent.click(screen.getByTestId('plan-menu'));
    fireEvent.click(await screen.findByTestId('plan-menu-startOver'));
    await screen.findByTestId('plan-startover-confirm-body');
    fireEvent.click(screen.getByTestId('plan-startover-confirm-confirm'));
    await screen.findByTestId('plan-start');
    expect(screen.queryByTestId('plan-header')).toBeNull();
    expect(screen.queryByText('Housing')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-start-empty'));
    await screen.findByTestId(`plan-unplanned-${mainId}`);
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toBe(before));
    expect(screen.getByTestId('plan-segment-empty-expenses')).toBeTruthy();
  }, 25_000);

  it('Start over belongs to this period: a period planned ahead does not offer it', async () => {
    await startEmptyPlan();
    await addHousingSubject('100');
    await screen.findByText('Housing');
    fireEvent.click(screen.getByTestId('plan-next'));
    fireEvent.click(await screen.findByTestId('plan-ahead-start'));
    await screen.findByTestId('plan-header');
    fireEvent.click(screen.getByTestId('plan-menu'));
    await screen.findByTestId('plan-menu-blueprints');
    expect(screen.queryByTestId('plan-menu-startOver')).toBeNull();
  }, 20_000);

  it('a subject in the red is covered from one with room; the tab wears the dot', async () => {
    await startEmptyPlan();
    await addHousingSubject('500');
    fireEvent.click(screen.getByTestId('plan-segment-add-expenses'));
    await screen.findByTestId('plan-editor');
    fireEvent.change(screen.getByTestId('plan-editor-name'), { target: { value: 'Food' } });
    fireEvent.click(screen.getByTestId('plan-editor-cat-consumption'));
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Over by/));
    // the sidebar and the bottom bar both carry the tab, so both wear the dot
    await waitFor(() => expect(screen.getAllByTestId('tab-planning-dot').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId('plan-fill-all'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Funded/));
    // #692: while the pool has money the pool pays — Cover from… is for when nothing is left to give
    fireEvent.click(screen.getByText('Food'));
    await screen.findByTestId('plan-sheet');
    expect(screen.getByTestId('plan-fund-cover')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('plan-page-back'));
    await screen.findByTestId('plan-header');
    // Housing takes everything the pool has, and more
    fireEvent.click(screen.getByText('Housing'));
    await screen.findByTestId('plan-sheet');
    fireEvent.change(screen.getByTestId('plan-fund-input'), { target: { value: '9999999' } });
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    fireEvent.click(await screen.findByTestId('plan-overbudget-confirm'));
    await screen.findByTestId('plan-header');
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/-/));

    fireEvent.click(screen.getByText('Food'));
    await screen.findByTestId('plan-sheet');
    expect(screen.getByTestId('plan-page-second').textContent).toMatch(/Overspent/);
    fireEvent.click(screen.getByTestId('plan-fund-cover'));
    await screen.findByTestId('plan-cover-list');
    // the candidate rows, not the list container
    fireEvent.click(screen.getAllByTestId(/^plan-cover-(?!list)/).find((el) => el.textContent?.includes('Housing'))!);
    // the page stays and shows the subject out of the red
    await waitFor(() => expect(screen.getByTestId('plan-page-second').textContent).not.toMatch(/Overspent/));
    fireEvent.click(screen.getByTestId('plan-page-back'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Over by/));
  }, 30_000);

  it('blueprints keep a shape, the sandbox is a copy, a period ahead fills from what is left', async () => {
    await startEmptyPlan();
    await addHousingSubject('100');
    await screen.findByText('Housing');
    fireEvent.click(screen.getByTestId('plan-menu'));
    fireEvent.click(await screen.findByTestId('plan-menu-blueprints'));
    await screen.findByTestId('plan-blueprints');
    fireEvent.change(screen.getByTestId('plan-bp-name'), { target: { value: 'Normal' } });
    fireEvent.click(screen.getByTestId('plan-bp-save'));
    await waitFor(() => expect(screen.getAllByTestId(/^plan-bp-row-/)).toHaveLength(1));
    // the copied subjects land a tick after the blueprint row — wait for the count
    await waitFor(() => expect(screen.getByTestId(/^plan-bp-row-/).textContent).toMatch(/1 subjects/));
    fireEvent.change(screen.getByTestId('plan-bp-name'), { target: { value: 'Twin' } });
    fireEvent.click(screen.getByTestId('plan-bp-save'));
    await screen.findByTestId('plan-bp-same');
    fireEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent.click(screen.getByTestId('plan-menu'));
    fireEvent.click(await screen.findByTestId('plan-menu-sandbox'));
    await screen.findByTestId('plan-sandbox-strip');
    await waitFor(() => expect(screen.getByTestId('plan-mode-sandbox').getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByTestId('plan-sandbox-finalize'));
    await waitFor(() => expect(screen.queryByTestId('plan-sandbox-strip')).toBeNull(), { timeout: 5000 });
    await screen.findByText('Housing', {}, { timeout: 5000 });

    fireEvent.click(screen.getByTestId('plan-ahead'));
    await screen.findByTestId('plan-ahead-sheet');
    fireEvent.click(screen.getByTestId('plan-ahead-fund'));
    await waitFor(() => expect(screen.getAllByTestId(/^plan-ahead-row-/)).toHaveLength(1));
    // the copied subject is funded a tick after its row lands
    await waitFor(() => expect(screen.getByTestId('plan-ahead-sheet-circle-count').textContent).toBe('1/3'), { timeout: 5000 });
  }, 25_000);

  it('“in the red” opens a review that walks the red subjects one by one — nothing moves until a source is picked; covered past its target the bar wears stripes (#557, #517)', async () => {
    await startEmptyPlan();
    fireEvent.click(screen.getByTestId('plan-segment-add-expenses'));
    await screen.findByTestId('plan-editor');
    fireEvent.change(screen.getByTestId('plan-editor-name'), { target: { value: 'Food' } });
    fireEvent.click(screen.getByTestId('plan-editor-cat-consumption'));
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Over by/));

    fireEvent.click(await screen.findByTestId('plan-attention-review'));
    await screen.findByTestId('plan-review');
    expect(screen.getByTestId('plan-review-progress').textContent).toBe('1 of 1');
    // #692: no explainer line — the red pill and the sources say it
    expect(screen.queryByTestId('plan-review-why')).toBeNull();
    expect(screen.getByTestId('plan-review-status').textContent).toMatch(/Over by/);
    expect(screen.getByTestId('plan-review-from-pool').textContent).toMatch(/leaves €[1-9]/);
    fireEvent.click(screen.getByTestId('plan-review-from-pool'));
    await screen.findByTestId('plan-review-done');
    expect(screen.getByTestId('plan-review-done').textContent).toMatch(/out of the red/);
    fireEvent.click(screen.getByTestId('plan-review-close'));
    await waitFor(() => expect(screen.queryByTestId('plan-attention')).toBeNull());
    expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/past target/);
    expect(screen.getAllByTestId(/^plan-subject-bar-.*-stripes$/)).toHaveLength(1);
  }, 30_000);

  it('#669: with nothing left to give, the review still offers the pool — it goes below zero and says so', async () => {
    await startEmptyPlan();
    await addHousingSubject('9999999');
    fireEvent.click((await screen.findAllByTestId(/^plan-subject-need-/))[0]);
    fireEvent.click(await screen.findByTestId('plan-overbudget-confirm'));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/-/));

    fireEvent.click(screen.getByTestId('plan-segment-add-expenses'));
    await screen.findByTestId('plan-editor');
    fireEvent.change(screen.getByTestId('plan-editor-name'), { target: { value: 'Food' } });
    fireEvent.click(screen.getByTestId('plan-editor-cat-consumption'));
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Over by/));

    fireEvent.click(await screen.findByTestId('plan-attention-review'));
    await screen.findByTestId('plan-review');
    const pool = screen.getByTestId('plan-review-from-pool');
    expect(pool.textContent).toMatch(/takes the pool to/);
    expect(pool.textContent).toMatch(/-€[1-9]/);
    fireEvent.click(pool);
    await screen.findByTestId('plan-review-done');
    expect(screen.getByTestId('plan-review-done').textContent).toMatch(/out of the red/);
  }, 30_000);

  it('an unplanned main is funded for this period only: the row reads funded, the head comes down, and nothing joins the plan (#494)', async () => {
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    const before = screen.getByTestId('plan-toallocate').textContent;
    const row = (await screen.findAllByTestId(/^plan-unplanned-(?!sheet|plan|oneoff|logo)/))[0];
    const mainId = row.getAttribute('data-testid')!.replace('plan-unplanned-', '');
    fireEvent.click(row);
    await screen.findByTestId('plan-oneoff');
    expect(screen.getByTestId('plan-oneoff-hint').textContent).toMatch(/does not carry it over/);
    // what it holds and what it still lacks stand apart from the field, which is the total
    expect(screen.getByTestId('plan-oneoff-funded').textContent).toMatch(/Funded€0[.,]00/);
    expect(screen.getByTestId('plan-oneoff-needed').textContent).toMatch(/Still needed€[1-9]/);
    fireEvent.click(screen.getByTestId('plan-oneoff-chip-spent'));
    fireEvent.click(screen.getByTestId('plan-oneoff-save'));
    await screen.findByTestId(`plan-unplanned-oneoff-${mainId}`);
    fireEvent.click(screen.getByTestId(`plan-unplanned-${mainId}`));
    await waitFor(() => expect(screen.getByTestId('plan-oneoff-funded').textContent).toMatch(/Funded€[1-9]/));
    expect(screen.getByTestId('plan-oneoff-needed').textContent).toMatch(/Still needed€0[.,]00/);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId(`plan-unplanned-${mainId}`).textContent).toMatch(/Funded/);
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toBe(before));
    expect(screen.getByTestId('plan-segment-empty-expenses')).toBeTruthy();
  }, 20_000);

  it('a segment folds into one line and opens again (#518)', async () => {
    await startEmptyPlan();
    await addHousingSubject('100');
    fireEvent.click(screen.getByTestId('plan-segment-fold-expenses'));
    expect(screen.getByTestId('plan-segment-fold-expenses').getAttribute('aria-expanded')).toBe('false');
    await screen.findByTestId('plan-segment-summary-expenses');
    await waitFor(() => expect(screen.queryByText('Housing')).toBeNull());
    fireEvent.click(screen.getByTestId('plan-segment-summary-expenses'));
    await screen.findByText('Housing');
    await waitFor(() => expect(screen.queryByTestId('plan-segment-summary-expenses')).toBeNull());
  }, 20_000);

  it('a new period carries the last plan over by itself instead of showing the start screen (#557)', async () => {
    const previous = monthStart(-1);
    await seedDemo(async (repo) => {
      const last = planId(DEMO_SPACE_ID, 'actual', previous);
      await repo.upsert('plan', DEMO_SPACE_ID, last, { kind: 'actual', periodStart: previous });
      await repo.upsert('planSubject', DEMO_SPACE_ID, 'carry_housing', { planId: last, segment: 'expenses', order: 0, name: 'Housing', catIds: ['housing'], targetCents: 50_000, fundedCents: 50_000 });
    });
    renderApp('/planning');
    await screen.findByTestId('plan-header');
    expect(await screen.findByText('Housing')).toBeTruthy();
    expect(screen.queryByTestId('plan-start')).toBeNull();
    expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Needs/);
  }, 20_000);

  it('an event joins the plan from its own segment; its target spreads the estimate — or the person’s own total — over the periods until it starts (#504)', async () => {
    await seedDemo(async (repo) => {
      await repo.upsert('event', DEMO_SPACE_ID, 'evt_plan', { name: 'Ski trip', from: `${monthStart(2).slice(0, 8)}10`, budgetCents: 90_000 });
      await repo.upsert('event', DEMO_SPACE_ID, 'evt_old', { name: 'Old party', from: '2020-01-01', to: '2020-01-02', budgetCents: 1_000 });
    });
    await startEmptyPlan();
    fireEvent.click(screen.getByTestId('plan-segment-add-events'));
    await screen.findByTestId('plan-add-source');
    expect(screen.queryByTestId('plan-add-source-evt_old')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-add-source-evt_plan'));
    fireEvent.click(screen.getByTestId('plan-add-source-save'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-events').textContent).toMatch(/Ski trip/));
    // this period, the next and the trip's own: a third of €900
    expect(screen.getByTestId('plan-segment-events').textContent).toMatch(/300\.00/);
    fireEvent.click(screen.getByText('Ski trip'));
    await screen.findByTestId('plan-event-total');
    expect(screen.getByTestId('plan-event-total-note').textContent).toMatch(/estimate/);
    fireEvent.change(screen.getByTestId('plan-event-total-input'), { target: { value: '1200' } });
    fireEvent.click(screen.getByTestId('plan-event-total-save'));
    await waitFor(() => expect(screen.getByTestId('plan-sheet').textContent).toMatch(/400\.00/));
  }, 25_000);

  it('a budget that counts a category blocks it in the expense editor, and leaves the plan from right there (#535)', async () => {
    await seedDemo(async (repo) => {
      await repo.upsert('budget', DEMO_SPACE_ID, 'bud_food', { name: 'Food', amountCents: 20_000, every: 'month', anchor: monthStart(0), catIds: ['consumption'], active: 1 });
    });
    await startEmptyPlan();
    fireEvent.click(screen.getByTestId('plan-segment-add-budgets'));
    fireEvent.click(await screen.findByTestId('plan-add-source-bud_food'));
    fireEvent.click(screen.getByTestId('plan-add-source-save'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-budgets').textContent).toMatch(/Food/));

    fireEvent.click(screen.getByTestId('plan-segment-add-expenses'));
    await screen.findByTestId('plan-editor');
    fireEvent.change(screen.getByTestId('plan-editor-name'), { target: { value: 'Consumption' } });
    fireEvent.click(screen.getByTestId('plan-editor-cat-consumption'));
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: '100' } });
    expect(screen.getByTestId('plan-editor-budget-consumption').textContent).toMatch(/Counted by the budget Food/);
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    expect(screen.getAllByTestId('plan-editor-blocker').some((el) => /another subject/.test(el.textContent ?? ''))).toBe(true);
    expect(screen.getByTestId('plan-editor')).toBeTruthy();
    fireEvent.click(screen.getByTestId('plan-editor-remove-consumption'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor-budget-consumption')).toBeNull());
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Consumption/));
    expect(screen.getByTestId('plan-segment-empty-budgets')).toBeTruthy();
  }, 30_000);

  it('the money pool offers a credit card too (#532)', async () => {
    await seedDemo(async (repo) => {
      await repo.upsert('account', DEMO_SPACE_ID, 'card_plan', { name: 'Visa', type: 'credit', currency: 'EUR', balanceCents: -12_000, source: 'manual' });
    });
    await startEmptyPlan();
    fireEvent.click(screen.getByTestId('plan-menu'));
    fireEvent.click(await screen.findByTestId('plan-menu-pool'));
    await screen.findByTestId('plan-pool');
    expect(screen.getByTestId('plan-pool-card_plan').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('plan-pool-credit').textContent).toMatch(/credit card/);
    fireEvent.click(screen.getByTestId('plan-pool-card_plan'));
    expect(screen.getByTestId('plan-pool-card_plan').getAttribute('aria-pressed')).toBe('true');
  }, 20_000);

  it('the home block and the settings door open the plan; the recurring manager keeps a way back', async () => {
    await startEmptyPlan();
    fireEvent.click(screen.getByTestId('tab-home'));
    await screen.findByTestId('screen-home');
    await screen.findByTestId('home-planning');
    fireEvent.click(screen.getByTestId('home-recurring-all'));
    await screen.findByTestId('screen-recurring');
    expect(screen.getByTestId('recurring-back')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tab-settings'));
    await screen.findByTestId('screen-settings');
    expect(screen.getByTestId('settings-recurring-row')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings-planning-row'));
    await screen.findByTestId('screen-planning');
  }, 20_000);
});
