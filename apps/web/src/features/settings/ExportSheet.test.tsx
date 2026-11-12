// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import * as platform from '@/lib/platform';
import { renderApp, renderWithData } from '@/test/harness';
import { ExportSheet } from './ExportSheet';

/** capture the exported blob and its file name; keep URL a constructor and clicks inert */
function captureDownloads(): { blobs: Blob[]; names: string[] } {
  const blobs: Blob[] = [];
  const names: string[] = [];
  (URL as { createObjectURL?: unknown }).createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return 'blob:test';
  });
  (URL as { revokeObjectURL?: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  return { blobs, names };
}

/** a second space beside the demo one, its period starting on the 10th, and one payment the demo space is sure to hold */
async function seedSecondSpace(): Promise<void> {
  const db = new MunniDB('munni_demo');
  const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
  await repo.upsert('space', 's-two', 's-two', { name: 'Household', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 10 });
  await repo.upsert('account', 's-two', 'a-two', { name: 'Joint', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
  const payment = (merchant: string, date: string) => ({ date, amountCents: -990, currency: 'EUR', merchant, needsReview: 0 as const });
  await repo.upsert('transaction', 's-two', 'tx-early', { accountId: 'a-two', ...payment('Bakery Early', '2026-07-05') });
  await repo.upsert('transaction', 's-two', 'tx-late', { accountId: 'a-two', ...payment('Bakery Late', '2026-07-12') });
  await repo.upsert('account', 'demo_space', 'a-extra', { name: 'Extra', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
  await repo.upsert('transaction', 'demo_space', 'tx-demo', { accountId: 'a-extra', ...payment('Bakery Demo', '2026-07-03') });
  db.close();
}

async function openSheet(): Promise<void> {
  renderApp('/settings/global');
  fireEvent.click(await screen.findByTestId('settings-export-row'));
  await screen.findByTestId('export-sheet');
}

describe('ExportSheet (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads a CSV of the current space with localized categories, ids included', async () => {
    const { blobs } = captureDownloads();

    await openSheet();
    // everything, so relative demo dates can't empty the window
    fireEvent.click(screen.getByTestId('export-range-all'));
    fireEvent.click(screen.getByTestId('export-run'));

    await waitFor(() => expect(blobs).toHaveLength(1), { timeout: 5000 });
    const text = await blobs[0].text();
    const lines = text.split('\r\n');
    expect(lines[0]).toContain('date,time,account,merchant'); // EN delimiter = comma
    expect(lines[0].endsWith('tx_id,account_id,category_id,space_id')).toBe(true);
    expect(lines[1].endsWith(',demo_space')).toBe(true);
    expect(text).toContain('Albert Heijn');
    expect(text).toContain('Grocery'); // localized category name
    expect(lines.length).toBeGreaterThan(50); // the demo history came along
  }, 15_000);

  it('exports JSON; the format is not called a backup', async () => {
    const { blobs } = captureDownloads();

    await openSheet();
    fireEvent.click(screen.getByTestId('export-range-all'));
    expect(screen.getByTestId('export-format-json').textContent).toBe('JSON');
    fireEvent.click(screen.getByTestId('export-format-json'));
    fireEvent.click(screen.getByTestId('export-run'));

    await waitFor(() => expect(blobs).toHaveLength(1), { timeout: 5000 });
    const payload = JSON.parse(await blobs[0].text()) as { space: { name: string }; transactions: unknown[] }[];
    expect(payload.length).toBeGreaterThan(0);
    expect(payload[0].transactions.length).toBeGreaterThan(0);
  }, 15_000);

  it('exports the spaces that are ticked, each row naming its space (#498)', async () => {
    await seedSecondSpace();
    const { blobs } = captureDownloads();

    await openSheet();
    const demo = await screen.findByTestId('export-space-demo_space');
    const two = screen.getByTestId('export-space-s-two');
    // one space is ticked to begin with, and the last one cannot be unticked
    const [first, other] = demo.getAttribute('aria-pressed') === 'true' ? [demo, two] : [two, demo];
    expect(other.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(first);
    expect(first.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(other);
    expect(screen.getByTestId('export-scope-all').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('export-range-all'));
    fireEvent.click(screen.getByTestId('export-run'));

    await waitFor(() => expect(blobs).toHaveLength(1), { timeout: 5000 });
    const lines = (await blobs[0].text()).split('\r\n');
    expect(lines[0].startsWith('﻿space,date,')).toBe(true);
    expect(lines.some((line) => line.startsWith('Demo,') && line.includes('Bakery Demo'))).toBe(true);
    expect(lines.some((line) => line.startsWith('Household,') && line.endsWith(',s-two'))).toBe(true);
  }, 15_000);

  it('"This period" takes every space\'s own period, not the open space\'s (#498)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 15, 12));
    await seedSecondSpace();
    const { blobs, names } = captureDownloads();

    await openSheet();
    await screen.findByTestId('export-space-s-two');
    fireEvent.click(screen.getByTestId('export-scope-all'));
    fireEvent.click(screen.getByTestId('export-range-period'));
    fireEvent.click(screen.getByTestId('export-run'));

    await waitFor(() => expect(blobs).toHaveLength(1), { timeout: 5000 });
    const text = await blobs[0].text();
    // the demo space counts from the 1st, Household from the 10th
    expect(text).toContain('Bakery Demo');
    expect(text).toContain('Bakery Late');
    expect(text).not.toContain('Bakery Early');
    // two different windows: the file name cannot carry one of them
    expect(names[0]).toBe('munni-period-2026-07-15.csv');
  }, 15_000);

  it('in the phone apps a share sheet that was closed leaves the export open: nothing was saved (#498)', async () => {
    const share = vi.spyOn(platform, 'shareNativeFile').mockResolvedValue('dismissed');
    const { blobs } = captureDownloads();
    const onOpenChange = vi.fn();

    renderWithData(<ExportSheet open onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByTestId('export-range-all'));
    fireEvent.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('export-failed')).toBeNull();

    share.mockResolvedValue('failed');
    fireEvent.click(screen.getByTestId('export-run'));
    expect(await screen.findByTestId('export-failed')).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();

    share.mockResolvedValue('shared');
    fireEvent.click(screen.getByTestId('export-run'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 5000 });
    // the shells never fall back to a browser download: it does nothing there
    expect(blobs).toHaveLength(0);
  }, 15_000);
});
