// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { frameOf, readLiveStream } from './liveStream';
import type { LiveFrame } from './types';

/** a body that hands out the given chunks, then either ends or goes quiet */
function bodyOf(chunks: string[], then: 'end' | 'quiet' = 'end'): Response {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(chunk));
  let cancelled = false;
  const reader = {
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      const value = queue.shift();
      if (value) return { done: false, value };
      if (then === 'end' || cancelled) return { done: true, value: undefined };
      return new Promise(() => undefined);
    },
    cancel: async () => {
      cancelled = true;
    },
  };
  return { body: { getReader: () => reader } } as unknown as Response;
}

const picture = (sequence: number) =>
  JSON.stringify({ sequence, width: 390, height: 844, origin: 'https://login.ah.nl', jpeg: btoa('frame-' + sequence) });

const quick = { firstByteMs: 30, idleMs: 30 };

describe('reading the pushed live view (#429)', () => {
  it('hands on every picture, whole, however the bytes were cut and whichever line ending they use', async () => {
    const frames: LiveFrame[] = [];
    const event = `id: 1\r\nevent: frame\r\ndata: ${picture(1)}\r\n\r\n`;
    const read = await readLiveStream(
      bodyOf(['retry: 1000\n\n: keep-alive\n\n', event.slice(0, 20), event.slice(20), `id: 2\nevent: frame\ndata: ${picture(2)}\n\n`]),
      (frame) => frames.push(frame),
    );

    expect(read).toEqual({ end: 'closed', heard: true });
    expect(frames.map((f) => f.sequence)).toEqual([1, 2]);
    expect(frames[0]).toMatchObject({ width: 390, height: 844, origin: 'https://login.ah.nl' });
    expect(await frames[1].blob.text()).toBe('frame-2');
  });

  it('stops on the platform word, and on another viewer taking the stream', async () => {
    expect((await readLiveStream(bodyOf(['event: end\ndata: {"code":"challenge_expired"}\n\n']), () => undefined)).end).toBe('over');
    expect((await readLiveStream(bodyOf(['event: superseded\ndata: {}\n\n']), () => undefined)).end).toBe('superseded');
  });

  it('a stream that never speaks is mute; one that spoke and went quiet is closed, to be reopened', async () => {
    expect(await readLiveStream(bodyOf([], 'quiet'), () => undefined, quick)).toEqual({ end: 'mute', heard: false });
    expect(await readLiveStream(bodyOf([': keep-alive\n\n'], 'quiet'), () => undefined, quick)).toEqual({ end: 'closed', heard: true });
    expect(await readLiveStream({ body: null } as unknown as Response, () => undefined)).toEqual({ end: 'mute', heard: false });
  });

  it('a frame that is not one is skipped, not drawn', () => {
    expect(frameOf('not json')).toBeNull();
    expect(frameOf(JSON.stringify({ sequence: 1, width: 0, height: 844, jpeg: btoa('x') }))).toBeNull();
    expect(frameOf(JSON.stringify({ sequence: 1, width: 390, height: 844, jpeg: '%%%' }))).toBeNull();
    expect(frameOf(JSON.stringify({ sequence: '1', width: 390, height: 844, jpeg: btoa('x') }))).toBeNull();
  });
});
