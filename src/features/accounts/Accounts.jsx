import React from 'react';
import { ACCOUNTS, DEMO_ACCOUNT_IDS, DEMO_ACCOUNTS, INTEGRATIONS, ALL_RECEIPTS, generateBankTxs, generateAsnTxs } from './data.js';
import { fmtEur, fmtDate, computePeriodHistory, fmtSyncTime } from '../../shared/utils/format.js';
import { getUserId, getUserSyncKey, addDevLog } from '../../shared/utils/user.js';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav, Sheet } from '../../app/nav.jsx';
import { useLocalStorage } from '../../shared/hooks.jsx';
import { BarChart, StackedBar } from '../../shared/components/Charts.jsx';
import { TxRow } from '../../shared/components/TxRow.jsx';
import { useTxCtx, useProfiles, useConnectedAccounts, Stat } from '../../app/providers.jsx';
import { STOCK_AVATARS } from '../../shared/constants.js';

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
                      <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{intg.category} Â· {intg.txCount} transactions synced</div>
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
          Connecting a store lets munni retrieve receipt details not included in your bank statements â€” line items, product names, and totals.
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
            Matching receipts for <strong>{sourceTx.merchant}</strong> Â· {fmtEur(Math.abs(sourceTx.amount))}
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
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{fmtDate(r.date, 'long')} Â· {r.items.length} items</div>
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



export function ScreenAccounts() {
  const nav = useNav();
  const { addTxs } = useTxCtx();
  const [connectedAccounts, setConnectedAccounts] = useConnectedAccounts();
  const { profiles, setProfiles } = useProfiles();
  const [showAdd, setShowAdd] = React.useState(false);
  const [bankSearch, setBankSearch] = React.useState('');
  const [selectedBank, setSelectedBank] = useLocalStorage('munni_selected_bank', null);
  const [psd2Step, setPsd2Step] = React.useState(null); // null | 'login' | 'consent' | 'connecting' | 'done'
  const [psd2Bank, setPsd2Bank] = React.useState(null);
  const [customIban, setCustomIban] = React.useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(null);

  const filteredBanks = DUTCH_BANKS.filter(b =>
    !bankSearch || b.name.toLowerCase().includes(bankSearch.toLowerCase())
  );

  const startBankConnect = (bank) => {
    const bic4 = (bank.bic || bank.id).toUpperCase().slice(0, 4);
    const randDigits = String(Math.floor(1000000000 + Math.random() * 9000000000));
    const checkNum = 10 + ((bank.name.charCodeAt(0) || 0) % 89);
    const defaultIban = `NL${checkNum} ${bic4} ${randDigits.slice(0,4)} ${randDigits.slice(4,8)} ${randDigits.slice(8)}`;
    setCustomIban(defaultIban);
    setPsd2Bank(bank);
    setSelectedBank(bank.id);
    setPsd2Step('login');
    setShowAdd(false);
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

  const confirmDelete = (acct) => {
    setConnectedAccounts(a => a.filter(x => x.id !== acct.id));
    setShowDeleteConfirm(null);
  };

  if (psd2Step) {
    return (
      <div className="m-screen">
        <StatusBar/>
        <AppBar title={psd2Bank?.name || 'Connect bank'}
          leading={psd2Step !== 'connecting' ? <button className="m-iconbtn m-tap" onClick={() => setPsd2Step(null)}><I name="x" size={20}/></button> : null}
        />
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', gap:20, overflowY:'auto' }}>
          {psd2Step === 'login' && (
            <>
              <div style={{ textAlign:'center', marginBottom:8 }}>
                <div style={{ fontSize:36, marginBottom:8 }}>{psd2Bank?.logo}</div>
                <div style={{ fontSize:17, fontWeight:700 }}>{psd2Bank?.name}</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:4 }}>Sign in with your {psd2Bank?.name} credentials to continue</div>
              </div>
              <div>
                <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Username / Customer number</div>
                <input defaultValue="demo.user@munni.app" style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Password</div>
                <input type="password" defaultValue="••••••••" style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('accounts.ibanLabel')}</div>
                <input value={customIban} onChange={e => setCustomIban(e.target.value)} placeholder={t('accounts.ibanPlaceholder')} style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontMono, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div style={{ padding:'12px 14px', borderRadius:10, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start' }}>
                <I name="lock" size={16} color={M.sage}/>
                <div style={{ fontSize:12, color:M.ink2, lineHeight:1.45 }}>
                  munni uses <strong>PSD2 Open Banking</strong>. Your credentials are sent directly to {psd2Bank?.name} â€” we never store them.
                </div>
              </div>
              <button className="m-btn sage m-tap" onClick={advancePsd2} style={{ marginTop:'auto' }}>Continue to {psd2Bank?.name}</button>
            </>
          )}
          {psd2Step === 'consent' && (
            <>
              <div style={{ textAlign:'center', marginBottom:8 }}>
                <div style={{ fontSize:36, marginBottom:8 }}>{psd2Bank?.logo}</div>
                <div style={{ fontSize:17, fontWeight:700 }}>Allow access?</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:4 }}>munni requests read-only access to:</div>
              </div>
              <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
                {[
                  { icon:'card', label:'Account information', sub:'IBAN, name, balance' },
                  { icon:'receipt', label:'Transaction history', sub:'Last 13 months Â· read-only' },
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
              <div style={{ fontSize:12, color:M.ink3, textAlign:'center', lineHeight:1.5 }}>
                munni can <strong>never initiate payments</strong>. You can revoke access at any time.
              </div>
              <button className="m-btn sage m-tap" onClick={advancePsd2} style={{ marginTop:'auto' }}>Authorise access</button>
              <button className="m-btn outline m-tap" onClick={() => setPsd2Step(null)}>Cancel</button>
            </>
          )}
          {psd2Step === 'connecting' && (
            <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, textAlign:'center' }}>
              <div style={{ fontSize:36 }}>{psd2Bank?.logo}</div>
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
              <div style={{ fontSize:13, color:M.ink3, lineHeight:1.5, maxWidth:260 }}>
                {psd2Bank?.name} is now connected. Transactions will sync automatically.
              </div>
              <button className="m-btn sage m-tap" onClick={advancePsd2} style={{ marginTop:8 }}>Done</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Bank accounts"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap" onClick={() => setShowAdd(true)}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Connected accounts</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {connectedAccounts.map((a, i) => {
            const isSavings = a.type === 'savings';
            const isInvest = a.type === 'invest';
            return (
              <React.Fragment key={a.id}>
                {i > 0 && <Divider inset={50}/>}
                <div className="m-tap" onClick={() => isSavings && nav.push('savingsDetail', { id: a.id })}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                  <div style={{ width:38, height:38, borderRadius:10, background:a.color, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name={isSavings?'piggy':isInvest?'rocket':'card'} size={18} color="#fff"/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:600 }}>{a.name}</div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                      <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono }}>{a.iban}</div>
                      {a.readOnly && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', letterSpacing:'0.04em' }}>Read-only</span>}
                    </div>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div className="m-num" style={{ fontSize:15, fontWeight:600 }}>{fmtEur(a.balance)}</div>
                    <button className="m-tap" onClick={e => { e.stopPropagation(); setShowDeleteConfirm(a); }}
                      style={{ background:'none', border:'none', padding:4, cursor:'pointer' }}>
                      <I name="x" size={14} color={M.ink4}/>
                    </button>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          <Divider inset={0}/>
          <div className="m-tap" onClick={() => setShowAdd(true)} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
            <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="plus" size={16} color={M.sage}/>
            </div>
            <div style={{ flex:1, fontSize:14, fontWeight:600, color:M.sage }}>Connect a bank</div>
            <I name="caretR" size={14} color={M.ink4}/>
          </div>
        </div>

        <div style={{ padding:'12px 16px', borderRadius:14, background:M.sageSoft, display:'flex', gap:12, alignItems:'flex-start' }}>
          <I name="lock" size={18} color={M.sage}/>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, fontWeight:600, color:M.sage }}>Read-only Â· PSD2 Open Banking</div>
            <div style={{ fontSize:12, color:M.ink2, marginTop:4, lineHeight:1.45 }}>
              munni reads transactions via Open Banking. We can never move money on your behalf.
            </div>
          </div>
        </div>
        <div style={{ height:8 }}/>
      </div>

      {showAdd && (
        <Sheet onClose={() => setShowAdd(false)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div className="m-h2" style={{ marginBottom:12 }}>Connect a bank</div>
            <div style={{ position:'relative', marginBottom:12 }}>
              <I name="search" size={16} color={M.ink4} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}/>
              <input
                autoFocus
                value={bankSearch}
                onChange={e => setBankSearch(e.target.value)}
                placeholder="Search banks…"
                style={{ width:'100%', padding:'10px 12px 10px 36px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}
              />
            </div>
            <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}`, maxHeight:340, overflowY:'auto' }}>
              {filteredBanks.length === 0 && (
                <div style={{ padding:'20px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>No banks found</div>
              )}
              {filteredBanks.map((bank, i) => {
                const connCount = connectedAccounts.filter(a => a.bankId === bank.id).length;
                return (
                  <React.Fragment key={bank.id}>
                    {i > 0 && <Divider inset={48}/>}
                    <div className="m-tap" onClick={() => startBankConnect(bank)}
                      style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                      <div style={{ width:36, height:36, borderRadius:10, background:bank.color+'22', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18 }}>
                        {bank.logo}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:14, fontWeight:500 }}>
                          <HighlightText text={bank.name} query={bankSearch}/>
                        </div>
                        <div style={{ fontSize:11, color:M.ink3, marginTop:1, fontFamily:M.fontMono }}>{bank.bic}</div>
                      </div>
                      {connCount > 0 ? (
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>{connCount}×</span>
                          <I name="caretR" size={14} color={M.ink4}/>
                        </div>
                      ) : <I name="caretR" size={14} color={M.ink4}/>}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </Sheet>
      )}

      {showDeleteConfirm && (
        <Sheet onClose={() => setShowDeleteConfirm(null)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>Remove account?</div>
            <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:20 }}>
              <strong>{showDeleteConfirm.name}</strong> will be disconnected. Historical transactions will remain but new syncing will stop.
            </div>
            <button onClick={() => confirmDelete(showDeleteConfirm)}
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
          <div className="m-cap">Manual transactions Â· {txs.length}</div>
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
                  <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{fmtDate(t.date)} Â· manual entry</div>
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
                    <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{acctTxs.length} transfer{acctTxs.length !== 1 ? 's' : ''} Â· {fmtEur(total)} saved</div>
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
            Saving accounts are the source of truth for all profiles. <strong>Disabling</strong> a saving account makes it read-only â€” no new transactions will be tracked to it.
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
          if (a.attachedBy === myId) return; // own account â€” not "shared with me"
          results.push({
            id: `${p.id}_${a.id}`, name: a.name || 'â€”', iban: a.iban || '',
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
                <div className="m-tap" onClick={() => nav.push('profileDetail', { id: item.profileId })} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                  <div style={{ width:36, height:36, borderRadius:10, background: item.color || M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name={item.type==='savings'?'piggy':item.type==='invest'?'rocket':'card'} size={16} color="#fff"/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</div>
                    {item.iban && <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.iban}</div>}
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:3, flexWrap:'wrap' }}>
                      <span style={{ fontSize:11, color:M.ink3 }}>From <strong>{item.fromName}</strong> Â· <span style={{ color:M.sage, fontWeight:600 }}>{item.profileName}</span></span>
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
                <div className="m-tap" onClick={() => nav.push('profileDetail', { id: profile.id })}
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
                          ? <>From <strong>{contributorName}</strong> Â· <span style={{ color:M.sage, fontWeight:600 }}>{profile.name}</span></>
                          : <>{t('accounts.sharedVia')} <strong>{profile.name}</strong> Â· {memberCount} member{memberCount>1?'s':''}</>
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
  const [showAdd, setShowAdd] = React.useState(false);
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
    const bic4 = (bank.bic || bank.id).toUpperCase().slice(0, 4);
    const randDigits = String(Math.floor(1000000000 + Math.random() * 9000000000));
    const checkNum = 10 + ((bank.name.charCodeAt(0) || 0) % 89);
    const defaultIban = `NL${checkNum} ${bic4} ${randDigits.slice(0,4)} ${randDigits.slice(4,8)} ${randDigits.slice(8)}`;
    setCustomIban(defaultIban);
    setPsd2Bank(bank);
    setSelectedBank(bank.id);
    setPsd2Step('login');
    setShowAdd(false);
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

  if (psd2Step) {
    return (
      <div className="m-screen">
        <StatusBar/>
        <AppBar title={psd2Bank?.name || 'Connect bank'}
          leading={psd2Step !== 'connecting' ? <button className="m-iconbtn m-tap" onClick={() => setPsd2Step(null)}><I name="x" size={20}/></button> : null}
        />
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', gap:20, overflowY:'auto' }}>
          {psd2Step === 'login' && (
            <>
              <div style={{ textAlign:'center', marginBottom:8 }}>
                <div style={{ fontSize:36, marginBottom:8 }}>{psd2Bank?.logo}</div>
                <div style={{ fontSize:17, fontWeight:700 }}>{psd2Bank?.name}</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:4 }}>Sign in with your {psd2Bank?.name} credentials to continue</div>
              </div>
              <div>
                <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Username / Customer number</div>
                <input defaultValue="demo.user@munni.app" style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Password</div>
                <input type="password" defaultValue="••••••••" style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('accounts.ibanLabel')}</div>
                <input value={customIban} onChange={e => setCustomIban(e.target.value)} placeholder={t('accounts.ibanPlaceholder')} style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontMono, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div style={{ padding:'12px 14px', borderRadius:10, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start' }}>
                <I name="lock" size={16} color={M.sage}/>
                <div style={{ fontSize:12, color:M.ink2, lineHeight:1.45 }}>
                  munni uses <strong>PSD2 Open Banking</strong>. Your credentials are sent directly to {psd2Bank?.name} â€” we never store them.
                </div>
              </div>
              <button className="m-btn sage m-tap" onClick={advancePsd2} style={{ marginTop:'auto' }}>Continue to {psd2Bank?.name}</button>
            </>
          )}
          {psd2Step === 'consent' && (
            <>
              <div style={{ textAlign:'center', marginBottom:8 }}>
                <div style={{ fontSize:36, marginBottom:8 }}>{psd2Bank?.logo}</div>
                <div style={{ fontSize:17, fontWeight:700 }}>Allow access?</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:4 }}>munni requests read-only access to:</div>
              </div>
              <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
                {[
                  { icon:'card', label:'Account information', sub:'IBAN, name, balance' },
                  { icon:'receipt', label:'Transaction history', sub:'Last 13 months Â· read-only' },
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
              <button className="m-btn outline m-tap" onClick={() => setPsd2Step(null)}>Cancel</button>
            </>
          )}
          {psd2Step === 'connecting' && (
            <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, textAlign:'center' }}>
              <div style={{ fontSize:36 }}>{psd2Bank?.logo}</div>
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
              <div className="m-tap" onClick={() => setShowAdd(true)} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0', color:M.sage }}>
                <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="plus" size={16} color={M.sage}/>
                </div>
                <div style={{ flex:1, fontSize:14, fontWeight:600 }}>{t('accounts.connectBank')}</div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>
            <div style={{ padding:'12px 14px', borderRadius:12, background:M.sageSoft, display:'flex', gap:10, alignItems:'flex-start', marginBottom:14 }}>
              <I name="lock" size={16} color={M.sage}/>
              <div style={{ fontSize:12, color:M.ink2, lineHeight:1.45 }}>Bank accounts connect via PSD2 Open Banking. munni has read-only access â€” we can never move money.</div>
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
      {showAdd && (
        <Sheet onClose={() => setShowAdd(false)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div className="m-h2" style={{ marginBottom:12 }}>Connect a bank</div>
            <div style={{ position:'relative', marginBottom:12 }}>
              <I name="search" size={16} color={M.ink4} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}/>
              <input autoFocus value={bankSearch} onChange={e => setBankSearch(e.target.value)} placeholder="Search banks…"
                style={{ width:'100%', padding:'10px 12px 10px 36px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
            </div>
            <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}`, maxHeight:340, overflowY:'auto' }}>
              {filteredBanks.length === 0 && <div style={{ padding:'20px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>No banks found</div>}
              {filteredBanks.map((bank, i) => {
                const connCount = connectedAccounts.filter(a => a.bankId === bank.id).length;
                return (
                  <React.Fragment key={bank.id}>
                    {i > 0 && <Divider inset={48}/>}
                    <div className="m-tap" onClick={() => startBankConnect(bank)}
                      style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                      <div style={{ width:36, height:36, borderRadius:10, background:bank.color+'22', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18 }}>{bank.logo}</div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:14, fontWeight:500 }}><HighlightText text={bank.name} query={bankSearch}/></div>
                        <div style={{ fontSize:11, color:M.ink3, marginTop:1, fontFamily:M.fontMono }}>{bank.bic}</div>
                      </div>
                      {connCount > 0 ? (
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>{connCount}×</span>
                          <I name="caretR" size={14} color={M.ink4}/>
                        </div>
                      ) : <I name="caretR" size={14} color={M.ink4}/>}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </Sheet>
      )}

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
            <div className="m-tap" onClick={() => { setShowAddChoice(false); setShowAdd(true); }}
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

