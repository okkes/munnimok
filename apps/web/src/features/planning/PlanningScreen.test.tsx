// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

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
    fireEvent.click(screen.getByTestId('plan-segment-fill-expenses'));
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).toMatch(/Funded/));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).not.toBe(before));
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
    // 2026-10-07 (user): a subject planned mid-period starts funded by what the
    // period already paid for it — so Food is NOT in the red yet; taking all
    // funding back puts it there
    await waitFor(() => expect(screen.getByTestId('plan-segment-expenses').textContent).not.toMatch(/Over by/));
    fireEvent.click(screen.getByTestId('plan-withdraw-all'));
    fireEvent.click(await screen.findByTestId('plan-withdraw-confirm-confirm'));
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
