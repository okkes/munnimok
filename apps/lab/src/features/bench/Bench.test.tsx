import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BENCH_SESSIONS, CATALOGUE, HAPPY, JOBS, renderLab, scriptFetch } from '../../test/harness';
import { cellText, columnsOf, encodeTaps, paramsBody } from './benchFacts';
import { parseSize } from './LiveView';

const RECEIPTS = [
  { id: 'rcp_1', externalId: 'A1', merchant: 'Mock store', purchasedAt: '2026-09-30T10:00:00Z', total: { amount: '12.50', currency: 'EUR' }, items: [{ name: 'x' }] },
  { id: 'rcp_2', externalId: 'A2', merchant: 'Mock store', purchasedAt: '2026-10-01T10:00:00Z', total: { amount: '3.00', currency: 'EUR' }, items: [] },
];

describe('Bench', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
    vi.stubGlobal('confirm', vi.fn((_message?: string) => true));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the lab sessions with their state and bundle, and opens the connect screen for a picked party', async () => {
    scriptFetch(HAPPY());
    renderLab('#/bench');
    const table = await screen.findByTestId('bench-sessions');
    expect([...table.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-testid'))).toEqual(['bench-session-ses_lab1', 'bench-session-ses_lab2']);
    expect(screen.getByTestId('bench-session-ses_lab1').textContent).toContain('Mock store');
    expect(screen.getByTestId('bench-session-ses_lab1').textContent).toContain('kept');
    expect(screen.getByTestId('bench-state-ses_lab2').textContent).toBe('needs_reauth');
    expect(screen.getByTestId('bench-session-ses_lab2').textContent).toContain('session_expired');
    fireEvent.change(screen.getByTestId('bench-party'), { target: { value: 'ah' } });
    fireEvent.click(screen.getByTestId('bench-connect'));
    expect(globalThis.location.hash).toBe('#/bench/connect/ah');
  });

  it('the connect screen renders the manifest form, posts the sign-in with the agent choice, answers a code, and lands on the session', async () => {
    const posted: unknown[] = [];
    let state = 'awaiting_input';
    const view = () => ({
      sessionId: 'ses_new',
      state,
      progress: { step: state === 'active' ? 'done' : 'logging_in', stepsDone: ['queued'] },
      challenge: state === 'awaiting_input' ? { id: 'chl_1', type: 'mfa_code', delivery: 'sms', length: 6, expiresAt: '2026-10-06T12:00:00Z' } : null,
      notes: ['the password form appeared'],
    });
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/mock-store-simple/login': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        return { status: 202, body: view() };
      },
      'POST /lab/bench/mock-store-simple/login/ses_new/answer': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        state = 'active';
        return { body: view() };
      },
      'GET /lab/bench/mock-store-simple/login/ses_new': () => ({ body: view() }),
    });
    renderLab('#/bench/connect/mock-store-simple');
    expect((await screen.findByTestId('bench-connect-title')).textContent).toContain('Connect to Mock store');
    const start = screen.getByTestId('bench-start') as HTMLButtonElement;
    expect(start.disabled).toBe(true); // the required fields are empty
    fireEvent.change(screen.getByTestId('bench-input-username'), { target: { value: 'shopper' } });
    fireEvent.change(screen.getByTestId('bench-input-password'), { target: { value: 'hunter2' } });
    fireEvent.change(screen.getByTestId('bench-label'), { target: { value: 'a bench run' } });
    fireEvent.change(screen.getByTestId('bench-run-on'), { target: { value: 'agt_fleet1' } });
    fireEvent.click(start);

    await screen.findByTestId('bench-challenge-mfa_code');
    expect(posted[0]).toMatchObject({ inputs: { username: 'shopper', password: 'hunter2' }, label: 'a bench run', preferAgent: 'agt_fleet1' });
    expect(screen.getByTestId('bench-run').textContent).toContain('the password form appeared');
    fireEvent.change(screen.getByTestId('bench-answer'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('bench-answer-send'));
    await screen.findByTestId('bench-open-session');
    expect(posted[1]).toEqual({ challengeId: 'chl_1', value: '123456' });
    expect(screen.getByTestId('bench-run-state').textContent).toBe('active');
    fireEvent.click(screen.getByTestId('bench-open-session'));
    expect(globalThis.location.hash).toBe('#/bench/sessions/ses_new');
  });

  it('a picture to tap encodes the taps as the control plane reads them; a choice and a page to open answer too', async () => {
    const answers: string[] = [];
    let challenge: Record<string, unknown> = { id: 'chl_img', type: 'image', answerKind: 'taps', imageUrl: '/x', expiresAt: '2026-10-06T12:00:00Z' };
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/mock-store-simple/login': () => ({ status: 202, body: { sessionId: 'ses_img', state: 'awaiting_input', challenge } }),
      'GET /lab/bench/mock-store-simple/login/ses_img/challenges/chl_img/image': () => ({ raw: 'png-bytes', contentType: 'image/png' }),
      'POST /lab/bench/mock-store-simple/login/ses_img/answer': (init) => {
        answers.push((JSON.parse(String(init?.body)) as { value: string }).value);
        challenge = answers.length === 1 ? { id: 'chl_opt', type: 'select_option', options: [{ value: 'a', label: 'Account A' }], expiresAt: '2026-10-06T12:00:00Z' } : { id: 'chl_red', type: 'redirect', url: 'https://party.example/approve', expiresAt: '2026-10-06T12:00:00Z' };
        return { body: { sessionId: 'ses_img', state: answers.length < 3 ? 'awaiting_input' : 'active', challenge: answers.length < 3 ? challenge : null } };
      },
      'GET /lab/bench/mock-store-simple/login/ses_img': () => ({ body: { sessionId: 'ses_img', state: 'awaiting_input', challenge } }),
    });
    renderLab('#/bench/connect/mock-store-simple');
    fireEvent.change(await screen.findByTestId('bench-input-username'), { target: { value: 'u' } });
    fireEvent.change(screen.getByTestId('bench-input-password'), { target: { value: 'p' } });
    fireEvent.click(screen.getByTestId('bench-start'));
    const image = await screen.findByTestId('bench-taps-image');
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(image, { clientX: 50, clientY: 25 });
    expect(screen.getByTestId('bench-taps-count').textContent).toContain('1 tap');
    fireEvent.click(screen.getByTestId('bench-taps-submit'));
    await screen.findByTestId('bench-challenge-select_option');
    expect(answers[0]).toBe('tap.v1:0.2500,0.2500;submit');
    fireEvent.click(screen.getByTestId('bench-option-a'));
    await screen.findByTestId('bench-challenge-redirect');
    expect(answers[1]).toBe('a');
    expect(screen.getByTestId('bench-redirect-url').getAttribute('href')).toBe('https://party.example/approve');
    fireEvent.change(screen.getByTestId('bench-answer'), { target: { value: 'munni://back?code=1' } });
    fireEvent.click(screen.getByTestId('bench-answer-send'));
    await screen.findByTestId('bench-open-session');
    expect(answers[2]).toBe('munni://back?code=1');
  });

  it('a session fetches a resource with its params and shows the records; a run that became a job is followed to its page', async () => {
    const bodies: unknown[] = [];
    let polls = 0;
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/sessions/ses_lab1/fetch': (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1
          ? { body: { accepted: false, resource: 'receipts', data: RECEIPTS, complete: true, notes: ['read 2 receipts'] } }
          : { status: 202, body: { accepted: true, jobId: 'job_f', state: 'queued' } };
      },
      'GET /lab/bench/mock-store-simple/jobs/job_f': () => {
        polls += 1;
        return polls < 2 ? { body: { jobId: 'job_f', sessionId: 'ses_lab1', state: 'running', progress: { step: 'fetching', stepsDone: [] }, complete: false } } : { body: { jobId: 'job_f', sessionId: 'ses_lab1', state: 'succeeded', resource: 'receipts', data: [RECEIPTS[0]], complete: false, notes: [] } };
      },
    });
    renderLab('#/bench/sessions/ses_lab1');
    expect((await screen.findByTestId('bench-session-title')).textContent).toBe('Mock store');
    expect(screen.getByTestId('bench-session-state').textContent).toBe('active');
    fireEvent.click(screen.getByTestId('bench-fetch'));
    const records = await screen.findByTestId('bench-records');
    expect(records.textContent).toContain('2 record(s)');
    expect(records.textContent).toContain('complete');
    const table = screen.getByTestId('bench-records-table');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.textContent).toContain('12.50 EUR');
    expect(bodies[0]).toEqual({ resource: 'receipts', params: {} });

    // the second fetch outruns the window: followed through the job until its page lands
    fireEvent.click(screen.getByTestId('bench-fetch'));
    await waitFor(() => expect(screen.getByTestId('bench-records').textContent).toContain('1 record(s)'), { timeout: 8000 });
    expect(screen.getByTestId('bench-records').textContent).toContain('the party holds more');
    expect(screen.getByTestId('bench-records').textContent).toContain('job job_f');
  }, 15_000);

  it('a session becomes the canary (after a confirm) and a disconnect forgets it', async () => {
    const calls: string[] = [];
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/sessions/ses_lab1/canary': (init) => {
        calls.push(`canary ${String(init?.body)}`);
        return { body: { providerId: 'mock-store-simple', resource: 'receipts', intervalMinutes: 120 } };
      },
      'DELETE /lab/bench/sessions/ses_lab1': () => {
        calls.push('disconnect');
        return { body: { loggedOut: true } };
      },
    });
    renderLab('#/bench/sessions/ses_lab1');
    await screen.findByTestId('bench-session-title');
    fireEvent.change(screen.getByTestId('bench-canary-interval'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('bench-make-canary'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/canaries'));
    expect(calls[0]).toBe('canary {"resource":"receipts","intervalMinutes":120}');

    cleanup();
    renderLab('#/bench/sessions/ses_lab1');
    await screen.findByTestId('bench-session-title');
    fireEvent.click(screen.getByTestId('bench-disconnect'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/bench'));
    expect(calls).toContain('disconnect');
  });

  it('the live view polls frames past the last sequence and sends what the operator does as input batches', async () => {
    const inputs: unknown[] = [];
    let frames = 0;
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/ah/login': () => ({
        status: 202,
        body: { sessionId: 'ses_live', state: 'awaiting_input', challenge: { id: 'chl_live', type: 'live_view', expiresAt: '2026-10-06T12:00:00Z' } },
      }),
      'GET /lab/bench/ah/login/ses_live/challenges/chl_live/live/frame': (_init, url) => {
        frames += 1;
        if (frames > 1) return { status: 204 };
        expect(url?.searchParams.get('after')).toBe('0');
        return { raw: 'jpeg-bytes', contentType: 'image/jpeg' };
      },
      'POST /lab/bench/ah/login/ses_live/challenges/chl_live/live/input': (init) => {
        inputs.push(JSON.parse(String(init?.body)));
        return { status: 202 };
      },
      'GET /lab/bench/ah/login/ses_live': () => ({ body: { sessionId: 'ses_live', state: 'awaiting_input', challenge: { id: 'chl_live', type: 'live_view', expiresAt: '2026-10-06T12:00:00Z' } } }),
    });
    renderLab('#/bench/connect/ah');
    fireEvent.click(await screen.findByTestId('bench-start')); // ah types nothing: the party signs in on its own page
    const surface = await screen.findByTestId('bench-live-surface');
    await screen.findByTestId('bench-live-frame');
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 600, right: 300, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(surface, { clientX: 150, clientY: 300 });
    fireEvent.pointerUp(surface, { clientX: 150, clientY: 300 });
    fireEvent.change(screen.getByTestId('bench-live-text'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByTestId('bench-live-text'), { key: 'Enter' });
    await waitFor(() => expect(inputs.length).toBeGreaterThan(0), { timeout: 3000 });
    const events = (inputs[0] as { events: { kind: string; x?: number; y?: number; text?: string; key?: string }[] }).events;
    expect(events[0]).toMatchObject({ kind: 'down', x: 0.5, y: 0.5, sequence: 1 });
    expect(events[1]).toMatchObject({ kind: 'up', x: 0.5, y: 0.5 });
    expect(events.some((e) => e.kind === 'text' && e.text === 'hello')).toBe(true);
    expect(events.some((e) => e.kind === 'key' && e.key === 'Enter')).toBe(true);
  });

  it('the helpers: params, columns, cells, taps, the frame size', () => {
    const specs = [
      { key: 'since', type: 'date', required: true },
      { key: 'include', type: 'enum', multi: true, values: ['items', 'invoice'] },
      { key: 'accounts', type: 'text' },
    ];
    expect(paramsBody(specs, { since: ' 2026-01-01 ', include: ['items'], accounts: '' })).toEqual({ since: '2026-01-01', include: ['items'] });
    expect(paramsBody(specs, { include: [] })).toEqual({});
    expect(columnsOf(RECEIPTS)).toEqual(['externalId', 'id', 'merchant', 'purchasedAt', 'total', 'items']);
    expect(cellText({ amount: '3.00', currency: 'EUR' })).toBe('3.00 EUR');
    expect(cellText(null)).toBe('');
    expect(cellText('x'.repeat(100))).toBe(`${'x'.repeat(77)}…`);
    expect(cellText([{ a: 1 }])).toBe('[{"a":1}]');
    expect(encodeTaps([])).toBe('tap.v1:');
    expect(encodeTaps([{ x: 1.2, y: -0.1 }])).toBe('tap.v1:1.0000,0.0000;submit');
    expect(parseSize(null)).toEqual({ width: 390, height: 844 });
    expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(BENCH_SESSIONS).toHaveLength(2);
  });
});

describe('Bench — the edges', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
    vi.stubGlobal('confirm', vi.fn((_message?: string) => true));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('an empty bench, an environment without connectors, and a dead control plane each say so', async () => {
    scriptFetch({ ...HAPPY(), 'GET /lab/bench/sessions': () => ({ body: [] }) });
    renderLab('#/bench');
    expect((await screen.findByTestId('bench-sessions')).textContent).toContain('No lab sessions yet');
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/bench/sessions': () => ({ status: 404 }) });
    renderLab('#/bench');
    await screen.findByTestId('lab-absent');
    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/bench/sessions': () => ({ status: 503 }) });
    renderLab('#/bench');
    await screen.findByTestId('lab-status-unreachable');
  });

  it('a party the control plane does not have, a refused sign-in, a cancel and a try-again', async () => {
    scriptFetch({ ...HAPPY(), 'GET /lab/providers/nope': () => ({ status: 404 }) });
    renderLab('#/bench/connect/nope');
    await screen.findByTestId('bench-connect-missing');
    cleanup();

    let attempts = 0;
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/mock-store-simple/login': () => {
        attempts += 1;
        return attempts === 1
          ? { status: 503, body: { error: { code: 'provider_unavailable', detailId: 'd1' } } }
          : { status: 202, body: { sessionId: 'ses_c', state: 'running', progress: { step: 'queued', stepsDone: [], ahead: 2 } } };
      },
      'POST /lab/bench/mock-store-simple/login/ses_c/cancel': () => ({ body: { sessionId: 'ses_c', state: 'failed', error: { code: 'invalid_request', userAction: 'none', retriable: false }, artifactsJobId: 'job_x' } }),
    });
    renderLab('#/bench/connect/mock-store-simple');
    fireEvent.change(await screen.findByTestId('bench-input-username'), { target: { value: 'u' } });
    fireEvent.change(screen.getByTestId('bench-input-password'), { target: { value: 'p' } });
    fireEvent.click(screen.getByTestId('bench-start'));
    expect((await screen.findByTestId('bench-connect-error')).textContent).toContain('provider_unavailable (d1)');
    fireEvent.click(screen.getByTestId('bench-start'));
    await screen.findByTestId('bench-run');
    expect(screen.getByTestId('bench-run').textContent).toContain('2 ahead in the queue');
    fireEvent.click(screen.getByTestId('bench-cancel'));
    expect((await screen.findByTestId('bench-run-error')).textContent).toContain('invalid_request');
    expect(screen.getByTestId('bench-run-error').textContent).toContain('picture of the page');
    fireEvent.click(screen.getByTestId('bench-again'));
    await screen.findByTestId('bench-connect-form');
  });

  it('a code to approve and a picture to type into are answered; a run read afresh lands on connected', async () => {
    let step = 0;
    const views = [
      { sessionId: 'ses_a', state: 'awaiting_input', challenge: { id: 'c1', type: 'code_display', code: 'AB-12', expiresAt: '2026-10-06T12:00:00Z' } },
      { sessionId: 'ses_a', state: 'awaiting_input', challenge: { id: 'c2', type: 'image', answerKind: 'text', imageUrl: '/x', expiresAt: '2026-10-06T12:00:00Z' } },
      { sessionId: 'ses_a', state: 'running', progress: { step: 'logging_in', stepsDone: [] } },
      { sessionId: 'ses_a', state: 'active', providerAccount: { displayName: 'Shopper' } },
    ];
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/mock-store-simple/login': () => ({ status: 202, body: views[0] }),
      'GET /lab/bench/mock-store-simple/login/ses_a/challenges/c2/image': () => ({ raw: 'png', contentType: 'image/png' }),
      'POST /lab/bench/mock-store-simple/login/ses_a/answer': () => {
        step += 1;
        return { body: views[step] };
      },
      'GET /lab/bench/mock-store-simple/login/ses_a': () => ({ body: views[3] }),
    });
    renderLab('#/bench/connect/mock-store-simple');
    fireEvent.change(await screen.findByTestId('bench-input-username'), { target: { value: 'u' } });
    fireEvent.change(screen.getByTestId('bench-input-password'), { target: { value: 'p' } });
    fireEvent.click(screen.getByTestId('bench-start'));
    expect((await screen.findByTestId('bench-challenge-code')).textContent).toBe('AB-12');
    fireEvent.click(screen.getByTestId('bench-approved'));
    await screen.findByTestId('bench-challenge-image');
    fireEvent.change(screen.getByTestId('bench-answer'), { target: { value: 'MOCK1' } });
    fireEvent.click(screen.getByTestId('bench-answer-send'));
    // running now: the poll reads the run afresh and finds it connected
    await screen.findByTestId('bench-open-session', {}, { timeout: 4000 });
    expect(screen.getByTestId('bench-run').textContent).toContain('Shopper');
  }, 10_000);

  it('a session page takes the manifest params (a date, a pick, a multi pick); a job that asks is answered and a failing one says why', async () => {
    const bank = { ...CATALOGUE.providers[2], resources: [{ id: 'transactions', returns: 'transaction', params: [{ key: 'since', type: 'date', required: true }, { key: 'accounts', type: 'enum', multi: true, values: ['current', 'savings'] }, { key: 'kind', type: 'enum', values: ['booked', 'pending'] }] }] };
    const bodies: unknown[] = [];
    let polls = 0;
    scriptFetch({
      ...HAPPY(),
      'GET /lab/bench/sessions': () => ({ body: [{ ...BENCH_SESSIONS[0], sessionId: 'ses_bank', provider: 'mock-bank-consent' }] }),
      'GET /lab/providers/mock-bank-consent': () => ({ body: bank }),
      'POST /lab/bench/sessions/ses_bank/fetch': (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? { status: 400, body: { error: { code: 'invalid_request' } } } : { status: 202, body: { accepted: true, jobId: 'job_b', state: 'queued' } };
      },
      'GET /lab/bench/mock-bank-consent/jobs/job_b': () => {
        polls += 1;
        if (polls === 1) return { body: { jobId: 'job_b', sessionId: 'ses_bank', state: 'awaiting_input', progress: { step: 'fetching', stepsDone: [] }, challenge: { id: 'cj', type: 'mfa_code', delivery: 'app', expiresAt: '2026-10-06T12:00:00Z' }, complete: false } };
        return { body: { jobId: 'job_b', sessionId: 'ses_bank', state: 'failed', error: { code: 'provider_changed', userAction: 'none', retriable: false }, complete: false } };
      },
      'POST /lab/bench/mock-bank-consent/jobs/job_b/answer': (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return { body: { jobId: 'job_b', sessionId: 'ses_bank', state: 'running', complete: false } };
      },
    });
    renderLab('#/bench/sessions/ses_bank?resource=transactions');
    await screen.findByTestId('bench-session-title');
    fireEvent.change(screen.getByTestId('bench-param-since'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getByTestId('bench-param-accounts-savings'));
    fireEvent.click(screen.getByTestId('bench-param-accounts-current'));
    fireEvent.click(screen.getByTestId('bench-param-accounts-savings'));
    fireEvent.change(screen.getByTestId('bench-param-kind'), { target: { value: 'booked' } });
    fireEvent.click(screen.getByTestId('bench-fetch'));
    expect((await screen.findByTestId('bench-fetch-error')).textContent).toContain('invalid_request');
    expect(bodies[0]).toEqual({ resource: 'transactions', params: { since: '2026-09-01', accounts: ['current'], kind: 'booked' } });

    fireEvent.click(screen.getByTestId('bench-fetch'));
    await screen.findByTestId('bench-job-answer', {}, { timeout: 4000 });
    expect(screen.getByTestId('bench-fetch-job').textContent).toContain('mfa_code (app)');
    fireEvent.change(screen.getByTestId('bench-job-answer'), { target: { value: '000111' } });
    fireEvent.click(screen.getByTestId('bench-job-answer-send'));
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]).toEqual({ challengeId: 'cj', value: '000111' });
    expect((await screen.findByTestId('bench-fetch-error', {}, { timeout: 6000 })).textContent).toContain('provider_changed (none)');
  }, 15_000);

  it('a session that is gone says so', async () => {
    scriptFetch(HAPPY());
    renderLab('#/bench/sessions/ses_gone');
    expect((await screen.findByTestId('bench-session-missing')).textContent).toContain('ses_gone');
  });

  it('the live view retries a dead poll, ends when the platform says the view is over, and sends the key buttons', async () => {
    let frames = 0;
    let ended = 0;
    const inputs: unknown[] = [];
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/ah/login': () => ({ status: 202, body: { sessionId: 'ses_l2', state: 'awaiting_input', challenge: { id: 'cl', type: 'live_view', expiresAt: '2026-10-06T12:00:00Z' } } }),
      'GET /lab/bench/ah/login/ses_l2/challenges/cl/live/frame': () => {
        frames += 1;
        if (frames === 1) return { status: 500 };
        if (frames === 2) return { raw: 'jpeg', contentType: 'image/jpeg' };
        return { status: 410 };
      },
      'POST /lab/bench/ah/login/ses_l2/challenges/cl/live/input': (init) => {
        inputs.push(JSON.parse(String(init?.body)));
        return { status: 410 };
      },
      'GET /lab/bench/ah/login/ses_l2': () => {
        ended += 1;
        return { body: { sessionId: 'ses_l2', state: 'active' } };
      },
    });
    renderLab('#/bench/connect/ah');
    fireEvent.click(await screen.findByTestId('bench-start'));
    await screen.findByTestId('bench-live-surface');
    fireEvent.click(screen.getByTestId('bench-live-key-Backspace'));
    fireEvent.change(screen.getByTestId('bench-live-text'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('bench-live-send'));
    await waitFor(() => expect(inputs.length).toBeGreaterThan(0), { timeout: 3000 });
    // the view is over: the run is read afresh and found connected
    await screen.findByTestId('bench-open-session', {}, { timeout: 6000 });
    expect(ended).toBeGreaterThan(0);
  }, 12_000);

  it('the helpers once more: a boolean cell, a param left out', () => {
    expect(cellText(true)).toBe('true');
    expect(paramsBody([{ key: 'a', type: 'text' }], {})).toEqual({});
  });
});

describe('Bench — explore and record', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
    vi.stubGlobal('confirm', vi.fn((_message?: string) => true));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the bench opens an explore run at a typed address; the view takes an address, back and reload; done ends it and the recording opens', async () => {
    const bodies: Record<string, unknown>[] = [];
    const inputs: { kind: string; url?: string }[] = [];
    const answers: string[] = [];
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/explore': (init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return { status: 202, body: { sessionId: 'ses_x', state: 'awaiting_input', challenge: { id: 'cx', type: 'live_view', promptKey: 'lab.explore.drive', expiresAt: '2026-10-06T12:30:00Z' } } };
      },
      'GET /lab/bench/explore/login/ses_x/challenges/cx/live/frame': () => ({ raw: 'jpeg', contentType: 'image/jpeg' }),
      'POST /lab/bench/explore/login/ses_x/challenges/cx/live/input': (init) => {
        inputs.push(...((JSON.parse(String(init?.body)) as { events: { kind: string; url?: string }[] }).events));
        return { status: 202 };
      },
      'POST /lab/bench/explore/login/ses_x/answer': (init) => {
        answers.push((JSON.parse(String(init?.body)) as { value: string }).value);
        return { body: { sessionId: 'ses_x', state: 'active' } };
      },
      'GET /lab/jobs': () => ({ body: { jobs: [JOBS.jobs[2]], truncated: false } }),
    });
    renderLab('#/bench');
    const box = await screen.findByTestId('bench-explore-url');
    expect((screen.getByTestId('bench-explore-go') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'https://www.example.com/' } });
    fireEvent.click(screen.getByTestId('bench-explore-go'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/bench/connect/explore?url=https%3A%2F%2Fwww.example.com%2F'));

    expect((await screen.findByTestId('bench-connect-title')).textContent).toBe('Explore a site');
    expect(screen.getByTestId('bench-explore-hint').textContent).toContain('recorded');
    expect((screen.getByTestId('bench-input-url') as HTMLInputElement).value).toBe('https://www.example.com/');
    expect(screen.queryByTestId('bench-record')).toBeNull();
    fireEvent.click(screen.getByTestId('bench-start'));

    await screen.findByTestId('bench-live-nav');
    expect(bodies[0]).toEqual({ url: 'https://www.example.com/' });
    fireEvent.change(screen.getByTestId('bench-live-address'), { target: { value: 'https://www.example.com/orders' } });
    fireEvent.click(screen.getByTestId('bench-live-go'));
    fireEvent.click(screen.getByTestId('bench-live-back'));
    fireEvent.click(screen.getByTestId('bench-live-reload'));
    await waitFor(() => expect(inputs.map((e) => e.kind)).toEqual(['navigate', 'back', 'reload']), { timeout: 3000 });
    expect(inputs[0].url).toBe('https://www.example.com/orders');

    fireEvent.click(screen.getByTestId('bench-explore-done'));
    await waitFor(() => expect(answers).toEqual(['done']));
    await screen.findByTestId('bench-open-recording', {}, { timeout: 4000 });
    expect(screen.queryByTestId('bench-open-session')).toBeNull();
    fireEvent.click(screen.getByTestId('bench-open-recording'));
    expect(globalThis.location.hash).toBe('#/jobs/job_lab1/trace');
  }, 12_000);

  it('a sign-in and a fetch carry the record flag only when it is switched on', async () => {
    const logins: Record<string, unknown>[] = [];
    const fetches: Record<string, unknown>[] = [];
    scriptFetch({
      ...HAPPY(),
      'POST /lab/bench/mock-store-simple/login': (init) => {
        logins.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return { body: { sessionId: 'ses_r', state: 'active' } };
      },
      'POST /lab/bench/sessions/ses_lab1/fetch': (init) => {
        fetches.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return { body: { accepted: false, resource: 'receipts', data: [], complete: true } };
      },
    });
    renderLab('#/bench/connect/mock-store-simple');
    fireEvent.change(await screen.findByTestId('bench-input-username'), { target: { value: 'u' } });
    fireEvent.change(screen.getByTestId('bench-input-password'), { target: { value: 'p' } });
    expect(screen.getByTestId('bench-record').textContent).toBe('not recorded');
    fireEvent.click(screen.getByTestId('bench-record'));
    expect(screen.getByTestId('bench-record').textContent).toBe('recording this run');
    fireEvent.click(screen.getByTestId('bench-start'));
    await screen.findByTestId('bench-run');
    expect(logins[0].record).toBe(true);
    cleanup();

    renderLab('#/bench/sessions/ses_lab1');
    await screen.findByTestId('bench-session-title');
    fireEvent.click(screen.getByTestId('bench-fetch'));
    await waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0].record).toBeUndefined();
    fireEvent.click(screen.getByTestId('bench-fetch-record'));
    fireEvent.click(screen.getByTestId('bench-fetch'));
    await waitFor(() => expect(fetches).toHaveLength(2));
    expect(fetches[1].record).toBe(true);
  });
});
