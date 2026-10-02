// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import type { LiveInputEvent } from './types';

const mocks = vi.hoisted(() => ({
  liveInput: vi.fn((_provider: string, _session: string, _challenge: string, _events: LiveInputEvent[]) => Promise.resolve()),
  liveFrame: vi.fn(async () => null),
}));
vi.mock('./api', () => ({ connectorApi: { liveFrame: mocks.liveFrame, liveInput: mocks.liveInput } }));

import { LiveView } from './LiveView';

const rect = (width: number, height: number): DOMRect =>
  ({ left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;

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
