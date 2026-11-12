// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderWithProviders } from '@/test/harness';
import { ImageSearchSheet } from './ImageSearchSheet';
import * as imageSearch from './imageSearch';
import type { ImageSearchReply } from './imageSearch';

const hit = (name: string) => ({ thumbnail: `https://imgs.search.brave.com/${name}.png`, title: name, source: `${name}.example`, width: 500, height: 300 });
const reply = (over: Partial<ImageSearchReply>): ImageSearchReply => ({ state: 'ok', results: [], until: null, ...over });

const show = (onPick = vi.fn(), initialQuery = 'Netflix logo') => {
  const onOpenChange = vi.fn();
  renderWithProviders(<ImageSearchSheet open onOpenChange={onOpenChange} initialQuery={initialQuery} onPick={onPick} />);
  return { onPick, onOpenChange };
};

const searchFor = (words?: string) => {
  if (words !== undefined) fireEvent.change(screen.getByTestId('imagesearch-query'), { target: { value: words } });
  fireEvent.click(screen.getByTestId('imagesearch-go'));
};

/** #521: searching the web for a picture */
describe('the web picture search', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('searches on the button with the words it was given, shows what it found with its source, and hands the picked picture on as a file', async () => {
    const search = vi.spyOn(imageSearch, 'searchImages').mockResolvedValue(reply({ results: [hit('one'), hit('two')] }));
    const file = new File(['x'], 'picture.png', { type: 'image/png' });
    const fetchPicked = vi.spyOn(imageSearch, 'fetchPickedImage').mockResolvedValue(file);
    const { onPick, onOpenChange } = show();

    await waitFor(() => expect((screen.getByTestId('imagesearch-query') as HTMLInputElement).value).toBe('Netflix logo'));
    expect(search).not.toHaveBeenCalled();
    searchFor();
    const first = await screen.findByTestId('imagesearch-hit-0');
    expect(first.querySelector('img')?.getAttribute('src')).toBe('https://imgs.search.brave.com/one.png');
    expect(screen.getByTestId('imagesearch-hit-1').getAttribute('aria-label')).toBe('two');
    expect(screen.getByTestId('imagesearch-credit').textContent).toBe('Results from Brave Search');
    expect(search).toHaveBeenCalledWith('Netflix logo');

    fireEvent.click(screen.getByTestId('imagesearch-hit-1'));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(file));
    expect(fetchPicked).toHaveBeenCalledWith(hit('two'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('one letter is no search; other words search again; a picture that does not load says so and the sheet stays', async () => {
    const search = vi.spyOn(imageSearch, 'searchImages').mockResolvedValue(reply({ results: [hit('one')] }));
    vi.spyOn(imageSearch, 'fetchPickedImage').mockResolvedValue(null);
    const { onPick, onOpenChange } = show(vi.fn(), '');

    expect((screen.getByTestId('imagesearch-go') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('imagesearch-query'), { target: { value: 'a' } });
    expect((screen.getByTestId('imagesearch-go') as HTMLButtonElement).disabled).toBe(true);
    searchFor('  spotify  ');
    await screen.findByTestId('imagesearch-hit-0');
    expect(search).toHaveBeenCalledWith('spotify');

    fireEvent.click(screen.getByTestId('imagesearch-hit-0'));
    expect(await screen.findByTestId('imagesearch-pickfailed')).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('nothing found, the month used up, today’s searches used up and no answer each say what is the matter — with Google Images as the way out where the search cannot help', async () => {
    const search = vi.spyOn(imageSearch, 'searchImages');
    show();
    await waitFor(() => expect((screen.getByTestId('imagesearch-query') as HTMLInputElement).value).toBe('Netflix logo'));

    search.mockResolvedValueOnce(reply({}));
    searchFor();
    const none = await screen.findByTestId('imagesearch-note');
    expect(none.getAttribute('data-state')).toBe('ok');
    expect(none.textContent).toContain('No pictures found');
    expect(screen.queryByTestId('imagesearch-google')).toBeNull();

    search.mockResolvedValueOnce(reply({ state: 'paused', until: '2026-12-01T13:00:00Z' }));
    searchFor('netflix');
    await waitFor(() => expect(screen.getByTestId('imagesearch-note').getAttribute('data-state')).toBe('paused'));
    expect(screen.getByTestId('imagesearch-note').textContent).toMatch(/paused until .*December.* — this month’s searches are used up/);
    const google = screen.getByTestId('imagesearch-google') as HTMLAnchorElement;
    expect(google.href).toBe('https://www.google.com/search?tbm=isch&q=netflix');
    expect(google.target).toBe('_blank');

    search.mockResolvedValueOnce(reply({ state: 'limited', until: '2026-11-13T00:00:00Z' }));
    searchFor('netflix app');
    await waitFor(() => expect(screen.getByTestId('imagesearch-note').getAttribute('data-state')).toBe('limited'));
    expect(screen.getByTestId('imagesearch-note').textContent).toContain('today’s web searches');

    search.mockResolvedValueOnce(reply({ state: 'unavailable' }));
    searchFor('netflix icon');
    await waitFor(() => expect(screen.getByTestId('imagesearch-note').getAttribute('data-state')).toBe('unavailable'));
    expect(screen.getByTestId('imagesearch-note').textContent).toContain('not available right now');
  });

  it('the API is asked for the search and for the picked picture; no answer is no result, never an error', async () => {
    const picture = new Blob(['png'], { type: 'image/png' });
    const apiFetch = vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path.startsWith('/images/search')) return new Response(JSON.stringify(reply({ results: [hit('one')] })), { status: 200 });
      if (path.includes('missing')) return new Response(null, { status: 404 });
      return new Response(picture, { status: 200, headers: { 'Content-Type': 'image/png' } });
    });
    expect((await imageSearch.searchImages('netflix logo')).results).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledWith('/images/search?q=netflix%20logo');
    const file = await imageSearch.fetchPickedImage(hit('one'));
    expect(file).toMatchObject({ name: 'picture.png', type: 'image/png' });
    expect(apiFetch).toHaveBeenLastCalledWith('/images/picked?u=https%3A%2F%2Fimgs.search.brave.com%2Fone.png');
    expect(await imageSearch.fetchPickedImage(hit('missing'))).toBeNull();

    apiFetch.mockRejectedValue(new Error('offline'));
    expect(await imageSearch.searchImages('netflix')).toEqual({ state: 'unavailable', results: [], until: null });
    expect(await imageSearch.fetchPickedImage(hit('one'))).toBeNull();
  });
});
