// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionRow } from '@/db/types';
import { renderWithData } from '@/test/harness';
import { TxPartRow } from './TxPartRow';
import { TxRow } from './TxRow';

const tx = (partial: Partial<TransactionRow>): TransactionRow =>
  ({
    id: 't1',
    spaceId: 'demo_space',
    accountId: 'demo_main',
    date: '2026-07-01',
    amountCents: -1250,
    currency: 'EUR',
    merchant: 'Albert Heijn',
    catId: 'groceries',
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    fieldVersions: {},
    ...partial,
  }) as TransactionRow;

describe('TxRow', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('renders merchant, category name and negative amount', async () => {
    renderWithData(<TxRow tx={tx({})} />);
    expect((await screen.findByTestId('tx-row-t1')).textContent).toContain('Albert Heijn');
    // #653: filed under its main's Other, the row reads as the main
    expect(screen.getByTestId('tx-row-t1').textContent).toContain('Groceries');
    expect(screen.getByTestId('tx-row-t1').textContent).not.toContain('Other');
    expect(screen.getByTestId('tx-row-t1').textContent).toContain('-€12.50');
  });

  it('cleans bank <br> noise and shows the review badge', async () => {
    renderWithData(<TxRow tx={tx({ merchant: 'Incasso<br>ING', needsReview: 1 })} />);
    const row = await screen.findByTestId('tx-row-t1');
    expect(row.textContent).toContain('Incasso · ING');
    expect(row.textContent).not.toContain('<br>');
    expect(row.textContent).toContain('Unreviewed');
  });

  it('positive amounts render with an explicit plus', async () => {
    renderWithData(<TxRow tx={tx({ amountCents: 2000, catId: 'salary'})} />);
    expect((await screen.findByTestId('tx-row-t1')).textContent).toContain('+€20.00');
  });

  it('a row partly paid back wears its own category, not the mixed mark; an open reimbursement entry keeps it mixed (user ss 2026-10-05)', async () => {
    renderWithData(
      <TxRow tx={tx({ amountCents: -6000, catId: 'restaurants', cats: [{ catId: 'reimbursed', amountCents: 3000 }, { catId: 'restaurants', amountCents: 3000 }] })} />,
    );
    const row = await screen.findByTestId('tx-row-t1');
    expect(row.textContent).toContain('Dining out');
    expect(row.textContent).not.toContain('Multiple categories');
    cleanup();
    // settled + still-expected money + a dinner: the expectation is a real opinion, so the face stays mixed
    renderWithData(
      <TxRow
        tx={tx({
          id: 't2',
          amountCents: -6000,
          catId: 'restaurants',
          cats: [{ catId: 'reimbursed', amountCents: 2000 }, { catId: 'expenseReimburse', amountCents: 2000 }, { catId: 'restaurants', amountCents: 2000 }],
        })}
      />,
    );
    expect((await screen.findByTestId('tx-row-t2')).textContent).toContain('Multiple categories');
    cleanup();
    renderWithData(<TxRow tx={tx({ id: 't3', amountCents: 5000, catId: 'reimbursed', cats: [{ catId: 'reimbursed', amountCents: 5000 }] })} />);
    expect((await screen.findByTestId('tx-row-t3')).textContent).toContain('Reimbursed');
  });

  it('unknown categories fall back to Uncategorized', async () => {
    renderWithData(<TxRow tx={tx({ catId: 'deleted-custom-cat' })} />);
    expect((await screen.findByTestId('tx-row-t1')).textContent).toContain('Uncategorized');
  });

  it('propagates clicks', async () => {
    const onClick = vi.fn();
    renderWithData(<TxRow tx={tx({})} onClick={onClick} />);
    fireEvent.click(await screen.findByTestId('tx-row-t1'));
    expect(onClick).toHaveBeenCalled();
  });

  it('the open row of a desktop list is marked as the current one', async () => {
    renderWithData(
      <>
        <TxRow tx={tx({ id: 'open' })} selected edge="first" />
        <TxRow tx={tx({ id: 'other' })} />
      </>,
    );
    expect((await screen.findByTestId('tx-row-open')).getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('tx-row-other').getAttribute('aria-current')).toBeNull();
  });

  const long = 'OPENAI *CHATGPT SUBSCRIPTION HTTPSOPENAI.COMBILLINGREFERENCE1234567890';

  it('#506: a long title is never cut short — it wraps, a code without spaces included, and the amount keeps to the first line', async () => {
    renderWithData(<TxRow tx={tx({ merchant: long })} accountName="ING creditcard" />);
    const title = await screen.findByTestId('txrow-title-t1');
    expect(title.textContent).toBe(long);
    expect(title.className).toContain('wrap-anywhere');
    expect(title.className).not.toMatch(/truncate|text-ellipsis|whitespace-nowrap|line-clamp/);
    // the row grows from its top: icon and amount stay beside the first line
    const row = screen.getByTestId('tx-row-t1');
    expect(row.className).toContain('items-start');
    expect(row.lastElementChild!.className).toContain('min-h-10');
  });

  it('#506: a split part standing alone wraps its long label the same way', async () => {
    renderWithData(<TxPartRow tx={tx({ merchant: long })} part={{ id: 'p1', catId: 'groceries', amountCents: 500 }} index={0} amountText="€5.00" />);
    const title = await screen.findByTestId('tx-part-solo-title-t1-0');
    expect(title.textContent).toContain(long);
    expect(title.className).toContain('wrap-anywhere');
    expect(title.className).not.toMatch(/truncate|text-ellipsis|whitespace-nowrap/);
    expect(screen.getByTestId('tx-part-solo-t1-0').className).toContain('items-start');
  });
});
