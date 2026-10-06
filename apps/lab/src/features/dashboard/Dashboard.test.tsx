import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAPPY, renderLab, scriptFetch } from '../../test/harness';

describe('Dashboard', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the tiles, the parties with their state, and the environment card', async () => {
    scriptFetch(HAPPY());
    renderLab('#/');
    const tiles = await screen.findByTestId('dashboard-tiles');
    expect(tiles.textContent).toContain('2 / 3'); // parties accepting work
    expect(tiles.textContent).toContain('1 / 2'); // agents online
    expect(tiles.textContent).toContain('1 · 2'); // in flight · awaiting
    expect(tiles.textContent).toContain('3'); // open streams
    // L1: the month's failures today and the people behind them, the reports to read
    expect(screen.getByTestId('dashboard-failures').textContent).toContain('3 · 2');
    expect(screen.getByTestId('dashboard-reports').textContent).toContain('1');
    expect(screen.getByTestId('dashboard-state-ah').textContent).toBe('paused');
    expect(screen.getByTestId('dashboard-state-mock-bank-consent').textContent).toBe('degraded');
    expect(screen.getByTestId('dashboard-party-ah').getAttribute('href')).toBe('#/providers/ah');
    const env = await screen.findByTestId('dashboard-environment');
    expect(env.textContent).toContain('build 640');
    expect(env.textContent).toContain('protocol 2');
    expect(env.textContent).toContain('connectors');
  });

  it('an environment without connectors says so; a dead control plane says that instead', async () => {
    scriptFetch({ ...HAPPY(), 'GET /lab/status': () => ({ status: 404 }) });
    renderLab('#/');
    expect((await screen.findByTestId('lab-absent')).textContent).toContain('runs no connectors');
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/status': () => ({ status: 503 }) });
    renderLab('#/');
    expect(await screen.findByTestId('lab-status-unreachable')).toBeTruthy();
  });
});
