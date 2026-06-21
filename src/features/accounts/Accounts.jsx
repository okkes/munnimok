import React from 'react';
import { ACCOUNTS, DEMO_ACCOUNT_IDS, DEMO_ACCOUNTS, INTEGRATIONS, ALL_RECEIPTS, generateBankTxs, generateAsnTxs, DUTCH_BANKS, generateBankIban, ALL_BANKS, BROKERS, BANK_COUNTRY_LABELS, BANK_COUNTRY_ORDER } from './data.js';
import { fmtEur, fmtMoney, fmtMoneyInt, fmtDate, computePeriodHistory, fmtSyncTime } from '../../shared/utils/format.js';
import { getUserId, getUserSyncKey, addDevLog } from '../../shared/utils/user.js';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang, useCurrency } from '../../shared/i18n.jsx';
import { CURRENCIES, STOCK_SPACE_AVATARS } from '../../shared/constants.js';
import { useNav, Sheet } from '../../app/nav.jsx';
import { useLocalStorage } from '../../shared/hooks.jsx';
import { BarChart, StackedBar } from '../../shared/components/Charts.jsx';
import { TxRow } from '../../shared/components/TxRow.jsx';
import { useTxCtx, useProfiles, useConnectedAccounts, Stat } from '../../app/providers.jsx';
import { STOCK_AVATARS } from '../../shared/constants.js';

function HighlightText({ text, query }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return <>{text.slice(0, idx)}<mark style={{ background: M.sageSoft, color: M.sage, borderRadius: 2, padding: '0 1px' }}>{text.slice(idx, idx + query.length)}</mark>{text.slice(idx + query.length)}</>;
}

// ── Shared bank-connect screens (used by ScreenAccounts, ScreenAccountsAll, and Auth onboarding) ──

function BankRow({ bank, query, countryCode, connectedAccounts, onSelect }) {
  const connCount = (connectedAccounts || []).filter(a => a.bankId === bank.id).length;
  return (
    <div className="m-tap" onClick={() => onSelect(bank)}
      style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
      <div style={{ width:36, height:36, borderRadius:10, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18 }}>{bank.logo}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:500, color:M.ink, display:'flex', alignItems:'center', gap:6 }}>
          <HighlightText text={bank.name} query={query}/>
          {countryCode !== undefined && (
            <span style={{ fontSize:9, fontWeight:700, padding:'2px 5px', borderRadius:4, background:M.paper2, border:`1px solid ${M.line}`, color:M.ink3, fontFamily:M.fontMono, letterSpacing:'0.04em', flexShrink:0 }}>
              {countryCode || '—'}
            </span>
          )}
        </div>
        {bank.bic && <div style={{ fontSize:11, color:M.ink3, marginTop:1, fontFamily:M.fontMono }}><HighlightText text={bank.bic} query={query}/></div>}
      </div>
      {connCount > 0 ? (
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.sageSoft, color:M.sage }}>{connCount}×</span>
          <I name="caretR" size={14} color={M.sage}/>
        </div>
      ) : <I name="caretR" size={14} color={M.ink4}/>}
    </div>
  );
}

function BankSearchFullScreen({ banks, bankSearch, setBankSearch, connectedAccounts, onSelect, onBack }) {
  const q = bankSearch.trim();
  const [expanded, setExpanded] = React.useState(() => new Set(['EU', 'NL']));

  const groups = React.useMemo(() => {
    const byCountry = {};
    banks.forEach(b => {
      const key = b.country ?? '';
      if (!byCountry[key]) byCountry[key] = [];
      byCountry[key].push(b);
    });
    return BANK_COUNTRY_ORDER
      .filter(code => byCountry[code]?.length)
      .map(code => ({ code, label: BANK_COUNTRY_LABELS[code] || code, banks: byCountry[code] }));
  }, [banks]);

  const flatFiltered = React.useMemo(() => {
    if (!q) return null;
    const lq = q.toLowerCase();
    return banks.filter(b => b.name.toLowerCase().includes(lq) || (b.bic || '').toLowerCase().includes(lq));
  }, [banks, q]);

  const toggleGroup = (code) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack}
          style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>Back
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink, fontFamily:M.fontUI }}>Select a bank</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ padding:'12px 20px 8px', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, background:M.paper2, boxSizing:'border-box' }}>
          <I name="search" size={16} color={M.ink4}/>
          <input data-testid="acct-bank-search" autoFocus value={bankSearch} onChange={e => setBankSearch(e.target.value)} placeholder="Search bank or BIC…"
            style={{ flex:1, border:'none', background:'transparent', fontSize:14, fontFamily:M.fontUI, outline:'none', color:M.ink, padding:0 }}/>
          {bankSearch && <button onClick={() => setBankSearch('')} style={{ background:'none', border:'none', cursor:'pointer', padding:0, display:'flex' }}><I name="x" size={14} color={M.ink4}/></button>}
        </div>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'0 20px 24px' }}>
        {flatFiltered !== null ? (
          /* Search results — flat list with country badge */
          <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
            {flatFiltered.length === 0
              ? <div style={{ padding:'24px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>No banks match your search</div>
              : flatFiltered.map((bank, i) => (
                  <React.Fragment key={bank.id}>
                    {i > 0 && <Divider inset={48}/>}
                    <BankRow bank={bank} query={q} countryCode={bank.country ?? ''} connectedAccounts={connectedAccounts} onSelect={onSelect}/>
                  </React.Fragment>
                ))
            }
          </div>
        ) : (
          /* Accordion grouped browse */
          groups.map(group => {
            const isOpen = expanded.has(group.code);
            return (
              <div key={group.code}>
                <div className="m-tap" onClick={() => toggleGroup(group.code)}
                  style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 4px 8px', cursor:'pointer', userSelect:'none' }}>
                  {group.code && group.code !== 'EU' && (
                    <span style={{ fontSize:9, fontWeight:700, padding:'2px 5px', borderRadius:4, background:M.paper2, border:`1px solid ${M.line}`, color:M.ink3, fontFamily:M.fontMono, letterSpacing:'0.04em' }}>{group.code}</span>
                  )}
                  <span style={{ flex:1, fontSize:11, fontWeight:700, color:M.ink3, textTransform:'uppercase', letterSpacing:'0.06em' }}>{group.label}</span>
                  <span style={{ fontSize:11, color:M.ink4 }}>{group.banks.length}</span>
                  <I name={isOpen ? 'caretD' : 'caretR'} size={14} color={M.ink4}/>
                </div>
                {isOpen && (
                  <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}`, marginBottom:4 }}>
                    {group.banks.map((bank, i) => (
                      <React.Fragment key={bank.id}>
                        {i > 0 && <Divider inset={48}/>}
                        <BankRow bank={bank} query="" connectedAccounts={connectedAccounts} onSelect={onSelect}/>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function BankConnectPsd2Screen({ psd2Step, psd2Bank, customIban, setCustomIban, advancePsd2, onClose }) {
  React.useEffect(() => {
    if (psd2Step !== 'done') return;
    const t = setTimeout(advancePsd2, 2000);
    return () => clearTimeout(t);
  }, [psd2Step]);
  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        {psd2Step !== 'connecting' ? (
          <button className="m-tap" onClick={onClose}
            style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
            <I name="x" size={18} color={M.tint}/>
          </button>
        ) : <div style={{ minWidth:60 }}/>}
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink, fontFamily:M.fontUI }}>
          {psd2Step === 'login' ? psd2Bank?.name : psd2Step === 'consent' ? 'Allow access?' : psd2Step === 'done' ? 'Connected' : psd2Bank?.name}
        </div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', gap:20, overflowY:'auto' }}>
        {psd2Step === 'login' && (
          <>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:10, marginBottom:4 }}>
              <div style={{ width:64, height:64, borderRadius:18, background:`${psd2Bank?.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{psd2Bank?.logo}</div>
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:15, fontWeight:600, color:M.ink }}>Enter your bank login credentials</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:2, fontFamily:M.fontMono }}>{psd2Bank?.bic}</div>
              </div>
            </div>
            <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}` }}>
              <div style={{ padding:'14px 0' }}>
                <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>Login name</div>
                <input defaultValue="demo.user@munni.app" style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}/>
              </div>
              <Divider/>
              <div style={{ padding:'14px 0' }}>
                <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>Password</div>
                <input type="password" defaultValue="••••••••" style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}/>
              </div>
              <Divider/>
              <div style={{ padding:'14px 0' }}>
                <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>Account number (IBAN)</div>
                <input value={customIban} onChange={e => setCustomIban(e.target.value)}
                  style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontMono, background:M.paper2, outline:'none', color:M.ink }}/>
              </div>
            </div>
            <div style={{ padding:'10px 12px', borderRadius:10, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start' }}>
              <I name="lock" size={14} color={M.sage}/>
              <div style={{ fontSize:11, color:M.sageDk, lineHeight:1.5 }}>
                munni uses <strong>PSD2 Open Banking</strong>. Your credentials are sent directly to {psd2Bank?.name} — we never store them.
              </div>
            </div>
            <button className="m-btn sage m-tap" onClick={advancePsd2} style={{ marginTop:'auto' }}>Continue to {psd2Bank?.name}</button>
          </>
        )}
        {psd2Step === 'consent' && (
          <>
            <div style={{ textAlign:'center', marginBottom:8 }}>
              <div style={{ width:64, height:64, borderRadius:18, background:`${psd2Bank?.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32, margin:'0 auto 12px' }}>{psd2Bank?.logo}</div>
              <div style={{ fontSize:13, color:M.ink3 }}>munni requests read-only access to:</div>
            </div>
            <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
              {[
                { icon:'card', label:'Account information', sub:'IBAN, name, balance' },
                { icon:'receipt', label:'Transaction history', sub:'Last 13 months · read-only' },
              ].map((item, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <Divider inset={48}/>}
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <I name={item.icon} size={16} color={M.sage}/>
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, fontWeight:500 }}>{item.label}</div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{item.sub}</div>
                    </div>
                    <I name="check" size={16} color={M.sage}/>
                  </div>
                </React.Fragment>
              ))}
            </div>
            <div style={{ fontSize:12, color:M.ink3, textAlign:'center', lineHeight:1.5 }}>munni can <strong>never initiate payments</strong>. You can revoke access at any time.</div>
            <button className="m-btn sage m-tap" onClick={advancePsd2} style={{ marginTop:'auto' }}>Authorise access</button>
            <button className="m-btn outline m-tap" onClick={onClose}>Cancel</button>
          </>
        )}
        {psd2Step === 'connecting' && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, textAlign:'center' }}>
            <div style={{ width:64, height:64, borderRadius:18, background:`${psd2Bank?.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{psd2Bank?.logo}</div>
            <div style={{ display:'flex', gap:8 }}>
              {[0,1,2].map(i => <div key={i} style={{ width:8, height:8, borderRadius:999, background:M.sage, animation:`pulse 1.2s ease-in-out ${i*0.4}s infinite` }}/>)}
            </div>
            <div style={{ fontSize:15, fontWeight:600 }}>Connecting to {psd2Bank?.name}…</div>
            <div style={{ fontSize:12, color:M.ink3 }}>Fetching your accounts and transactions</div>
          </div>
        )}
        {psd2Step === 'done' && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, textAlign:'center' }}>
            <div style={{ width:80, height:80, borderRadius:24, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <I name="check" size={36} color={M.sage} stroke={2.5}/>
            </div>
            <div className="m-h2">Connected!</div>
            <div style={{ fontSize:13, color:M.ink3, lineHeight:1.5, maxWidth:260 }}>{psd2Bank?.name} is now connected. Transactions will sync automatically.</div>
            <button className="m-btn sage m-tap" onClick={advancePsd2} style={{ marginTop:8 }}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ScreenIntegrations({ params }) {
  const nav = useNav();
  const [integrations, setIntegrations] = useLocalStorage('munni_integrations', INTEGRATIONS);
  const sourceTxId = params?.sourceTxId;

  const connect = (id) => {
    setIntegrations(list => list.map(i => i.id === id ? { ...i, _pendingConnect: true } : i));
    nav.push('integrationLogin', { id, sourceTxId });
  };
  const disconnect = (id) => {
    setIntegrations(list => list.map(i => i.id === id ? { ...INTEGRATIONS.find(x => x.id === id), status: 'available' } : i));
  };

  const connected = integrations.filter(i => i.status === 'connected');
  const available = integrations.filter(i => i.status !== 'connected');

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Integrations"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {sourceTxId && (
          <div style={{ margin:'0 0 16px', padding:'12px 14px', borderRadius:12, background:M.violetSoft||'#EEE8FF', border:`1px solid #D4C8FF`, fontSize:13, color:M.violet, lineHeight:1.5 }}>
            Select a connected store to find the receipt for this transaction.
          </div>
        )}

        {connected.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Connected</div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
              {connected.map((intg, i) => (
                <React.Fragment key={intg.id}>
                  <div className="m-tap" onClick={() => nav.push('integrationReceipts', { id: intg.id, sourceTxId })} style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                    <div style={{ width:40, height:40, borderRadius:12, background:intg.color+'22', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>{intg.icon}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, fontWeight:600 }}>{intg.store}</div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{intg.category} · {intg.txCount} transactions synced</div>
                      <div style={{ fontSize:10, color:M.ink4, marginTop:1 }}>Last sync {intg.lastSync}</div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:6 }}>
                      <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.04em', textTransform:'uppercase', color:M.sage, background:M.sageSoft, padding:'2px 8px', borderRadius:999 }}>Active</div>
                      <button className="m-tap" onClick={e => { e.stopPropagation(); disconnect(intg.id); }}
                        style={{ fontSize:11, fontWeight:600, color:M.clay, background:'transparent', border:'none', cursor:'pointer', fontFamily:M.fontUI, padding:0 }}>
                        Disconnect
                      </button>
                    </div>
                  </div>
                  {i < connected.length - 1 && <Divider inset={52}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Available stores</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {available.map((intg, i) => (
            <React.Fragment key={intg.id}>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <div style={{ width:40, height:40, borderRadius:12, background:intg.color+'22', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>{intg.icon}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:600 }}>{intg.store}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{intg.category}</div>
                </div>
                <button className="m-tap" onClick={() => connect(intg.id)}
                  style={{ fontSize:13, fontWeight:600, color:M.sage, background:M.sageSoft, border:'none', borderRadius:8, padding:'7px 14px', cursor:'pointer', fontFamily:M.fontUI, flexShrink:0 }}>
                  Connect
                </button>
              </div>
              {i < available.length - 1 && <Divider inset={52}/>}
            </React.Fragment>
          ))}
        </div>

        <div style={{ padding:'8px 4px 24px', fontSize:12, color:M.ink3, lineHeight:1.6 }}>
          Connecting a store lets munni retrieve receipt details not included in your bank statements — line items, product names, and totals.
        </div>
      </div>
    </div>
  );
}

export function ScreenIntegrationLogin({ params }) {
  const nav = useNav();
  const [integrations, setIntegrations] = useLocalStorage('munni_integrations', INTEGRATIONS);
  const intg = integrations.find(i => i.id === params?.id) || INTEGRATIONS.find(i => i.id === params?.id);
  const sourceTxId = params?.sourceTxId;
  const [step, setStep] = React.useState('login'); // 'login' | 'connecting' | 'done'
  const [email, setEmail] = React.useState(intg?.id === 'int_ah' ? 'demo@ahbonus.nl' : '');
  const [password, setPassword] = React.useState(intg?.id === 'int_ah' ? '••••••••' : '');

  const doLogin = () => {
    setStep('connecting');
    setTimeout(() => {
      setIntegrations(list => list.map(i => i.id === intg?.id ? {
        ...i, status: 'connected', connectedSince: '2026-02-18', txCount: 4, lastSync: '2026-02-18', email, _pendingConnect: false
      } : i));
      setStep('done');
    }, 1800);
  };

  if (step === 'done') {
    return (
      <div className="m-screen">
        <StatusBar/>
        <AppBar title={intg?.store || 'Store'} leading={<button className="m-iconbtn m-tap" onClick={() => { nav.pop(); nav.pop(); }}><I name="arrowL" size={20}/></button>}/>
        <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:32, textAlign:'center', gap:12 }}>
          <div style={{ width:72, height:72, borderRadius:20, background:intg?.color+'22'||M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{intg?.icon}</div>
          <div style={{ width:40, height:40, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', marginTop:-16, marginLeft:32 }}>
            <I name="check" size={20} color={M.sage} stroke={2.5}/>
          </div>
          <div className="m-h2" style={{ marginTop:8 }}>{intg?.store} connected!</div>
          <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, maxWidth:260 }}>Your receipts will now be automatically matched to your transactions.</div>
          <button className="m-btn m-tap" style={{ marginTop:16 }} onClick={() => {
            if (sourceTxId) { nav.pop(); nav.pop(); nav.replace('integrationReceipts', { id: intg?.id, sourceTxId }); }
            else { nav.pop(); nav.pop(); }
          }}>
            {sourceTxId ? 'View receipts' : 'Done'}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'connecting') {
    return (
      <div className="m-screen">
        <StatusBar/>
        <AppBar title={intg?.store || 'Store'} leading={null}/>
        <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:32, textAlign:'center', gap:16 }}>
          <div style={{ width:72, height:72, borderRadius:20, background:intg?.color+'22'||M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{intg?.icon}</div>
          <div style={{ fontSize:15, fontWeight:600, marginTop:8 }}>Connecting…</div>
          <div style={{ fontSize:13, color:M.ink3 }}>Retrieving your receipts</div>
          <div style={{ display:'flex', gap:6, marginTop:8 }}>
            {[0,1,2].map(i => (
              <div key={i} style={{ width:8, height:8, borderRadius:999, background:M.sage, opacity:0.3, animation:`pulse 1.2s ease-in-out ${i*0.4}s infinite` }}/>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={`Connect ${intg?.store || 'Store'}`}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll" style={{ padding:'0 20px' }}>
        <div style={{ textAlign:'center', padding:'24px 0 28px' }}>
          <div style={{ width:72, height:72, borderRadius:20, background:intg?.color+'22'||M.paper2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32, margin:'0 auto 12px' }}>{intg?.icon}</div>
          <div style={{ fontSize:13, color:M.ink3, lineHeight:1.5 }}>Sign in with your {intg?.store} account to connect receipts.</div>
        </div>

        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:4 }}>Email address</div>
          <input value={email} onChange={e => setEmail(e.target.value)}
            placeholder={`Your ${intg?.store} email`}
            style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', border:`1px solid ${M.line}`, borderRadius:10, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}/>
        </div>
        <div style={{ marginBottom:20 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:4 }}>Password</div>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', border:`1px solid ${M.line}`, borderRadius:10, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}/>
        </div>
        <button className="m-tap" onClick={doLogin}
          style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
          Connect {intg?.store}
        </button>
        <div style={{ padding:'16px 0 24px', fontSize:11, color:M.ink4, textAlign:'center', lineHeight:1.6 }}>
          munni reads your receipts read-only. Your credentials are never stored.
        </div>
      </div>
    </div>
  );
}

export function ScreenIntegrationReceipts({ params }) {
  const nav = useNav();
  const { txs, updateTx } = useTxCtx();
  const [integrations] = useLocalStorage('munni_integrations', INTEGRATIONS);
  const intg = integrations.find(i => i.id === params?.id) || INTEGRATIONS[0];
  const sourceTxId = params?.sourceTxId;
  const sourceTx = sourceTxId ? txs.find(t => t.id === sourceTxId) : null;

  const receipts = ALL_RECEIPTS[intg.id] || [];

  const selectReceipt = (receipt) => {
    if (sourceTxId) {
      updateTx(sourceTxId, { hasReceipt: true, receiptId: receipt.id, receiptStore: intg.store, receiptItems: receipt.items, receiptTotal: receipt.total });
      nav.pop(); nav.pop(); // back to TxDetail
    }
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={`${intg.store} receipts`}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {sourceTx && (
          <div style={{ margin:'0 0 16px', padding:'12px 14px', borderRadius:12, background:M.ochreSoft, fontSize:13, color:M.ochre, lineHeight:1.5 }}>
            Matching receipts for <strong>{sourceTx.merchant}</strong> · {fmtEur(Math.abs(sourceTx.amount))}
          </div>
        )}
        {receipts.length === 0 ? (
          <div style={{ textAlign:'center', padding:'48px 0', color:M.ink3, fontSize:14 }}>No receipts found for this store.</div>
        ) : receipts.map(r => {
          const isMatch = r.matchedTxId === sourceTxId;
          return (
            <div key={r.id} className="m-tap" onClick={() => selectReceipt(r)}
              style={{ marginBottom:12, padding:'14px 16px', borderRadius:14, background:isMatch?M.sageSoft:'#fff', border:`1px solid ${isMatch?M.sage:M.line}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:r.items.length?10:0 }}>
                <div style={{ width:36, height:36, borderRadius:10, background:intg.color+'22', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>{intg.icon}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600 }}>{r.store}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{fmtDate(r.date, 'long')} · {r.items.length} items</div>
                </div>
                <div className="m-num" style={{ fontSize:15, fontWeight:700, color:isMatch?M.sage:M.ink }}>{fmtEur(r.total)}</div>
                {isMatch && <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.04em', textTransform:'uppercase', color:M.sage, background:M.sage+'22', padding:'2px 8px', borderRadius:999 }}>Match</div>}
              </div>
              {r.items.slice(0, 3).map((item, i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:M.ink3, padding:'2px 0', paddingLeft:48 }}>
                  <span>{item.qty > 1 ? `${item.qty}× ` : ''}{item.name}</span>
                  <span className="m-num">{fmtEur(item.price * item.qty)}</span>
                </div>
              ))}
              {r.items.length > 3 && <div style={{ fontSize:11, color:M.ink4, paddingLeft:48, marginTop:2 }}>+{r.items.length - 3} more items</div>}
              {sourceTxId && (
                <div style={{ marginTop:10, paddingLeft:48 }}>
                  <button className="m-tap" onClick={e => { e.stopPropagation(); selectReceipt(r); }}
                    style={{ fontSize:12, fontWeight:600, color:M.sage, background:M.sageSoft, border:'none', borderRadius:8, padding:'6px 14px', cursor:'pointer', fontFamily:M.fontUI }}>
                    Use this receipt
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const DEFAULT_PROFILES = [
  { id:'p1', name:'Personal',  icon:'user',  active:true,  accountIds:['main','save','inv'], picture: null },
  { id:'p2', name:'Family',    icon:'house', active:false, accountIds:['main'],              picture: null },
  { id:'p3', name:'Freelance', icon:'bag',   active:false, accountIds:['main'],              picture: null },
  { id:'p_demo', name:'Demo',  icon:'user',  active:false, accountIds:['main','save'],       picture: 'av7', isDemo: true },
];



// ── Financial Accounts helpers ────────────────────────────────────────────────

function acctGroup(type) {
  return ['checking','bank','saving','savings','cash','brokerage','invest'].includes(type) ? 'asset' : 'liability';
}
function acctTypeLabel(type, t) {
  const m = { checking:t('acct.bank'), bank:t('acct.bank'), saving:t('acct.saving'), savings:t('acct.saving'),
               cash:t('acct.cashWallet'), brokerage:t('acct.brokerage'), invest:t('acct.brokerage'),
               credit:t('acct.creditCard'), mortgage:t('acct.mortgage'), loan:t('acct.loan') };
  return m[type] || type;
}
function acctTypeColor(type) {
  const m = { checking:'#FF6200', bank:'#FF6200', saving:'#A8782B', savings:'#A8782B',
               cash:'#26A69A', brokerage:'#5E4A78', invest:'#5E4A78',
               credit:'#E05555', mortgage:'#D4940A', loan:'#7B61FF' };
  return m[type] || M.slate;
}
function acctIcon(type) {
  const m = { checking:'card', bank:'card', saving:'piggy', savings:'piggy',
               cash:'wallet', brokerage:'rocket', invest:'rocket',
               credit:'card', mortgage:'home', loan:'doc' };
  return m[type] || 'card';
}

function AcctTypeBadge({ type, t }) {
  const color = acctTypeColor(type);
  return (
    <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999,
      background:color+'22', color:color, textTransform:'uppercase', letterSpacing:'0.04em', flexShrink:0 }}>
      {acctTypeLabel(type, t)}
    </span>
  );
}

function AcctRow({ acct, i, t, currency, onDelete, onEdit }) {
  const color = acct.color || acctTypeColor(acct.type);
  const isLiability = acctGroup(acct.type) === 'liability';
  return (
    <React.Fragment>
      {i > 0 && <Divider inset={52}/>}
      <div data-testid="account-row" className="m-tap" onClick={() => onEdit && onEdit(acct)}
        style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
        <div style={{ width:38, height:38, borderRadius:10, background:color, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <I name={acctIcon(acct.type)} size={18} color="#fff"/>
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:14, fontWeight:600 }}>{acct.name}</div>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2, flexWrap:'wrap' }}>
            {acct.iban && <span style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono }}>{acct.iban}</span>}
            <AcctTypeBadge type={acct.type} t={t}/>
            {acct.readOnly
              ? <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase' }}>{t('acct.automated')}</span>
              : <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.paper2, color:M.ink3, textTransform:'uppercase', border:`1px solid ${M.line}` }}>{t('acct.manual')}</span>
            }
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div className="m-num" style={{ fontSize:14, fontWeight:600, color: isLiability ? M.clay : M.ink }}>
            {fmtMoney(acct.balance || 0, currency)}
          </div>
          <button className="m-tap" onClick={e => { e.stopPropagation(); onDelete(acct); }}
            style={{ background:'none', border:'none', padding:4, cursor:'pointer', opacity:0.6 }}>
            <I name="x" size={13} color={M.ink4}/>
          </button>
        </div>
      </div>
    </React.Fragment>
  );
}

// ── Account type selector ────────────────────────────────────────────────────

function AccountTypeSelectScreen({ onSelect, onBack, filter }) {
  const { t } = useLang();
  const ASSET_TYPES = [
    { id:'bank',     icon:'card',   label:t('acct.bank'),       sub:t('acct.bankDesc') },
    { id:'saving',   icon:'piggy',  label:t('acct.saving'),     sub:t('acct.savingDesc') },
    { id:'cash',     icon:'wallet', label:t('acct.cashWallet'), sub:t('acct.cashDesc') },
    { id:'brokerage',icon:'rocket', label:t('acct.brokerage'),  sub:t('acct.brokerageDesc') },
  ];
  const LIAB_TYPES = [
    { id:'credit',   icon:'card',   label:t('acct.creditCard'), sub:t('acct.creditDesc') },
    { id:'mortgage', icon:'home',   label:t('acct.mortgage'),   sub:t('acct.mortgageDesc') },
    { id:'loan',     icon:'doc',    label:t('acct.loan'),       sub:t('acct.loanDesc') },
  ];
  const showAssets = !filter || filter === 'asset';
  const showLiabs  = !filter || filter === 'liability';
  const renderTypes = (types) => types.map((tp, i) => (
    <React.Fragment key={tp.id}>
      {i > 0 && <Divider inset={52}/>}
      <div data-testid={`acct-type-${tp.id}`} className="m-tap" onClick={() => onSelect(tp.id)}
        style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
        <div style={{ width:38, height:38, borderRadius:10, background:acctTypeColor(tp.id)+'22', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <I name={tp.icon} size={18} color={acctTypeColor(tp.id)}/>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:600 }}>{tp.label}</div>
          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{tp.sub}</div>
        </div>
        <I name="caretR" size={14} color={M.ink4}/>
      </div>
    </React.Fragment>
  ));
  const title = filter === 'asset' ? t('acct.assets') : filter === 'liability' ? t('acct.liabilities') : t('acct.selectType');
  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack}
          style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{title}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'16px 20px 32px' }}>
        {showAssets && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('acct.assets')} — {t('acct.assetDesc')}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>{renderTypes(ASSET_TYPES)}</div>
        </>}
        {showLiabs && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('acct.liabilities')} — {t('acct.liabilityDesc')}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>{renderTypes(LIAB_TYPES)}</div>
        </>}
      </div>
    </div>
  );
}

// ── Manual/Automated method selector ────────────────────────────────────────

function AccountMethodScreen({ typeLabel, onManual, onAutomatic, onBack }) {
  const { t } = useLang();
  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack}
          style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{typeLabel}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'24px 20px' }}>
        <div data-testid="acct-method-manual" className="m-tap" onClick={onManual}
          style={{ padding:'18px 20px', borderRadius:14, border:`1.5px solid ${M.line}`, background:M.card, marginBottom:12, display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ width:44, height:44, borderRadius:12, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <I name="plus" size={20} color={M.sage}/>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15, fontWeight:700 }}>{t('acct.manual')}</div>
            <div style={{ fontSize:12, color:M.ink3, marginTop:2 }}>Enter balance and details manually</div>
          </div>
          <I name="caretR" size={14} color={M.ink4}/>
        </div>
        <div data-testid="acct-method-auto" className="m-tap" onClick={onAutomatic}
          style={{ padding:'18px 20px', borderRadius:14, border:`1.5px solid ${M.line}`, background:M.card, marginBottom:16, display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ width:44, height:44, borderRadius:12, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <I name="sync" size={20} color={M.sage}/>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15, fontWeight:700 }}>{t('acct.automated')}</div>
            <div style={{ fontSize:12, color:M.ink3, marginTop:2 }}>Sync via Open Banking — read-only</div>
          </div>
          <I name="caretR" size={14} color={M.ink4}/>
        </div>
        <div style={{ padding:'12px 16px', borderRadius:12, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start' }}>
          <I name="lock" size={16} color={M.sage}/>
          <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5 }}>{t('acct.psd2Notice')}</div>
        </div>
      </div>
    </div>
  );
}

// ── Reusable inline currency sheet ──────────────────────────────────────────

function CurrencySheet({ open, current, onSelect, onClose, t }) {
  return (
    <Sheet open={open} onClose={onClose} title={t('acct.currency')}>
      <div style={{ overflowY:'auto', flex:1 }}>
        <div className="m-card" style={{ padding:'4px 16px', margin:'0 0 24px', border:`1px solid ${M.line}` }}>
          {CURRENCIES.map((cur, i) => (
            <React.Fragment key={cur.code}>
              {i > 0 && <Divider inset={0}/>}
              <div className="m-tap" onClick={() => onSelect(cur.code)}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                <span style={{ width:36, textAlign:'center', fontSize:16, fontWeight:700, color:M.sage }}>{cur.symbol}</span>
                <div style={{ flex:1 }}>
                  <span style={{ fontSize:14 }}>{cur.name}</span>
                  <span style={{ fontSize:11, color:M.ink3, marginLeft:8, fontFamily:M.fontMono }}>{cur.code}</span>
                </div>
                {current === cur.code && <I name="check" size={16} color={M.sage}/>}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

// ── Bank / Saving / Credit Manual form ──────────────────────────────────────

function BankManualForm({ typeLabel, typeId, defaultCurrency, onSave, onBack }) {
  const { t } = useLang();
  const [bankSearch, setBankSearch] = React.useState('');
  const [selectedBank, setSelectedBank] = React.useState(null);
  const [showBankSearch, setShowBankSearch] = React.useState(true);
  const [displayName, setDisplayName] = React.useState('');
  const [accountNum, setAccountNum] = React.useState('');
  const [balance, setBalance] = React.useState('0');
  const [currency, setCurrency] = React.useState(defaultCurrency || 'EUR');
  const [showCurrSheet, setShowCurrSheet] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const curInfo = CURRENCIES.find(c => c.code === currency);

  const handleSave = () => {
    const errs = {};
    if (!selectedBank) errs.bank = 'Select a bank';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    onSave({
      id: `acct_${Date.now()}`,
      name: displayName.trim() || (selectedBank?.id === 'other' ? typeLabel : selectedBank?.name || typeLabel),
      type: typeId,
      iban: accountNum.trim(),
      balance: parseFloat(balance) || 0,
      currency,
      color: selectedBank?.color || acctTypeColor(typeId),
      bankId: selectedBank?.id,
    });
  };

  if (showBankSearch) {
    const filteredBanks = ALL_BANKS.filter(b => !bankSearch || b.name.toLowerCase().includes(bankSearch.toLowerCase()) || (b.bic && b.bic.toLowerCase().includes(bankSearch.toLowerCase())));
    return (
      <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
        <StatusBar/>
        <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
          <button className="m-tap" onClick={onBack}
            style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
            <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
          </button>
          <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{typeLabel}</div>
          <div style={{ minWidth:60 }}/>
        </div>
        <div style={{ padding:'12px 20px 8px', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, background:M.paper2 }}>
            <I name="search" size={16} color={M.ink4}/>
            <input autoFocus data-testid="acct-bank-search"
              value={bankSearch} onChange={e => setBankSearch(e.target.value)}
              placeholder={t('acct.bankSearch')}
              style={{ flex:1, border:'none', background:'transparent', fontSize:14, fontFamily:M.fontUI, outline:'none', color:M.ink, padding:0 }}/>
          </div>
          {errors.bank && <div style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.bank}</div>}
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'0 20px 24px' }}>
          <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
            {filteredBanks.length === 0 && <div style={{ padding:'20px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('onboarding.noResults')}</div>}
            {filteredBanks.map((bank, i) => (
              <React.Fragment key={bank.id}>
                {i > 0 && <Divider inset={48}/>}
                <div data-testid={`bank-row-${bank.id}`} className="m-tap"
                  onClick={() => { setSelectedBank(bank); setShowBankSearch(false); }}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                  <div style={{ width:36, height:36, borderRadius:10, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18 }}>
                    {bank.logo}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:500 }}><HighlightText text={bank.name} query={bankSearch.trim()}/></div>
                    {bank.bic && <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono, marginTop:1 }}>{bank.bic}</div>}
                  </div>
                  {bank.country && <span style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:4, background:M.paper2, color:M.ink3 }}>{bank.country}</span>}
                  <I name="caretR" size={14} color={M.ink4}/>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={() => setShowBankSearch(true)}
          style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{typeLabel}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'20px 20px 32px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderRadius:12, background:M.sageSoft, marginBottom:20 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:`${selectedBank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18 }}>
            {selectedBank.logo}
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:600 }}>{selectedBank.name}</div>
            {selectedBank.bic && <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono }}>{selectedBank.bic}</div>}
          </div>
          <button className="m-tap" onClick={() => setShowBankSearch(true)}
            style={{ fontSize:12, color:M.sage, background:'none', border:'none', cursor:'pointer', fontFamily:M.fontUI, fontWeight:600 }}>Change</button>
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.displayName')}</div>
          <input data-testid="acct-display-name"
            value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder={selectedBank.id === 'other' ? t('acct.displayNameRequired') : selectedBank.name}
            style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.accountNumber')}</div>
          <input data-testid="acct-account-number"
            value={accountNum} onChange={e => setAccountNum(e.target.value)}
            placeholder="e.g. NL12 INGB 0123 4567 89"
            style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.currency')}</div>
          <button data-testid="acct-currency-btn" className="m-tap"
            onClick={() => setShowCurrSheet(true)}
            style={{ width:'100%', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between', color:M.ink }}>
            <span>{curInfo ? `${curInfo.code} (${curInfo.symbol})` : currency}</span>
            <I name="caretR" size={14} color={M.ink4}/>
          </button>
        </div>
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.initialBalance')}</div>
          <input data-testid="acct-initial-balance" type="number"
            value={balance} onChange={e => setBalance(e.target.value)} placeholder="0"
            style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
        </div>
        <button data-testid="acct-save-btn" className="m-btn sage m-tap" style={{ width:'100%' }} onClick={handleSave}>
          {t('action.save')}
        </button>
      </div>
      <CurrencySheet open={showCurrSheet} current={currency} onSelect={c => { setCurrency(c); setShowCurrSheet(false); }} onClose={() => setShowCurrSheet(false)} t={t}/>
    </div>
  );
}

// ── Cash Wallet form ─────────────────────────────────────────────────────────

function CashWalletForm({ defaultCurrency, onSave, onBack }) {
  const { t } = useLang();
  const [displayName, setDisplayName] = React.useState('');
  const [balance, setBalance] = React.useState('0');
  const [currency, setCurrency] = React.useState(defaultCurrency || 'EUR');
  const [purpose, setPurpose] = React.useState('daily');
  const [selectedIcon, setSelectedIcon] = React.useState('sp7');
  const [showCurrSheet, setShowCurrSheet] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const CASH_ICONS = STOCK_SPACE_AVATARS;
  const curInfo = CURRENCIES.find(c => c.code === currency);

  const handleSave = () => {
    if (!displayName.trim()) { setErrors({ name: t('acct.displayNameRequired') }); return; }
    const icon = CASH_ICONS.find(i => i.id === selectedIcon);
    onSave({ id:`acct_cash_${Date.now()}`, name:displayName.trim(), type:'cash', iban:'',
      balance:parseFloat(balance)||0, currency, color:icon?.bg||M.sage, purpose });
  };

  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack}
          style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{t('acct.cashWallet')}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'20px 20px 32px' }}>
        <div style={{ padding:'12px 16px', borderRadius:12, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start', marginBottom:20 }}>
          <I name="info" size={16} color={M.sage}/>
          <div style={{ fontSize:12, color:M.ink2, lineHeight:1.55 }}>{t('acct.usageNotice')}</div>
        </div>
        <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>{t('acct.iconPicker')}</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:20 }}>
          {CASH_ICONS.map(ic => (
            <button key={ic.id} data-testid={`cash-icon-${ic.id}`} className="m-tap"
              onClick={() => setSelectedIcon(ic.id)}
              style={{ width:44, height:44, borderRadius:12, background:selectedIcon===ic.id?ic.bg:M.paper2,
                border:`2px solid ${selectedIcon===ic.id?ic.bg:M.line}`,
                display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', fontSize:20 }}>
              {ic.emoji}
            </button>
          ))}
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.displayNameRequired')} *</div>
          <input data-testid="cash-display-name"
            value={displayName} onChange={e => { setDisplayName(e.target.value); setErrors({}); }}
            placeholder={t('acct.cashWallet')}
            style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10,
              border:`1px solid ${errors.name?M.clay:M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
          {errors.name && <div style={{ fontSize:11, color:M.clay, marginTop:3 }}>{errors.name}</div>}
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>{t('acct.purpose')}</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            {[['daily',t('acct.purposeDaily')],['saving',t('acct.purposeSaving')]].map(([val,label]) => (
              <button key={val} data-testid={`cash-purpose-${val}`} className="m-tap"
                onClick={() => setPurpose(val)}
                style={{ padding:'10px 0', borderRadius:10, border:`1.5px solid ${purpose===val?M.sage:M.line}`,
                  background:purpose===val?M.sageSoft:M.paper2, color:purpose===val?M.sage:M.ink2,
                  fontSize:13, fontWeight:purpose===val?700:400, cursor:'pointer', fontFamily:M.fontUI }}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.currency')}</div>
          <button data-testid="cash-currency-btn" className="m-tap"
            onClick={() => setShowCurrSheet(true)}
            style={{ width:'100%', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between', color:M.ink }}>
            <span>{curInfo?`${curInfo.code} (${curInfo.symbol})`:currency}</span>
            <I name="caretR" size={14} color={M.ink4}/>
          </button>
        </div>
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.initialBalance')}</div>
          <input data-testid="cash-initial-balance" type="number"
            value={balance} onChange={e => setBalance(e.target.value)} placeholder="0"
            style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
        </div>
        <button data-testid="cash-save-btn" className="m-btn sage m-tap" style={{ width:'100%' }} onClick={handleSave}>
          {t('action.save')}
        </button>
      </div>
      <CurrencySheet open={showCurrSheet} current={currency} onSelect={c=>{setCurrency(c);setShowCurrSheet(false);}} onClose={()=>setShowCurrSheet(false)} t={t}/>
    </div>
  );
}

// ── Broker flows ─────────────────────────────────────────────────────────────

function BrokerManualForm({ defaultCurrency, onSave, onBack }) {
  const { t } = useLang();
  const [search, setSearch] = React.useState('');
  const [selectedBroker, setSelectedBroker] = React.useState(null);
  const [displayName, setDisplayName] = React.useState('');
  const [currency, setCurrency] = React.useState(defaultCurrency||'EUR');
  const [showCurrSheet, setShowCurrSheet] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const curInfo = CURRENCIES.find(c => c.code === currency);
  const filtered = BROKERS.filter(b => !search || b.name.toLowerCase().includes(search.toLowerCase()));
  const handleSave = () => {
    if (!selectedBroker) { setErrors({broker:'Select a broker'}); return; }
    onSave({ id:`acct_broker_${Date.now()}`,
      name:displayName.trim()||(selectedBroker.id==='other_broker'?'Brokerage':selectedBroker.name),
      type:'brokerage', iban:'', balance:0, currency, color:selectedBroker.color, brokerId:selectedBroker.id });
  };
  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{t('acct.brokerage')}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ padding:'12px 20px 8px', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, background:M.paper2 }}>
          <I name="search" size={16} color={M.ink4}/>
          <input autoFocus data-testid="broker-search" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder={t('acct.brokerSearch')}
            style={{ flex:1, border:'none', background:'transparent', fontSize:14, fontFamily:M.fontUI, outline:'none', color:M.ink, padding:0 }}/>
        </div>
        {errors.broker && <div style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.broker}</div>}
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'8px 20px' }}>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {filtered.map((b, i) => (
            <React.Fragment key={b.id}>
              {i>0&&<Divider inset={48}/>}
              <div data-testid={`broker-row-${b.id}`} className="m-tap" onClick={()=>setSelectedBroker(b)}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0', background:selectedBroker?.id===b.id?M.sageSoft:'transparent' }}>
                <div style={{ width:36, height:36, borderRadius:10, background:`${b.color}22`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <span style={{ fontSize:18 }}>{b.logo}</span>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}><HighlightText text={b.name} query={search.trim()}/></div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{b.region}</div>
                </div>
                {selectedBroker?.id===b.id&&<I name="check" size={16} color={M.sage}/>}
              </div>
            </React.Fragment>
          ))}
        </div>
        {selectedBroker && (
          <>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.displayName')}</div>
              <input data-testid="broker-display-name" value={displayName} onChange={e=>setDisplayName(e.target.value)}
                placeholder={selectedBroker.name}
                style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
            </div>
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.currency')} (locked after creation)</div>
              <button data-testid="broker-currency-btn" className="m-tap" onClick={()=>setShowCurrSheet(true)}
                style={{ width:'100%', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between', color:M.ink }}>
                <span>{curInfo?`${curInfo.code} (${curInfo.symbol})`:currency}</span>
                <I name="caretR" size={14} color={M.ink4}/>
              </button>
            </div>
            <button data-testid="broker-save-btn" className="m-btn sage m-tap" style={{ width:'100%' }} onClick={handleSave}>
              {t('action.save')}
            </button>
          </>
        )}
      </div>
      <CurrencySheet open={showCurrSheet} current={currency} onSelect={c=>{setCurrency(c);setShowCurrSheet(false);}} onClose={()=>setShowCurrSheet(false)} t={t}/>
    </div>
  );
}

function BrokerAutoFlow({ onSave, onBack }) {
  const { t } = useLang();
  const [step, setStep] = React.useState('search');
  const [selectedBroker, setSelectedBroker] = React.useState(null);
  const [search, setSearch] = React.useState('');
  const filtered = BROKERS.filter(b => b.id!=='other_broker' && (!search || b.name.toLowerCase().includes(search.toLowerCase())));

  const handleConnect = () => {
    setStep('connecting');
    setTimeout(() => {
      onSave({ id:`acct_broker_auto_${Date.now()}`, name:selectedBroker.name, type:'brokerage',
        iban:'', balance:parseFloat((5000+Math.random()*20000).toFixed(2)), currency:'EUR',
        color:selectedBroker.color, brokerId:selectedBroker.id, readOnly:true });
    }, 1800);
  };

  if (step==='connecting') return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, padding:'0 40px', textAlign:'center' }}>
      <StatusBar/>
      <div style={{ width:64, height:64, borderRadius:18, background:`${selectedBroker?.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{selectedBroker?.logo}</div>
      <div style={{ fontSize:16, fontWeight:600 }}>Connecting to {selectedBroker?.name}…</div>
      <div style={{ fontSize:13, color:M.ink3 }}>Fetching your portfolio</div>
    </div>
  );

  if (step==='auth') return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={()=>setStep('search')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16 }}>{selectedBroker?.name}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'24px 24px 32px', display:'flex', flexDirection:'column', gap:16 }}>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, marginBottom:8 }}>
          <div style={{ width:64, height:64, borderRadius:18, background:`${selectedBroker?.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{selectedBroker?.logo}</div>
          <div style={{ fontSize:14, fontWeight:600 }}>Connect {selectedBroker?.name}</div>
          <div style={{ fontSize:12, color:M.ink3 }}>Enter your login credentials</div>
        </div>
        <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}` }}>
          <div style={{ padding:'14px 0' }}>
            <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>Username</div>
            <input data-testid="broker-creds-username" defaultValue="demo.user@munni.app"
              style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
          </div>
          <Divider/>
          <div style={{ padding:'14px 0' }}>
            <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>Password</div>
            <input type="password" defaultValue="••••••••"
              style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
          </div>
        </div>
        <button data-testid="broker-connect-btn" className="m-btn sage m-tap" style={{ width:'100%' }} onClick={handleConnect}>
          {t('acct.connectBroker')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16 }}>{t('acct.connectBroker')}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ padding:'12px 20px 8px', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, background:M.paper2 }}>
          <I name="search" size={16} color={M.ink4}/>
          <input autoFocus data-testid="broker-auto-search" value={search} onChange={e=>setSearch(e.target.value)}
            placeholder={t('acct.brokerSearch')}
            style={{ flex:1, border:'none', background:'transparent', fontSize:14, fontFamily:M.fontUI, outline:'none', color:M.ink, padding:0 }}/>
        </div>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'8px 20px 24px' }}>
        <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
          {filtered.map((b, i) => (
            <React.Fragment key={b.id}>
              {i>0&&<Divider inset={48}/>}
              <div data-testid={`broker-auto-row-${b.id}`} className="m-tap" onClick={()=>{setSelectedBroker(b);setStep('auth');}}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                <div style={{ width:36, height:36, borderRadius:10, background:`${b.color}22`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><span style={{ fontSize:18 }}>{b.logo}</span></div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}><HighlightText text={b.name} query={search.trim()}/></div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{b.region}</div>
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Mortgage form ─────────────────────────────────────────────────────────────

function MortgageForm({ defaultCurrency, onSave, onBack }) {
  const { t } = useLang();
  const [vals, setVals] = React.useState({ name:'', lender:'', original:'', balance:'', rate:'', years:'', monthly:'' });
  const [errors, setErrors] = React.useState({});
  const set = (k) => (e) => setVals(v=>({...v,[k]:e.target.value}));

  const handleSave = () => {
    const errs = {};
    if (!vals.lender.trim()) errs.lender = 'Required';
    if (!vals.original) errs.original = 'Required';
    if (!vals.balance) errs.balance = 'Required';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    onSave({ id:`acct_mortgage_${Date.now()}`, name:vals.name.trim()||`Mortgage · ${vals.lender.trim()}`,
      type:'mortgage', iban:'', balance:-(parseFloat(vals.balance)||0), currency:defaultCurrency||'EUR',
      color:M.ochre, lender:vals.lender.trim(), originalAmount:parseFloat(vals.original)||0,
      interestRate:parseFloat(vals.rate)||0, contractYears:parseInt(vals.years)||0,
      monthlyPayment:parseFloat(vals.monthly)||0 });
  };

  const fld = (label, key, placeholder, type='text', required=false) => (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{label}{required&&' *'}</div>
      <input data-testid={`mortgage-${key}`} type={type} value={vals[key]} onChange={set(key)} placeholder={placeholder}
        style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10,
          border:`1px solid ${errors[key]?M.clay:M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
      {errors[key]&&<div style={{ fontSize:11, color:M.clay, marginTop:3 }}>{errors[key]}</div>}
    </div>
  );

  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{t('acct.mortgage')}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'20px 20px 32px' }}>
        {fld(t('acct.displayName'),'name','My Home')}
        {fld(t('acct.lenderName'),'lender','e.g. ING Bank','text',true)}
        {fld(t('acct.originalAmount'),'original','e.g. 320000','number',true)}
        {fld(t('acct.currentBalance'),'balance','e.g. 280000','number',true)}
        {fld(t('acct.interestRate'),'rate','e.g. 3.5','number')}
        {fld(t('acct.contractYears'),'years','e.g. 30','number')}
        {fld(t('acct.monthlyPayment'),'monthly','e.g. 1200','number')}
        <button data-testid="mortgage-save-btn" className="m-btn sage m-tap" style={{ width:'100%', marginTop:8 }} onClick={handleSave}>
          {t('action.save')}
        </button>
      </div>
    </div>
  );
}

// ── Loan flow ─────────────────────────────────────────────────────────────────

function LoanFlow({ defaultCurrency, onSave, onBack }) {
  const { t } = useLang();
  const [loanType, setLoanType] = React.useState(null);
  const [vals, setVals] = React.useState({ name:'', lender:'', original:'', balance:'', rate:'', monthly:'', startDate:'' });
  const [currency, setCurrency] = React.useState(defaultCurrency||'EUR');
  const [showCurrSheet, setShowCurrSheet] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const curInfo = CURRENCIES.find(c => c.code === currency);
  const LOAN_TYPES = [
    {id:'personal',label:t('acct.loanPersonal')},{id:'car',label:t('acct.loanCar')},
    {id:'student',label:t('acct.loanStudent')},{id:'other',label:t('acct.loanOther')},
  ];
  const set = (k) => (e) => setVals(v=>({...v,[k]:e.target.value}));

  const handleSave = () => {
    const errs = {};
    if (!vals.lender.trim()) errs.lender='Required';
    if (!vals.original) errs.original='Required';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    const loanLabel = LOAN_TYPES.find(l=>l.id===loanType)?.label||t('acct.loan');
    onSave({ id:`acct_loan_${Date.now()}`,
      name:vals.name.trim()||`${loanLabel} · ${vals.lender.trim()}`,
      type:'loan', iban:'', balance:-(parseFloat(vals.balance)||0), currency, color:M.violet,
      loanType, lender:vals.lender.trim(), originalAmount:parseFloat(vals.original)||0,
      interestRate:parseFloat(vals.rate)||0, monthlyPayment:parseFloat(vals.monthly)||0,
      startDate:vals.startDate });
  };

  if (!loanType) return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{t('acct.loanType')}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'20px 20px 32px' }}>
        <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
          {LOAN_TYPES.map((lt,i) => (
            <React.Fragment key={lt.id}>
              {i>0&&<Divider inset={0}/>}
              <div data-testid={`loan-type-${lt.id}`} className="m-tap" onClick={()=>setLoanType(lt.id)}
                style={{ display:'flex', alignItems:'center', padding:'14px 0' }}>
                <div style={{ flex:1, fontSize:14, fontWeight:500 }}>{lt.label}</div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );

  const fld = (label, key, placeholder, type='text', required=false) => (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{label}{required&&' *'}</div>
      <input data-testid={`loan-${key}`} type={type} value={vals[key]} onChange={set(key)} placeholder={placeholder}
        style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10,
          border:`1px solid ${errors[key]?M.clay:M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
      {errors[key]&&<div style={{ fontSize:11, color:M.clay, marginTop:3 }}>{errors[key]}</div>}
    </div>
  );

  const loanLabel = LOAN_TYPES.find(l=>l.id===loanType)?.label||t('acct.loan');
  return (
    <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
      <StatusBar/>
      <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
        <button className="m-tap" onClick={()=>setLoanType(null)} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
          <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
        </button>
        <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink }}>{loanLabel}</div>
        <div style={{ minWidth:60 }}/>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'20px 20px 32px' }}>
        {fld(t('acct.displayName'),'name','')}
        {fld(t('acct.lenderName'),'lender','e.g. ABN AMRO','text',true)}
        {fld(t('acct.originalAmount'),'original','e.g. 15000','number',true)}
        {fld(t('acct.currentBalance'),'balance','e.g. 12000','number')}
        {fld(t('acct.interestRate'),'rate','e.g. 5.5','number')}
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.currency')}</div>
          <button data-testid="loan-currency-btn" className="m-tap" onClick={()=>setShowCurrSheet(true)}
            style={{ width:'100%', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between', color:M.ink }}>
            <span>{curInfo?`${curInfo.code} (${curInfo.symbol})`:currency}</span>
            <I name="caretR" size={14} color={M.ink4}/>
          </button>
        </div>
        {fld(t('acct.monthlyPayment'),'monthly','e.g. 350','number')}
        {fld(t('acct.startDate'),'startDate','','date')}
        <button data-testid="loan-save-btn" className="m-btn sage m-tap" style={{ width:'100%', marginTop:8 }} onClick={handleSave}>
          {t('action.save')}
        </button>
      </div>
      <CurrencySheet open={showCurrSheet} current={currency} onSelect={c=>{setCurrency(c);setShowCurrSheet(false);}} onClose={()=>setShowCurrSheet(false)} t={t}/>
    </div>
  );
}

// ── Main Financial Accounts screen ───────────────────────────────────────────

export function ScreenAccounts({ params }) {
  const nav = useNav();
  const { t } = useLang();
  const { currency } = useCurrency();
  const { addTxs } = useTxCtx();
  const [connectedAccounts, setConnectedAccounts] = useConnectedAccounts();
  const { profiles, setProfiles } = useProfiles();
  // spaceId present = came from space detail "Manage accounts" → auto-attach new accounts to that space
  const attachToSpaceId = params?.spaceId || null;

  // New flow state machine
  const [flowScreen, setFlowScreen] = React.useState(null); // null=main | 'typeSelect' | 'bankMethod' | 'bankManual' | 'bankAuto' | 'cashForm' | 'brokerMethod' | 'brokerManual' | 'brokerAuto' | 'creditMethod' | 'creditManual' | 'creditAuto' | 'savingMethod' | 'savingManual' | 'savingAuto' | 'mortgageForm' | 'loanFlow'
  const [typeFilter, setTypeFilter] = React.useState(null); // null=all | 'asset' | 'liability'
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(null);
  const [showEditSheet, setShowEditSheet] = React.useState(null); // null | acct object
  const [editName, setEditName] = React.useState('');
  const [editIban, setEditIban] = React.useState('');

  // PSD2 auto flow state (for bank/saving/credit automated)
  const [psd2Step, setPsd2Step] = React.useState(null);
  const [psd2Bank, setPsd2Bank] = React.useState(null);
  const [customIban, setCustomIban] = React.useState('');
  const [bankSearch, setBankSearch] = React.useState('');
  const [selectedBank, setSelectedBank] = useLocalStorage('munni_selected_bank', null);
  const [psd2TypeId, setPsd2TypeId] = React.useState('bank');

  const startBankConnect = (bank) => {
    setCustomIban(generateBankIban(bank));
    setPsd2Bank(bank);
    setSelectedBank(bank.id);
    setPsd2Step('login');
  };

  const advancePsd2 = () => {
    if (psd2Step === 'login') setPsd2Step('consent');
    else if (psd2Step === 'consent') {
      setPsd2Step('connecting');
      const bank = psd2Bank;
      const savedIban = customIban;
      setTimeout(() => {
        const bankColors = { ing:'#ff6200', abn:'#00a63c', rabo:'#da1913', sns:'#e20082', asn:'#7ab800', triodos:'#00ac42', bunq:'#00ccff', knab:'#0057b8', regio:'#e4003a', revolut:'#191c1f', n26:'#1e1e1e', wise:'#9fe870' };
        const newAcct = {
          id: `bank_${Date.now()}`,
          name: bank.name,
          type: psd2TypeId === 'saving' ? 'saving' : psd2TypeId === 'credit' ? 'credit' : 'bank',
          iban: savedIban.trim() || generateBankIban(bank),
          color: bankColors[bank.id] || bank.color || M.slate,
          bankId: bank.id,
          readOnly: true,
        };
        const isAsn = bank.id === 'asn' || bank.name.toLowerCase().includes('asn');
        const newBalance = isAsn ? 3245.67 : parseFloat((1000 + Math.random() * 8000).toFixed(2));
        setConnectedAccounts(a => [...a, { ...newAcct, balance: newBalance }]);
        const newTxs = isAsn ? generateAsnTxs(newAcct.id) : generateBankTxs(newAcct.id, bank.name);
        addTxs(newTxs);
        if (attachToSpaceId) {
          setProfiles(ps => ps.map(p => p.id === attachToSpaceId ? { ...p, accountIds: [...(p.accountIds||[]), newAcct.id] } : p));
        }
        setSelectedBank(null);
        setPsd2Step('done');
      }, 1800);
    }
    else if (psd2Step === 'done') { setPsd2Step(null); setFlowScreen(null); }
  };

  const handleSaveNewAccount = (acct) => {
    setConnectedAccounts(a => [...a, acct]);
    if (attachToSpaceId) {
      setProfiles(ps => ps.map(p => p.id === attachToSpaceId ? { ...p, accountIds: [...(p.accountIds||[]), acct.id] } : p));
    }
    setFlowScreen(null);
  };

  const confirmDelete = (acct) => {
    setConnectedAccounts(a => a.filter(x => x.id !== acct.id));
    setShowDeleteConfirm(null);
  };

  const openEdit = (acct) => {
    setEditName(acct.name || '');
    setEditIban(acct.iban || '');
    setShowEditSheet(acct);
  };

  const saveEdit = () => {
    if (!showEditSheet) return;
    setConnectedAccounts(a => a.map(x => x.id !== showEditSheet.id ? x : {
      ...x,
      name: editName.trim() || x.name,
      iban: editIban.trim(),
    }));
    setShowEditSheet(null);
  };

  // PSD2 auto back: return to the correct method screen based on which type started the flow
  const psd2MethodScreen = { bank:'bankMethod', saving:'savingMethod', credit:'creditMethod' }[psd2TypeId] || 'typeSelect';

  // PSD2 flow screens (for automated bank/saving/credit)
  if (psd2Step === 'search') {
    return <BankSearchFullScreen banks={ALL_BANKS} bankSearch={bankSearch} setBankSearch={setBankSearch} connectedAccounts={connectedAccounts} onSelect={startBankConnect} onBack={() => { setPsd2Step(null); setFlowScreen(psd2MethodScreen); }}/>;
  }
  if (psd2Step === 'done') {
    return <BankConnectPsd2Screen psd2Step="done" psd2Bank={psd2Bank} customIban={customIban} setCustomIban={setCustomIban} advancePsd2={() => { setPsd2Step(null); setFlowScreen(null); }} onClose={() => { setPsd2Step(null); setFlowScreen(null); }}/>;
  }
  if (psd2Step) {
    return <BankConnectPsd2Screen psd2Step={psd2Step} psd2Bank={psd2Bank} customIban={customIban} setCustomIban={setCustomIban} advancePsd2={advancePsd2} onClose={() => { setPsd2Step(null); setFlowScreen(psd2MethodScreen); }}/>;
  }

  // New account creation flows
  if (flowScreen === 'typeSelect') return <AccountTypeSelectScreen filter={typeFilter} onSelect={type => {
    if (type === 'bank') setFlowScreen('bankMethod');
    else if (type === 'saving') setFlowScreen('savingMethod');
    else if (type === 'cash') setFlowScreen('cashForm');
    else if (type === 'brokerage') setFlowScreen('brokerMethod');
    else if (type === 'credit') setFlowScreen('creditMethod');
    else if (type === 'mortgage') setFlowScreen('mortgageForm');
    else if (type === 'loan') setFlowScreen('loanFlow');
  }} onBack={() => setFlowScreen(null)}/>;

  if (flowScreen === 'bankMethod') return <AccountMethodScreen typeLabel={t('acct.bank')}
    onManual={() => setFlowScreen('bankManual')} onAutomatic={() => { setPsd2TypeId('bank'); setBankSearch(''); setPsd2Step('search'); }} onBack={() => setFlowScreen('typeSelect')}/>;
  if (flowScreen === 'bankManual') return <BankManualForm typeLabel={t('acct.bank')} typeId="bank" defaultCurrency={currency} onSave={handleSaveNewAccount} onBack={() => setFlowScreen('bankMethod')}/>;

  if (flowScreen === 'savingMethod') return <AccountMethodScreen typeLabel={t('acct.saving')}
    onManual={() => setFlowScreen('savingManual')} onAutomatic={() => { setPsd2TypeId('saving'); setBankSearch(''); setPsd2Step('search'); }} onBack={() => setFlowScreen('typeSelect')}/>;
  if (flowScreen === 'savingManual') return <BankManualForm typeLabel={t('acct.saving')} typeId="saving" defaultCurrency={currency} onSave={handleSaveNewAccount} onBack={() => setFlowScreen('savingMethod')}/>;

  if (flowScreen === 'cashForm') return <CashWalletForm defaultCurrency={currency} onSave={handleSaveNewAccount} onBack={() => setFlowScreen('typeSelect')}/>;

  if (flowScreen === 'brokerMethod') return <AccountMethodScreen typeLabel={t('acct.brokerage')}
    onManual={() => setFlowScreen('brokerManual')} onAutomatic={() => setFlowScreen('brokerAuto')} onBack={() => setFlowScreen('typeSelect')}/>;
  if (flowScreen === 'brokerManual') return <BrokerManualForm defaultCurrency={currency} onSave={handleSaveNewAccount} onBack={() => setFlowScreen('brokerMethod')}/>;
  if (flowScreen === 'brokerAuto') return <BrokerAutoFlow onSave={handleSaveNewAccount} onBack={() => setFlowScreen('brokerMethod')}/>;

  if (flowScreen === 'creditMethod') return <AccountMethodScreen typeLabel={t('acct.creditCard')}
    onManual={() => setFlowScreen('creditManual')} onAutomatic={() => { setPsd2TypeId('credit'); setBankSearch(''); setPsd2Step('search'); }} onBack={() => setFlowScreen('typeSelect')}/>;
  if (flowScreen === 'creditManual') return <BankManualForm typeLabel={t('acct.creditCard')} typeId="credit" defaultCurrency={currency} onSave={handleSaveNewAccount} onBack={() => setFlowScreen('creditMethod')}/>;

  if (flowScreen === 'mortgageForm') return <MortgageForm defaultCurrency={currency} onSave={handleSaveNewAccount} onBack={() => setFlowScreen('typeSelect')}/>;
  if (flowScreen === 'loanFlow') return <LoanFlow defaultCurrency={currency} onSave={handleSaveNewAccount} onBack={() => setFlowScreen('typeSelect')}/>;

  // ── Main screen ──────────────────────────────────────────────────────────────
  const assets = connectedAccounts.filter(a => acctGroup(a.type) === 'asset');
  const liabilities = connectedAccounts.filter(a => acctGroup(a.type) === 'liability');

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('acct.financialAccounts')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {/* Assets group */}
        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8, paddingLeft:4 }}>
          <div className="m-cap">{t('acct.assets')}</div>
          <div style={{ fontSize:11, color:M.ink4 }}>{t('acct.assetDesc')}</div>
        </div>
        <div data-testid="assets-group" className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {assets.length === 0 ? (
            <div style={{ padding:'16px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>{t('acct.noAccounts')}</div>
          ) : assets.map((a, i) => (
            <AcctRow key={a.id} acct={a} i={i} t={t} currency={currency} onDelete={setShowDeleteConfirm} onEdit={openEdit}/>
          ))}
          <Divider inset={0}/>
          <div data-testid="asset-add-row" className="m-tap" onClick={() => { setTypeFilter('asset'); setFlowScreen('typeSelect'); }}
            style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
            <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="plus" size={16} color={M.sage}/>
            </div>
            <div style={{ flex:1, fontSize:14, fontWeight:600, color:M.sage }}>{t('acct.addAssetAccount')}</div>
            <I name="caretR" size={14} color={M.ink4}/>
          </div>
        </div>

        {/* Liabilities group */}
        <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:8, paddingLeft:4 }}>
          <div className="m-cap">{t('acct.liabilities')}</div>
          <div style={{ fontSize:11, color:M.ink4 }}>{t('acct.liabilityDesc')}</div>
        </div>
        <div data-testid="liabilities-group" className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {liabilities.length === 0 ? (
            <div style={{ padding:'16px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>{t('acct.noAccounts')}</div>
          ) : liabilities.map((a, i) => (
            <AcctRow key={a.id} acct={a} i={i} t={t} currency={currency} onDelete={setShowDeleteConfirm} onEdit={openEdit}/>
          ))}
          <Divider inset={0}/>
          <div data-testid="liability-add-row" className="m-tap" onClick={() => { setTypeFilter('liability'); setFlowScreen('typeSelect'); }}
            style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
            <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="plus" size={16} color={M.sage}/>
            </div>
            <div style={{ flex:1, fontSize:14, fontWeight:600, color:M.sage }}>{t('acct.addLiabilityAccount')}</div>
            <I name="caretR" size={14} color={M.ink4}/>
          </div>
        </div>

        {/* PSD2 notice */}
        <div style={{ padding:'12px 16px', borderRadius:14, background:M.sageSoft, display:'flex', gap:12, alignItems:'flex-start', marginBottom:8 }}>
          <I name="lock" size={18} color={M.sage}/>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:600, color:M.sage }}>{t('acct.psd2Title')}</div>
            <div style={{ fontSize:12, color:M.ink2, marginTop:4, lineHeight:1.45 }}>{t('acct.psd2Notice')}</div>
          </div>
        </div>
        <div style={{ height:8 }}/>
      </div>

      {showDeleteConfirm && (
        <Sheet onClose={() => setShowDeleteConfirm(null)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>{t('acct.removeTitle')}</div>
            <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:20 }}>
              <strong>{showDeleteConfirm.name}</strong> {t('acct.removeDesc')}
            </div>
            <button onClick={() => confirmDelete(showDeleteConfirm)}
              style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('acct.removeConfirm')}
            </button>
            <button onClick={() => setShowDeleteConfirm(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}

      {showEditSheet && (
        <Sheet onClose={() => setShowEditSheet(null)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('acct.editAccount')}</div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.accountName')}</div>
              <input value={editName} onChange={e => setEditName(e.target.value)}
                style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none' }}/>
            </div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('acct.accountNumber')}</div>
              <input value={editIban} onChange={e => setEditIban(e.target.value)} placeholder="e.g. NL12 INGB 0123 4567 89"
                style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontMono, background:M.paper2, outline:'none' }}/>
            </div>
            <div style={{ marginBottom:20 }}/>
            <button onClick={saveEdit}
              style={{ width:'100%', padding:'14px 0', background:M.brand, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('action.save')}
            </button>
            <button onClick={() => { setShowDeleteConfirm(showEditSheet); setShowEditSheet(null); }}
              style={{ width:'100%', padding:'14px 0', background:'transparent', color:M.clay, border:`1px solid ${M.clay}33`, borderRadius:12, fontSize:15, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('acct.removeConfirm')}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenSavings() {
  const nav = useNav();
  const { t } = useLang();
  const { txs, addTxs, setTxs } = useTxCtx();
  const [connectedAccounts, setConnectedAccounts] = useConnectedAccounts();
  const [showAddSheet, setShowAddSheet] = React.useState(null);
  const [showCorrectionSheet, setShowCorrectionSheet] = React.useState(null);
  const [addDraft, setAddDraft] = React.useState({ amount:'', desc:'', date:new Date().toISOString().slice(0,10), dir:'deposit' });
  const [correctionBalance, setCorrectionBalance] = React.useState('');

  const savingAccounts = connectedAccounts.filter(a => a.type === 'savings' || a.type === 'invest');
  const savingsTxs = txs.filter(t => t.savingAccount);

  const doAddTx = () => {
    if (!addDraft.amount || !showAddSheet) return;
    const amt = parseFloat(addDraft.amount) || 0;
    const signed = addDraft.dir === 'deposit' ? Math.abs(amt) : -Math.abs(amt);
    const cat = addDraft.dir === 'deposit' ? 'savingDeposit' : 'savingWithdraw';
    const newTx = {
      id: `stx_${Date.now()}`,
      merchant: showAddSheet.name,
      desc: addDraft.desc || (addDraft.dir === 'deposit' ? 'Manual deposit' : 'Manual withdrawal'),
      amount: signed,
      date: addDraft.date,
      time: '12:00',
      cat,
      account: showAddSheet.id,
      savingAccount: showAddSheet.id,
      cats: [{ catId: cat, amount: amt }],
    };
    addTxs([newTx]);
    setConnectedAccounts(a => a.map(x => x.id === showAddSheet.id ? { ...x, balance: (x.balance||0) + signed } : x));
    setShowAddSheet(null);
    setAddDraft({ amount:'', desc:'', date:new Date().toISOString().slice(0,10), dir:'deposit' });
  };

  const doCorrection = () => {
    if (!correctionBalance || !showCorrectionSheet) return;
    const newBal = parseFloat(correctionBalance) || 0;
    const currentBal = showCorrectionSheet.balance || 0;
    const diff = newBal - currentBal;
    if (Math.abs(diff) < 0.01) { setShowCorrectionSheet(null); return; }
    const dir = diff >= 0 ? 'deposit' : 'withdraw';
    const cat = dir === 'deposit' ? 'savingDeposit' : 'savingWithdraw';
    const newTx = {
      id: `stx_corr_${Date.now()}`,
      merchant: showCorrectionSheet.name,
      desc: 'Balance correction',
      amount: diff,
      date: new Date().toISOString().slice(0,10),
      time: '12:00',
      cat,
      account: showCorrectionSheet.id,
      savingAccount: showCorrectionSheet.id,
      cats: [{ catId: cat, amount: Math.abs(diff) }],
      isCorrection: true,
    };
    addTxs([newTx]);
    setConnectedAccounts(a => a.map(x => x.id === showCorrectionSheet.id ? { ...x, balance: newBal } : x));
    setShowCorrectionSheet(null);
    setCorrectionBalance('');
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.savings')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {savingAccounts.length === 0 ? (
          <div style={{ textAlign:'center', padding:'40px 16px', color:M.ink3, fontSize:14, lineHeight:1.6 }}>
            No saving accounts linked.<br/>
            <span style={{ fontSize:12 }}>Create one under Settings › Accounts.</span>
          </div>
        ) : savingAccounts.map((acct) => {
          const acctTxs = savingsTxs.filter(t => t.savingAccount === acct.id);
          return (
            <div key={acct.id} className="m-card" style={{ padding:0, marginBottom:14, border:`1px solid ${M.line}`, overflow:'hidden' }}>
              <div style={{ padding:'14px 16px', display:'flex', alignItems:'center', gap:12, borderBottom:`1px solid ${M.line2}` }}>
                <div style={{ width:40, height:40, borderRadius:12, background: acct.color || M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name={acct.type==='invest'?'rocket':'piggy'} size={18} color={acct.manual?M.ochre:'#fff'}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:15, fontWeight:600 }}>{acct.name}</div>
                  <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono, marginTop:1 }}>{acct.iban}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div className="m-num" style={{ fontSize:18, fontWeight:700 }}>{fmtEur(acct.balance||0)}</div>
                  <div style={{ fontSize:10, color:M.ink3, marginTop:1 }}>balance</div>
                </div>
              </div>
              <div style={{ display:'flex', borderBottom:`1px solid ${M.line2}` }}>
                <button className="m-tap" onClick={() => { setShowAddSheet(acct); setAddDraft({ amount:'', desc:'', date:new Date().toISOString().slice(0,10), dir:'deposit' }); }}
                  style={{ flex:1, padding:'12px 0', textAlign:'center', background:'transparent', border:'none', cursor:'pointer', borderRight:`1px solid ${M.line2}`, fontFamily:M.fontUI, display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <I name="plus" size={16} color={M.sage}/>
                  <span style={{ fontSize:11, fontWeight:600, color:M.sage }}>Add transaction</span>
                </button>
                <button className="m-tap" onClick={() => { setShowCorrectionSheet(acct); setCorrectionBalance(String(acct.balance||'')); }}
                  style={{ flex:1, padding:'12px 0', textAlign:'center', background:'transparent', border:'none', cursor:'pointer', fontFamily:M.fontUI, display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <I name="edit" size={16} color={M.ochre}/>
                  <span style={{ fontSize:11, fontWeight:600, color:M.ochre }}>Set balance</span>
                </button>
              </div>
              {acctTxs.length > 0 && (
                <div>
                  {acctTxs.slice(0,3).map((t, i, a) => (
                    <React.Fragment key={t.id}>
                      {i > 0 && <Divider inset={52}/>}
                      <TxRow tx={t} onClick={() => nav.push('txDetail', { id: t.id })}/>
                    </React.Fragment>
                  ))}
                  {acctTxs.length > 3 && (
                    <div className="m-tap" onClick={() => nav.push('savingsDetail', { id: acct.id })} style={{ padding:'10px 16px', borderTop:`1px solid ${M.line2}`, fontSize:12, color:M.sage, fontWeight:600, textAlign:'center', display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>
                      View all {acctTxs.length} transactions <I name="caretR" size={12} color={M.sage}/>
                    </div>
                  )}
                </div>
              )}
              {acctTxs.length === 0 && (
                <div style={{ padding:'16px', textAlign:'center', color:M.ink4, fontSize:13 }}>No transactions yet</div>
              )}
            </div>
          );
        })}
        <div style={{ height:8 }}/>
      </div>

      {showAddSheet && (
        <Sheet onClose={() => setShowAddSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{showAddSheet.name}</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:14 }}>Add manual transaction</div>
            <div style={{ display:'flex', gap:8, marginBottom:14 }}>
              {[{v:'deposit',l:'Deposit'},{v:'withdraw',l:'Withdrawal'}].map(opt => (
                <button key={opt.v} className="m-tap" onClick={() => setAddDraft(d=>({...d,dir:opt.v}))}
                  style={{ flex:1, padding:'10px', borderRadius:10, border:`2px solid ${addDraft.dir===opt.v?M.sage:M.line}`, background:addDraft.dir===opt.v?M.sageSoft:M.paper2, fontFamily:M.fontUI, fontSize:13, fontWeight:600, color:addDraft.dir===opt.v?M.sage:M.ink, cursor:'pointer' }}>
                  {opt.l}
                </button>
              ))}
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Amount (â‚¬)</div>
            <input type="number" value={addDraft.amount} onChange={e=>setAddDraft(d=>({...d,amount:e.target.value}))} placeholder="0.00" autoFocus
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:16, fontFamily:M.fontMono, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:10 }}/>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Description</div>
            <input value={addDraft.desc} onChange={e=>setAddDraft(d=>({...d,desc:e.target.value}))} placeholder="e.g. Monthly savings"
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:10 }}/>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Date</div>
            <input type="date" value={addDraft.date} onChange={e=>setAddDraft(d=>({...d,date:e.target.value}))}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:18 }}/>
            <button onClick={doAddTx} style={{ width:'100%', padding:'14px 0', background:addDraft.amount?M.sage:M.line, color:addDraft.amount?'#fff':M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:addDraft.amount?'pointer':'default', fontFamily:M.fontUI, marginBottom:10 }}>Add transaction</button>
            <button onClick={()=>setShowAddSheet(null)} style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>Cancel</button>
          </div>
        </Sheet>
      )}

      {showCorrectionSheet && (
        <Sheet onClose={() => setShowCorrectionSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>Set balance</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:4, lineHeight:1.5 }}>Enter the current actual balance. The difference will be recorded as a correction transaction.</div>
            <div style={{ padding:'10px 14px', borderRadius:10, background:M.ochreSoft, marginBottom:14, fontSize:12, color:M.ink2 }}>
              Current balance: <strong>{fmtEur(showCorrectionSheet.balance||0)}</strong>
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Actual balance (â‚¬)</div>
            <input type="number" value={correctionBalance} onChange={e=>setCorrectionBalance(e.target.value)} placeholder={String(showCorrectionSheet.balance||0)} autoFocus
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:16, fontFamily:M.fontMono, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:18 }}/>
            {correctionBalance && Math.abs(parseFloat(correctionBalance)-(showCorrectionSheet.balance||0)) > 0.01 && (
              <div style={{ padding:'8px 12px', borderRadius:8, background:M.sageSoft, marginBottom:14, fontSize:12, color:M.ink2 }}>
                A {parseFloat(correctionBalance)-(showCorrectionSheet.balance||0)>0?'deposit':'withdrawal'} of <strong>{fmtEur(Math.abs(parseFloat(correctionBalance)-(showCorrectionSheet.balance||0)))}</strong> will be recorded.
              </div>
            )}
            <button onClick={doCorrection} style={{ width:'100%', padding:'14px 0', background:correctionBalance?M.sage:M.line, color:correctionBalance?'#fff':M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:correctionBalance?'pointer':'default', fontFamily:M.fontUI, marginBottom:10 }}>Update balance</button>
            <button onClick={()=>setShowCorrectionSheet(null)} style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>Cancel</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenSavingsDetail({ params }) {
  const nav = useNav();
  const acct = ACCOUNTS.find(a => a.id === params?.id) || ACCOUNTS.find(a => a.type === 'savings');
  const [txs, setTxs] = React.useState([
    { id:'m1', desc:'Savings interest Q4', amount:42.80, date:'2026-01-01' },
    { id:'m2', desc:'Savings interest Jan', amount:14.20, date:'2026-02-01' },
  ]);
  const [showAdd, setShowAdd] = React.useState(false);

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={acct?.name || 'Savings'}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap" onClick={() => setShowAdd(true)}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-card" style={{ padding:18, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div className="m-cap">Balance</div>
          <div className="m-num" style={{ fontSize:32, fontWeight:600, fontFamily:M.fontDisp, marginTop:4 }}>
            {fmtEur(acct?.balance || 0)}
          </div>
          <div style={{ fontSize:11, color:M.ink3, marginTop:2, fontFamily:M.fontMono }}>{acct?.iban}</div>
        </div>

        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8, paddingLeft:4 }}>
          <div className="m-cap">Manual transactions · {txs.length}</div>
        </div>
        <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}`, marginBottom:14 }}>
          {txs.length === 0 ? (
            <div style={{ padding:'24px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>
              No manual transactions yet
            </div>
          ) : txs.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <div style={{ width:36, height:36, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="piggy" size={16} color={M.sage}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}>{t.desc}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{fmtDate(t.date)} · manual entry</div>
                </div>
                <div className="m-num" style={{ fontSize:15, fontWeight:600, color:M.sage }}>+{fmtEur(t.amount)}</div>
                <button className="m-tap" onClick={() => setTxs(ts => ts.filter(x => x.id !== t.id))} style={{ background:'transparent', border:'none', cursor:'pointer', padding:4, flexShrink:0 }}>
                  <I name="x" size={14} color={M.ink4}/>
                </button>
              </div>
              {i < a.length-1 && <Divider inset={48}/>}
            </React.Fragment>
          ))}
        </div>

        <div style={{ padding:'12px 14px', borderRadius:12, background:M.ochreSoft, border:`1px solid #E8D5A8`, display:'flex', gap:10, alignItems:'flex-start', marginBottom:8 }}>
          <I name="help" size={16} color={M.ochre} style={{ flexShrink:0, marginTop:1 }}/>
          <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5 }}>
            Open Banking doesn't expose savings account transactions. Add manual entries here to track interest, deposits and transfers.
          </div>
        </div>
        <div style={{ height:8 }}/>
      </div>

      {showAdd && (
        <Sheet onClose={() => setShowAdd(false)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div className="m-h2" style={{ marginBottom:4 }}>Add manual transaction</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:18 }}>Track interest, deposits, or any amount not synced automatically.</div>
            <div className="m-card" style={{ padding:4, marginBottom:14, border:`1px solid ${M.line}` }}>
              <FormRow label="Description" value="Savings interest" placeholder="e.g. Interest Q1 2026"/>
              <Divider inset={16}/>
              <FormRow label="Amount" value="â‚¬0,00" icon="wallet"/>
              <Divider inset={16}/>
              <FormRow label="Date" value="Today" icon="cal"/>
            </div>
            <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={() => {
              setTxs(ts => [...ts, { id:'m'+Date.now(), desc:'Savings interest', amount:18.40, date:'2026-02-19' }]);
              setShowAdd(false);
            }}>Add transaction</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenSavingAccounts() {
  const nav = useNav();
  const { txs } = useTxCtx();
  const savingAccounts = ACCOUNTS.filter(a => a.type === 'savings' || a.type === 'invest');
  const [disabled, setDisabled] = useLocalStorage('munni_disabled_save_accounts', []);

  const toggleDisabled = (id) => setDisabled(ds => ds.includes(id) ? ds.filter(x => x !== id) : [...ds, id]);

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Saving accounts"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap" onClick={() => nav.push('accounts')}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Accounts</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {savingAccounts.map((a, i) => {
            const isDisabled = disabled.includes(a.id);
            const acctTxs = txs.filter(t => t.savingAccount === a.id);
            const total = acctTxs.reduce((s, t) => s + Math.abs(t.amount), 0);
            return (
              <React.Fragment key={a.id}>
                {i > 0 && <Divider inset={50}/>}
                <div className="m-tap" onClick={() => nav.push('savingsDetail', { id: a.id })}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', opacity: isDisabled ? 0.5 : 1 }}>
                  <div style={{ width:40, height:40, borderRadius:12, background:a.color, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name={a.type==='invest'?'rocket':'piggy'} size={18} color="#fff"/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:600 }}>{a.name}</div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                      <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono }}>{a.iban}</div>
                      {isDisabled && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:M.line2, color:M.ink3, textTransform:'uppercase' }}>Read-only</span>}
                    </div>
                    <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{acctTxs.length} transfer{acctTxs.length !== 1 ? 's' : ''} · {fmtEur(total)} saved</div>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:6 }}>
                    <div className="m-num" style={{ fontSize:15, fontWeight:600 }}>{fmtEur(a.balance)}</div>
                    <button className="m-tap" onClick={e => { e.stopPropagation(); toggleDisabled(a.id); }}
                      style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999,
                        background: isDisabled ? M.ochreSoft : M.sageSoft,
                        color: isDisabled ? M.ochre : M.sage,
                        border: 'none', cursor:'pointer', fontFamily:M.fontUI }}>
                      {isDisabled ? 'Enable' : 'Disable'}
                    </button>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        <div style={{ padding:'12px 14px', borderRadius:12, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start', marginBottom:8 }}>
          <I name="lock" size={16} color={M.sage}/>
          <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5 }}>
            Saving accounts are the source of truth for all profiles. <strong>Disabling</strong> a saving account makes it read-only — no new transactions will be tracked to it.
          </div>
        </div>
        <div style={{ height:8 }}/>
      </div>
    </div>
  );
}

export const HOME_CARDS_DEFAULT = [
  { id:'review',     label:'Transaction Review', sub:'Verify categories for newly imported transactions', visible:true,  pinned:true  },
  { id:'period',     label:'Overview',           sub:'Income, spent, savings, invest',                   visible:true,  pinned:true  },
  { id:'budgets',    label:'Budgets',            sub:'Budget overview',                                  visible:true,  pinned:false },
  { id:'goals',      label:'Goals',             sub:'Savings goals progress',                            visible:true,  pinned:false },
  { id:'debts',      label:'Debts',             sub:'Debt tracker',                                      visible:true,  pinned:false },
  { id:'upcoming',   label:'Upcoming',          sub:'Recurring payments due',                            visible:true,  pinned:false },
  { id:'investment', label:'Investments',       sub:'Portfolio overview',                                visible:true,  pinned:false },
  { id:'events',     label:'Events',            sub:'Upcoming and active events',                        visible:true,  pinned:false },
  { id:'insights',   label:'Insights',          sub:'AI-powered spending insights',                      visible:false, pinned:false },
  { id:'quickActions',label:'Quick Actions',    sub:'Shortcuts to common tasks',                         visible:false, pinned:false },
];

export function AccountsSharingOverview() {
  const { t } = useLang();
  const nav = useNav();
  const myId = React.useMemo(() => getUserId(), []);
  const { profiles } = useProfiles();
  const [connectedAccounts] = useConnectedAccounts();
  const [userRegistry] = useLocalStorage('munni_global_users', {});

  // Accounts shared with me: read from munni_shared_data_{profileId} for each isShared profile
  const sharedWithMe = React.useMemo(() => {
    const results = [];
    profiles.filter(p => p.isShared).forEach(p => {
      try {
        const sd = JSON.parse(localStorage.getItem(`munni_shared_data_${p.id}`) || '{"accounts":[]}');
        (sd.accounts || []).forEach(a => {
          if (a.attachedBy === myId) return; // own account — not "shared with me"
          results.push({
            id: `${p.id}_${a.id}`, name: a.name || '—', iban: a.iban || '',
            color: a.color, type: a.type, fromName: p.ownerDisplay || p.ownerId || '?',
            profileName: p.name, profileId: p.id,
            permission: (p.members || []).find(m => m.userId === myId)?.permission || 'contributor',
          });
        });
      } catch {}
    });
    return results;
  }, [profiles, myId]);

  // Accounts being shared: own accounts shared with members, member contributions (read-only for owner), and guest's own contributions
  const iSharing = React.useMemo(() => {
    const results = [];
    // Owner's own accounts + member-contributed accounts visible in the profile
    profiles.filter(p => !p.isShared).forEach(p => {
      const otherMembers = (p.members || []).filter(m => m.userId !== myId);
      if (otherMembers.length === 0) return;
      connectedAccounts.filter(a => (p.accountIds || []).includes(a.id)).forEach(a => {
        results.push({ account: a, profile: p, memberCount: otherMembers.length });
      });
      // Member-contributed accounts shown read-only to the owner
      try {
        const sd = JSON.parse(localStorage.getItem(`munni_shared_data_${p.id}`) || '{"accounts":[]}');
        (sd.accounts || []).filter(a => !connectedAccounts.some(ca => ca.id === a.id)).forEach(a => {
          results.push({ account: a, profile: p, memberCount: otherMembers.length,
            contributorName: userRegistry[a.attachedBy]?.displayName || a.attachedBy || '?' });
        });
      } catch {}
    });
    // Guest's own accounts contributed to shared profiles
    profiles.filter(p => p.isShared).forEach(p => {
      try {
        const sd = JSON.parse(localStorage.getItem(`munni_shared_data_${p.id}`) || '{"accounts":[]}');
        (sd.accounts || []).filter(a => a.attachedBy === myId).forEach(a => {
          results.push({ account: a, profile: p, memberCount: (p.members || []).length });
        });
      } catch {}
    });
    return results;
  }, [profiles, myId, connectedAccounts, userRegistry]);

  if (sharedWithMe.length === 0 && iSharing.length === 0) return null;

  return (
    <>
      {sharedWithMe.length > 0 && (
        <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4, marginTop:8 }}>{t('accounts.sharedWith')}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
            {sharedWithMe.map((item, i) => (
              <React.Fragment key={item.id}>
                {i > 0 && <Divider inset={48}/>}
                <div className="m-tap" onClick={() => nav.push('spaceDetail', { id: item.profileId })} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                  <div style={{ width:36, height:36, borderRadius:10, background: item.color || M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name={item.type==='savings'?'piggy':item.type==='invest'?'rocket':'card'} size={16} color="#fff"/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</div>
                    {item.iban && <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.iban}</div>}
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:3, flexWrap:'wrap' }}>
                      <span style={{ fontSize:11, color:M.ink3 }}>From <strong>{item.fromName}</strong> · <span style={{ color:M.sage, fontWeight:600 }}>{item.profileName}</span></span>
                      <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase', flexShrink:0 }}>{item.permission}</span>
                    </div>
                  </div>
                  <I name="caretR" size={14} color={M.ink4} style={{ flexShrink:0 }}/>
                </div>
              </React.Fragment>
            ))}
          </div>
        </>
      )}

      {iSharing.length > 0 && (
        <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4, marginTop:8 }}>{t('accounts.iSharing')}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
            {iSharing.map(({ account, profile, memberCount, contributorName }, i) => (
              <React.Fragment key={`${account.id}-${profile.id}`}>
                {i > 0 && <Divider inset={48}/>}
                <div className="m-tap" onClick={() => nav.push('spaceDetail', { id: profile.id })}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                  <div style={{ width:36, height:36, borderRadius:10, background: account.color || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name={account.type==='savings'?'piggy':account.type==='invest'?'rocket':'card'} size={16} color="#fff"/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{account.name}</div>
                    {account.iban && <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{account.iban}</div>}
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:3, flexWrap:'wrap' }}>
                      <span style={{ fontSize:11, color:M.ink3 }}>
                        {contributorName
                          ? <>From <strong>{contributorName}</strong> · <span style={{ color:M.sage, fontWeight:600 }}>{profile.name}</span></>
                          : <>{t('accounts.sharedVia')} <strong>{profile.name}</strong> · {memberCount} member{memberCount>1?'s':''}</>
                        }
                      </span>
                      {contributorName && (
                        <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.paper2, color:M.ink3, textTransform:'uppercase', flexShrink:0 }}>read only</span>
                      )}
                    </div>
                  </div>
                  <I name="caretR" size={14} color={M.ink4}/>
                </div>
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function ScreenAccountsAll() {
  const nav = useNav();
  const { t } = useLang();
  const { addTxs } = useTxCtx();
  const [connectedAccounts, setConnectedAccounts] = useConnectedAccounts();
  const { profiles, setProfiles } = useProfiles();
  const [showAddChoice, setShowAddChoice] = React.useState(false);
  const [bankSearch, setBankSearch] = React.useState('');
  const [selectedBank, setSelectedBank] = useLocalStorage('munni_selected_bank', null);
  const [psd2Step, setPsd2Step] = React.useState(null);
  const [psd2Bank, setPsd2Bank] = React.useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(null);
  const [showCreateSaving, setShowCreateSaving] = React.useState(false);
  const [savingDraft, setSavingDraft] = React.useState({ name:'', balance:'', type:'savings' });
  const [showRenameSheet, setShowRenameSheet] = React.useState(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [showAddTxSheet, setShowAddTxSheet] = React.useState(null);
  const [txDraft, setTxDraft] = React.useState({ amount:'', desc:'', date: new Date().toISOString().slice(0,10), dir:'deposit' });
  const [customIban, setCustomIban] = React.useState('');

  const bankAccounts = connectedAccounts.filter(a => a.type === 'checking');
  const savingAccounts = connectedAccounts.filter(a => a.type === 'savings' || a.type === 'invest');
  const filteredBanks = DUTCH_BANKS.filter(b => !bankSearch || b.name.toLowerCase().includes(bankSearch.toLowerCase()));
  const isDemoUser = sessionStorage.getItem('munni_last_login_method') === 'bank';
  const demoAccounts = connectedAccounts.filter(a => DEMO_ACCOUNT_IDS.includes(a.id));
  const realBankAccounts = bankAccounts.filter(a => !DEMO_ACCOUNT_IDS.includes(a.id));
  const realSavingAccounts = savingAccounts.filter(a => !DEMO_ACCOUNT_IDS.includes(a.id));

  const startBankConnect = (bank) => {
    setCustomIban(generateBankIban(bank));
    setPsd2Bank(bank);
    setSelectedBank(bank.id);
    setPsd2Step('login');
  };

  const advancePsd2 = () => {
    if (psd2Step === 'login') setPsd2Step('consent');
    else if (psd2Step === 'consent') {
      setPsd2Step('connecting');
      const bank = psd2Bank;
      const savedIban = customIban;
      setTimeout(() => {
        const bankColors = { ing:'#ff6200', abn:'#00a63c', rabo:'#da1913', sns:'#e20082', asn:'#7ab800', triodos:'#00ac42', bunq:'#00ccff', knab:'#0057b8', regio:'#e4003a', revolut:'#191c1f', n26:'#1e1e1e', wise:'#9fe870' };
        const newAcct = {
          id: `bank_${Date.now()}`,
          name: bank.name,
          type: 'checking',
          iban: savedIban.trim() || `NL${20 + (bank.name.length % 78)} ${bank.id.toUpperCase().slice(0,4)} ${Math.floor(1000000000 + (bank.name.charCodeAt(0) * 17 + Date.now()) % 9000000000)}`,
          color: bankColors[bank.id] || M.slate,
          bankId: bank.id,
        };
        const isAsn = bank.id === 'asn' || bank.name.toLowerCase().includes('asn');
        const newBalance = isAsn ? 3245.67 : parseFloat((1000 + Math.random() * 8000).toFixed(2));
        setConnectedAccounts(a => [...a, { ...newAcct, balance: newBalance }]);
        const newTxs = isAsn ? generateAsnTxs(newAcct.id) : generateBankTxs(newAcct.id, bank.name);
        addTxs(newTxs);
        setProfiles(ps => ps.map(p => p.active ? { ...p, accountIds: [...(p.accountIds || []), newAcct.id] } : p));
        setSelectedBank(null);
        setPsd2Step('done');
      }, 1800);
    }
    else if (psd2Step === 'done') setPsd2Step(null);
  };

  const createSavingAccount = () => {
    if (!savingDraft.name.trim()) return;
    const colors = { savings: M.ochreSoft, invest: M.violetSoft };
    const newAcct = {
      id: `save_${Date.now()}`,
      name: savingDraft.name.trim(),
      type: savingDraft.type,
      iban: 'Manual',
      color: colors[savingDraft.type] || M.ochreSoft,
      manual: true,
      balance: parseFloat(savingDraft.balance) || 0,
    };
    setConnectedAccounts(a => [...a, newAcct]);
    setShowCreateSaving(false);
    setSavingDraft({ name:'', balance:'', type:'savings' });
  };

  const deleteAccount = (acct) => {
    setConnectedAccounts(a => a.filter(x => x.id !== acct.id));
    setShowDeleteConfirm(null);
  };

  const renameAccount = () => {
    if (!renameDraft.trim() || !showRenameSheet) return;
    setConnectedAccounts(a => a.map(x => x.id === showRenameSheet.id ? { ...x, name: renameDraft.trim() } : x));
    setShowRenameSheet(null);
  };

  const addSavingTx = () => {
    if (!txDraft.amount || !showAddTxSheet) return;
    const amt = parseFloat(txDraft.amount) || 0;
    // deposit: money going into the saving account (positive balance change), shown as negative tx (outflow from checking)
    const signed = txDraft.dir === 'deposit' ? -Math.abs(amt) : Math.abs(amt);
    const cat = txDraft.dir === 'deposit' ? 'savingDeposit' : 'savingWithdraw';
    const newTx = {
      id: `stx_${Date.now()}`,
      merchant: showAddTxSheet.name,
      desc: txDraft.desc || (txDraft.dir === 'deposit' ? 'Saving deposit' : 'Saving withdrawal'),
      amount: signed,
      date: txDraft.date,
      time: '12:00',
      cat,
      account: showAddTxSheet.id,
      savingAccount: showAddTxSheet.id,
      cats: [{ catId: cat, amount: Math.abs(amt) }],
    };
    addTxs([newTx]);
    // Update the saving account's displayed balance
    const balanceDelta = txDraft.dir === 'deposit' ? Math.abs(amt) : -Math.abs(amt);
    setConnectedAccounts(a => a.map(x => x.id === showAddTxSheet.id ? { ...x, balance: (x.balance || 0) + balanceDelta } : x));
    setShowAddTxSheet(null);
    setTxDraft({ amount:'', desc:'', date: new Date().toISOString().slice(0,10), dir:'deposit' });
  };

  if (psd2Step === 'search') {
    return <BankSearchFullScreen banks={DUTCH_BANKS} bankSearch={bankSearch} setBankSearch={setBankSearch} connectedAccounts={connectedAccounts} onSelect={startBankConnect} onBack={() => setPsd2Step(null)}/>;
  }

  if (psd2Step) {
    return <BankConnectPsd2Screen psd2Step={psd2Step} psd2Bank={psd2Bank} customIban={customIban} setCustomIban={setCustomIban} advancePsd2={advancePsd2} onClose={() => setPsd2Step(null)}/>;
  }

  const renderAccountRow = (a, opts = {}) => (
    <div className={opts.readonly ? '' : 'm-tap'} onClick={opts.readonly ? undefined : opts.onPress}
      style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
      <div style={{ width:38, height:38, borderRadius:10, background: a.color || M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <I name={a.type==='invest'?'rocket':a.type==='savings'?'piggy':'card'} size={18} color={a.isDemo ? M.ink3 : '#fff'}/>
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ fontSize:14, fontWeight:600 }}>{a.name}</div>
          {a.isDemo && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase' }}>Demo</span>}
          {a.bankId && !a.isDemo && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>Bank</span>}
          {a.manual && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase' }}>Manual</span>}
        </div>
        <div style={{ fontSize:11, color:M.ink3, marginTop:2, fontFamily:M.fontMono }}>{a.iban}</div>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <div className="m-num" style={{ fontSize:15, fontWeight:600 }}>{fmtEur(a.balance || 0)}</div>
        {!opts.readonly && <I name="caretR" size={14} color={M.ink4}/>}
      </div>
    </div>
  );

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.accounts')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={null}
      />
      <div className="m-body-scroll">

        {isDemoUser ? (
          /* â”€â”€ Demo user (1-click bank login): show demo accounts read-only â”€â”€ */
          <>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingLeft:4 }}>
              <div className="m-cap">{t('accounts.demoSection')}</div>
              <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase' }}>read-only</span>
            </div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:12, border:`1px solid ${M.line}` }}>
              {demoAccounts.map((a, i) => (
                <React.Fragment key={a.id}>
                  {i > 0 && <Divider inset={50}/>}
                  {renderAccountRow(a, { readonly: true })}
                </React.Fragment>
              ))}
            </div>
            <div style={{ padding:'12px 14px', borderRadius:12, background:M.ochreSoft, display:'flex', gap:10, alignItems:'flex-start', marginBottom:8 }}>
              <I name="help" size={16} color={M.ochre}/>
              <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5 }}>{t('accounts.demoDesc')}</div>
            </div>
          </>
        ) : (
          /* â”€â”€ Real profile: show real accounts only â”€â”€ */
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('accounts.bankSection')}</div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
              {realBankAccounts.length === 0 && (
                <div style={{ padding:'16px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('accounts.noBank')}</div>
              )}
              {realBankAccounts.map((a, i) => (
                <React.Fragment key={a.id}>
                  {i > 0 && <Divider inset={50}/>}
                  {renderAccountRow(a, { onPress: () => setShowDeleteConfirm(a) })}
                </React.Fragment>
              ))}
              <Divider inset={0}/>
              <div className="m-tap" onClick={() => { setBankSearch(''); setPsd2Step('search'); }} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0', color:M.sage }}>
                <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="plus" size={16} color={M.sage}/>
                </div>
                <div style={{ flex:1, fontSize:14, fontWeight:600 }}>{t('accounts.connectBank')}</div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>
            <div style={{ padding:'12px 14px', borderRadius:12, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start', marginBottom:14 }}>
              <I name="lock" size={16} color={M.sage}/>
              <div style={{ fontSize:12, color:M.ink2, lineHeight:1.45 }}>Bank accounts connect via PSD2 Open Banking. munni has read-only access — we can never move money.</div>
            </div>

            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('accounts.savingSection')}</div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
              {realSavingAccounts.length === 0 && (
                <div style={{ padding:'16px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('accounts.noSaving')}</div>
              )}
              {realSavingAccounts.map((a, i) => (
                <React.Fragment key={a.id}>
                  {i > 0 && <Divider inset={50}/>}
                  {renderAccountRow(a, { onPress: () => { setShowRenameSheet(a); setRenameDraft(a.name); } })}
                </React.Fragment>
              ))}
              <Divider inset={0}/>
              <div className="m-tap" onClick={() => setShowCreateSaving(true)} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0', color:M.sage }}>
                <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="plus" size={16} color={M.sage}/>
                </div>
                <div style={{ flex:1, fontSize:14, fontWeight:600 }}>{t('accounts.addManual')}</div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>
            <div style={{ padding:'12px 14px', borderRadius:12, background:M.ochreSoft, display:'flex', gap:10, alignItems:'flex-start', marginBottom:8 }}>
              <I name="help" size={16} color={M.ochre}/>
              <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5 }}>Banks often don't expose saving accounts via Open Banking (PSD2). Create saving accounts manually here to track deposits and withdrawals yourself.</div>
            </div>
          </>
        )}
        <AccountsSharingOverview/>
        <div style={{ height:8 }}/>
      </div>

      {/* Connect bank sheet */}
      {/* Create saving account sheet */}
      {showCreateSaving && (
        <Sheet onClose={() => setShowCreateSaving(false)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>Create saving account</div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Account name</div>
            <input autoFocus value={savingDraft.name} onChange={e => setSavingDraft(d => ({ ...d, name: e.target.value }))}
              placeholder="e.g. Emergency fund, Holiday…"
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:12 }}/>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Starting balance (optional)</div>
            <input type="number" value={savingDraft.balance} onChange={e => setSavingDraft(d => ({ ...d, balance: e.target.value }))}
              placeholder="0.00"
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:12 }}/>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Type</div>
            <div style={{ display:'flex', gap:8, marginBottom:20 }}>
              {[{v:'savings',l:'Savings',icon:'piggy'},{v:'invest',l:'Invest',icon:'rocket'}].map(opt => (
                <button key={opt.v} className="m-tap" onClick={() => setSavingDraft(d => ({ ...d, type:opt.v }))}
                  style={{ flex:1, padding:'12px 8px', borderRadius:12, border:`2px solid ${savingDraft.type===opt.v?M.sage:M.line}`, background: savingDraft.type===opt.v?M.sageSoft:M.paper2, textAlign:'center', cursor:'pointer', fontFamily:M.fontUI }}>
                  <I name={opt.icon} size={18} color={savingDraft.type===opt.v?M.sage:M.ink3}/>
                  <div style={{ fontSize:12, fontWeight:600, marginTop:6, color:savingDraft.type===opt.v?M.sage:M.ink }}>{opt.l}</div>
                </button>
              ))}
            </div>
            <button onClick={createSavingAccount}
              style={{ width:'100%', padding:'14px 0', background:savingDraft.name.trim()?M.sage:M.line, color:savingDraft.name.trim()?'#fff':M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:savingDraft.name.trim()?'pointer':'default', fontFamily:M.fontUI, marginBottom:10 }}>
              Create account
            </button>
            <button onClick={() => setShowCreateSaving(false)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {/* Rename saving account */}
      {showRenameSheet && (
        <Sheet onClose={() => setShowRenameSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>Edit account</div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Account name</div>
            <input autoFocus value={renameDraft} onChange={e => setRenameDraft(e.target.value)}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:20 }}/>
            <button onClick={renameAccount}
              style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              Save
            </button>
            <Divider inset={0}/>
            <button onClick={() => { const acct = showRenameSheet; setShowRenameSheet(null); setTimeout(() => { setShowAddTxSheet(acct); setTxDraft({ amount:'', desc:'', date:new Date().toISOString().slice(0,10), dir:'deposit' }); }, 150); }}
              style={{ width:'100%', padding:'14px 0', background:M.sageSoft, color:M.sage, border:`1px solid ${M.sage}22`, borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              Add transaction
            </button>
            <button onClick={() => setShowRenameSheet(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              Cancel
            </button>
            <button onClick={() => { setConnectedAccounts(a => a.filter(x => x.id !== showRenameSheet.id)); setShowRenameSheet(null); }}
              style={{ width:'100%', padding:'14px 0', background:'transparent', color:M.clay, border:`1.5px solid ${M.clay}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
              Delete account
            </button>
          </div>
        </Sheet>
      )}

      {/* Add transaction to saving account */}
      {showAddTxSheet && (
        <Sheet onClose={() => setShowAddTxSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{showAddTxSheet.name}</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>Add a manual transaction to this saving account.</div>
            <div style={{ display:'flex', gap:8, marginBottom:16 }}>
              {[{v:'deposit',l:'Deposit'},{v:'withdraw',l:'Withdraw'}].map(opt => (
                <button key={opt.v} className="m-tap" onClick={() => setTxDraft(d => ({ ...d, dir:opt.v }))}
                  style={{ flex:1, padding:'10px', borderRadius:10, border:`2px solid ${txDraft.dir===opt.v?M.sage:M.line}`, background: txDraft.dir===opt.v?M.sageSoft:M.paper2, fontFamily:M.fontUI, fontSize:13, fontWeight:600, color:txDraft.dir===opt.v?M.sage:M.ink, cursor:'pointer' }}>
                  {opt.l}
                </button>
              ))}
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Amount (â‚¬)</div>
            <input type="number" value={txDraft.amount} onChange={e => setTxDraft(d => ({ ...d, amount:e.target.value }))}
              placeholder="0.00" autoFocus
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:16, fontFamily:M.fontMono, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:12 }}/>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Description</div>
            <input value={txDraft.desc} onChange={e => setTxDraft(d => ({ ...d, desc:e.target.value }))}
              placeholder="e.g. Monthly savings"
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:12 }}/>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Date</div>
            <input type="date" value={txDraft.date} onChange={e => setTxDraft(d => ({ ...d, date:e.target.value }))}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:20 }}/>
            <button onClick={addSavingTx}
              style={{ width:'100%', padding:'14px 0', background:txDraft.amount?M.sage:M.line, color:txDraft.amount?'#fff':M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:txDraft.amount?'pointer':'default', fontFamily:M.fontUI, marginBottom:10 }}>
              Add transaction
            </button>
            <button onClick={() => setShowAddTxSheet(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <Sheet onClose={() => setShowDeleteConfirm(null)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>Remove account?</div>
            <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:20 }}>
              <strong>{showDeleteConfirm.name}</strong> will be removed.{!showDeleteConfirm.manual ? ' Historical transactions will remain but new syncing will stop.' : ''}
            </div>
            <button onClick={() => deleteAccount(showDeleteConfirm)}
              style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              Remove account
            </button>
            <button onClick={() => setShowDeleteConfirm(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {/* Add account choice */}
      {showAddChoice && (
        <Sheet onClose={() => setShowAddChoice(false)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>Add account</div>
            <div className="m-tap" onClick={() => { setShowAddChoice(false); setBankSearch(''); setPsd2Step('search'); }}
              style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', borderBottom:`1px solid ${M.line2}` }}>
              <div style={{ width:40, height:40, borderRadius:12, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="card" size={18} color={M.sage}/>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:15, fontWeight:600 }}>Connect a bank</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:1 }}>PSD2 Open Banking connection</div>
              </div>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
            <div className="m-tap" onClick={() => { setShowAddChoice(false); setShowCreateSaving(true); }}
              style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
              <div style={{ width:40, height:40, borderRadius:12, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="piggy" size={18} color={M.ochre}/>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:15, fontWeight:600 }}>Create saving account</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:1 }}>Manual saving or investment account</div>
              </div>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

