// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DecimalInput } from '@/ui/DecimalInput';

describe('DecimalInput', () => {
  afterEach(cleanup);

  it('is a text field that asks for the decimal keypad, so no browser rule stands between the comma and the page', () => {
    render(<DecimalInput data-testid="field" value="" onValue={() => {}} />);
    const field = screen.getByTestId('field') as HTMLInputElement;
    expect(field.type).toBe('text');
    expect(field.inputMode).toBe('decimal');
  });

  it('hands over a comma and a dot alike, and nothing a number field would have refused', () => {
    const onValue = vi.fn();
    render(<DecimalInput data-testid="field" value="" onValue={onValue} />);
    const field = screen.getByTestId('field');
    fireEvent.change(field, { target: { value: '7,5' } });
    fireEvent.change(field, { target: { value: '7.5' } });
    fireEvent.change(field, { target: { value: '12 euro' } });
    expect(onValue.mock.calls.map(([text]) => text)).toEqual(['7,5', '7.5', '12']);
  });
});
