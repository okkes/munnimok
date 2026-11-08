// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import type { LiveInputEvent } from './types';

/** an API without the pushed stream: what the poll path is for */
const noStream = () => Promise.reject(Object.assign(new Error('no such route'), { status: 404, envelope: { code: 'unsupported_resource' } }));

const mocks = vi.hoisted(() => ({
  liveInput: vi.fn((_provider: string, _session: string, _challenge: string, _events: LiveInputEvent[]) => Promise.resolve()),
  liveFrame: vi.fn(async () => null),
  liveStream: vi.fn((_provider: string, _session: string, _challenge: string, _after: number, _signal: AbortSignal): Promise<Response> =>
    Promise.reject(Object.assign(new Error('no such route'), { status: 404 })),
  ),
}));
vi.mock('./api', () => ({ connectorApi: { liveFrame: mocks.liveFrame, liveInput: mocks.liveInput, liveStream: mocks.liveStream } }));

import { LiveView } from './LiveView';

const rect = (width: number, height: number): DOMRect =>
  ({ left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;

/**
 * A response whose body the test writes as it goes, the way the API pushes
 * it; `close` ends it as a dropped connection would, and an abort of the
 * view's signal ends it too.
 */
function pushedStream(signal?: AbortSignal) {
  const encoder = new TextEncoder();
  const queued: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const settle = () => {
    wake?.();
    wake = null;
  };
  signal?.addEventListener('abort', () => {
    done = true;
    settle();
  });
  const reader = {
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      while (queued.length === 0 && !done) await new Promise<void>((resolve) => (wake = resolve));
      const value = queued.shift();
      return value ? { done: false, value } : { done: true, value: undefined };
    },
    cancel: async () => {
      done = true;
      settle();
    },
  };
  return {
    response: { body: { getReader: () => reader } } as unknown as Response,
    push: (text: string) => {
      queued.push(encoder.encode(text));
      settle();
    },
    close: () => {
      done = true;
      settle();
    },
  };
}

const frameEvent = (sequence: number, width = 390, height = 844) =>
  `id: ${sequence}\nevent: frame\ndata: ${JSON.stringify({ sequence, width, height, origin: 'https://login.ah.nl', jpeg: btoa('jpeg-bytes') })}\n\n`;

describe('the streamed page (user request 2026-10-01)', () => {
  it('a tap reaches the page as one down and one up at the SAME point; the close is the way out; no prompt on a phone', async () => {
    const onClose = vi.fn();
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c" prompt="the hint" onClose={onClose} />
      </LangProvider>,
    );
    const surface = screen.getByTestId('connect-live-surface');
    surface.getBoundingClientRect = () => rect(200, 400);

    // the finger wobbles three pixels between down and up — the page gets a click, not a drag
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 200, pointerType: 'touch' });
    fireEvent.pointerUp(surface, { clientX: 103, clientY: 203, pointerType: 'touch' });
    await waitFor(() => expect(mocks.liveInput).toHaveBeenCalled());
    const events = mocks.liveInput.mock.calls[0][3];
    expect(events.map((e) => e.kind)).toEqual(['down', 'up']);
    expect(events[1].x).toBe(events[0].x);
    expect(events[1].y).toBe(events[0].y);
    expect(events[0].x).toBeCloseTo(0.5);

    expect(screen.queryByTestId('connect-live-prompt')).toBeNull();
    expect(screen.getByTestId('connect-live-waiting')).toBeTruthy();
    fireEvent.click(screen.getByTestId('connect-live-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the platform ending the stream tells the host once, and the polls stop; the frame reports its size', async () => {
    const onEnded = vi.fn();
    const onFrame = vi.fn();
    let polls = 0;
    mocks.liveFrame.mockImplementation(async () => {
      polls += 1;
      if (polls === 1) return { sequence: 7, width: 1280, height: 720, blob: new Blob([new Uint8Array([1])]) } as never;
      throw Object.assign(new Error('gone'), { status: 410, envelope: { code: 'challenge_expired' } });
    });
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c3" onEnded={onEnded} onFrame={onFrame} />
      </LangProvider>,
    );
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    expect(onFrame).toHaveBeenCalledWith({ width: 1280, height: 720 });
    const seen = polls;
    await new Promise((r) => setTimeout(r, 120));
    expect(polls).toBe(seen);
    mocks.liveFrame.mockImplementation(async () => null);
  });

  it('a real swipe keeps its two points', async () => {
    mocks.liveInput.mockClear();
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c2" />
      </LangProvider>,
    );
    const surface = screen.getByTestId('connect-live-surface');
    surface.getBoundingClientRect = () => rect(200, 400);
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 300, pointerType: 'touch' });
    fireEvent.pointerUp(surface, { clientX: 100, clientY: 100, pointerType: 'touch' });
    await waitFor(() => expect(mocks.liveInput).toHaveBeenCalled());
    const events = mocks.liveInput.mock.calls[0][3];
    expect(events[0].y).toBeCloseTo(0.75);
    expect(events[1].y).toBeCloseTo(0.25);
    expect(screen.queryByTestId('connect-live-close')).toBeNull();
  });
});

describe('the pushed stream (#429)', () => {
  afterEach(() => {
    mocks.liveStream.mockImplementation(noStream);
    mocks.liveFrame.mockImplementation(async () => null);
    mocks.liveStream.mockClear();
    mocks.liveFrame.mockClear();
  });

  it('pictures arrive on one stream, with their size and whose page they are, and nothing is polled', async () => {
    const onFrame = vi.fn();
    const stream = pushedStream();
    mocks.liveStream.mockResolvedValueOnce(stream.response);
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c-stream" onFrame={onFrame} />
      </LangProvider>,
    );

    stream.push(': keep-alive\n\n');
    stream.push(frameEvent(1, 1280, 720));
    await waitFor(() => expect(onFrame).toHaveBeenCalledWith({ width: 1280, height: 720 }));
    expect(await screen.findByTestId('connect-live-origin')).toBeTruthy();
    expect(screen.queryByTestId('connect-live-waiting')).toBeNull();
    expect(mocks.liveFrame).not.toHaveBeenCalled();
    expect(mocks.liveStream).toHaveBeenCalledTimes(1);
  });

  it('the platform ending the view on the stream tells the host once, and nothing is reopened', async () => {
    const onEnded = vi.fn();
    const stream = pushedStream();
    mocks.liveStream.mockResolvedValueOnce(stream.response);
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c-end" onEnded={onEnded} />
      </LangProvider>,
    );

    stream.push(frameEvent(3));
    stream.push('event: end\ndata: {"code":"challenge_expired"}\n\n');
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    expect(mocks.liveStream).toHaveBeenCalledTimes(1);
    expect(mocks.liveFrame).not.toHaveBeenCalled();
  });

  it('a stream that drops is reopened past the picture it drew', async () => {
    const first = pushedStream();
    const second = pushedStream();
    mocks.liveStream.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c-drop" />
      </LangProvider>,
    );

    first.push(frameEvent(5));
    await waitFor(() => expect(screen.queryByTestId('connect-live-waiting')).toBeNull());
    first.close();

    await waitFor(() => expect(mocks.liveStream).toHaveBeenCalledTimes(2));
    expect(mocks.liveStream.mock.calls[1][3]).toBe(5);
    expect(mocks.liveFrame).not.toHaveBeenCalled();
  });

  it('a view that is already over when the stream opens ends without a poll', async () => {
    const onEnded = vi.fn();
    mocks.liveStream.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 410, envelope: { code: 'challenge_expired' } }));
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c-gone" onEnded={onEnded} />
      </LangProvider>,
    );

    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    expect(mocks.liveFrame).not.toHaveBeenCalled();
  });

  it('where no stream can be held - an API without it, another viewer taking it - the poll serves the view', async () => {
    const onFrame = vi.fn();
    mocks.liveFrame.mockImplementation(async () => ({ sequence: 2, width: 390, height: 844, blob: new Blob([new Uint8Array([1])]) }) as never);
    const taken = pushedStream();
    mocks.liveStream.mockResolvedValueOnce(taken.response);
    render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c-superseded" onFrame={onFrame} />
      </LangProvider>,
    );

    taken.push('event: superseded\ndata: {}\n\n');
    await waitFor(() => expect(mocks.liveFrame).toHaveBeenCalled());
    await waitFor(() => expect(onFrame).toHaveBeenCalledWith({ width: 390, height: 844 }));
    expect(mocks.liveStream).toHaveBeenCalledTimes(1);
  });

  it('closing the view lets the stream go', async () => {
    let signal: AbortSignal | undefined;
    mocks.liveStream.mockImplementationOnce((_p, _s, _c, _a, given) => {
      signal = given;
      return Promise.resolve(pushedStream(given).response);
    });
    const view = render(
      <LangProvider>
        <LiveView provider="p" sessionId="s" challengeId="c-close" />
      </LangProvider>,
    );

    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
