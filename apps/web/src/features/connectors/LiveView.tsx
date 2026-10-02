import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { useLgViewport } from '@/lib/viewport';
import { IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { connectorApi } from './api';
import { fitFrame, isTap, keyboardInset, nearestScroller } from './liveLayout';
import type { LiveFrame, LiveInputEvent } from './types';

/**
 * The `live_view` challenge (§10.2): the party's own page, streamed as
 * JPEG frames from the agent's browser, with the human's taps, keys and
 * text relayed back — the clipped page rectangle, never a full viewport.
 * Frames are long-polled past the last sequence; input is batched.
 *
 * The frame takes every pixel the sheet leaves it (user request
 * 2026-10-01): the host opens the sheet at full height, the frame is
 * sized to the room that is left after the lines above it and the bar
 * below it, and an open keyboard takes its height off the frame instead
 * of pushing the frame off the screen — so the bar stays reachable and a
 * tap lands where the finger is. See liveLayout.ts.
 *
 * The stream ENDS on the platform's say-so: a poll answered "this live
 * view is over" (the adapter's success signal, or the challenge's expiry)
 * tells the host, which reads the session afresh — nobody is left watching
 * a finished page (the DUO sign-in that went nowhere, user ss 2026-10-01).
 */
const FRAME_IDLE_MS = 400;
const FRAME_RETRY_MS = 1_500;
/** the floor between two polls that both came straight back with a picture */
const MIN_POLL_GAP_MS = 60;
const FLUSH_MS = 80;
const MOVE_GAP_MS = 40;
const BATCH_MAX = 64;
/** the gaps between the head line, the frame and the bar, plus the sheet scroller's own bottom padding */
const CHROME_PX = 8 + 8 + 24;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** the platform refusing further pixels: the challenge was answered or expired, or the session moved on */
export const liveViewOver = (err: unknown): boolean => {
  const e = err as { status?: number; envelope?: { code?: string } } | null;
  if (!e || typeof e !== 'object') return false;
  return e.status === 410 || e.status === 404 || e.envelope?.code === 'challenge_expired' || e.envelope?.code === 'unsupported_resource';
};

/** what one poll came back with, and therefore how long to wait before the next */
type Poll = 'idle' | 'advanced' | 'repeat' | 'retry' | 'over';

/**
 * The pause after a poll. A picture already shown (a relay that lost the
 * sequence header) is kept at the idle pace: re-asking at once is the
 * storm that drained the whole API into 429s (user ss 2026-10-01).
 */
const pauseAfter = (outcome: Poll, elapsedMs: number): number => {
  if (outcome === 'advanced') return Math.max(0, MIN_POLL_GAP_MS - elapsedMs);
  if (outcome === 'retry') return FRAME_RETRY_MS;
  if (outcome === 'over') return 0;
  return FRAME_IDLE_MS;
};

export function LiveView({
  provider,
  sessionId,
  challengeId,
  prompt,
  onClose,
  onEnded,
  onFrame,
}: Readonly<{
  provider: string;
  sessionId: string;
  challengeId: string;
  /** the one-line explanation; shown where there is room (the desktop dialog), never on a phone */
  prompt?: string;
  /** the close affordance: a full-height sheet leaves no backdrop to tap and no handle to drag */
  onClose?: () => void;
  /** the platform ended the stream — the host reads the session again */
  onEnded?: () => void;
  /** the page's own size, so the host can give a landscape page a wider dialog */
  onFrame?: (size: { width: number; height: number }) => void;
}>) {
  const { t } = useLang();
  const desktop = useLgViewport();
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 390, height: 844 });
  const [origin, setOrigin] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const inputSequence = useRef(0);
  const queue = useRef<LiveInputEvent[]>([]);
  const lastMove = useRef(0);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const over = useRef(false);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const framed = useRef(onFrame);
  framed.current = onFrame;
  const shown = useRef<string | null>(null);

  const finish = useCallback(() => {
    if (over.current) return;
    over.current = true;
    ended.current?.();
  }, []);

  /** a newer picture on screen; false when it is the one already shown */
  const showFrame = useCallback((frame: LiveFrame): boolean => {
    const advanced = frame.sequence > sequence.current;
    sequence.current = Math.max(sequence.current, frame.sequence);
    setSize({ width: frame.width, height: frame.height });
    framed.current?.({ width: frame.width, height: frame.height });
    setOrigin(frame.origin);
    const url = URL.createObjectURL(frame.blob);
    if (shown.current) URL.revokeObjectURL(shown.current);
    shown.current = url;
    setFrameUrl(url);
    return advanced;
  }, []);

  // frames: one long-poll after another, each asking past the last sequence
  useEffect(() => {
    let alive = true;
    const pollOnce = async (): Promise<Poll> => {
      try {
        const frame = await connectorApi.liveFrame(provider, sessionId, challengeId, sequence.current);
        if (!alive) return 'over';
        if (!frame) return 'idle';
        return showFrame(frame) ? 'advanced' : 'repeat';
      } catch (err) {
        return liveViewOver(err) ? 'over' : 'retry';
      }
    };
    void (async () => {
      while (alive && !over.current) {
        const startedAt = Date.now();
        const outcome = await pollOnce();
        if (!alive) break;
        if (outcome === 'over') {
          finish();
          break;
        }
        await sleep(pauseAfter(outcome, Date.now() - startedAt));
      }
      if (shown.current) URL.revokeObjectURL(shown.current);
      shown.current = null;
    })();
    return () => {
      alive = false;
    };
  }, [provider, sessionId, challengeId, showFrame, finish]);

  // input: whatever gathered since the last flush goes as one batch
  useEffect(() => {
    const timer = setInterval(() => {
      if (queue.current.length === 0 || over.current) return;
      const batch = queue.current.splice(0, BATCH_MAX);
      void connectorApi.liveInput(provider, sessionId, challengeId, batch).catch((err: unknown) => {
        if (liveViewOver(err)) finish();
      });
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, [provider, sessionId, challengeId, finish]);

  // the frame's box: the room the scroller has, minus the head, the bar,
  // the gaps and the keyboard — remeasured whenever any of those move
  const measure = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const scroller = nearestScroller(el);
    const rootTop = el.getBoundingClientRect().top;
    const roomTop = scroller ? rootTop - scroller.getBoundingClientRect().top + scroller.scrollTop : rootTop;
    const roomH = scroller ? scroller.clientHeight : window.innerHeight;
    const availH = roomH - roomTop - (head.current?.offsetHeight ?? 0) - (bar.current?.offsetHeight ?? 0) - CHROME_PX - keyboardInset(window);
    const next = fitFrame({ availW: el.clientWidth, availH, frameW: size.width, frameH: size.height });
    setBox((prev) => (prev?.width === next?.width && prev?.height === next?.height ? prev : next));
  }, [size.width, size.height]);

  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && root.current) {
      observer = new ResizeObserver(measure);
      observer.observe(root.current);
      const scroller = nearestScroller(root.current);
      if (scroller) observer.observe(scroller);
    }
    return () => {
      window.removeEventListener('resize', measure);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, desktop]);

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
      if (e.buttons === 0 && e.pointerType !== 'mouse') return;
      const now = Date.now();
      if (now - lastMove.current < MOVE_GAP_MS) return;
      lastMove.current = now;
    }
    let point = pointAt(e);
    if (!point) return;
    // the default would move focus off the text field and close the
    // keyboard mid-tap, shifting the frame under the finger
    e.preventDefault();
    if (kind === 'down') downAt.current = point;
    // a tap is one down and one up at ONE point: the finger's wobble, or
    // the frame moving under it, must not reach the party's page as a drag
    if (kind === 'up' && downAt.current && isTap(downAt.current, point)) point = downAt.current;
    push({ kind, ...point });
  };

  const sendText = () => {
    if (!text) return;
    push({ kind: 'text', text: text.slice(0, 256) });
    setText('');
  };

  return (
    <div ref={root} className="flex flex-col gap-2" data-testid="connect-live">
      <div ref={head} className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {desktop && prompt && (
            <p className="text-[12px] leading-relaxed text-ink-2" data-testid="connect-live-prompt">
              {prompt}
            </p>
          )}
          {origin && (
            <p className="truncate text-[11px] text-ink-4" data-testid="connect-live-origin">
              {t('connect.live.origin', { origin })}
            </p>
          )}
        </div>
        {onClose && (
          <IconButton label={t('connect.live.close')} testId="connect-live-close" onClick={onClose}>
            <Icon name="close" size={20} />
          </IconButton>
        )}
      </div>
      <div className="flex justify-center">
        <div
          ref={surface}
          data-testid="connect-live-surface"
          className="relative touch-none select-none overflow-hidden rounded-card border border-line bg-bg-2"
          style={box ? { width: box.width, height: box.height } : { width: '100%', aspectRatio: `${size.width} / ${size.height}` }}
          onPointerDown={onPointer('down')}
          onPointerUp={onPointer('up')}
          onPointerMove={onPointer('move')}
          onWheel={(e) => push({ kind: 'scroll', deltaY: e.deltaY })}
        >
          {frameUrl ? (
            <img src={frameUrl} alt="" className="h-full w-full object-contain" draggable={false} />
          ) : (
            <p className="absolute inset-0 flex items-center justify-center text-[12px] text-ink-4" data-testid="connect-live-waiting">
              {t('connect.live.waiting')}
            </p>
          )}
        </div>
      </div>
      <div ref={bar} className="flex items-center gap-2">
        <input
          data-testid="connect-live-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              sendText();
              push({ kind: 'key', key: 'Enter' });
            }
          }}
          autoComplete="off"
          placeholder={t('connect.live.type')}
          className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none placeholder:text-ink-4"
        />
        <Button size="sm" variant="outline" data-testid="connect-live-send" onClick={sendText} disabled={!text}>
          {t('connect.live.send')}
        </Button>
        <Button size="sm" variant="outline" data-testid="connect-live-enter" onClick={() => push({ kind: 'key', key: 'Enter' })}>
          ⏎
        </Button>
        <Button size="sm" variant="outline" data-testid="connect-live-backspace" onClick={() => push({ kind: 'key', key: 'Backspace' })}>
          ⌫
        </Button>
      </div>
    </div>
  );
}
