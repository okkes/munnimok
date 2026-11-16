import { useEffect } from 'react';
import { hasOpenSheet } from './Sheet';

const EDGE_PX = 24;
const MIN_DX = 70;
const MAX_DY = 60;

// every AppBar back button carries a `*-back` testid (DetailBackButton included): that is how a screen opts in
const backButtonPresent = () =>
  document.querySelector('[data-testid$="-back"]') !== null;

// an open sheet stands down this gesture; screens without a back arrow ignore it, so tab roots never navigate away
export function EdgeSwipeBack() {
  useEffect(() => {
    let startX = -1;
    let startY = -1;
    let armed = false;

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      armed = touch.clientX <= EDGE_PX && !hasOpenSheet() && backButtonPresent();
      startX = touch.clientX;
      startY = touch.clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (dy > MAX_DY) {
        armed = false;
        return;
      }
      if (dx >= MIN_DX) {
        armed = false;
        window.history.back();
      }
    };
    const onEnd = () => {
      armed = false;
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, []);
  return null;
}
