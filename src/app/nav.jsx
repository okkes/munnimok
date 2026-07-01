import React from 'react';
import { M, I } from './theme.jsx';
import { useLang } from '../shared/i18n.jsx';


export const DarkCtx = React.createContext({ dark: false, setDark: () => {} });
export const useDark = () => React.useContext(DarkCtx);


export const NavCtx = React.createContext(null);

export function NavProvider({ children, initial = 'home' }) {
  const [tab, setTab] = React.useState(initial);
  const [stacks, setStacks] = React.useState({ home: [], tx: [], recurring: [], portfolio: [], insights: [], profile: [] });
  const [kickNotif, setKickNotif] = React.useState(null);
  const stacksRef = React.useRef(stacks);
  const tabRef = React.useRef(tab);
  stacksRef.current = stacks;
  tabRef.current = tab;

  React.useEffect(() => {
    window.history.replaceState({ tab: initial, depth: 0 }, '');
    const onPop = (e) => {
      const state = e.state;
      if (!state || state.munniScreen || state.munniLoginMode) return;
      const curStack = stacksRef.current[tabRef.current];
      if (state.depth < curStack.length) {
        setStacks(s => ({ ...s, [tabRef.current]: s[tabRef.current].slice(0, state.depth) }));
      } else if (state.tab !== tabRef.current) {
        setTab(state.tab);
        setStacks(s => ({ ...s, [state.tab]: s[state.tab].slice(0, state.depth) }));
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const push = (screen, params = {}) => {
    setStacks(s => {
      const next = [...s[tabRef.current], { screen, params }];
      window.history.pushState({ tab: tabRef.current, depth: next.length }, '');
      return { ...s, [tabRef.current]: next };
    });
  };
  const pop = () => {
    setStacks(s => {
      const next = s[tabRef.current].slice(0, -1);
      window.history.pushState({ tab: tabRef.current, depth: next.length }, '');
      return { ...s, [tabRef.current]: next };
    });
  };
  const popAll = () => {
    setStacks(s => {
      window.history.pushState({ tab: tabRef.current, depth: 0 }, '');
      return { ...s, [tabRef.current]: [] };
    });
  };
  const switchTab = (t) => {
    window.history.pushState({ tab: t, depth: stacksRef.current[t].length }, '');
    setTab(t);
  };
  const replace = (screen, params = {}) => {
    setStacks(s => {
      const next = [...s[tabRef.current].slice(0, -1), { screen, params }];
      window.history.replaceState({ tab: tabRef.current, depth: next.length }, '');
      return { ...s, [tabRef.current]: next };
    });
  };

  const value = { tab, stack: stacks[tab], push, pop, popAll, switchTab, replace, kickNotif, setKickNotif };
  return (
    <NavCtx.Provider value={value}>
      {children}
      {kickNotif && (
        <div style={{
          position:'absolute', top:0, left:0, right:0, zIndex:9999,
          display:'flex', justifyContent:'center', pointerEvents:'none',
          padding:'10px 16px 0',
        }}>
          <div style={{
            background:'rgba(15,23,42,0.92)', color:'#f1f5f9',
            fontSize:13, fontFamily:M.fontUI, fontWeight:500,
            padding:'10px 16px', borderRadius:12, maxWidth:320,
            boxShadow:'0 4px 20px rgba(0,0,0,0.35)',
            display:'flex', alignItems:'center', gap:10, pointerEvents:'all',
            backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)',
          }}>
            <I name="x" size={15} color="#f87171"/>
            <span>{kickNotif}</span>
          </div>
        </div>
      )}
    </NavCtx.Provider>
  );
}

export const useNav = () => React.useContext(NavCtx);

export function TabBar({ active, onChange }) {
  const mobile = React.useMemo(() => window.matchMedia('(max-width: 430px)').matches, []);
  const { t } = useLang();
  const tabs = [
    { id: 'home',      icon: 'home',        label: t('tab.home') },
    { id: 'tx',        icon: 'list',        label: t('tab.transactions') },
    { id: 'recurring', icon: 'receipt',     label: t('tab.recurring') },
    { id: 'portfolio', icon: 'wallet',      label: t('tab.portfolio') },
    { id: 'insights',  icon: 'trending-up', label: t('tab.insights') },
  ];
  return (
    <div style={{
      flexShrink: 0,
      borderTop: `1px solid ${M.line}`,
      background: 'rgba(247, 244, 238, 0.92)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      paddingBottom: mobile ? 'env(safe-area-inset-bottom, 8px)' : 18,
      paddingTop: 8,
      display: 'flex',
    }}>
      {tabs.map(tab => {
        const active_ = tab.id === active;
        return (
          <button key={tab.id}
            data-testid={`tab-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className="m-tap"
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', gap: 3, padding: '6px 0',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: active_ ? M.ink : M.ink4, fontFamily: M.fontUI,
            }}>
            <I name={tab.icon} size={22} stroke={active_ ? 1.9 : 1.5}/>
            <div style={{ fontSize: 10, fontWeight: active_ ? 600 : 500, letterSpacing: 0.02 }}>{tab.label}</div>
          </button>
        );
      })}
    </div>
  );
}

export function StackScreen({ children, depth = 0 }) {
  return (
    <div key={depth} style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      animation: depth > 0 ? 'mSlideIn 0.28s cubic-bezier(.2,.7,.2,1) both' : undefined,
      background: M.paper,
    }}>
      {children}
    </div>
  );
}

if (typeof document !== 'undefined' && !document.getElementById('m-nav-styles')) {
  const s = document.createElement('style');
  s.id = 'm-nav-styles';
  s.textContent = `
    @keyframes mSlideIn { from { transform: translateX(100%); } to { transform: none; } }
    @keyframes mSlideInLeft { from { transform: translateX(-100%); } to { transform: none; } }
    @keyframes mSheetUp { from { transform: translateY(100%); } to { transform: none; } }
    @keyframes pulse { 0%,100% { opacity:0.3; transform:scale(0.8); } 50% { opacity:1; transform:scale(1); } }
    @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
    @keyframes backdropFade { from { opacity:0; } to { opacity:1; } }
    @keyframes barRise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    .m-bar-animate { transform-origin: bottom; animation: barRise 0.4s cubic-bezier(0.34,1.56,0.64,1) both; }
    @keyframes acctFlash { 0% { opacity:1; } 100% { opacity:0; } }
  `;
  document.head.appendChild(s);
}

export function Sheet({ children, onClose, open, title }) {
  const [dragY, setDragY] = React.useState(0);
  const dragYRef = React.useRef(0);
  const startYRef = React.useRef(null);
  const didMountRef = React.useRef(false);
  const [kbOffset, setKbOffset] = React.useState(0);
  const panelRef = React.useRef(null);
  const [lockedMinHeight, setLockedMinHeight] = React.useState(null);

  React.useEffect(() => { didMountRef.current = true; }, []);

  // Lock background scroll while sheet is open, compensating for scrollbar width
  // to prevent layout shift (which makes Playwright see elements as "not stable").
  React.useEffect(() => {
    const scrollbarW = window.innerWidth - document.documentElement.clientWidth;
    if (scrollbarW > 0) document.body.style.paddingRight = `${scrollbarW}px`;
    document.body.style.overflow = 'hidden';
    const scrollEls = Array.from(document.querySelectorAll('.m-body-scroll'));
    scrollEls.forEach(el => { el.dataset._prevOv = el.style.overflowY || ''; el.style.overflowY = 'hidden'; });
    return () => {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
      scrollEls.forEach(el => { el.style.overflowY = el.dataset._prevOv || ''; delete el.dataset._prevOv; });
    };
  }, []);

  // Lock height after open animation so content filtering never shrinks the sheet
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (panelRef.current) {
        setLockedMinHeight(panelRef.current.getBoundingClientRect().height);
      }
    }, 380);
    return () => clearTimeout(timer);
  }, []);

  // Push sheet above keyboard on iOS using Visual Viewport API
  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbOffset(offset);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);

  if (open !== undefined && !open) return null;

  const onHandleTouchStart = (e) => {
    startYRef.current = e.touches[0].clientY;
  };
  const onHandleTouchMove = (e) => {
    if (startYRef.current === null) return;
    const dy = e.touches[0].clientY - startYRef.current;
    if (dy > 0) { dragYRef.current = dy; setDragY(dy); }
  };
  const onHandleTouchEnd = () => {
    const y = dragYRef.current;
    dragYRef.current = 0; setDragY(0);
    startYRef.current = null;
    if (y > 80) onClose?.();
  };

  const onHandleMouseDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startYRef.current = e.clientY;
    const onMouseMove = (ev) => {
      if (startYRef.current === null) return;
      const dy = ev.clientY - startYRef.current;
      if (dy > 0) { dragYRef.current = dy; setDragY(dy); }
    };
    const onMouseUp = () => {
      const y = dragYRef.current;
      dragYRef.current = 0; setDragY(0);
      startYRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (y > 80) onClose?.();
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div data-testid="sheet-close" style={{
      position: 'absolute', inset: 0, background: 'rgba(27,26,23,0.45)', zIndex: 50,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      animation: 'backdropFade 0.22s ease',
      paddingBottom: kbOffset,
      boxSizing: 'border-box',
      transition: 'padding-bottom 0.15s ease',
      touchAction: 'none',
    }} onClick={onClose}>
      <div ref={panelRef} style={{
        background: M.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24,
        maxHeight: '88%', minHeight: lockedMinHeight || undefined,
        display: 'flex', flexDirection: 'column',
        animation: !didMountRef.current ? 'mSheetUp 0.32s cubic-bezier(.2,.7,.2,1)' : 'none',
        transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
        transition: (dragY === 0 && didMountRef.current) ? 'transform 0.25s cubic-bezier(.2,.7,.2,1)' : 'none',
        touchAction: 'pan-y',
      }} onClick={e => e.stopPropagation()}>
        {/* Draggable header: pill + title combined into one full-height touch target */}
        <div
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
          onMouseDown={onHandleMouseDown}
          style={{ touchAction: 'none', cursor: 'grab', userSelect: 'none', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'center', padding: title ? '12px 0 6px' : '14px 0 10px' }}>
            <div style={{ width: 36, height: 4, borderRadius: 999, background: M.line }}/>
          </div>
          {title && (
            <div style={{ fontSize: 17, fontWeight: 700, padding: '2px 16px 14px', fontFamily: M.fontUI }}>
              {title}
            </div>
          )}
        </div>
        {title ? (
          <div style={{ padding: '0 16px 16px', overflowY: 'auto' }}>{children}</div>
        ) : children}
      </div>
    </div>
  );
}
