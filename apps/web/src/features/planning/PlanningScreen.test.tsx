// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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

/** the first day of the month `offset` months from this one */
const monthStart = (offset: number): string => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

/** a recurring cost with a brand logo, paid this month — the lean demo has no recurring costs of its own */
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

/**
 * Planning (#128) on the lean demo: checking €3,420.55 + the cash wallet
 * make the pool; this month holds real consumption spending (groceries,
 * coffee, restaurants) under €1,000 and no housing spending.
 */
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
    // nothing funded yet: the whole pool is left to give a job
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
    // the month's other spending is still unplanned; the bike is not among it
    expect((await screen.findByTestId('plan-segment-unplanned')).textContent).not.toMatch(/777/);
  }, 20_000);

  // round 30 (user 2026-10-07 pm): one-tap funding, Fund all, beyond the pool once a day, the pick per segment, the Unplanned sheet

  it('a Needs chip funds its subject to the target with one tap; beyond the pool it asks once, then not again today', async () => {
    await startEmptyPlan();
    await addHousingSubject('500');
    const chip = (await screen.findAllByTestId(/^plan-subject-need-/))[0];
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Funded/));
    expect(screen.queryByTestId('plan-overbudget-confirm')).toBeNull(); // the demo pool covers 500

    // a target the pool cannot cover — Housing's own, raised in the editor (a category without spending
    // this month, so it reads Needs; a subject with spending is born unfunded and reads Over by instead):
    // the question comes once, confirmed it funds, and the same day it no longer asks
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
    expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/-/); // beyond the pool now
    // withdraw everything and fund again: no question the same day
    fireEvent.click(screen.getByTestId('plan-withdraw-all'));
    fireEvent.click(await screen.findByTestId('plan-withdraw-confirm-confirm'));
    // the header says the pool is whole again: the model re-emitted for every row
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toMatch(/-/));
    const before = screen.getAllByTestId(/^plan-subject-need-/).length;
    expect(before).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByTestId(/^plan-subject-need-/)[0]);
    // the chip went without a confirm click: nothing asked this time (a closed Sheet keeps its children, so the
    // button's absence cannot be the proof — the funding going through is)
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
    // both are born with nothing funded (user 2026-10-08), so both still need their target
    await screen.findByTestId('plan-segment-fundall-expenses');
    fireEvent.click(screen.getByTestId('plan-segment-fundall-expenses'));
    await waitFor(() => expect(screen.queryByTestId(/^plan-subject-need-/)).toBeNull());
    expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Needs/);
  }, 20_000);

  // the pool rule (user 2026-10-08): the head reads what the period started with — the balance plus what
  // already left — so a subject planned mid-period is born unfunded and its spending is assigned by hand

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
    // the editor comes filled in, the spending as the target
    await screen.findByTestId('plan-editor');
    expect((screen.getByTestId('plan-editor-target') as HTMLInputElement).value).toMatch(/[1-9]/);
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId(`plan-unplanned-${mainId}`)).toBeNull());
    // nothing funded yet: what it spent reads Over by, and the head still counts that money
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Over by/));
    expect(screen.getByTestId('plan-toallocate').textContent).toBe(before);

    // its target is what it spent, so one chip says both (#519): it says what a tap does, hands the field its amount and lights up
    fireEvent.click(screen.getAllByTestId(/^plan-subject-(?!need-|status-|funded-|orphan-|logo-|bar-|overlap-|inpool-)/)[0]);
    await screen.findByTestId('plan-sheet');
    expect(screen.getByTestId('plan-fund-chips-hint').textContent).toMatch(/Tap an amount/);
    expect(screen.queryByTestId('plan-fund-chip-spent')).toBeNull();
    expect(screen.getByTestId('plan-fund-chip-target').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('plan-fund-chip-target'));
    expect(screen.getByTestId('plan-fund-chip-target').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-sheet')).toBeNull());
    // funded for what it spent: out of the red, and the head came down by that much
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Over by/));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toBe(before));
  }, 25_000);

  // the Unplanned source rows (user 2026-10-09): a paid recurring cost sits under Unplanned with its logo until Plan it
  // mirrors it — and the head reads the same before and after, because the money only moves from Unplanned into the subject

  it('a paid recurring cost is an Unplanned row with its logo; Plan it adds the mirrored subject and the head does not move', async () => {
    await seedPaidRecurring();
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    const row = await screen.findByTestId('plan-unplanned-recurring-rec_plan');
    expect(row.textContent).toMatch(/Streamo/);
    expect(row.textContent).toMatch(/Recurring cost/);
    expect(row.textContent).toMatch(/15\.99/);
    // the brand logo the recurring list shows, not the segment's icon
    expect(screen.getByTestId('plan-unplanned-logo-rec_plan').querySelector('img')?.getAttribute('src')).toBe('brands/netflix.svg');
    const before = screen.getByTestId('plan-toallocate').textContent;
    const startedBefore = screen.getByTestId('plan-pool-line').textContent;
    expect(startedBefore).toMatch(/Started with/);

    fireEvent.click(row);
    await screen.findByTestId('plan-unplanned-sheet');
    expect(screen.getByTestId('plan-unplanned-sheet-spent').textContent).toMatch(/15\.99/);
    expect(screen.getByTestId('plan-unplanned-sheet-hint').textContent).toMatch(/Recurring costs segment/);
    fireEvent.click(screen.getByTestId('plan-unplanned-plan'));
    // no editor: the subject lands in the recurring segment straight away, wearing the logo, and the row is gone
    await waitFor(() => expect(screen.queryByTestId('plan-unplanned-recurring-rec_plan')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-recurring').textContent).toMatch(/Streamo/));
    expect(screen.getAllByTestId(/^plan-subject-logo-/)).toHaveLength(1);
    // born unfunded, so what it paid reads Over by — and what the period started with did not move
    expect(screen.getByTestId('plan-segment-recurring').textContent).toMatch(/Over by/);
    expect(screen.getByTestId('plan-toallocate').textContent).toBe(before);
    expect(screen.getByTestId('plan-pool-line').textContent).toBe(startedBefore);
  }, 30_000);

  it('Start over removes the plan after a confirm and the start screen comes back; starting again finds the money in the pool and the spending under Unplanned (#557)', async () => {
    await startEmptyPlan();
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toMatch(/€[1-9]/));
    const before = screen.getByTestId('plan-toallocate').textContent;
    // plan an unplanned main and a Housing subject, fund both
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
    // the initial screen, not an empty plan (user 2026-10-23)
    await screen.findByTestId('plan-start');
    expect(screen.queryByTestId('plan-header')).toBeNull();
    expect(screen.queryByText('Housing')).toBeNull();
    // started again: the spending answers to no subject, and the head is back where the empty plan started
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
    // groceries have real spending this month and nothing set aside → in the red
    fireEvent.click(screen.getByTestId('plan-segment-add-expenses'));
    await screen.findByTestId('plan-editor');
    fireEvent.change(screen.getByTestId('plan-editor-name'), { target: { value: 'Food' } });
    fireEvent.click(screen.getByTestId('plan-editor-cat-consumption'));
    fireEvent.change(screen.getByTestId('plan-editor-target'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    await waitFor(() => expect(screen.queryByTestId('plan-editor')).toBeNull());
    // born unfunded (user 2026-10-08): the spending puts Food in the red at once
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Over by/));
    // the sidebar and the bottom bar both carry the tab, so both wear the dot
    await waitFor(() => expect(screen.getAllByTestId('tab-planning-dot').length).toBeGreaterThan(0));

    // fill Home first so it has room, then cover Food from it
    fireEvent.click(screen.getByTestId('plan-fill-all'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Funded/));
    fireEvent.click(screen.getByText('Food'));
    await screen.findByTestId('plan-sheet');
    fireEvent.click(screen.getByTestId('plan-fund-cover'));
    await screen.findByTestId('plan-cover-list');
    // the candidate rows, not the list container
    fireEvent.click(screen.getAllByTestId(/^plan-cover-(?!list)/).find((el) => el.textContent?.includes('Housing'))!);
    await waitFor(() => expect(screen.queryByTestId('plan-sheet')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Over by/));
  }, 20_000);

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
    // the same shape again is refused
    fireEvent.change(screen.getByTestId('plan-bp-name'), { target: { value: 'Twin' } });
    fireEvent.click(screen.getByTestId('plan-bp-save'));
    await screen.findByTestId('plan-bp-same');
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // the sandbox: a copy that becomes the plan on finalize
    fireEvent.click(screen.getByTestId('plan-menu'));
    fireEvent.click(await screen.findByTestId('plan-menu-sandbox'));
    await screen.findByTestId('plan-sandbox-strip');
    await waitFor(() => expect(screen.getByTestId('plan-mode-sandbox').getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(screen.getByTestId('plan-sandbox-finalize'));
    await waitFor(() => expect(screen.queryByTestId('plan-sandbox-strip')).toBeNull(), { timeout: 5000 });
    // the actual plan now holds the sandbox's copies
    await screen.findByText('Housing', {}, { timeout: 5000 });

    // a period ahead
    fireEvent.click(screen.getByTestId('plan-ahead'));
    await screen.findByTestId('plan-ahead-sheet');
    fireEvent.click(screen.getByTestId('plan-ahead-fund'));
    await waitFor(() => expect(screen.getAllByTestId(/^plan-ahead-row-/)).toHaveLength(1));
    // the copied subject is funded a tick after its row lands
    await waitFor(() => expect(screen.getByTestId('plan-ahead-sheet-circle-count').textContent).toBe('1/3'), { timeout: 5000 });
  }, 25_000);

  // the user's round of 2026-10-21/23: #494 #504 #517 #518 #532 #535 #557

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
    expect(screen.getByTestId('plan-review-why').textContent).toMatch(/more than it holds/);
    expect(screen.getByTestId('plan-review-status').textContent).toMatch(/Over by/);
    expect(screen.getByTestId('plan-review-from-pool').textContent).toMatch(/leaves €[1-9]/);
    fireEvent.click(screen.getByTestId('plan-review-from-pool'));
    await screen.findByTestId('plan-review-done');
    expect(screen.getByTestId('plan-review-done').textContent).toMatch(/out of the red/);
    fireEvent.click(screen.getByTestId('plan-review-close'));
    await waitFor(() => expect(screen.queryByTestId('plan-attention')).toBeNull());
    // funded for all it spent, far past its €0.01 target: green, with the orange stripes
    expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/past target/);
    expect(screen.getAllByTestId(/^plan-subject-bar-.*-stripes$/)).toHaveLength(1);
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
    fireEvent.click(screen.getByTestId('plan-oneoff-chip-spent'));
    fireEvent.click(screen.getByTestId('plan-oneoff-save'));
    await screen.findByTestId(`plan-unplanned-oneoff-${mainId}`);
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
    // the list closes as the summary opens, then leaves
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
    // carried unfunded: the new period gives it its money afresh
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
    // the past is not offered; the trip ahead is
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
    // the save is blocked while the budget holds it
    fireEvent.click(screen.getByTestId('plan-editor-save'));
    expect(screen.getAllByTestId('plan-editor-blocker').some((el) => /another subject/.test(el.textContent ?? ''))).toBe(true);
    expect(screen.getByTestId('plan-editor')).toBeTruthy();
    // freed in place: the budget leaves the plan and the subject saves
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
