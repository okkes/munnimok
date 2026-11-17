import type { ConnectorFrame } from './types';

// a frame is the view without secrets (never a bundle): a subscriber that needs the bundle still reads the view itself

type Listener = (frame: ConnectorFrame) => void;

const listeners = new Set<Listener>();

export function publishConnectorFrame(frame: unknown): void {
  const f = frame as ConnectorFrame | null;
  if (f?.kind !== 'connector' || typeof f.sessionId !== 'string') return;
  for (const listener of listeners) listener(f);
}

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
