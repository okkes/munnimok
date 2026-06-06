import React from 'react';
import { M, I } from './theme.jsx';
import { useLang } from './i18n.jsx';


export const DarkCtx = React.createContext({ dark: false, setDark: () => {} });
export const useDark = () => React.useContext(DarkCtx);


export const NavCtx = React.createContext(null);

export function NavProvider({ children, initial = 'home' }) {
  const [tab, setTab] = React.useState(initial);
  const [stacks, setStacks] = React.useState({ home: [], tx: [], recurring: [], events: [], insights: [], profile: [] });
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

  const value = { tab, stack: stacks[tab], push, pop, popAll, switchTab, replace };
  return <NavCtx.Provider value={value}>{children}</NavCtx.Provider>;
}

export const useNav = () => React.useContext(NavCtx);

export function TabBar({ active, onChange }) {
  const mobile = React.useMemo(() => window.matchMedia('(max-width: 430px)').matches, []);
  const { t } = useLang();
  const tabs = [
    { id: 'home',      icon: 'home',        label: t('tab.home') },
    { id: 'tx',        icon: 'list',        label: t('tab.transactions') },
    { id: 'recurring', icon: 'receipt',     label: t('tab.recurring') },
    { id: 'events',    icon: 'star',        label: t('tab.events') },
    { id: 'insights',  icon: 'trending-up', label: t('tab.insights') },
    { id: 'profile',   icon: 'sliders',     label: t('tab.settings') },
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
    @keyframes mSheetUp { from { transform: translateY(100%); } to { transform: none; } }
    @keyframes pulse { 0%,100% { opacity:0.3; transform:scale(0.8); } 50% { opacity:1; transform:scale(1); } }
    @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
    @keyframes barRise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    .m-bar-animate { transform-origin: bottom; animation: barRise 0.4s cubic-bezier(0.34,1.56,0.64,1) both; }
  `;
  document.head.appendChild(s);
}

export function Sheet({ children, onClose, open, title }) {
  if (open !== undefined && !open) return null;
  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(27,26,23,0.45)', zIndex: 50,
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
    }} onClick={onClose}>
      <div style={{
        background: M.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24,
        animation: 'mSheetUp 0.32s cubic-bezier(.2,.7,.2,1)',
        maxHeight: '88%', display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: M.line }}/>
        </div>
        {title && (
          <div style={{ fontSize: 17, fontWeight: 700, padding: '4px 16px 12px', fontFamily: M.fontUI }}>
            {title}
          </div>
        )}
        {title ? (
          <div style={{ padding: '0 16px 16px', overflowY: 'auto' }}>{children}</div>
        ) : children}
      </div>
    </div>
  );
}
