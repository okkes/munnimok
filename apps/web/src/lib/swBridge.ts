/**
 * Mirrors the UI language into the service worker's tiny IDB store so
 * push notifications are localized even when the worker boots cold
 * (src/sw.ts reads it back). Dependency-free on purpose: imported by
 * the i18n provider.
 */
export function mirrorLangForSw(lang: string): void {
  try {
    const open = indexedDB.open('munni_sw', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => {
      try {
        open.result.transaction('kv', 'readwrite').objectStore('kv').put(lang, 'lang');
      } catch {
        // best effort — notifications fall back to English
      }
    };
  } catch {
    // indexedDB unavailable (some private modes) — fall back to English
  }
}
