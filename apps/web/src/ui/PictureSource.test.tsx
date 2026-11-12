// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as imageSearch from '@/features/pictures/imageSearch';
import * as api from '@/lib/api';
import * as platform from '@/lib/platform';
import { renderWithProviders } from '@/test/harness';
import { usePictureSource } from './PictureSource';

function Door({ onFile, openLibrary, hint }: Readonly<{ onFile: (file: File) => void; openLibrary: () => void; hint?: string }>) {
  const { pick, sheet } = usePictureSource(onFile, openLibrary, hint);
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

  it('#521: where the environment searches the web, a browser gets the choice too — a file or a search that starts from what the picture is for', async () => {
    vi.spyOn(api, 'getApiCapabilities').mockResolvedValue({ imageSearch: true });
    const search = vi.spyOn(imageSearch, 'searchImages').mockResolvedValue({
      state: 'ok',
      results: [{ thumbnail: 'https://imgs.search.brave.com/a.png', title: 'Netflix', source: 'netflix.com', width: 500, height: 300 }],
      until: null,
    });
    const picture = new File(['x'], 'picture.png', { type: 'image/png' });
    vi.spyOn(imageSearch, 'fetchPickedImage').mockResolvedValue(picture);
    const openLibrary = vi.fn();
    const onFile = vi.fn();
    renderWithProviders(<Door onFile={onFile} openLibrary={openLibrary} hint="Netflix logo" />);

    // the capability arrives a moment after the first render: from then on the door opens the choice
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('door'));
      expect(screen.getByTestId('picture-source-search')).toBeTruthy();
    });
    expect(screen.queryByTestId('picture-source-camera')).toBeNull();
    expect(screen.getByTestId('picture-source-library')).toBeTruthy();

    fireEvent.click(screen.getByTestId('picture-source-search'));
    const field = (await screen.findByTestId('imagesearch-query')) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('Netflix logo'));
    // nothing is searched until asked: every search is paid for
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('imagesearch-go'));
    fireEvent.click(await screen.findByTestId('imagesearch-hit-0'));
    await waitFor(() => expect(onFile).toHaveBeenCalledWith(picture));
    expect(search).toHaveBeenCalledWith('Netflix logo');
  });
});
