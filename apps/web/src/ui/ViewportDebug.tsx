import { useEffect, useState } from 'react';

const VPDEBUG_KEY = 'munni_vpdebug';
const VPDEBUG_EVENT = 'munni-vpdebug';

export function vpdebugEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.location.href.includes('vpdebug') || localStorage.getItem(VPDEBUG_KEY) === '1')
  );
}

/** flip the overlay from anywhere (Settings row) — the overlay reacts live */
export function setVpdebug(on: boolean): void {
  localStorage.setItem(VPDEBUG_KEY, on ? '1' : '0');
  window.dispatchEvent(new Event(VPDEBUG_EVENT));
}

/**
 * On-device viewport diagnostics for mobile layout reports: toggle it in
 * Settings (installed PWAs have no URL bar for ?vpdebug=1) and read the
 * numbers off a screenshot. Mobile viewport bugs are unguessable from a
 * desk — this turns the next report into data.
 */
export function ViewportDebug() {
  const [enabled, setEnabled] = useState(vpdebugEnabled);
  useEffect(() => {
    const onChange = () => setEnabled(vpdebugEnabled());
    window.addEventListener(VPDEBUG_EVENT, onChange);
    return () => window.removeEventListener(VPDEBUG_EVENT, onChange);
  }, []);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;height:100dvh;padding-bottom:env(safe-area-inset-bottom);padding-top:env(safe-area-inset-top)';
    document.body.appendChild(probe);
    const svhProbe = document.createElement('div');
    svhProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:100svh';
    document.body.appendChild(svhProbe);
    const lvhProbe = document.createElement('div');
    lvhProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:100lvh';
    document.body.appendChild(lvhProbe);

    const measure = () => {
      const cs = getComputedStyle(probe);
      const root = document.getElementById('root');
      const rootRect = root?.getBoundingClientRect();
      const tabbar = document.querySelector('[data-vpdebug="tabbar"]')?.getBoundingClientRect();
      const vv = window.visualViewport;
      setLines([
        `inner ${window.innerHeight} / outer ${window.outerHeight}`,
        `visual ${Math.round(vv?.height ?? 0)} @${Math.round(vv?.offsetTop ?? 0)}/${Math.round(vv?.pageTop ?? 0)} / screen ${window.screen.height}`,
        `dvh ${probe.offsetHeight} / svh ${svhProbe.offsetHeight} / lvh ${lvhProbe.offsetHeight}`,
        `vvh ${document.documentElement.style.getPropertyValue('--vvh') || '—'} / root ${Math.round(rootRect?.top ?? 0)}→${Math.round(rootRect?.bottom ?? 0)}`,
        `tabbar ${tabbar ? `${Math.round(tabbar.top)}→${Math.round(tabbar.bottom)}` : '—'}`,
        `safe top ${cs.paddingTop} bottom ${cs.paddingBottom}`,
        `standalone ${window.matchMedia('(display-mode: standalone)').matches}`,
      ]);
    };
    measure();
    const timer = setInterval(measure, 1000);
    return () => {
      clearInterval(timer);
      probe.remove();
      svhProbe.remove();
      lvhProbe.remove();
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div
      style={{
        position: 'fixed',
        top: 'max(40px, env(safe-area-inset-top))',
        right: 6,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.75)',
        color: '#9f9',
        font: '10px/1.5 monospace',
        padding: '6px 8px',
        borderRadius: 6,
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      {lines.join('\n')}
    </div>
  );
}
