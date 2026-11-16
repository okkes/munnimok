import { useSession } from '@/app/session';
import { nativeExits } from './platform';
import type { NativeExitRecord } from './platform';
import { reportErrorWith } from './report';

// #594: the web layer's error reports die with the app's process, so an Android app crash left no trace; the shell notes
// how its processes ended and the next start reports what was not somebody's choice, once

const SEEN_KEY = 'munni_native_exit_seen';

/** ApplicationExitInfo's reasons that are a fault whenever they happen */
const FAULTS: Readonly<Record<number, string>> = {
  4: 'crash',
  5: 'native crash',
  6: 'not responding',
  7: 'failed to start',
  9: 'excessive resource use',
};
/** …and the ones that are a fault only while the app was on screen: Android ends a resting app as it pleases */
const FAULTS_ON_SCREEN: Readonly<Record<number, string>> = {
  2: 'killed by a signal',
  3: 'low memory',
  12: 'a process it depends on died',
};
/** ActivityManager's importance of a process the person can see: foreground is 100, visible 200 */
const ON_SCREEN = 200;

function faultOf(exit: NativeExitRecord): string | null {
  const always = FAULTS[exit.reason];
  if (always) return always;
  const onScreen = FAULTS_ON_SCREEN[exit.reason];
  return onScreen && (exit.importance ?? Number.POSITIVE_INFINITY) <= ON_SCREEN ? onScreen : null;
}

const megabytes = (kb: number | undefined): number | undefined => (kb ? Math.round(kb / 1024) : undefined);
const oneLine = (text: string): string => text.split('\n')[0].slice(0, 300);

export async function reportNativeExits(): Promise<number> {
  const found = await nativeExits();
  if (!found) return 0;
  let raised = 0;

  const seen = Number(localStorage.getItem(SEEN_KEY) ?? 0);
  const exits = (found.exits ?? []).filter((exit) => exit.at > seen);
  for (const exit of exits) {
    const fault = faultOf(exit);
    if (!fault) continue;
    const detail = exit.description ? `: ${oneLine(exit.description)}` : '';
    reportErrorWith('android-exit', new Error(`Android ended the app: ${fault}${detail}`), {
      at: new Date(exit.at).toISOString(),
      reason: exit.reason,
      process: exit.process ?? undefined,
      importance: exit.importance,
      status: exit.status,
      residentMb: megabytes(exit.rssKb),
      proportionalMb: megabytes(exit.pssKb),
    });
    raised += 1;
  }
  if (exits.length > 0) localStorage.setItem(SEEN_KEY, String(Math.max(...exits.map((exit) => exit.at))));

  if (found.javaCrash) {
    const [at, thread, ...trace] = found.javaCrash.split('\n');
    reportErrorWith('android-exit', new Error(`Android crash: ${oneLine(trace.join('\n'))}`), {
      at: new Date(Number(at)).toISOString(),
      thread,
      trace: trace.join('\n'),
    });
    raised += 1;
  }
  if (found.renderer) {
    const [at, how, priority] = found.renderer.split('\n');
    reportErrorWith('android-exit', new Error(`Android ended the app: its web view process ${how}`), {
      at: new Date(Number(at)).toISOString(),
      priority,
    });
    raised += 1;
  }
  return raised;
}

/** reports only once a signed-in identity is known: a chosen-offline identity sends nothing, ever */
export function watchNativeExits(): void {
  let told = false;
  const tell = () => {
    if (told || useSession.getState().identity?.kind !== 'user') return;
    told = true;
    void reportNativeExits().catch(() => undefined);
  };
  useSession.subscribe(tell);
  tell();
}
