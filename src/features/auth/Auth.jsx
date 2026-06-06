import React from 'react';
import { M, I, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useNav } from '../../app/nav.jsx';
import { useAppCtx } from '../../app/providers.jsx';

export function ScreenLogin() {
  const { logout: logoutFn } = useAppCtx();
  React.useEffect(() => { logoutFn(); }, []);
  return null;
}

export function ScreenSignupGate() {
  const nav = useNav();
  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title=""
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-h2" style={{ marginBottom: 6 }}>Set up munni</div>
        <div style={{ fontSize: 14, color: M.ink3, marginBottom: 28, lineHeight: 1.5 }}>
          Choose how you'd like to connect your finances.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="m-tap" onClick={() => nav.push('signupProd')}
            style={{ padding: 18, borderRadius: 14, border: `2px solid ${M.ink}`, background: M.card }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: M.sageSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <I name="lock" size={16} color={M.sage}/>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Connect your bank</div>
                <span style={{ fontSize: 10, fontWeight: 600, color: M.sage, background: M.sageSoft, padding: '2px 6px', borderRadius: 999 }}>Recommended</span>
              </div>
            </div>
            <div style={{ fontSize: 13, color: M.ink3, paddingLeft: 48, lineHeight: 1.5 }}>
              Read-only via Open Banking. ING, Rabobank, ABN AMRO, N26 and 200+ more.
            </div>
          </div>

          <div className="m-tap" onClick={() => nav.push('signupDemo')}
            style={{ padding: 18, borderRadius: 14, border: `1px solid ${M.line}`, background: M.card }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: M.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <I name="box" size={16} color={M.ink2}/>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Demo / developer</div>
                <span style={{ fontSize: 10, fontWeight: 600, color: M.ink3, background: M.paper2, padding: '2px 6px', borderRadius: 999 }}>Dev</span>
              </div>
            </div>
            <div style={{ fontSize: 13, color: M.ink3, paddingLeft: 48, lineHeight: 1.5 }}>
              Point munni at your own backend for development and feature exploration.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ScreenSignupProd() {
  const nav = useNav();
  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Connect your bank" sub="Step 1 of 2"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ padding: 14, borderRadius: 14, background: M.sageSoft, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <I name="lock" size={18} color={M.sage}/>
          <div style={{ flex: 1, fontSize: 13, color: M.sageDk, lineHeight: 1.45 }}>
            Read-only access. munni can never move money on your behalf.
          </div>
        </div>
        <div className="m-cap" style={{ marginBottom: 6, paddingLeft: 4 }}>Country</div>
        <div className="m-input" style={{ marginBottom: 16 }}>Netherlands</div>
        <div className="m-cap" style={{ marginBottom: 6, paddingLeft: 4 }}>Search your bank</div>
        <div className="m-input empty" style={{ gap: 8, marginBottom: 12 }}>
          <I name="search" size={16}/> Search 200+ banks…
        </div>
        <div className="m-card" style={{ padding: '0 16px', border: `1px solid ${M.line}` }}>
          {['ING', 'Rabobank', 'ABN AMRO', 'N26', 'Bunq'].map((b, i, a) => (
            <React.Fragment key={b}>
              <div className="m-tap" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: M.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>{b[0]}</div>
                <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{b}</div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
              {i < a.length - 1 && <Divider inset={48}/>}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ScreenSignupDemo() {
  const nav = useNav();
  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Demo setup"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ fontSize: 14, color: M.ink2, marginBottom: 24, lineHeight: 1.5 }}>
          Point munni at your self-hosted backend. We never store this URL outside your device.
        </div>
        <div className="m-cap" style={{ marginBottom: 6, paddingLeft: 4 }}>API base URL</div>
        <div className="m-input" style={{ fontFamily: M.fontMono, fontSize: 13, marginBottom: 14 }}>https://api.munni.local</div>
        <div className="m-cap" style={{ marginBottom: 6, paddingLeft: 4 }}>API token (optional)</div>
        <div className="m-input empty" style={{ marginBottom: 14 }}>paste token…</div>
        <button className="m-btn outline sm m-tap" style={{ marginBottom: 24 }}>
          <I name="check" size={14}/> Test connection
        </button>
        <div className="m-cap" style={{ marginBottom: 6, paddingLeft: 4 }}>Display name</div>
        <div className="m-input" style={{ marginBottom: 28 }}>Demo User</div>
        <button className="m-btn m-tap" style={{ width: '100%', height: 52 }} onClick={() => nav.popAll()}>
          Create demo account
        </button>
      </div>
    </div>
  );
}