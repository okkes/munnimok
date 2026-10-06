import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAPPY, JOBS, renderLab, scriptFetch, TRACE } from '../../test/harness';
import type { TraceEntry } from '../../types';
import { entriesLine } from './JobScreen';
import { pascalOf, scaffoldQuery } from './TraceScreen';
import { clock, entryLine, filterEntries, hostOf, isNoise, kb, pathOf, pretty } from './traceFacts';

describe('Trace', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
    vi.stubGlobal('confirm', vi.fn((_message?: string) => true));
    // the download helper clicks a blob anchor; happy-dom would follow it and leave the screen
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a recording opens: the noise is folded, the filters narrow it, an entry opens, the jar is listed, the digest downloads, delete returns to the job', async () => {
    const calls = scriptFetch({ ...HAPPY(), 'DELETE /lab/jobs/job_lab1/trace': () => ({ status: 204 }) });
    renderLab('#/jobs/job_lab1/trace');
    expect((await screen.findByTestId('trace-title')).textContent).toContain('mock-store-simple');
    expect(screen.getByTestId('trace-facts').textContent).toContain('12 (2 scripts, pictures and fonts)');
    expect(screen.getByTestId('trace-facts').textContent).toContain('Secrets were taken out');

    // the script's request and answer are folded away by default
    expect(screen.queryByTestId('trace-entry-5')).toBeNull();
    expect(screen.getByTestId('trace-count').textContent).toBe('10 of 12');
    fireEvent.click(screen.getByTestId('trace-filter-noise'));
    expect(screen.getByTestId('trace-count').textContent).toBe('12 of 12');
    expect(screen.getByTestId('trace-entry-5')).toBeTruthy();

    fireEvent.change(screen.getByTestId('trace-filter-kind'), { target: { value: 'response' } });
    expect(screen.getByTestId('trace-count').textContent).toBe('4 of 12');
    fireEvent.change(screen.getByTestId('trace-filter-text'), { target: { value: 'api/session' } });
    expect(screen.getByTestId('trace-count').textContent).toBe('1 of 12');

    fireEvent.click(screen.getByTestId('trace-entry-8'));
    expect(screen.getByTestId('trace-body-8').textContent).toContain('"orders"');
    expect(screen.getByTestId('trace-entry-8').textContent).toContain('200');
    fireEvent.click(screen.getByTestId('trace-entry-8'));
    expect(screen.queryByTestId('trace-detail-8')).toBeNull();

    expect(screen.getByTestId('trace-cookie-sid').textContent).toContain('sha256 abcdef012345');
    expect(screen.getByTestId('trace-cookie-sid').textContent).toContain('httpOnly secure sameSite=Lax');

    fireEvent.click(screen.getByTestId('trace-digest'));
    await waitFor(() => expect(calls).toContain('GET /lab/jobs/job_lab1/trace/digest.md'));
    fireEvent.click(screen.getByTestId('trace-json'));

    fireEvent.click(screen.getByTestId('trace-delete'));
    await waitFor(() => expect(calls).toContain('DELETE /lab/jobs/job_lab1/trace'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/jobs/job_lab1'));
  });

  it('a job names its recording, the history says so, and a run without one says that too', async () => {
    scriptFetch(HAPPY());
    renderLab('#/jobs/job_lab1');
    expect((await screen.findByTestId('job-trace')).textContent).toContain('12');
    expect(screen.getByTestId('job-trace').textContent).toContain('4.0 KB packed');
    fireEvent.click(screen.getByTestId('job-trace-open'));
    expect(globalThis.location.hash).toBe('#/jobs/job_lab1/trace');
    cleanup();

    scriptFetch(HAPPY());
    renderLab('#/jobs');
    expect((await screen.findByTestId('job-job_lab1')).textContent).toContain('recording');
    cleanup();

    scriptFetch({ ...HAPPY(), 'GET /lab/jobs/job_failed1/trace': () => ({ status: 404 }) });
    renderLab('#/jobs/job_failed1/trace');
    expect((await screen.findByTestId('trace-missing')).textContent).toContain('No recording');
    cleanup();

    scriptFetch({ ...HAPPY(), 'GET /lab/jobs/job_failed1/trace': () => ({ status: 503 }) });
    renderLab('#/jobs/job_failed1/trace');
    expect((await screen.findByTestId('trace-missing')).textContent).toContain('did not answer');
  });

  it('the scaffold card asks the relay for the zip with the names given and says when it is refused', async () => {
    const calls = scriptFetch({
      ...HAPPY(),
      'GET /lab/jobs/job_lab1/scaffold': (_init, url) => (url?.searchParams.get('name') === 'Refused' ? { status: 400 } : { raw: 'PK', contentType: 'application/zip' }),
    });
    renderLab('#/jobs/job_lab1/trace');
    await screen.findByTestId('trace-scaffold');
    // a recorded run of a known party pre-fills its id and name
    expect((screen.getByTestId('scaffold-provider') as HTMLInputElement).value).toBe('mock-store-simple');
    expect((screen.getByTestId('scaffold-name') as HTMLInputElement).value).toBe('MockStoreSimple');
    fireEvent.change(screen.getByTestId('scaffold-product'), { target: { value: 'bank' } });
    fireEvent.click(screen.getByTestId('scaffold-download'));
    await waitFor(() => expect(calls).toContain('GET /lab/jobs/job_lab1/scaffold'));
    await waitFor(() => expect(screen.getByTestId('scaffold-download').textContent).toBe('download the scaffold'));
    expect(screen.queryByTestId('scaffold-error')).toBeNull();

    fireEvent.change(screen.getByTestId('scaffold-name'), { target: { value: 'Refused' } });
    fireEvent.click(screen.getByTestId('scaffold-download'));
    expect((await screen.findByTestId('scaffold-error')).textContent).toBe('HTTP 400');

    fireEvent.change(screen.getByTestId('scaffold-provider'), { target: { value: 'Not Kebab' } });
    expect((screen.getByTestId('scaffold-download') as HTMLButtonElement).disabled).toBe(true);

    expect(pascalOf('example-shop')).toBe('ExampleShop');
    expect(pascalOf('asn-persistent')).toBe('AsnPersistent');
    expect(scaffoldQuery('example-shop', 'ExampleShop', 'shop', 'NL')).toBe('?provider=example-shop&name=ExampleShop&product=shop&country=NL');
    expect(scaffoldQuery('Example', 'ExampleShop', 'shop', 'NL')).toBeNull();
    expect(scaffoldQuery('example', 'example', 'shop', 'NL')).toBeNull();
    expect(scaffoldQuery('example', 'Example', 'shop', 'nl')).toBeNull();
  });

  it('the helpers: the clock, sizes, hosts and paths, the noise rule, the filters, the line, the pretty body', () => {
    expect(clock(0)).toBe('00:00.0');
    expect(clock(61_250)).toBe('01:01.2');
    expect(kb(null)).toBe('');
    expect(kb(512)).toBe('512 B');
    expect(kb(2048)).toBe('2.0 KB');
    expect(kb(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(hostOf('https://shop.test/a?b=1')).toBe('shop.test');
    expect(hostOf('nope')).toBe('nope');
    expect(hostOf(null)).toBe('');
    expect(pathOf('https://shop.test/a?b=1')).toBe('/a?b=1');
    expect(pathOf('nope')).toBe('nope');

    const entries = TRACE.entries as TraceEntry[];
    expect(isNoise(entries[4])).toBe(true);
    expect(isNoise(entries[7])).toBe(false);
    expect(isNoise({ kind: 'response', via: 'http', resourceType: 'http' })).toBe(false);
    expect(filterEntries(entries, { kind: '', text: '', worthReading: true })).toHaveLength(10);
    expect(filterEntries(entries, { kind: 'console', text: '', worthReading: false })).toHaveLength(1);
    expect(filterEntries(entries, { kind: '', text: 'TOKEN', worthReading: false })).toHaveLength(1);

    expect(entryLine(entries[1])).toBe('→ https://shop.test/login');
    expect(entryLine(entries[2])).toBe('GET https://shop.test/login');
    expect(entryLine(entries[3])).toBe('200 GET https://shop.test/login');
    expect(entryLine(entries[8])).toBe('[error] Uncaught TypeError: x is undefined');
    expect(entryLine(entries[9])).toBe('document sha256:orders-v9 https://shop.test/orders');
    expect(entryLine(entries[11])).toBe('the run ended');

    expect(pretty('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(pretty('<html>')).toBe('<html>');
    expect(pretty(null)).toBe('');

    const summary = JOBS.jobs[2].trace!;
    expect(entriesLine(summary)).toBe('12');
    expect(entriesLine({ ...summary, truncated: true, dropped: 7 })).toBe('12 (7 dropped — the book ran out of room)');
  });
});
