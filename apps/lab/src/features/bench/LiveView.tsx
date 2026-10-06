import { useCallback, useEffect, useRef, useState } from 'react';
import type { Call } from '../../app/api';

/**
 * The live browser view, the lab's own rendering of the control plane's
 * contract (never the member app's component): the newest JPEG past the
 * last sequence, long-polled through `/lab/bench/…/live/frame?after=n`
 * with `X-Live-Sequence`, `X-Live-Size` and `X-Live-Origin`; the
 * operator's taps, moves, scrolls, text and keys batched every 80 ms to
 * `…/live/input` as fractions of the frame. The stream ends when the
 * platform says so (404/410/challenge over).
 */
const FRAME_IDLE_MS = 400;
const FRAME_RETRY_MS = 1_500;
const FLUSH_MS = 80;
const BATCH_MAX = 64;
const MOVE_GAP_MS = 40;

export type LiveInputKind = 'move' | 'down' | 'up' | 'scroll' | 'text' | 'key';

export interface LiveInputEvent {
  kind: LiveInputKind;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
  sequence: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** the relay's size header, `390x844` when it is missing */
export function parseSize(header: string | null): { width: number; height: number } {
  const [w, h] = (header ?? '390x844').split('x').map(Number);
  return { width: w > 0 ? w : 390, height: h > 0 ? h : 844 };
}

export function LiveView({
  call,
  provider,
  sessionId,
  challengeId,
  onEnded,
}: Readonly<{ call: Call; provider: string; sessionId: string; challengeId: string; onEnded?: () => void }>) {
  const base = `/lab/bench/${encodeURIComponent(provider)}/login/${encodeURIComponent(sessionId)}/challenges/${encodeURIComponent(challengeId)}/live`;
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 390, height: 844 });
  const [origin, setOrigin] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(0);
  const sequence = useRef(0);
  const inputSequence = useRef(0);
  const queue = useRef<LiveInputEvent[]>([]);
  const over = useRef(false);
  const shown = useRef<string | null>(null);
  const lastMove = useRef(0);
  const surface = useRef<HTMLDivElement | null>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  const finish = useCallback(() => {
    if (over.current) return;
    over.current = true;
    ended.current?.();
  }, []);

  // frames: one long-poll after another, each asking past the last sequence
  useEffect(() => {
    let alive = true;
    const pollOnce = async (): Promise<number> => {
      let res: Response | null;
      try {
        res = await call(`${base}/frame?after=${sequence.current}`);
      } catch {
        return FRAME_RETRY_MS;
      }
      if (!alive) return 0;
      if (res.status === 204) return FRAME_IDLE_MS;
      if (res.status === 404 || res.status === 410) {
        finish();
        return 0;
      }
      if (!res.ok) return FRAME_RETRY_MS;
      const seq = Number(res.headers.get('X-Live-Sequence') ?? sequence.current);
      const advanced = seq > sequence.current;
      sequence.current = Math.max(sequence.current, seq);
      setSize(parseSize(res.headers.get('X-Live-Size')));
      setOrigin(res.headers.get('X-Live-Origin'));
      if (typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(await res.blob());
        if (shown.current) URL.revokeObjectURL(shown.current);
        shown.current = url;
        setFrameUrl(url);
      } else {
        setFrameUrl(`frame-${seq}`);
      }
      return advanced ? 0 : FRAME_IDLE_MS;
    };
    void (async () => {
      while (alive && !over.current) {
        const wait = await pollOnce();
        if (!alive || over.current) break;
        if (wait > 0) await sleep(wait);
      }
      if (shown.current && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(shown.current);
      shown.current = null;
    })();
    return () => {
      alive = false;
    };
  }, [call, base, finish]);

  // input: whatever gathered since the last flush goes as one batch
  const flush = useCallback(() => {
    if (queue.current.length === 0 || over.current) return;
    const events = queue.current.splice(0, BATCH_MAX);
    void call(`${base}/input`, { method: 'POST', body: JSON.stringify({ events }) })
      .then((res) => {
        if (res.status === 404 || res.status === 410) finish();
        else setSent((n) => n + events.length);
      })
      .catch(() => undefined);
  }, [call, base, finish]);

  useEffect(() => {
    const timer = setInterval(flush, FLUSH_MS);
    return () => clearInterval(timer);
  }, [flush]);

  const push = (event: Omit<LiveInputEvent, 'sequence'>) => {
    inputSequence.current += 1;
    queue.current.push({ ...event, sequence: inputSequence.current });
  };

  const pointAt = (e: React.PointerEvent): { x: number; y: number } | null => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  const onPointer = (kind: 'down' | 'up' | 'move') => (e: React.PointerEvent) => {
    if (kind === 'move') {
      const now = Date.now();
      if (e.buttons === 0 || now - lastMove.current < MOVE_GAP_MS) return;
      lastMove.current = now;
    }
    const point = pointAt(e);
    if (!point) return;
    e.preventDefault();
    push({ kind, ...point });
  };

  const sendText = () => {
    if (!text) return;
    push({ kind: 'text', text: text.slice(0, 256) });
    setText('');
  };

  return (
    <div data-testid="bench-live">
      <p className="hint">
        The party&apos;s page, live from the agent&apos;s browser: tap, type and scroll as the person would. {origin ? `Origin: ${origin}.` : ''}{' '}
        <span className="sub">{sent} input event(s) sent · frame {sequence.current}</span>
      </p>
      <div
        ref={surface}
        data-testid="bench-live-surface"
        style={{ width: '100%', maxWidth: 420, aspectRatio: `${size.width} / ${size.height}`, border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--surface2, #f3f3f3)', touchAction: 'none', userSelect: 'none', position: 'relative' }}
        onPointerDown={onPointer('down')}
        onPointerUp={onPointer('up')}
        onPointerMove={onPointer('move')}
        onWheel={(e) => push({ kind: 'scroll', deltaY: e.deltaY })}
      >
        {frameUrl ? (
          <img src={frameUrl} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain' }} data-testid="bench-live-frame" />
        ) : (
          <p className="hint" data-testid="bench-live-waiting" style={{ padding: 16 }}>
            waiting for the first picture…
          </p>
        )}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          data-testid="bench-live-text"
          value={text}
          placeholder="type here, Enter sends"
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              sendText();
              push({ kind: 'key', key: 'Enter' });
            }
          }}
        />
        <button className="btn" data-testid="bench-live-send" onClick={sendText}>
          send
        </button>
        {(['Backspace', 'Tab', 'Escape'] as const).map((key) => (
          <button key={key} className="btn quiet" data-testid={`bench-live-key-${key}`} onClick={() => push({ kind: 'key', key })}>
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
