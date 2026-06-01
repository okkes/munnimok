import React from 'react';

export function useLocalStorage(key, defaultValue) {
  const read = React.useCallback(() => {
    try {
      const s = localStorage.getItem(key);
      return s !== null ? JSON.parse(s) : (typeof defaultValue === 'function' ? defaultValue() : defaultValue);
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
    setState(prev => {
      const next = typeof val === 'function' ? val(prev) : val;
      try {
        localStorage.setItem(key, JSON.stringify(next));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key } }));
      } catch {}
      return next;
    });
  }, [key]);
  return [state, set];
}

export function clearAllStorage() { localStorage.clear(); }
