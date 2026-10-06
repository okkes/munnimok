import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAPPY, JOBS, renderLab, scriptFetch } from '../../test/harness';
import { artifactsLine, jobsQuery, outcomeLine, triggerWord, whoLine } from './jobFacts';

describe('Jobs', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists every run with who asked, how it ended and what it left behind; a filter rewrites the hash and the list follows', async () => {
    const calls = scriptFetch(HAPPY());
    renderLab('#/jobs');
    const table = await screen.findByTestId('jobs-table');
    const ids = [...table.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-testid'));
    expect(ids).toEqual(['job-job_failed1', 'job-job_pending1', 'job-job_lab1']);
    expect(screen.getByTestId('job-job_failed1').textContent).toContain('Bob');
    expect(screen.getByTestId('job-job_failed1').textContent).toContain('the schedule');
    expect(screen.getByTestId('job-job_failed1').textContent).toContain('provider_changed');
    expect(screen.getByTestId('job-job_failed1').textContent).toContain('picture');
    expect(screen.getByTestId('job-job_pending1').textContent).toContain('awaiting the person');
    expect(screen.getByTestId('job-job_lab1').textContent).toContain('the lab');
    expect(screen.getByTestId('job-state-job_lab1').textContent).toBe('succeeded');

    fireEvent.change(screen.getByTestId('jobs-filter-provider'), { target: { value: 'ah' } });
    fireEvent.change(screen.getByTestId('jobs-filter-state'), { target: { value: 'failed' } });
    await waitFor(() => expect(globalThis.location.hash).toBe('#/jobs?provider=ah&state=failed'));
    await waitFor(() => expect(calls.some((c) => c === 'GET /lab/jobs')).toBe(true));
  });

  it('a run opens in full: the facts, the error, the notes, the request, and a shared picture', async () => {
    scriptFetch(HAPPY());
    renderLab('#/jobs/job_failed1');
    expect((await screen.findByTestId('job-title')).textContent).toContain('fetch · receipts');
    expect(screen.getByTestId('job-state').textContent).toBe('failed');
    expect(screen.getByTestId('job-facts').textContent).toContain('Bob');
    expect(screen.getByTestId('job-facts').textContent).toContain('the schedule');
    expect(screen.getByTestId('job-error').textContent).toContain('provider_changed');
    expect(screen.getByTestId('job-error').textContent).toContain('neither an order nor an empty-history notice');
    expect(screen.getByTestId('job-notes').textContent).toContain('no cards found');
    expect(screen.getByTestId('job-request').textContent).toContain('"since": "2026-09-01"');
    expect(screen.getByTestId('job-artifacts').textContent).toContain('sha256:orders-v9');
    // the picture is fetched with the lab's credentials where the browser can show a blob; happy-dom cannot, and says so
    await waitFor(() => expect(screen.queryByTestId('job-screenshot') ?? screen.queryByTestId('job-screenshot-loading')).toBeTruthy());
  });

  it('a pending picture is named as waiting on the person, and nothing of it is shown', async () => {
    scriptFetch(HAPPY());
    renderLab('#/jobs/job_pending1');
    await screen.findByTestId('job-artifacts-pending');
    expect(screen.getByTestId('job-artifacts').textContent).toContain('waits on the person');
    expect(screen.queryByTestId('job-screenshot')).toBeNull();
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/jobs/job_nobody': () => ({ status: 404 }) });
    renderLab('#/jobs/job_nobody');
    expect((await screen.findByTestId('job-missing')).textContent).toContain('No run named');
  });

  it('the helpers: who, the trigger, what was left behind, the query', () => {
    expect(whoLine(JOBS.jobs[2])).toBe('the lab');
    expect(whoLine({ who: null, subject: 'u_x', trigger: 'canary' })).toBe('the canary');
    expect(whoLine({ who: null, subject: 'u_x', trigger: 'user' })).toBe('u_x');
    expect(triggerWord(null)).toBe('nobody in particular');
    expect(triggerWord('schedule')).toBe('the schedule');
    expect(artifactsLine({ artifacts: 'retained', hasScreenshot: false })).toBe('digest');
    expect(artifactsLine({ artifacts: 'none', hasScreenshot: false })).toBe('');
    expect(outcomeLine(JOBS.jobs[0])).toBe('provider_changed');
    expect(outcomeLine(JOBS.jobs[2])).toBe('3 found');
    expect(outcomeLine({ state: 'succeeded', complete: false, notes: [] } as never)).toBe('partial');
    expect(outcomeLine({ state: 'running', complete: true } as never)).toBe('');
    expect(jobsQuery({ provider: ' ah ', state: '', code: 'provider_changed' })).toBe('?provider=ah&code=provider_changed');
    expect(jobsQuery({ provider: '' })).toBe('');
  });
});
