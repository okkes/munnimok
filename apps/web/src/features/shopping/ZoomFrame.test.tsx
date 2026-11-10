// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ZoomFrame } from './ZoomFrame';

describe('the zoom frame’s mouse drag (#568)', () => {
  afterEach(cleanup);

  const mount = (): HTMLElement => {
    render(
      <LangProvider>
        <ZoomFrame testId="zoom" status="1 page">
          {() => <div />}
        </ZoomFrame>
      </LangProvider>,
    );
    return screen.getByTestId('zoom-frame');
  };

  it('keeps hold of the mouse, so a button let go beyond the frame still ends the drag', () => {
    const frame = mount();
    const capture = vi.spyOn(frame, 'setPointerCapture');
    fireEvent.pointerDown(frame, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 150, clientY: 150 });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(frame, { pointerId: 7, pointerType: 'mouse', clientX: 110, clientY: 120 });
    expect(frame.dataset.dragging).toBe('1');

    // the hold is lost without a release ever arriving: the drag is over all the same
    fireEvent.lostPointerCapture(frame, { pointerId: 7 });
    expect(frame.dataset.dragging).toBeUndefined();
    const left = frame.scrollLeft;
    fireEvent.pointerMove(frame, { pointerId: 7, pointerType: 'mouse', clientX: 40, clientY: 40 });
    expect(frame.dataset.dragging).toBeUndefined();
    expect(frame.scrollLeft).toBe(left);
  });

  it('leaves a finger alone: one finger scrolls the frame natively', () => {
    const frame = mount();
    const capture = vi.spyOn(frame, 'setPointerCapture');
    fireEvent.pointerDown(frame, { pointerId: 3, pointerType: 'touch', clientX: 150, clientY: 150 });
    expect(capture).not.toHaveBeenCalled();
  });
});
