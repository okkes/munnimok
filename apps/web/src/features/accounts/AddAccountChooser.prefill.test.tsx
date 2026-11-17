// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { guessCadence } from '@/features/review/ReviewScreen';

// #326: the Create door mounts the chooser itself (no props), so review stages a one-shot prefill the chooser drinks on open
describe('AddAccountChooser prefill from review (#326)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('a loan-ish card with monthly siblings prefills the Create door\'s loan form', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('loanpre'), { trackOutbox: false });
    // 2020 dates lead the oldest-first queue: duo-1 is the current card, the other two its similar siblings
    for (const [id, date] of [['duo-1', '2020-01-05'], ['duo-2', '2020-02-04'], ['duo-3', '2020-03-05']] as const) {
      await seedRepo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: 'demo_main', date, amountCents: -15000, currency: 'EUR',
        merchant: 'DUO Studiefinanciering', needsReview: 1,
      });
    }
    seed.close();
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card', undefined, { timeout: 10_000 });
    await screen.findByTestId('review-bulk', undefined, { timeout: 10_000 });

    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0', undefined, { timeout: 10_000 }));
    fireEvent.click(await screen.findByTestId('catpicker-loanRepayment', undefined, { timeout: 10_000 }));
    await screen.findByTestId('counter-accounts', undefined, { timeout: 10_000 });
    fireEvent.click(screen.getByTestId('counter-full-setup'));
    fireEvent.click(await screen.findByTestId('chooser-manual', undefined, { timeout: 10_000 }));
    fireEvent.click(await screen.findByTestId('chooser-accttype-loan', undefined, { timeout: 10_000 }));

    const name = (await screen.findByTestId('chooser-acctform-name', undefined, { timeout: 10_000 })) as HTMLInputElement;
    expect(name.value).toBe('DUO Studiefinanciering');
    expect((screen.getByTestId('chooser-acctform-payment') as HTMLInputElement).value).toBe('150.00');
    expect((screen.getByTestId('chooser-acctform-payday') as HTMLInputElement).value).toBe('5');
  }, 30_000);
});

describe('guessCadence (#326 unit)', () => {
  it('rows a near-month apart (every gap 25–35 days) guess monthly', () => {
    expect(guessCadence(['2026-01-05', '2026-02-04', '2026-03-05'])).toBe('month');
    expect(guessCadence(['2026-01-31', '2026-02-28'])).toBe('month');
  });

  it('anything else stays unguessed — a single row, weekly rhythm, or a broken one', () => {
    expect(guessCadence(['2026-01-05'])).toBeUndefined();
    expect(guessCadence([])).toBeUndefined();
    expect(guessCadence(['2026-01-05', '2026-01-12'])).toBeUndefined();
    expect(guessCadence(['2026-01-05', '2026-02-04', '2026-02-10'])).toBeUndefined();
    // same-day duplicates collapse before the gaps are measured
    expect(guessCadence(['2026-01-05', '2026-01-05', '2026-02-04'])).toBe('month');
  });
});
