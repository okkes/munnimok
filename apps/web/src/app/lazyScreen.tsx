import { use, useEffect, useState } from 'react';
import type { ComponentType, FunctionComponent } from 'react';
import { useLang } from '@/i18n';
import { reportWarning } from '@/lib/report';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { usePwa } from './pwa';

/** a route component the router loads before it shows the route — `preload` is gone once nothing is left to load */
export type LazyScreen<P = object> = FunctionComponent<P> & { preload?: () => Promise<void> };
type ScreenProps<C> = C extends ComponentType<infer P> ? P : never;

/** #554: a screen in its own chunk; a chunk that cannot load (a deploy replaced the files)
 * moves to the current build, never a blank screen */
export function lazyScreen<M, K extends keyof M & string>(load: () => Promise<M>, name: K): LazyScreen<ScreenProps<M[K]>> {
  type P = ScreenProps<M[K]>;
  let Screen: ComponentType<object> | undefined;
  let loading: Promise<void> | undefined;
  let failure: unknown;
  const start = () => {
    loading ??= load().then(
      (loaded) => {
        Screen = loaded[name] as ComponentType<object>;
        failure = undefined;
        Lazy.preload = undefined;
      },
      (error: unknown) => {
        loading = undefined;
        failure = error ?? new Error(`${name} did not load`);
      },
    );
    return loading;
  };
  const Lazy: LazyScreen<P> = (props) => {
    if (!Screen && !failure) use(start());
    return Screen ? <Screen {...(props as object)} /> : <ScreenLoadFailed error={failure} />;
  };
  Lazy.displayName = `Lazy(${name})`;
  Lazy.preload = start;
  return Lazy;
}

/** a route component that renders lazy screens itself (a layout around one, a screen with props): the router loads them first */
export function withScreens<P>(component: FunctionComponent<P>, ...screens: Array<{ preload?: () => Promise<void> }>): LazyScreen<P> {
  const route: LazyScreen<P> = component;
  route.preload = () =>
    Promise.all(screens.map((screen) => screen.preload?.() ?? Promise.resolve())).then(() => {
      if (screens.every((screen) => !screen.preload)) route.preload = undefined;
    });
  return route;
}

const RELOAD_STAMP = 'munni_chunk_reload';
/** a failure this soon after such a reload is no stale build (offline, a deploy without the file): stop instead of looping */
const RELOAD_WINDOW_MS = 60_000;
/** once per page life: a second failed screen waits for the reload already on its way */
let reloadIssued = false;

/** reloads into the current build (via the waiting service worker if any); false when offline,
 * no storage for the loop guard, or a reload just happened */
export function recoverFromMissingChunk(): boolean {
  if (reloadIssued) return true;
  if (navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_STAMP));
    if (last && Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_STAMP, String(Date.now()));
  } catch {
    return false;
  }
  reloadIssued = true;
  reloadIntoCurrentBuild();
  return true;
}

function reloadIntoCurrentBuild(): void {
  const pwa = usePwa.getState();
  if (pwa.needRefresh) pwa.update();
  else globalThis.location.reload();
}

export function ScreenPending() {
  const { t } = useLang();
  return (
    <output className="flex h-full items-center justify-center text-ink-4" data-testid="screen-pending" aria-label={t('pwa.screenLoading')}>
      <span className="inline-flex animate-spin">
        <Icon name="loading" size={22} />
      </span>
    </output>
  );
}

function ScreenLoadFailed({ error }: Readonly<{ error: unknown }>) {
  const { t } = useLang();
  const [reloading, setReloading] = useState(true);
  useEffect(() => {
    if (recoverFromMissingChunk()) return;
    setReloading(false);
    if (navigator.onLine !== false) reportWarning('chunk', 'a screen failed to load', { error: String(error) });
  }, [error]);
  if (reloading) return <ScreenPending />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center" data-testid="screen-load-failed" role="alert">
      <Icon name="cloud-alert-outline" size={44} color="var(--m-accent)" />
      <div className="m-h3 text-ink">{t('pwa.screenFailedTitle')}</div>
      <p className="max-w-[320px] text-[13px] leading-relaxed text-ink-3">{t('pwa.screenFailedNote')}</p>
      <Button data-testid="screen-load-failed-reload" onClick={reloadIntoCurrentBuild}>
        {t('pwa.reload')}
      </Button>
    </div>
  );
}
