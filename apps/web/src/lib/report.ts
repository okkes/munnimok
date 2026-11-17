import * as Sentry from '@sentry/react';

/** the SDK's transport, as its fetch transport factory types it (the interface itself is not exported) */
export type Transport = ReturnType<typeof Sentry.makeFetchTransport>;
export type Envelope = Parameters<Transport['send']>[0];

// safe anywhere: the beforeSend gate in main.tsx drops zero-network identities (demo/offline),
// the offline transport queues for signed-in ones
export function reportError(scope: string, err: unknown): void {
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { scope } });
}

/** `reportError` with the facts that explain it (sizes, counts, a trace): never anything a person typed or owns */
export function reportErrorWith(scope: string, err: Error, extra: Record<string, unknown>): void {
  Sentry.captureException(err, { tags: { scope }, extra });
}

/** a non-crash observation (#135 memory watcher), same gates as reportError */
export function reportWarning(scope: string, message: string, extra: Record<string, unknown>): void {
  Sentry.captureMessage(message, { level: 'warning', tags: { scope }, extra });
}

// the zero-network gate at the transport, under beforeSend/beforeSendTransaction: with tracing on the SDK also sends
// envelopes no hook can drop (INP standalone spans); resolving without a request queues nothing for later,
// the offline transport wraps this one
export function gateTransport<A extends unknown[]>(
  create: (...args: A) => Transport,
  silenced: () => boolean,
): (...args: A) => Transport {
  return (...args: A) => {
    const inner = create(...args);
    return { ...inner, send: (envelope) => (silenced() ? Promise.resolve({}) : inner.send(envelope)) };
  };
}
