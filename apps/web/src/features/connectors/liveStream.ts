import type { LiveFrame } from './types';

/**
 * The live view pushed (#429): one response from the munni API carrying
 * every picture as the agent takes it, instead of one request per frame.
 *
 *   id: 12
 *   event: frame
 *   data: {"sequence":12,"width":390,"height":844,"origin":"https://login.ah.nl","jpeg":"/9j/4AAQ…"}
 *
 * plus `: keep-alive` comments in the quiet, `event: end` when the platform
 * says the live view is over, and `event: superseded` when a newer stream of
 * the same viewer took its place. Read over fetch (EventSource cannot send
 * the bearer), which is the path /sync/events already proves in the shells.
 */

/** how a read ended: the platform's word, another viewer, a stream that never spoke, or a connection that closed */
export type LiveStreamEnd = 'over' | 'superseded' | 'mute' | 'closed';

export interface LiveStreamRead {
  end: LiveStreamEnd;
  /** anything at all arrived — a stream that worked is reopened, one that never did is not trusted */
  heard: boolean;
}

export interface LiveStreamTiming {
  /** the API writes its first line on open: silence this long is something between buffering the stream */
  firstByteMs: number;
  /** the control plane writes a keep-alive after ten quiet seconds: this long without one is a dead line */
  idleMs: number;
}

export const LIVE_STREAM_TIMING: LiveStreamTiming = { firstByteMs: 6_000, idleMs: 35_000 };

type Chunk = ReadableStreamReadResult<Uint8Array> | 'timeout';

/** one read, or 'timeout' when nothing came within `ms` */
function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<Chunk> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Chunk>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

/** a frame event's data as a picture to draw; null when it is not one */
export function frameOf(data: string): LiveFrame | null {
  try {
    const body = JSON.parse(data) as { sequence?: unknown; width?: unknown; height?: unknown; origin?: unknown; jpeg?: unknown };
    const { sequence, width, height, origin, jpeg } = body;
    if (typeof sequence !== 'number' || typeof width !== 'number' || typeof height !== 'number' || typeof jpeg !== 'string') return null;
    if (width <= 0 || height <= 0 || jpeg.length === 0) return null;
    const bytes = Uint8Array.from(atob(jpeg), (c) => c.codePointAt(0) ?? 0);
    return { sequence, width, height, origin: typeof origin === 'string' ? origin : undefined, blob: new Blob([bytes], { type: 'image/jpeg' }) };
  } catch {
    return null;
  }
}

/** the event in one block of lines: its name and its data (multi-line data joined), or null for a comment or a retry */
function eventOf(block: string): { name: string; data: string } | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  }
  return name === 'message' && data.length === 0 ? null : { name, data: data.join('\n') };
}

/**
 * Hands on every complete event in the buffer: the pictures to `onFrame`,
 * the platform's last word as `end`. What is left is the start of the next.
 */
function takeEvents(buffer: string, onFrame: (frame: LiveFrame) => void): { rest: string; end?: 'over' | 'superseded' } {
  let rest = buffer;
  for (let boundary = rest.indexOf('\n\n'); boundary !== -1; boundary = rest.indexOf('\n\n')) {
    const event = eventOf(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    if (event?.name === 'end') return { rest, end: 'over' };
    if (event?.name === 'superseded') return { rest, end: 'superseded' };
    const frame = event?.name === 'frame' ? frameOf(event.data) : null;
    if (frame) onFrame(frame);
  }
  return { rest };
}

/** one chunk, or what the wait for it amounted to: the time ran out, or the connection broke */
async function nextChunk(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<Chunk | 'broken'> {
  try {
    return await readWithin(reader, ms);
  } catch {
    return 'broken';
  }
}

/**
 * Reads the stream until it ends, handing every picture to `onFrame`.
 * Never throws: a broken connection is just a stream that closed.
 */
export async function readLiveStream(
  response: Response,
  onFrame: (frame: LiveFrame) => void,
  timing: LiveStreamTiming = LIVE_STREAM_TIMING,
): Promise<LiveStreamRead> {
  const reader = response.body?.getReader();
  if (!reader) return { end: 'mute', heard: false };
  const decoder = new TextDecoder();
  let buffer = '';
  let heard = false;
  const stop = (end: LiveStreamEnd): LiveStreamRead => {
    reader.cancel().catch(() => undefined);
    return { end, heard };
  };

  for (;;) {
    const chunk = await nextChunk(reader, heard ? timing.idleMs : timing.firstByteMs);
    if (chunk === 'broken') return stop('closed');
    if (chunk === 'timeout') return stop(heard ? 'closed' : 'mute');
    if (chunk.done) return { end: 'closed', heard };
    heard = true;

    const taken = takeEvents((buffer + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n'), onFrame);
    if (taken.end) return stop(taken.end);
    buffer = taken.rest;
  }
}
