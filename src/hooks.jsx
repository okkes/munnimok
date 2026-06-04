import React from 'react';

export function useLocalStorage(key, defaultValue) {
  const read = React.useCallback(() => {
    try {
      const s = localStorage.getItem(key);
      if (s === null) return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
      try { return JSON.parse(s); } catch { return s; }
    } catch { return typeof defaultValue === 'function' ? defaultValue() : defaultValue; }
  }, [key]);
  const [state, setState] = React.useState(read);
  React.useEffect(() => { setState(read()); }, [key, read]);
  React.useEffect(() => {
    const handler = (e) => { if (e.detail?.key === key) setState(read()); };
    const storageHandler = (e) => { if (e.key === key) setState(read()); };
    window.addEventListener('munni-ls', handler);
    window.addEventListener('storage', storageHandler);
    return () => { window.removeEventListener('munni-ls', handler); window.removeEventListener('storage', storageHandler); };
  }, [key, read]);
  const set = React.useCallback(val => {
    const current = read();
    const next = typeof val === 'function' ? val(current) : val;
    try {
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key } }));
    } catch {}
    setState(next);
  }, [key, read]);
  return [state, set];
}

export function clearAllStorage() {
  // Write reset signal BEFORE clearing — other tabs receive the storage event and reload
  localStorage.setItem('munni_reset_signal', String(Date.now()));
  localStorage.clear();
  sessionStorage.clear();
}

export function useSessionStorage(key, defaultValue) {
  const read = React.useCallback(() => {
    try {
      const s = sessionStorage.getItem(key);
      if (s === null) return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
      try { return JSON.parse(s); } catch { return s; }
    } catch { return typeof defaultValue === 'function' ? defaultValue() : defaultValue; }
  }, [key]);
  const [state, setState] = React.useState(read);
  React.useEffect(() => { setState(read()); }, [key, read]);
  React.useEffect(() => {
    const handler = (e) => { if (e.detail?.key === key) setState(read()); };
    window.addEventListener('munni-ss', handler);
    return () => window.removeEventListener('munni-ss', handler);
  }, [key, read]);
  const set = React.useCallback(val => {
    const current = read();
    const next = typeof val === 'function' ? val(current) : val;
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent('munni-ss', { detail: { key } }));
    } catch {}
    setState(next);
  }, [key, read]);
  return [state, set];
}
