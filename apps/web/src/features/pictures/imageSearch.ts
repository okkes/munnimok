import { apiFetch } from '@/lib/api';

/** one picture a web search found: its address in the search service's own image store */
export interface ImageHit {
  thumbnail: string;
  title: string;
  source: string;
  width: number | null;
  height: number | null;
}

/** ok; paused = the month's searches are used up; limited = this person's for today; unavailable = no answer to give */
export type ImageSearchState = 'ok' | 'paused' | 'limited' | 'unavailable';

export interface ImageSearchReply {
  state: ImageSearchState;
  results: ImageHit[];
  /** paused and limited: when the search is back (ISO) */
  until: string | null;
}

const UNAVAILABLE: ImageSearchReply = { state: 'unavailable', results: [], until: null };

/** #521: one search through the API — it holds the key and counts; anything that is no answer reads as unavailable */
export async function searchImages(query: string): Promise<ImageSearchReply> {
  const res = await apiFetch(`/images/search?q=${encodeURIComponent(query)}`).catch(() => null);
  if (!res?.ok) return UNAVAILABLE;
  return (await res.json()) as ImageSearchReply;
}

/** the picked picture as a file — the API fetches it from the search service's store, so it comes in like an upload */
export async function fetchPickedImage(hit: Pick<ImageHit, 'thumbnail'>): Promise<File | null> {
  const res = await apiFetch(`/images/picked?u=${encodeURIComponent(hit.thumbnail)}`).catch(() => null);
  if (!res?.ok) return null;
  const blob = await res.blob();
  const type = blob.type || 'image/png';
  return new File([blob], `picture.${type.split('/')[1] ?? 'png'}`, { type });
}

/** the way out while the search is paused: the same words in Google Images, in the browser */
export const googleImagesUrl = (query: string): string => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
