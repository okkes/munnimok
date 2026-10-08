// @vitest-environment happy-dom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { AmountSuggestions } from './AmountSuggestions';

const fmt = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const items = [
  { id: 'last', label: 'Last period', cents: 12_000 },
  { id: 'avg', label: 'Average', cents: 9_500 },
];

describe('AmountSuggestions (user 2026-10-08: the chips must read as buttons, and show what a tap did)', () => {
  it('says what a tap does, lights the chip whose amount the field holds, and hands the amount over on a tap', () => {
    const onPick = vi.fn();
    renderWithProviders(<AmountSuggestions items={items} fmt={fmt} currency="EUR" testIdPrefix="chip" selectedCents={9_500} onPick={onPick} />);
    expect(screen.getByTestId('chips-hint').textContent).toBe('Tap an amount to use it');
    expect(screen.getByTestId('chip-avg').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('chip-last').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('chip-last').textContent).toContain('€120.00');
    fireEvent.click(screen.getByTestId('chip-last'));
    expect(onPick).toHaveBeenCalledWith(12_000);
  });

  it('nothing is pressed while the field holds no amount, and nothing renders without items', () => {
    renderWithProviders(<AmountSuggestions items={items} fmt={fmt} currency="EUR" testIdPrefix="chip" onPick={() => undefined} />);
    expect(screen.getByTestId('chip-avg').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('chip-last').getAttribute('aria-pressed')).toBe('false');
    cleanup();
    renderWithProviders(<AmountSuggestions items={[]} fmt={fmt} currency="EUR" testIdPrefix="chip" selectedCents={1} onPick={() => undefined} />);
    expect(screen.queryByTestId('chips')).toBeNull();
  });
});
