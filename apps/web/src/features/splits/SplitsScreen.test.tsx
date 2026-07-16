// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

const ME = '11111111-1111-1111-1111-111111111111';
const ANNA = '22222222-2222-2222-2222-222222222222';

const DETAIL = {
  id: 'split-1',
  name: 'Barcelona',
  currency: 'EUR',
  status: 'open',
  role: 'owner',
  members: [
    { userId: ME, role: 'owner', displayName: 'Me', isMe: true },
    { userId: ANNA, role: 'member', displayName: 'Anna', isMe: false },
  ],
  entries: [
    {
      id: 'e-tapas',
      kind: 'expense',
      paidByUserId: ME,
      description: 'Tapas',
      amountCents: 3000,
      date: '2026-07-12',
      shares: [
        { userId: ME, cents: 1500 },
        { userId: ANNA, cents: 1500 },
      ],
      createdBy: ME,
    },
  ],
};

describe('Splits (SP1)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('lists splits, opens the detail, and the ledger says who owes whom', async () => {
    renderAppAsUser('/splits', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {} }),
        'GET /splits': () => [
          { id: 'split-1', name: 'Barcelona', currency: 'EUR', status: 'open', role: 'owner', memberCount: 2, entryCount: 1 },
        ],
        'GET /splits/split-1': () => DETAIL,
      },
    });

    fireEvent.click(await screen.findByTestId('split-row-split-1'));
    await screen.findByTestId('screen-split-detail');

    // balances: I paid €30, my share is €15 → +15, Anna −15
    const ledger = await screen.findByTestId('split-ledger');
    expect(ledger.textContent).toContain('+€15.00');
    expect(ledger.textContent).toContain('-€15.00');
    // and the plan spells it out
    expect(screen.getByTestId('split-transfer').textContent).toContain('Anna');
    expect(screen.getByTestId('split-transfer').textContent).toContain('€15.00');

    const entries = screen.getByTestId('split-entries');
    expect(entries.textContent).toContain('Tapas');
    expect(entries.textContent).toContain('€30.00');
  });

  it('adds a manual expense with a chosen payer and reloads', async () => {
    const posted: unknown[] = [];
    let entries = [...DETAIL.entries];
    renderAppAsUser('/splits/split-1', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {} }),
        'GET /splits/split-1': () => ({ ...DETAIL, entries }),
        'POST /splits/split-1/entries': (body) => {
          posted.push(body);
          const req = body as { id: string; description: string; amountCents: number; paidByUserId: string };
          entries = [
            ...entries,
            {
              id: req.id,
              kind: 'expense',
              paidByUserId: req.paidByUserId,
              description: req.description,
              amountCents: req.amountCents,
              date: '2026-07-16',
              shares: [
                { userId: ME, cents: req.amountCents / 2 },
                { userId: ANNA, cents: req.amountCents / 2 },
              ],
              createdBy: ME,
            },
          ];
          return { id: req.id };
        },
      },
    });

    fireEvent.click(await screen.findByTestId('split-add-entry'));
    fireEvent.change(await screen.findByTestId('split-entry-desc'), { target: { value: 'Metro' } });
    fireEvent.change(screen.getByTestId('split-entry-amount'), { target: { value: '9,00' } });
    fireEvent.click(screen.getByTestId(`split-payer-${ANNA}`)); // Anna paid
    fireEvent.click(screen.getByTestId('split-entry-save'));

    await waitFor(() => expect(screen.getByTestId('split-entries').textContent).toContain('Metro'));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ description: 'Metro', amountCents: 900, paidByUserId: ANNA, kind: 'expense' });
  });

  it('creates a split from the list and navigates into it', async () => {
    const created: unknown[] = [];
    renderAppAsUser('/splits', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {} }),
        'GET /splits': () => [],
        'POST /splits': (body) => {
          created.push(body);
          return { id: (body as { id: string }).id };
        },
      },
    });

    await screen.findByTestId('splits-empty');
    fireEvent.click(screen.getByTestId('splits-add'));
    fireEvent.change(await screen.findByTestId('split-name'), { target: { value: 'Weekend' } });
    fireEvent.click(screen.getByTestId('split-create'));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ name: 'Weekend', currency: 'EUR' });
  });
});
