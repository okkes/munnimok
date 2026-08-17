// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { WebcamCaptureSheet } from './WebcamCaptureSheet';

/** happy-dom may or may not ship a mediaDevices stub — pin it per test */
const setMediaDevices = (value: unknown) => {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true });
};

const renderSheet = (onCapture = vi.fn(), onOpenChange = vi.fn()) => {
  localStorage.setItem('munni_lang', 'en');
  render(
    <LangProvider>
      <WebcamCaptureSheet open onOpenChange={onOpenChange} onCapture={onCapture} />
    </LangProvider>,
  );
  return { onCapture, onOpenChange };
};

describe('WebcamCaptureSheet', () => {
  it('shows the error note instead of crashing when mediaDevices is missing (#160)', async () => {
    setMediaDevices(undefined);
    renderSheet();
    expect(await screen.findByTestId('webcam-error')).toBeTruthy();
    expect(screen.queryByTestId('webcam-video')).toBeNull();
  });

  it('shows the error note when the camera permission is refused', async () => {
    setMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(new Error('denied'))) });
    renderSheet();
    expect(await screen.findByTestId('webcam-error')).toBeTruthy();
  });

  it('starts the front camera into the preview and stops tracks on close', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream);
    setMediaDevices({ getUserMedia });

    localStorage.setItem('munni_lang', 'en');
    const onCapture = vi.fn();
    const view = render(
      <LangProvider>
        <WebcamCaptureSheet open onOpenChange={vi.fn()} onCapture={onCapture} />
      </LangProvider>,
    );

    expect(await screen.findByTestId('webcam-video')).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'user' } });

    // happy-dom has no canvas pixels — the capture handler must stay
    // defensive: no blob, no capture, the sheet simply stays open
    fireEvent.click(screen.getByTestId('webcam-capture'));
    expect(onCapture).not.toHaveBeenCalled();

    view.unmount();
    // the stream may resolve before OR after unmount — both paths stop the tracks
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });
});
