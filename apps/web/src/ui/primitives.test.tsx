// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppBar, IconButton } from './AppBar';
import { Button } from './Button';
import { Icon } from './Icon';
import { Logo } from './Logo';
// harness registers RTL cleanup between tests
import '@/test/harness';

describe('Button', () => {
  it('renders each variant/size with the mapped classes', () => {
    render(
      <>
        <Button>Go</Button>
        <Button variant="outline" size="sm">
          Out
        </Button>
        <Button variant="ghost">Gh</Button>
        <Button variant="danger">Del</Button>
      </>,
    );
    expect(screen.getByText('Go').className).toContain('bg-brand');
    expect(screen.getByText('Go').className).toContain('h-12');
    expect(screen.getByText('Out').className).toContain('border-line');
    expect(screen.getByText('Out').className).toContain('h-9');
    expect(screen.getByText('Gh').className).toContain('bg-transparent');
    expect(screen.getByText('Del').className).toContain('bg-negative');
  });

  it('forwards native button props', () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled data-testid="b">
        Save
      </Button>,
    );
    const btn = screen.getByTestId('b') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('AppBar', () => {
  it('compact bar renders title, sub, leading and trailing', () => {
    render(<AppBar title="Accounts" sub="3 linked" leading={<span>L</span>} trailing={<span>T</span>} />);
    expect(screen.getByText('Accounts')).toBeTruthy();
    expect(screen.getByText('3 linked')).toBeTruthy();
    expect(screen.getByText('L')).toBeTruthy();
    expect(screen.getByText('T')).toBeTruthy();
  });

  it('large bar renders the title as an h1', () => {
    render(<AppBar title="Transactions" large />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Transactions');
  });
});

describe('IconButton', () => {
  it('exposes the aria label and handles clicks', () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Close" onClick={onClick} testId="ib" filled>
        x
      </IconButton>,
    );
    const btn = screen.getByLabelText('Close');
    expect(btn.getAttribute('data-testid')).toBe('ib');
    expect(btn.className).toContain('bg-surface');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Icon', () => {
  it('maps the name to an mdi class and sizes the glyph', () => {
    const { container } = render(<Icon name="bank" size={24} color="red" />);
    const i = container.querySelector('i')!;
    expect(i.className).toContain('mdi-bank');
    expect(i.style.fontSize).toBe('24px');
    expect(i.style.color).toBe('red');
  });

  it('falls back to help-circle-outline for an empty name', () => {
    const { container } = render(<Icon name="" />);
    expect(container.querySelector('i')!.className).toContain('mdi-help-circle-outline');
  });
});

describe('Logo', () => {
  it('renders the wordmark with the accent dot', () => {
    const { container } = render(<Logo size={40} />);
    expect(container.textContent).toBe('munni.');
    expect((container.firstElementChild as HTMLElement).style.fontSize).toBe('40px');
  });
});
