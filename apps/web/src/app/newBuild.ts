/** how long the new worker gets to take the page over before the page reloads anyway (a page no worker controls hears nothing) */
export const TAKEOVER_WAIT_MS = 4_000;

/** the worker holding the newer build once it is installed; null when the server has none */
function installedWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (registration.waiting) return Promise.resolve(registration.waiting);
  const installing = registration.installing;
  if (!installing) return Promise.resolve(null);
  return new Promise((resolve) => {
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') resolve(installing);
      else if (installing.state === 'redundant') resolve(null);
    });
  });
}

// #652: a reload is answered by the worker in charge, from ITS cache: the newer worker has to take over first,
// and the page reloads when it has
export async function reloadIntoNewBuild(
  workers: ServiceWorkerContainer | undefined = navigator.serviceWorker,
  reload: () => void = () => globalThis.location.reload(),
): Promise<void> {
  const registration = await workers?.getRegistration().catch(() => undefined);
  if (!workers || !registration) return reload();
  await registration.update().catch(() => undefined);
  const next = await installedWorker(registration);
  if (!next) return reload();
  let reloaded = false;
  const once = () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  };
  workers.addEventListener('controllerchange', once, { once: true });
  setTimeout(once, TAKEOVER_WAIT_MS);
  next.postMessage({ type: 'SKIP_WAITING' });
}
