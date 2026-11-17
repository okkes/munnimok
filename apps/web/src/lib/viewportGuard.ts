// iOS ignores overflow: hidden when it focus-scrolls the layout viewport for the keyboard (WebKit quirk) and the shift can
// stick: the app sits displaced and sheets look "tripped"; snap the window back, the sheet's own keyboard avoidance lifts
export function installViewportGuard(): () => void {
  let raf = 0;
  const snapBack = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    });
  };
  window.addEventListener('scroll', snapBack);
  window.visualViewport?.addEventListener('scroll', snapBack);
  window.visualViewport?.addEventListener('resize', snapBack);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('scroll', snapBack);
    window.visualViewport?.removeEventListener('scroll', snapBack);
    window.visualViewport?.removeEventListener('resize', snapBack);
  };
}
