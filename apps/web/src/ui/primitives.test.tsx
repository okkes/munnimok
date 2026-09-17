// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppBar, IconButton } from './AppBar';
import { Button } from './Button';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Chip, Field, HeroCard, Pill, ProgressBar, Row, Tile } from './primitives';
import { MasterDetailLayout } from './SplitPane';
// harness registers RTL cleanup between tests
import '@/test/harness';

// the layout reads its detail from the router — stub the two hooks so
// the primitive can be exercised without mounting a real route tree
const routerStub = vi.hoisted(() => ({ childMatches: [] as unknown[] }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useChildMatches: () => routerStub.childMatches,
  Outlet: () => <div data-testid="pane-detail" />,
}));

describe('Button', () => {
  it('renders its label as a real button, forwards clicks, and a disabled one is inert', () => {
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick}>Go</Button>
        <Button onClick={onClick} disabled data-testid="b">
          Save
        </Button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    const btn = screen.getByTestId('b') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
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
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });
});

describe('Icon', () => {
  it('renders the named glyph as decoration and falls back to a generic glyph for an empty name', () => {
    const { container } = render(
      <>
        <Icon name="bank" />
        <Icon name="" />
      </>,
    );
    const [named, fallback] = [...container.querySelectorAll('i')];
    expect(named.className).toContain('mdi-bank');
    expect(named.getAttribute('aria-hidden')).toBe('true');
    expect(fallback.className).toContain('mdi-help-circle-outline');
  });
});

describe('Logo', () => {
  it('renders the wordmark with the accent dot', () => {
    const { container } = render(<Logo size={40} />);
    expect(container.textContent).toBe('munni.');
  });
});

describe('redesign primitives', () => {
  it('Tile shows its icon, or richer content when given', () => {
    const { container } = render(
      <>
        <Tile icon="bank" />
        <Tile icon="bank">
          <img alt="Acme" src="/brands/acme.svg" />
        </Tile>
      </>,
    );
    const tiles = [...container.querySelectorAll('span')].filter((s) => s.querySelector('i, img'));
    expect(tiles[0].querySelector('i')?.className).toContain('mdi-bank');
    expect(tiles[1].querySelector('img')?.getAttribute('alt')).toBe('Acme');
    expect(tiles[1].querySelector('i')).toBeNull(); // the content replaces the icon
  });

  it('Row: a nav row is a button with a chevron affordance; a data row is inert and shows its record', () => {
    const onClick = vi.fn();
    const { container } = render(
      <>
        <Row title="Budgets" icon="wallet-outline" onClick={onClick} testId="nav-row" />
        <Row kind="data" title="Receipt" sub="12 items" trailing={<span>€3</span>} testId="data-row" />
      </>,
    );
    const nav = screen.getByTestId('nav-row');
    expect(nav.tagName).toBe('BUTTON');
    expect(nav.querySelector('.mdi-chevron-right')).toBeTruthy();
    fireEvent.click(nav);
    expect(onClick).toHaveBeenCalled();
    const data = screen.getByTestId('data-row');
    expect(data.tagName).toBe('DIV'); // no onClick -> not a button
    expect(data.querySelector('.mdi-chevron-right')).toBeNull();
    expect(container.textContent).toContain('12 items');
    expect(container.textContent).toContain('€3');
  });

  it('Pill shows its label; Chip exposes its selected state and a disabled chip is inert', () => {
    const onClick = vi.fn();
    render(
      <>
        <Pill tone="warning" testId="pill">
          Unreviewed
        </Pill>
        <Chip selected onClick={onClick} testId="chip-on">
          Monthly
        </Chip>
        <Chip selected={false} onClick={onClick} testId="chip-off">
          Weekly
        </Chip>
        <Chip selected={false} onClick={onClick} disabled testId="chip-dead">
          Off
        </Chip>
      </>,
    );
    expect(screen.getByTestId('pill').textContent).toBe('Unreviewed');
    expect(screen.getByTestId('chip-on').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('chip-off').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('chip-on'));
    expect(onClick).toHaveBeenCalledTimes(1);
    const dead = screen.getByTestId('chip-dead') as HTMLButtonElement;
    expect(dead.disabled).toBe(true);
    fireEvent.click(dead);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ProgressBar clamps its value into 0–100, exposes it, and takes an overlay', () => {
    render(
      <>
        <ProgressBar value={1.4} size="sm" testId="bar" overlay={<div data-testid="stripes" />} />
        <ProgressBar value={-1} size="lg" color="red" testId="bar2" />
        <ProgressBar value={0.5} testId="bar3" />
      </>,
    );
    const bar = screen.getByTestId('bar');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByTestId('stripes')).toBeTruthy();
    expect(screen.getByTestId('bar2').getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByTestId('bar3').getAttribute('aria-valuenow')).toBe('50');
  });

  it('Field labels its control — the label reaches the input', () => {
    render(
      <Field label="Name" htmlFor="f">
        <input id="f" />
      </Field>,
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).id).toBe('f');
  });

  it('MasterDetailLayout: detail replaces the list below lg, panes beside it at lg', () => {
    // no detail child: the list owns the screen (any viewport)
    routerStub.childMatches = [];
    const { unmount } = render(<MasterDetailLayout list={<div data-testid="pane-list" />} />);
    expect(screen.queryByTestId('split-pane')).toBeNull();
    expect(screen.getByTestId('pane-list')).toBeTruthy();
    expect(screen.queryByTestId('pane-detail')).toBeNull();
    unmount();

    // happy-dom reports a non-lg viewport: a matched detail fills the screen
    routerStub.childMatches = [{}];
    const second = render(<MasterDetailLayout list={<div data-testid="pane-list" />} />);
    expect(screen.queryByTestId('split-pane')).toBeNull();
    expect(screen.queryByTestId('pane-list')).toBeNull();
    expect(screen.getByTestId('pane-detail')).toBeTruthy();
    second.unmount();

    const original = window.matchMedia;
    window.matchMedia = (() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(<MasterDetailLayout list={<div data-testid="pane-list" />} />);
      expect(screen.getByTestId('split-pane')).toBeTruthy();
      expect(screen.getByTestId('pane-list')).toBeTruthy();
      expect(screen.getByTestId('pane-detail')).toBeTruthy();
    } finally {
      window.matchMedia = original;
    }
  });

  it('HeroCard lays out tile, number, progress and meta', () => {
    render(
      <HeroCard
        testId="hero"
        tile={<Tile icon="flag-outline" size={48} />}
        title="Emergency fund"
        titleBadge={<Pill tone="accent">On track</Pill>}
        sub="Savings"
        number="€1,200"
        progress={<ProgressBar value={0.5} testId="hero-bar" />}
        meta={<span>next €100 · Aug</span>}
      />,
    );
    const hero = screen.getByTestId('hero');
    expect(hero.textContent).toContain('Emergency fund');
    expect(hero.textContent).toContain('On track');
    expect(hero.textContent).toContain('€1,200');
    expect(screen.getByTestId('hero-bar')).toBeTruthy();
    expect(hero.textContent).toContain('next €100');
  });
});
