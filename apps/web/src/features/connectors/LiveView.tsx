import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { connectorApi } from './api';
import type { LiveInputEvent } from './types';

/**
 * The `live_view` challenge (§10.2): the party's own page, streamed as
 * JPEG frames from the agent's browser, with the human's taps, keys and
 * text relayed back — the clipped page rectangle, never a full viewport.
 * Frames are long-polled past the last sequence; input is batched.
 */
const FRAME_IDLE_MS = 400;
const FRAME_RETRY_MS = 1_500;
const FLUSH_MS = 80;
const MOVE_GAP_MS = 40;
const BATCH_MAX = 64;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function LiveView({
  provider,
  sessionId,
  challengeId,
}: Readonly<{
  provider: string;
  sessionId: string;
  challengeId: string;
}>) {
  const { t } = useLang();
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 390, height: 844 });
  const [origin, setOrigin] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const surface = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const inputSequence = useRef(0);
  const queue = useRef<LiveInputEvent[]>([]);
  const lastMove = useRef(0);

  // frames: one long-poll after another, each asking past the last sequence
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    void (async () => {
      while (alive) {
        try {
          const frame = await connectorApi.liveFrame(provider, sessionId, challengeId, sequence.current);
          if (!alive) break;
          if (!frame) {
            await sleep(FRAME_IDLE_MS);
            continue;
          }
          sequence.current = frame.sequence;
          setSize({ width: frame.width, height: frame.height });
          setOrigin(frame.origin);
          const url = URL.createObjectURL(frame.blob);
          if (current) URL.revokeObjectURL(current);
          current = url;
          setFrameUrl(url);
        } catch {
          await sleep(FRAME_RETRY_MS);
        }
      }
      if (current) URL.revokeObjectURL(current);
    })();
    return () => {
      alive = false;
    };
  }, [provider, sessionId, challengeId]);

  // input: whatever gathered since the last flush goes as one batch
  useEffect(() => {
    const timer = setInterval(() => {
      if (queue.current.length === 0) return;
      const batch = queue.current.splice(0, BATCH_MAX);
      void connectorApi.liveInput(provider, sessionId, challengeId, batch).catch(() => undefined);
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, [provider, sessionId, challengeId]);

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
    <div className="flex flex-col gap-2" data-testid="connect-live">
      {origin && (
        <p className="truncate px-1 text-[11px] text-ink-4" data-testid="connect-live-origin">
          {t('connect.live.origin', { origin })}
        </p>
      )}
      <div
        ref={surface}
        data-testid="connect-live-surface"
        className="relative w-full touch-none select-none overflow-hidden rounded-card border border-line bg-bg-2"
        style={{ aspectRatio: `${size.width} / ${size.height}`, maxHeight: 420 }}
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
      <div className="flex items-center gap-2">
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
