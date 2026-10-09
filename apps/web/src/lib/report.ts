import * as Sentry from '@sentry/react';

/** the SDK's transport, as its fetch transport factory types it (the interface itself is not exported) */
export type Transport = ReturnType<typeof Sentry.makeFetchTransport>;
export type Envelope = Parameters<Transport['send']>[0];

/**
 * GlitchTip capture with a scope tag (user rule: send every exception
 * that helps troubleshooting). Safe to call anywhere: the global
 * beforeSend gate in main.tsx drops events for zero-network identities
 * (demo/offline), and the offline transport queues for signed-in users
 * without connectivity.
 */
export function reportError(scope: string, err: unknown): void {
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { scope } });
}

/** a non-crash observation (#135: the memory watcher) — same gates as
 *  reportError: zero-network identities never send, offline queues */
export function reportWarning(scope: string, message: string, extra: Record<string, unknown>): void {
  Sentry.captureMessage(message, { level: 'warning', tags: { scope }, extra });
}

/**
 * The zero-network gate at the transport, under the capture-time gates
 * (beforeSend / beforeSendTransaction): with tracing on, the SDK also
 * sends envelopes no hook can drop — INP standalone spans — and a
 * chosen-offline identity sends NOTHING (user rule). Resolving without a
 * request means nothing is queued for later either; the offline
 * transport wraps the gated one (user 2026-10-09).
 */
export function gateTransport<A extends unknown[]>(
  create: (...args: A) => Transport,
  silenced: () => boolean,
): (...args: A) => Transport {
  return (...args: A) => {
    const inner = create(...args);
    return { ...inner, send: (envelope) => (silenced() ? Promise.resolve({}) : inner.send(envelope)) };
  };
}
