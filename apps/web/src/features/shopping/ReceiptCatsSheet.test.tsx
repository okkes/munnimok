// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptItem, ReceiptPick } from '@/db/types';
import { renderWithData } from '@/test/harness';
import { ReceiptCatsSheet } from './ReceiptCatsSheet';

// the picker is its own feature (and wants a router): here it only has to hand a category back
const picker = vi.hoisted(() => ({ next: 'groceries' }));
vi.mock('@/features/categories/CategoryPicker', () => ({
  CategoryPicker: ({ open, onPick }: { open: boolean; onPick: (catId: string) => void }) =>
    open ? <button data-testid="picker-pick" onClick={() => onPick(picker.next)} /> : null,
}));

// the ticket's own receipt: four lines of 110 together, 10 off, 100 paid
const ITEMS: ReceiptItem[] = [
  { name: 'Eggs', totalCents: 3000 },
  { name: 'Ice cream', totalCents: 2500 },
  { name: 'Ben & Jerry', totalCents: 4500 },
  { name: 'Gift card', totalCents: 1000 },
  { name: 'Discount', totalCents: -1000, kind: 'discount' },
];

const text = (testId: string) => screen.getByTestId(testId).textContent ?? '';

function open(props: Partial<Parameters<typeof ReceiptCatsSheet>[0]> = {}) {
  const onApply = vi.fn<(picks: ReceiptPick[]) => void>();
  renderWithData(
    <ReceiptCatsSheet
      open
      onOpenChange={() => undefined}
      items={ITEMS}
      currency="EUR"
      netCents={10_000}
      restCatId="uncategorized"
      initial={[]}
      suggestions={new Map()}
      onApply={onApply}
      {...props}
    />,
  );
  return onApply;
}

/** #567: the transaction categorised by the lines of its receipt */
describe('categorise by receipt', () => {
  beforeEach(() => {
    localStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    picker.next = 'groceries';
  });
  afterEach(cleanup);

  it('ticked lines take a category and stand for what was paid after the discount; the count of what is left follows; apply hands the picks over', async () => {
    const onApply = open();
    await screen.findByTestId('receiptcats-sheet');
    // the discount is no line of its own: it came off the four
    expect(screen.queryByTestId('receiptcats-line-4')).toBeNull();
    expect(text('receiptcats-amount-0')).toContain('27.27');
    expect(text('receiptcats-net')).toContain('100.00');
    expect(text('receiptcats-left')).toContain('100.00');
    expect((screen.getByTestId('receiptcats-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('receiptcats-hint')).toBeTruthy();

    fireEvent.click(screen.getByTestId('receiptcats-tick-0'));
    fireEvent.click(screen.getByTestId('receiptcats-tick-1'));
    expect(text('receiptcats-categorise')).toBe('Category · 2 selected');
    fireEvent.click(screen.getByTestId('receiptcats-categorise'));
    fireEvent.click(screen.getByTestId('picker-pick'));

    expect(text('receiptcats-cat-0')).toBe('Grocery');
    expect(text('receiptcats-cat-1')).toBe('Grocery');
    expect(text('receiptcats-placed')).toContain('50.00');
    expect(text('receiptcats-left')).toContain('50.00');
    expect(text('receiptcats-rest')).toContain('Uncategorized');
    // the ticks are spent: the footer is the apply again
    fireEvent.click(screen.getByTestId('receiptcats-apply'));
    expect(onApply).toHaveBeenCalledWith([
      { line: 0, catId: 'groceries', amountCents: 2727 },
      { line: 1, catId: 'groceries', amountCents: 2273 },
    ]);
  });

  it('a line’s value is the person’s to choose — after discount, as printed, typed, or what is left — and lines never claim more than the transaction holds', async () => {
    // €100 paid, €75 paid back by friends: €25 is left to file (the ticket's example)
    open({ netCents: 2500, settledCents: 7500, initial: [{ line: 0, catId: 'groceries', amountCents: 2727 }] });
    await screen.findByTestId('receiptcats-sheet');
    expect(text('receiptcats-settled')).toMatch(/75\.00 .*paid back.*25\.00/);
    expect(screen.getByTestId('receiptcats-left').getAttribute('data-over')).toBe('true');
    expect(text('receiptcats-over')).toContain('2.27');
    expect((screen.getByTestId('receiptcats-apply') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('receiptcats-amount-0'));
    expect(text('receiptcats-fill-0')).toContain('25.00');
    fireEvent.click(screen.getByTestId('receiptcats-fill-0'));
    expect(text('receiptcats-amount-0')).toContain('25.00');
    expect(text('receiptcats-left')).toContain('0.00');
    expect(screen.queryByTestId('receiptcats-over')).toBeNull();
    expect((screen.getByTestId('receiptcats-apply') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('receiptcats-printed-0'));
    expect(text('receiptcats-amount-0')).toContain('30.00');
    expect(screen.getByTestId('receiptcats-over')).toBeTruthy();
    fireEvent.click(screen.getByTestId('receiptcats-paid-0'));
    expect(text('receiptcats-amount-0')).toContain('27.27');

    fireEvent.change(screen.getByTestId('receiptcats-typed-0'), { target: { value: '12,50' } });
    expect(text('receiptcats-amount-0')).toContain('12.50');
    expect(text('receiptcats-left')).toContain('12.50');
    // half-typed text changes nothing
    fireEvent.change(screen.getByTestId('receiptcats-typed-0'), { target: { value: 'x' } });
    expect(text('receiptcats-amount-0')).toContain('12.50');
    // the editor folds away again
    fireEvent.click(screen.getByTestId('receiptcats-amount-0'));
    expect(screen.queryByTestId('receiptcats-values-0')).toBeNull();
  });

  it('a suggestion is one tap, all of them one more; a category comes off again; every open line can be selected at once', async () => {
    const onApply = open({ suggestions: new Map([[0, 'groceries'], [2, 'sweets']]) });
    await screen.findByTestId('receiptcats-sheet');
    expect(text('receiptcats-suggest-0')).toBe('Suggested: Grocery');
    fireEvent.click(screen.getByTestId('receiptcats-suggest-0'));
    expect(text('receiptcats-cat-0')).toBe('Grocery');
    expect(text('receiptcats-suggest-all')).toBe('Use the suggestions (1)');
    fireEvent.click(screen.getByTestId('receiptcats-suggest-all'));
    expect(text('receiptcats-cat-2')).toBe('Sweets & Treats');
    expect(screen.queryByTestId('receiptcats-suggest-all')).toBeNull();

    fireEvent.click(screen.getByTestId('receiptcats-clear-0'));
    expect(screen.queryByTestId('receiptcats-cat-0')).toBeNull();
    expect(screen.getByTestId('receiptcats-suggest-0')).toBeTruthy();

    fireEvent.click(screen.getByTestId('receiptcats-select-open'));
    expect(text('receiptcats-categorise')).toBe('Category · 3 selected');
    // a tick comes off again
    fireEvent.click(screen.getByTestId('receiptcats-tick-3'));
    expect(text('receiptcats-categorise')).toBe('Category · 2 selected');
    picker.next = 'coffee';
    fireEvent.click(screen.getByTestId('receiptcats-categorise'));
    fireEvent.click(screen.getByTestId('picker-pick'));
    fireEvent.click(screen.getByTestId('receiptcats-apply'));
    expect(onApply).toHaveBeenCalledWith([
      { line: 0, catId: 'coffee', amountCents: 2727 },
      { line: 1, catId: 'coffee', amountCents: 2273 },
      { line: 2, catId: 'sweets', amountCents: 4091 },
    ]);
  });

  it('it reopens on the picks the transaction stands on; a line worth nothing is left out of them; a receipt without paid lines says so', async () => {
    const onApply = open({
      initial: [
        { line: 0, catId: 'groceries', amountCents: 1000 },
        { line: 3, catId: 'sweets', amountCents: 909 },
      ],
    });
    await screen.findByTestId('receiptcats-sheet');
    expect(text('receiptcats-amount-0')).toContain('10.00');
    expect(text('receiptcats-cat-3')).toBe('Sweets & Treats');
    expect(text('receiptcats-placed')).toContain('19.09');
    fireEvent.click(screen.getByTestId('receiptcats-amount-3'));
    fireEvent.change(screen.getByTestId('receiptcats-typed-3'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('receiptcats-apply'));
    expect(onApply).toHaveBeenCalledWith([{ line: 0, catId: 'groceries', amountCents: 1000 }]);

    cleanup();
    open({ items: [{ name: 'Discount', totalCents: -100, kind: 'discount' }] });
    expect(await screen.findByTestId('receiptcats-empty')).toBeTruthy();
    expect((screen.getByTestId('receiptcats-apply') as HTMLButtonElement).disabled).toBe(true);
  });
});
