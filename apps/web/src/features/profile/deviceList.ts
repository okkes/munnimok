import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';

export interface DeviceDto {
  id: string;
  platform: string | null;
  name: string | null;
  createdAt: string;
  lastSeenAt: string;
  revoked: boolean;
}

export type DeviceListStatus = 'loading' | 'ready' | 'failed';

async function fetchDevices(): Promise<DeviceDto[] | null> {
  // no-store: a list another device just changed must never come from an HTTP cache
  const res = await apiFetch('/me/devices', { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json().catch(() => null)) as DeviceDto[] | null) ?? null;
}

// #685: a list fetched once on open went stale while the screen stayed open or the app sat in the background
export function useDeviceList() {
  const [devices, setDevices] = useState<DeviceDto[] | null>(null);
  const [status, setStatus] = useState<DeviceListStatus>('loading');
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const latest = useRef(0);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    const seq = ++latest.current;
    inFlight.current = true;
    setStatus('loading');
    const list = await fetchDevices();
    // an older answer must not overwrite a newer one
    if (seq !== latest.current) return;
    inFlight.current = false;
    if (!list) {
      setStatus('failed');
      return;
    }
    setDevices(list);
    setFetchedAt(new Date().toISOString());
    setStatus('ready');
  }, []);

  useEffect(() => {
    void reload();
    const onForeground = () => {
      if (document.visibilityState !== 'visible') return;
      // returning to a tab fires both focus and visibilitychange: one request answers both
      if (inFlight.current) return;
      void reload();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    window.addEventListener('online', onForeground);
    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      window.removeEventListener('online', onForeground);
    };
  }, [reload]);

  return { devices, status, fetchedAt, reload };
}

/** one revoke per device (the server has no bulk call); the ids that did not go through come back */
export async function revokeDevices(ids: readonly string[]): Promise<{ revoked: string[]; failed: string[] }> {
  const results = await Promise.all(
    ids.map(async (id) => {
      const res = await apiFetch(`/me/devices/${id}/revoke`, { method: 'POST' }).catch(() => null);
      return { id, ok: !!res?.ok };
    }),
  );
  return {
    revoked: results.filter((r) => r.ok).map((r) => r.id),
    failed: results.filter((r) => !r.ok).map((r) => r.id),
  };
}
