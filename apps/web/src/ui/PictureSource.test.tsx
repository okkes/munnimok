// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platform from '@/lib/platform';
import { renderWithProviders } from '@/test/harness';
import { usePictureSource } from './PictureSource';

function Door({ onFile, openLibrary }: Readonly<{ onFile: (file: File) => void; openLibrary: () => void }>) {
  const { pick, sheet } = usePictureSource(onFile, openLibrary);
  return (
    <>
      <button data-testid="door" onClick={pick} />
      {sheet}
    </>
  );
}

/** #522: the phone apps' photo picker turned every picture into a JPEG — a see-through logo arrived on black */
describe('where a picture comes from', () => {
  afterEach(() => vi.restoreAllMocks());

  it('in a browser the door is the file input itself', () => {
    const openLibrary = vi.fn();
    renderWithProviders(<Door onFile={vi.fn()} openLibrary={openLibrary} />);
    fireEvent.click(screen.getByTestId('door'));
    expect(openLibrary).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('picture-source')).toBeNull();
  });

  it('in the phone apps "Choose a picture" opens the file input — the file as it is — and never the plugin', async () => {
    vi.spyOn(platform, 'isNativeApp').mockReturnValue(true);
    const camera = vi.spyOn(platform, 'takeNativePhoto').mockResolvedValue(null);
    const openLibrary = vi.fn();
    renderWithProviders(<Door onFile={vi.fn()} openLibrary={openLibrary} />);
    fireEvent.click(screen.getByTestId('door'));
    expect(openLibrary).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('picture-source-library'));
    expect(openLibrary).toHaveBeenCalledTimes(1);
    expect(camera).not.toHaveBeenCalled();
  });

  it('"Take a photo" still goes through the camera, and a cancelled camera hands nothing on', async () => {
    vi.spyOn(platform, 'isNativeApp').mockReturnValue(true);
    const photo = new File(['x'], 'receipt.jpeg', { type: 'image/jpeg' });
    const camera = vi.spyOn(platform, 'takeNativePhoto').mockResolvedValueOnce(photo).mockResolvedValueOnce(null);
    const onFile = vi.fn();
    renderWithProviders(<Door onFile={onFile} openLibrary={vi.fn()} />);

    fireEvent.click(screen.getByTestId('door'));
    fireEvent.click(await screen.findByTestId('picture-source-camera'));
    await waitFor(() => expect(onFile).toHaveBeenCalledWith(photo));
    expect(camera).toHaveBeenCalledWith('CAMERA');

    fireEvent.click(screen.getByTestId('door'));
    fireEvent.click(await screen.findByTestId('picture-source-camera'));
    await waitFor(() => expect(camera).toHaveBeenCalledTimes(2));
    expect(onFile).toHaveBeenCalledTimes(1);
  });
});
