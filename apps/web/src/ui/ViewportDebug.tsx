import { useEffect, useState } from 'react';

/**
 * On-device viewport diagnostics for mobile layout reports: open the app
 * with ?vpdebug=1 (or set localStorage munni_vpdebug=1) and read the
 * numbers off a screenshot. Mobile viewport bugs are unguessable from a
 * desk — this turns the next report into data.
 */
export function ViewportDebug() {
  const enabled =
    typeof window !== 'undefined' &&
    (window.location.href.includes('vpdebug') || localStorage.getItem('munni_vpdebug') === '1');
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

    const measure = () => {
      const cs = getComputedStyle(probe);
      const root = document.getElementById('root');
      setLines([
        `inner ${window.innerHeight} / outer ${window.outerHeight}`,
        `visual ${Math.round(window.visualViewport?.height ?? 0)} / screen ${window.screen.height}`,
        `dvh ${probe.offsetHeight} / svh ${svhProbe.offsetHeight}`,
        `vvh ${document.documentElement.style.getPropertyValue('--vvh') || '—'} / root ${root?.offsetHeight ?? 0}`,
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
