// leak WATCH (#135), not a profiler: where a JS heap size exists (Chromium), sample it slowly, report sustained growth once
// iOS WebKit has no heap API; its code is shared with the Chromium platforms, whose reports cover it
// the bar is high (near-monotonic, big absolute and relative rise over an hour) so ordinary churn never pages

const SAMPLE_MS = 5 * 60_000;
const WINDOW = 12; // one hour of samples
const MIN_RISE_BYTES = 80 * 1024 * 1024;
const MIN_RISE_RATIO = 1.5;

interface HeapSource {
  usedJSHeapSize: number;
}

const sustainedRise = (samples: readonly number[]): boolean =>
  samples.every((value, i) => i === 0 || value >= samples[i - 1] * 0.98);

export function installMemWatch(
  report: (message: string, extra: Record<string, unknown>) => void,
  heap?: HeapSource,
): () => void {
  const source = heap ?? (performance as { memory?: HeapSource }).memory;
  if (!source) return () => undefined; // iOS WebKit and friends: no heap API
  const samples: number[] = [];
  let reported = false;
  const tick = () => {
    samples.push(source.usedJSHeapSize);
    if (samples.length > WINDOW) samples.shift();
    if (reported || samples.length < WINDOW) return;
    const first = samples[0];
    const last = samples.at(-1) as number;
    if (sustainedRise(samples) && last - first > MIN_RISE_BYTES && last / first > MIN_RISE_RATIO) {
      reported = true; // one alarm per session — the samples say the rest
      report('memory-growth', {
        firstBytes: first,
        lastBytes: last,
        minutes: (WINDOW * SAMPLE_MS) / 60_000,
        samples: [...samples],
      });
    }
  };
  const id = setInterval(tick, SAMPLE_MS);
  return () => clearInterval(id);
}
