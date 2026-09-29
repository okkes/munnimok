import type { ConnectorFrame } from './types';

/**
 * The connector frames of `/sync/events`, republished in-process: the
 * sync engine hands every `{ kind: "connector" }` frame here, and a
 * connect flow or a sync in flight subscribes to its own session or job.
 * A frame is the view without its secrets — never a bundle, never data —
 * so a subscriber that needs the bundle still reads the view itself.
 */

type Listener = (frame: ConnectorFrame) => void;

const listeners = new Set<Listener>();

export function publishConnectorFrame(frame: unknown): void {
  const f = frame as ConnectorFrame | null;
  if (f?.kind !== 'connector' || typeof f.sessionId !== 'string') return;
  for (const listener of listeners) listener(f);
}

/** frames of one session (or one job, when `jobId` is given); returns unsubscribe */
export function subscribeConnectorFrames(sessionId: string, listener: Listener, jobId?: string): () => void {
  const scoped: Listener = (frame) => {
    if (frame.sessionId !== sessionId) return;
    if (jobId && frame.jobId !== jobId) return;
    listener(frame);
  };
  listeners.add(scoped);
  return () => {
    listeners.delete(scoped);
  };
}

/** test seam */
export function resetConnectorFrames(): void {
  listeners.clear();
}
