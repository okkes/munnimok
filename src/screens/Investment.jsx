import React from 'react';
import { fmtEur, fmtEurInt, PORTFOLIO, ASSETS } from '../data.jsx';
import { M, I, Divider, StatusBar, AppBar } from '../theme.jsx';
import { useNav } from '../i18n.jsx';
import { Sparkline, LineChart } from '../components.jsx';
import { Stat } from '../providers.jsx';


export function ScreenInvestment() {
  const nav = useNav();
  const change = PORTFOLIO.total - PORTFOLIO.contributed;
  const changePct = (change / PORTFOLIO.contributed) * 100;

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Investment"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap"><I name="more" size={18}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign: 'center', padding: '8px 0 22px' }}>
          <div className="m-cap">Portfolio value</div>
          <div className="m-num" style={{ fontSize: 38, fontWeight: 600, fontFamily: M.fontDisp, letterSpacing: '-0.025em', marginTop: 4 }}>{fmtEur(PORTFOLIO.total)}</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 6, padding: '4px 10px', borderRadius: 999, background: change >= 0 ? M.sageSoft : M.claySoft }}>
            <I name={change >= 0 ? 'arrow-up-right' : 'arrow-dn-right'} size={12} color={change >= 0 ? M.sage : M.clay}/>
            <span className="m-num" style={{ fontSize: 12, fontWeight: 600, color: change >= 0 ? M.sage : M.clay }}>
              {fmtEur(change)} · {changePct.toFixed(1)}%
            </span>
          </div>
        </div>

        <div className="m-card" style={{ padding: 16, marginBottom: 16, border: `1px solid ${M.line}` }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {['1W','1M','3M','1Y','ALL'].map((p, i) => (
              <button key={p} className="m-tap" style={{
                flex: 1, height: 28, borderRadius: 8, border: 'none',
                background: i === 1 ? M.ink : 'transparent', color: i === 1 ? '#fff' : M.ink3,
                fontSize: 11, fontWeight: 600,
              }}>{p}</button>
            ))}
          </div>
          <LineChart data={PORTFOLIO.curve} height={120} color={M.sage} fill="rgba(74,106,79,0.08)"/>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>This period</div>
        <div className="m-card" style={{ padding: 16, marginBottom: 16, border: `1px solid ${M.line}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Stat label="Set aside" value={fmtEur(300)} color={M.ink}/>
            <Stat label="Deployed" value={fmtEur(250)} color={M.sage}/>
            <Stat label="Queued" value={fmtEur(50)} color={M.ochre}/>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Holdings · {PORTFOLIO.positions.length}</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 18, border: `1px solid ${M.line}` }}>
          {PORTFOLIO.positions.map((h, i, a) => (
            <React.Fragment key={h.ticker}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: M.slate, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: 11, fontFamily: M.fontMono }}>
                  {h.ticker.slice(0, 4)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{h.name}</div>
                  <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{h.alloc}% allocation</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="m-num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtEur(h.value)}</div>
                  <div className="m-num" style={{ fontSize: 11, color: h.change >= 0 ? M.sage : M.clay, marginTop: 1, fontWeight: 600 }}>
                    {h.change >= 0 ? '+' : ''}{h.change.toFixed(2)}%
                  </div>
                </div>
              </div>
              {i < a.length - 1 && <Divider inset={48}/>}
            </React.Fragment>
          ))}
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>All assets</div>
        {ASSETS.map((a, i) => {
          const isProperty = a.type === 'real_estate';
          const change = a.curve[a.curve.length-1] - a.curve[a.curve.length-2];
          const changePct = (change / a.curve[a.curve.length-2] * 100).toFixed(1);
          const colors = { real_estate: M.sage, vehicle: M.ochre, pension: M.violet };
          const softs  = { real_estate: M.sageSoft, vehicle: M.ochreSoft, pension: M.violetSoft };
          const color  = colors[a.type] || M.ink2;
          const soft   = softs[a.type]  || M.paper2;
          return (
            <div key={a.id} className="m-card" style={{ padding:16, marginBottom:12, border:`1px solid ${M.line}` }}>
              <div style={{ display:'flex', alignItems:'flex-start', gap:12, marginBottom:12 }}>
                <div style={{ width:42, height:42, borderRadius:12, background:soft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name={a.icon} size={20} color={color}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:600, marginBottom:3 }}>{a.name}</div>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                    <span style={{ fontSize:11, color:M.ink3 }}>Value: <span className="m-num" style={{ color:M.ink, fontWeight:600 }}>{fmtEurInt(a.value)}</span></span>
                    {a.mortgageLeft > 0 && <span style={{ fontSize:11, color:M.ink3 }}>Mortgage: <span className="m-num" style={{ color:M.clay, fontWeight:600 }}>{fmtEurInt(a.mortgageLeft)}</span></span>}
                    {a.loanLeft > 0 && <span style={{ fontSize:11, color:M.ink3 }}>Loan: <span className="m-num" style={{ color:M.clay, fontWeight:600 }}>{fmtEurInt(a.loanLeft)}</span></span>}
                  </div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div className="m-num" style={{ fontSize:16, fontWeight:700 }}>{fmtEurInt(a.equity)}</div>
                  <div style={{ fontSize:11, marginTop:2, fontWeight:600, color:a.changeYr >= 0 ? M.sage : M.clay }}>
                    {a.changeYr >= 0 ? '+' : ''}{a.changeYr}%/yr
                  </div>
                </div>
              </div>
              <Sparkline data={a.curve} width={80} height={36} color={color} fill={soft} strokeWidth={1.8}/>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:M.ink3, marginTop:6 }}>
                <span>Equity: <span style={{ color:M.sage, fontWeight:600 }}>{Math.round(a.equity/a.value*100)}%</span></span>
                <span>{change >= 0 ? '+' : ''}{fmtEurInt(change)} this year</span>
              </div>
            </div>
          );
        })}
        <div style={{ height:8 }}/>
      </div>
    </div>
  );
}

export function ScreenInvestmentConnect() {
  const nav = useNav();
  const brokers = [
    { id: 'degiro',     name: 'DEGIRO',         sub: 'NL · most popular', supported: true },
    { id: 'trade-rep',  name: 'Trade Republic', sub: 'EU broker',         supported: true },
    { id: 'ibkr',       name: 'Interactive Brokers', sub: 'Global',       supported: true },
    { id: 'bux',        name: 'BUX Zero',       sub: 'NL',                 supported: true },
    { id: 'etoro',      name: 'eToro',          sub: 'Global',             supported: false },
  ];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Connect broker"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ padding: 16, borderRadius: 14, background: M.sageSoft, marginBottom: 16, display: 'flex', gap: 12 }}>
          <I name="lock" size={20} color={M.sage}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: M.sage }}>Read-only access</div>
            <div style={{ fontSize: 12, color: M.ink2, marginTop: 4, lineHeight: 1.45 }}>
              munni reads holdings &amp; history. No trading permissions are ever requested.
            </div>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Supported brokers</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 16, border: `1px solid ${M.line}` }}>
          {brokers.map((b, i, a) => (
            <React.Fragment key={b.id}>
              <div className="m-tap" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', opacity: b.supported ? 1 : 0.5 }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, background: M.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontFamily: M.fontDisp, fontSize: 16 }}>
                  {b.name[0]}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{b.name}</div>
                  <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{b.sub}</div>
                </div>
                {b.supported ? <I name="caretR" size={14} color={M.ink4}/> : <span style={{ fontSize: 10, color: M.ink3, fontWeight: 600 }}>Soon</span>}
              </div>
              {i < a.length - 1 && <Divider inset={50}/>}
            </React.Fragment>
          ))}
        </div>

        <button className="m-btn outline m-tap" style={{ width: '100%' }}>
          <I name="edit" size={16}/> Enter manually
        </button>
        <div style={{ fontSize: 11, color: M.ink3, textAlign: 'center', marginTop: 8, lineHeight: 1.5 }}>
          Don't see your broker? Track holdings by entering<br/>them manually. Prices still update automatically.
        </div>
      </div>
    </div>
  );
}
