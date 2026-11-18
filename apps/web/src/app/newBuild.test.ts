// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAKEOVER_WAIT_MS, reloadIntoNewBuild } from './newBuild';

class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  constructor(public state: ServiceWorkerState) {
    super();
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  becomes(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeContainer extends EventTarget {
  updates = 0;
  constructor(private readonly registration: { waiting?: FakeWorker | null; installing?: FakeWorker | null } | undefined) {
    super();
  }
  getRegistration = async () =>
    this.registration && {
      ...this.registration,
      update: async () => {
        this.updates += 1;
      },
    };
}

const asContainer = (fake: FakeContainer) => fake as unknown as ServiceWorkerContainer;
const SKIP = [{ type: 'SKIP_WAITING' }];

describe('reloadIntoNewBuild (#652)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hands the page to the waiting worker first: the reload follows the takeover, not the click', async () => {
    const waiting = new FakeWorker('installed');
    const workers = new FakeContainer({ waiting });
    const reload = vi.fn();
    await reloadIntoNewBuild(asContainer(workers), reload);
    expect(workers.updates).toBe(1);
    expect(waiting.posted).toEqual(SKIP);
    expect(reload).not.toHaveBeenCalled();
    workers.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TAKEOVER_WAIT_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits for a worker that is still installing', async () => {
    const installing = new FakeWorker('installing');
    const workers = new FakeContainer({ installing });
    const reload = vi.fn();
    const done = reloadIntoNewBuild(asContainer(workers), reload);
    await vi.advanceTimersByTimeAsync(0);
    expect(installing.posted).toEqual([]);
    installing.becomes('installed');
    await done;
    expect(installing.posted).toEqual(SKIP);
    workers.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads anyway when the takeover is never heard (a page no worker controls)', async () => {
    const workers = new FakeContainer({ waiting: new FakeWorker('installed') });
    const reload = vi.fn();
    await reloadIntoNewBuild(asContainer(workers), reload);
    vi.advanceTimersByTime(TAKEOVER_WAIT_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is a plain reload where there is no newer worker, a failed install, or no worker at all', async () => {
    const reload = vi.fn();
    await reloadIntoNewBuild(asContainer(new FakeContainer({})), reload);
    expect(reload).toHaveBeenCalledTimes(1);

    const failing = new FakeWorker('installing');
    const done = reloadIntoNewBuild(asContainer(new FakeContainer({ installing: failing })), reload);
    await vi.advanceTimersByTimeAsync(0);
    failing.becomes('redundant');
    await done;
    expect(failing.posted).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(2);

    await reloadIntoNewBuild(asContainer(new FakeContainer(undefined)), reload);
    await reloadIntoNewBuild(undefined, reload);
    expect(reload).toHaveBeenCalledTimes(4);
  });
});
