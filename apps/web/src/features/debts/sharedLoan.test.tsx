// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { HlcClock } from '@/sync/hlc';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

const SPACE = 's-household';
/** what the server names: a contributor of the space, and the partner's loan feed reached only through its attachment */
const ROLES = { [SPACE]: 'contributor', 'feed-partner': 'reader' } as const;
const server = {
  spaces: [{ id: SPACE, name: 'Household', kind: 'shared' as const }],
  roles: ROLES,
  api: { 'GET /me/spaces': () => Object.keys(ROLES) },
};

/** the space's own loan next to the loan a partner connected and attached */
async function seed() {
  const db = new MunniDB(USER_TEST_DB);
  await db.meta.put({ key: 'activeSpaceId', value: SPACE });
  await db.meta.put({ key: 'spaceRoles', value: ROLES });
  const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'Household', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'loan-own', {
    name: 'Car loan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -400_000,
    interestPctYear: 5, paymentCents: 20_000, paymentEvery: 'month',
  });
  await repo.upsert('account', 'feed-partner', 'loan-duo', {
    name: 'DUO', type: 'loan', source: 'connector', currency: 'EUR', balanceCents: -600_000,
    interestPctYear: 2.5, paymentCents: 15_000, paymentEvery: 'month',
  });
  await repo.upsert('accountLink', SPACE, 'link-duo', { feedSpaceId: 'feed-partner', accountId: 'loan-duo', type: 'loan', attachedByName: 'Eukesh' });
  db.close();
}

describe('a loan another member attached to the space', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('the payoff plan leaves it as it is and says whose it is; the space’s own loan keeps its weights and Apply', async () => {
    await seed();
    renderAppAsUser('/debts/plan', server);
    await screen.findByTestId('debtplan-hero', {}, { timeout: 8000 });
    fireEvent.click(screen.getByTestId('debtplan-strategy-tsunami'));

    const theirs = await screen.findByTestId('debtplan-stress-loan-duo-3');
    expect(theirs.closest('[inert]')).not.toBeNull();
    expect(screen.getByTestId('debtplan-owner-loan-duo').textContent).toContain('Eukesh');
    expect(screen.queryByTestId('debtplan-debt-apply-loan-duo')).toBeNull();

    expect(screen.getByTestId('debtplan-stress-loan-own-3').closest('[inert]')).toBeNull();
    expect(screen.getByTestId('debtplan-debt-apply-loan-own')).toBeTruthy();
    expect(screen.queryByTestId('debtplan-owner-loan-own')).toBeNull();
  }, 20_000);

  it('its own page offers no way out and says whose it is; a payment can still be typed in the space', async () => {
    await seed();
    renderAppAsUser('/debts/loan-duo', server);
    await screen.findByTestId('debtdetail-hero', {}, { timeout: 8000 });

    expect(screen.getByTestId('debtdetail-owner-note').textContent).toContain('Eukesh');
    expect(screen.queryByTestId('debtdetail-archive')).toBeNull();
    expect(screen.getByTestId('debtdetail-add-payment')).toBeTruthy();
  }, 20_000);
});
