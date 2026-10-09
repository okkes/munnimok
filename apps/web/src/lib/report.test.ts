import { describe, expect, it, vi } from 'vitest';
import { gateTransport, reportError, reportWarning } from './report';
import type { Envelope, Transport } from './report';

vi.mock('@sentry/react', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
import * as Sentry from '@sentry/react';

const envelope = [{}, []] as unknown as Envelope;

describe('report', () => {
  it('captures errors with a scope tag, wrapping non-errors', () => {
    const err = new Error('x');
    reportError('sync', err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { tags: { scope: 'sync' } });
    reportError('sync', 'plain');
    const wrapped = vi.mocked(Sentry.captureException).mock.calls[1][0] as Error;
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('plain');
    reportWarning('memwatch', 'growth', { samples: 3 });
    expect(Sentry.captureMessage).toHaveBeenCalledWith('growth', { level: 'warning', tags: { scope: 'memwatch' }, extra: { samples: 3 } });
  });

  it('the gated transport sends nothing for a zero-network identity and everything otherwise', async () => {
    const send = vi.fn(async () => ({ statusCode: 200 }));
    const flush = vi.fn(async () => true);
    let silenced = true;
    const create = gateTransport((options: { url: string }): Transport => ({ send, flush, ...(options.url ? {} : {}) }), () => silenced);
    const transport = create({ url: 'https://glitchtip.example/1' });

    await expect(transport.send(envelope)).resolves.toEqual({});
    expect(send).not.toHaveBeenCalled();

    silenced = false;
    await expect(transport.send(envelope)).resolves.toEqual({ statusCode: 200 });
    expect(send).toHaveBeenCalledWith(envelope);
    await expect(transport.flush()).resolves.toBe(true); // the rest of the transport is untouched
  });
});
