// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { ImageFocusFrame } from './ImageFocusFrame';

/** a loaded 1200×400 picture in a 300×112 frame: scaled to the height, it overhangs 36px sideways */
function loadPicture(frameTestId: string) {
  const frame = screen.getByTestId(frameTestId);
  frame.getBoundingClientRect = () => ({ width: 300, height: 112, x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 112, toJSON: () => ({}) });
  const img = screen.getByTestId(`${frameTestId}-img`) as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { value: 1200, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 400, configurable: true });
  fireEvent.load(img);
  return frame;
}

describe('ImageFocusFrame (#446: drag the picture to choose what shows)', () => {
  it('renders the picture at the stored focus, owning its gesture against the sheet, with the hint', () => {
    render(<ImageFocusFrame src="data:image/jpeg;base64,ZmFrZQ==" focus={{ x: 20, y: 50 }} onFocus={() => undefined} hint="Drag" testId="frame" />);
    const frame = screen.getByTestId('frame');
    expect(frame.hasAttribute('data-sheet-own-gesture')).toBe(true);
    expect(frame.textContent).toContain('Drag');
    expect((screen.getByTestId('frame-img') as HTMLElement).style.objectPosition).toBe('20% 50%');
  });

  it('dragging the picture left reveals its right edge — the focus moves right, clamped at the edge, and never along an axis that fits', () => {
    const onFocus = vi.fn();
    render(<ImageFocusFrame src="data:image/jpeg;base64,ZmFrZQ==" focus={null} onFocus={onFocus} hint="Drag" testId="frame" />);
    const frame = loadPicture('frame');

    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 91, clientY: 50 });
    // 9px of a 36px overhang = a quarter of the range
    expect(onFocus).toHaveBeenLastCalledWith({ x: 75, y: 50 });

    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 20, clientY: 120 });
    // far past the overhang: pinned to the right edge; the vertical axis fits, so y stays
    expect(onFocus).toHaveBeenLastCalledWith({ x: 100, y: 50 });

    // a pointer that is not the dragging one is ignored, and so is a move after release
    const calls = onFocus.mock.calls.length;
    fireEvent.pointerMove(frame, { pointerId: 2, clientX: 150, clientY: 50 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 150, clientY: 50 });
    expect(onFocus.mock.calls.length).toBe(calls);
  });

  it('before the picture has loaded there is nothing to measure, so a drag changes nothing', () => {
    const onFocus = vi.fn();
    render(<ImageFocusFrame src="data:image/jpeg;base64,ZmFrZQ==" focus={null} onFocus={onFocus} hint="Drag" testId="frame" />);
    const frame = screen.getByTestId('frame');
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 60, clientY: 50 });
    expect(onFocus).not.toHaveBeenCalled();
  });
});
