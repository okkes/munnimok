// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoHeight } from './AutoHeight';
// harness registers RTL cleanup between tests
import '@/test/harness';

/** a ResizeObserver the test drives: `resize(h)` reports the content at that height */
function drivenObserver() {
  let notify: (() => void) | null = null;
  let height = 0;
  class Driven {
    constructor(cb: () => void) {
      notify = cb;
    }
    observe() {
      notify?.();
    }
    disconnect() {
      notify = null;
    }
  }
  vi.stubGlobal('ResizeObserver', Driven);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
  return {
    resize(next: number) {
      height = next;
      notify?.();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AutoHeight (#540: the next card never jumps)', () => {
  it('takes its content’s height, eases to a new one while clipping, and lets go of the clip once settled', () => {
    vi.useFakeTimers();
    const observer = drivenObserver();
    observer.resize(120);
    render(
      <AutoHeight testId="auto">
        <p>content</p>
      </AutoHeight>,
    );
    const box = screen.getByTestId('auto');
    // the first measure sets the height outright — nothing to ease from
    expect(box.style.height).toBe('120px');
    expect(box.style.overflow).toBe('');
    expect(box.style.transition).toContain('height');
    observer.resize(260);
    expect(box.style.height).toBe('260px');
    expect(box.style.overflow).toBe('hidden');
    vi.advanceTimersByTime(400);
    expect(box.style.overflow).toBe('');
    // the same height again changes nothing
    observer.resize(260);
    expect(box.style.overflow).toBe('');
  });

  it('where nothing measures it is a plain box', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(
      <AutoHeight testId="plain">
        <p>content</p>
      </AutoHeight>,
    );
    expect(screen.getByTestId('plain').style.height).toBe('');
    expect(screen.getByText('content')).toBeTruthy();
  });
});
