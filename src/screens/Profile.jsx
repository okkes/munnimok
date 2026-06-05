import React from 'react';
import { CATEGORIES, fmtEur, fmtDate, ACCOUNTS, RECURRING, RECURRING_SUGGESTIONS, getUserId, INTEGRATIONS, ALL_RECEIPTS, getUserSyncKey, fmtSyncTime, addDevLog, DEMO_ACCOUNT_IDS, DEMO_ACCOUNTS, computePeriodHistory, generateBankTxs, generateAsnTxs, computeUserDataKey, registerUserInGlobalRegistry, getDefaultProfileName } from '../data.jsx';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../theme.jsx';
import { useDark } from '../nav.jsx';
import { LangCtx, useLang, NavCtx, useNav, Sheet, OTHER_LANGUAGES, TabBar } from '../i18n.jsx';
import { useLocalStorage, useSessionStorage, clearAllStorage } from '../hooks.jsx';
import { BarChart, StackedBar, TxRow } from '../components.jsx';
import { useCatCtx, ProfilesProvider, useProfiles, TxCtx, useTxCtx, AllocProvider, useConnectedAccounts, Stat } from '../providers.jsx';
import { HighlightText, ScreenExpenses, DetailRow } from './Tx.jsx';
import { Toggle, FormRow } from './Events.jsx';
import { useAppCtx } from '../App.jsx';
import { CategoryPicker } from './Review.jsx';
import { ProfileMembersSheet, MemberActionSheet } from '../App.jsx';


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

const STOCK_AVATARS = [
  { id:'av1', emoji:'🧑', bg:'#FF6B6B' },
  { id:'av2', emoji:'👩', bg:'#4ECDC4' },
  { id:'av3', emoji:'👨', bg:'#45B7D1' },
  { id:'av4', emoji:'🧔', bg:'#96CEB4' },
  { id:'av5', emoji:'👱', bg:'#FFEAA7' },
  { id:'av6', emoji:'🧕', bg:'#DDA0DD' },
  { id:'av7', emoji:'🧑‍💼', bg:'#98D8C8' },
  { id:'av8', emoji:'👨‍🎨', bg:'#F7DC6F' },
];

export function ProfileAvatar({ profile, size = 36 }) {
  const borderRadius = Math.round(size * 0.28);
  if (profile?.picture) {
    if (profile.picture.startsWith('av')) {
      const av = STOCK_AVATARS.find(a => a.id === profile.picture);
      if (av) return (
        <div style={{ width:size, height:size, borderRadius, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:size*0.5, flexShrink:0 }}>
          {av.emoji}
        </div>
      );
    }
    if (profile.picture.startsWith('data:')) {
      return <img src={profile.picture} style={{ width:size, height:size, borderRadius, objectFit:'cover', flexShrink:0 }}/>;
    }
  }
  return (
    <div style={{ width:size, height:size, borderRadius, background:M.slate, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
      <span style={{ color:'#fff', fontSize:size*0.38, fontWeight:700, fontFamily:M.fontUI }}>{(profile?.name||'?')[0].toUpperCase()}</span>
    </div>
  );
}

export function ScreenProfile() {
  const nav = useNav();
  const { t } = useLang();
  const [editing, setEditing] = React.useState(false);
  const [loginMethod] = useSessionStorage('munni_last_login_method', '');
  const [email] = useSessionStorage('munni_profile_email', '');
  const _safeEmail = React.useMemo(() => { try { return JSON.parse(email||'""')||''; } catch { return email||''; } }, [email]);
  const _nameKey = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_name');
  const [name, setName] = useLocalStorage(_nameKey, '');
  const pictureKey = React.useMemo(() => {
    if (loginMethod === 'google') return 'munni_user_picture_google';
    if (loginMethod === 'apple') return 'munni_user_picture_apple';
    if (loginMethod === 'bank') return 'munni_user_picture_bank';
    if (_safeEmail && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(_safeEmail)) return `munni_user_picture_${_safeEmail}`;
    return 'munni_user_picture';
  }, [loginMethod, _safeEmail]);
  const [userPicture, setUserPicture] = useLocalStorage(pictureKey, null);
  const _myId = React.useMemo(() => getUserId(), []);
  React.useEffect(() => { registerUserInGlobalRegistry(_myId, name, userPicture); }, [_myId, name, userPicture]);
  const { profiles } = useProfiles();
  const activeProfile = profiles.find(p => p.active) || profiles[0];
  const [connectedAccounts] = useConnectedAccounts();
  const [draft, setDraft] = React.useState({ name });
  const [showReset, setShowReset] = React.useState(false);
  const [showPicturePicker, setShowPicturePicker] = React.useState(false);

  const handleUserFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setUserPicture(ev.target.result); setShowPicturePicker(false); };
    reader.readAsDataURL(file);
  };

  const { logout: logoutFn } = useAppCtx();
  const startEdit = () => { setDraft({ name }); setEditing(true); };
  const save = () => { setName(draft.name); setEditing(false); };
  const cancel = () => setEditing(false);
  const initial = (name || '?').charAt(0).toUpperCase();

  const isDemo = loginMethod === 'bank';
  const connectedBanks = connectedAccounts.filter(a => a.type === 'checking').length;
  const _lastMethod = loginMethod;
  const emailDisplay = isDemo ? 'demo@munni.app' : (email && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(email)) ? email : _lastMethod === 'google' ? t('login.signedInGoogle') : _lastMethod === 'apple' ? t('login.signedInApple') : (email || '');

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.settings')} large
        trailing={editing
          ? <button className="m-tap" onClick={cancel} style={{ background:'transparent', border:'none', fontSize:14, fontWeight:600, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI }}>{t('action.cancel')}</button>
          : null
        }
      />
      <div className="m-body-scroll">
        {/* Identity card */}
        <div className="m-card" style={{ padding: 18, marginBottom: 16, border: `1px solid ${M.line}`, display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="m-tap" onClick={() => !isDemo && setShowPicturePicker(true)} style={{ position:'relative', background:'none', border:'none', cursor: isDemo ? 'default' : 'pointer', padding:0, flexShrink:0 }}>
            {userPicture ? (
              userPicture.startsWith('av') ? (
                (() => { const av = STOCK_AVATARS.find(a => a.id === userPicture); return av ? <div style={{ width:56, height:56, borderRadius:999, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:26 }}>{av.emoji}</div> : null; })()
              ) : (
                <img src={userPicture} style={{ width:56, height:56, borderRadius:999, objectFit:'cover' }}/>
              )
            ) : (
              <div style={{ width:56, height:56, borderRadius:999, background:`linear-gradient(135deg, ${M.sage} 0%, #3D5A42 100%)`, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:22, fontFamily:M.fontDisp }}>{initial}</div>
            )}
            {!isDemo && <div style={{ position:'absolute', bottom:0, right:0, width:20, height:20, borderRadius:'50%', background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #fff' }}>
              <I name="cam" size={10} color="#fff"/>
            </div>}
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing && !isDemo ? (
              <input value={draft.name} onChange={e => setDraft(d => ({...d, name: e.target.value}))}
                style={{ width:'100%', fontSize:16, fontWeight:600, border:`1px solid ${M.sage}`, borderRadius:8, padding:'6px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:6 }}/>
            ) : (
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2, flexWrap:'wrap' }}>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{name}</div>
                {isDemo && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', letterSpacing:'0.05em' }}>Demo</span>}
              </div>
            )}
            <div style={{ fontSize: 12, color: M.ink3 }}>{emailDisplay}</div>
            {isDemo && <div style={{ fontSize:11, color:M.ochre, marginTop:3 }}>Demo account · read-only profile</div>}
          </div>
          {!isDemo && (editing ? (
            <button className="m-tap" onClick={save} style={{ width:36, height:36, borderRadius:999, background:M.sage, border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="check" size={16} color="#fff" stroke={2.5}/>
            </button>
          ) : (
            <button className="m-tap" onClick={startEdit} style={{ width:36, height:36, borderRadius:999, background:M.paper2, border:`1px solid ${M.line}`, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="edit" size={16} color={M.ink3}/>
            </button>
          ))}
        </div>

        {/* Manage */}
        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>{t('settings.manage')}</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 16, border: `1px solid ${M.line}` }}>
          <ProfileLink icon="user"    label={t('settings.profiles')}       sub={`${profiles.length} profile${profiles.length!==1?'s':''} · ${activeProfile?.name}`} onClick={() => nav.push('profiles')}/>
          <Divider inset={48}/>
          <ProfileLink icon="users"   label={t('settings.friends')}        sub={t('settings.friendsSub')}               onClick={() => nav.push('friends')}/>
          <Divider inset={48}/>
          <ProfileLink icon="box"     label={t('screen.categories')}       sub="Manage custom categories"           onClick={() => nav.push('manageCategories')}/>
          <Divider inset={48}/>
          <ProfileLink icon="card"    label={t('screen.accounts')}         sub={`${connectedBanks} connected`}      onClick={() => nav.push('accountsAll')}/>
          <Divider inset={48}/>
          <ProfileLink icon="link"    label="Integrations"                 sub="4 stores connected"                 onClick={() => nav.push('integrations')}/>
          <Divider inset={48}/>
          <ProfileLink icon="cal"     label={t('settings.periods')}        sub={(() => { const [pd] = useLocalStorage ? [null] : [null]; const pday = parseInt(localStorage.getItem('munni_period_day')||'20'); const ptype = localStorage.getItem('munni_period_type')||'monthly'; if(ptype==='weekly') return 'Weekly · '+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][pday]||'Mon'; if(ptype==='biweekly') return 'Bi-weekly · '+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][pday]||'Mon'; return 'Monthly · '+pday+(pday===1||pday===21?'st':pday===2||pday===22?'nd':pday===3||pday===23?'rd':'th'); })()} onClick={() => nav.push('periods')}/>
          <Divider inset={48}/>
          <ProfileLink icon="sliders" label={t('settings.customizeHome')}  sub="Reorder and show/hide cards"        onClick={() => nav.push('customizeHome')}/>
        </div>

        {/* Account */}
        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>{t('settings.account')}</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 16, border: `1px solid ${M.line}` }}>
          <ProfileLink icon="bell"    label={t('settings.notifications')}  onClick={() => nav.push('notifications')}/>
          <Divider inset={48}/>
          <ProfileLink icon="lock"    label="Privacy & security"/>
          <Divider inset={48}/>
          <ProfileLink icon="sun"     label={t('settings.appearance')}     sub="Dark mode, fonts & display"          onClick={() => nav.push('settings')}/>
          <Divider inset={48}/>
          <ProfileLink icon="globe" label={t('settings.language')} sub={t('settings.languageSub')} onClick={() => nav.push('language')}/>
          <Divider inset={48}/>
          <ProfileLink icon="map"     label={t('settings.tutorial')}       sub="Walkthrough of key features"        onClick={() => nav.push('tutorial')}/>
          <Divider inset={48}/>
          <ProfileLink icon="help"    label={t('settings.help')}/>
          <Divider inset={48}/>
          <ProfileLink icon="logout"  label={t('settings.signOut')}        danger onClick={logoutFn}/>
        </div>

        {/* Demo */}
        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Demo</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 16, border: `1px solid ${M.line}` }}>
          <div className="m-tap" onClick={() => setShowReset(true)} style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
            <div style={{ width:32, height:32, borderRadius:9, background:M.claySoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <I name="refresh" size={16} color={M.clay}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:600, color:M.clay }}>{t('settings.resetDemo')}</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('settings.resetDemoSub')}</div>
            </div>
            <I name="caretR" size={16} color={M.ink4}/>
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: 11, color: M.ink4, padding: '12px 0 24px' }}>munni · v1.0.0 · build 248</div>
      </div>

      <TabBar active="profile" onChange={(t) => nav.switchTab(t)}/>

      {showReset && (
        <Sheet onClose={() => setShowReset(false)}>
          <div style={{ padding:'0 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>{t('settings.resetConfirmTitle')}</div>
            <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:20 }}>
              {t('settings.resetConfirmBody')}
            </div>
            <button onClick={() => { clearAllStorage(); window.location.reload(); }}
              style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('settings.resetEverything')}
            </button>
            <button onClick={() => setShowReset(false)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}

      {showPicturePicker && (
        <Sheet onClose={() => setShowPicturePicker(false)}>
          <div style={{ padding:'0 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('profile.picTitle')}</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10, marginBottom:20 }}>
              {STOCK_AVATARS.map(av => (
                <button key={av.id} className="m-tap" onClick={() => { setUserPicture(av.id); setShowPicturePicker(false); }}
                  style={{ background: userPicture === av.id ? M.sage : M.paper2, border: userPicture === av.id ? `2px solid ${M.sage}` : `2px solid ${M.line}`, borderRadius:14, padding:8, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <div style={{ width:40, height:40, borderRadius:999, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22 }}>{av.emoji}</div>
                </button>
              ))}
            </div>
            <label style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0', cursor:'pointer', borderBottom:`1px solid ${M.line2}`, marginBottom:12 }}>
              <div style={{ width:40, height:40, borderRadius:10, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="cam" size={18} color={M.ink2}/>
              </div>
              <div style={{ fontSize:15, fontWeight:500 }}>{t('profile.chooseLibrary')}</div>
              <input type="file" accept="image/*" onChange={handleUserFileChange} style={{ display:'none' }}/>
            </label>
            {userPicture && (
              <button className="m-tap" onClick={() => { setUserPicture(null); setShowPicturePicker(false); }}
                style={{ width:'100%', padding:'12px 0', background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, borderRadius:12, fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                {t('profile.removePic')}
              </button>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenProfiles() {
  const nav = useNav();
  const { t } = useLang();
  const { profiles, setProfiles } = useProfiles();
  const [connectedAccounts] = useConnectedAccounts();
  const [showNewProfile, setShowNewProfile] = React.useState(false);
  const [newProfileName, setNewProfileName] = React.useState('');
  const [newProfileIsDemo, setNewProfileIsDemo] = React.useState(false);
  const [newProfileError, setNewProfileError] = React.useState('');
  const [renameInviteSheet, setRenameInviteSheet] = React.useState(null);
  const myId = React.useMemo(() => getUserId(), []);
  const [invitations, setInvitations] = useLocalStorage('munni_global_invitations', []);
  const [userRegistry] = useLocalStorage('munni_global_users', {});
  const [_blocks] = useLocalStorage('munni_global_blocks', {});

  const myBlockedSenderIds = new Set((_blocks[myId] || []).map(b => b.userId));
  const pendingProfileInvites = invitations.filter(i => i.type === 'profile' && i.toId === myId && i.status === 'pending' && !myBlockedSenderIds.has(i.fromId));

  const acceptProfileInvite = (inv, customName = null) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: 'accepted', respondedAt: Date.now() } : i));
    let freshName, freshPic;
    try {
      const sdKey = `munni_shared_data_${inv.profileId}`;
      const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
      if (sd.left?.[myId] || sd.expelled?.[myId]) {
        const { [myId]: _l, ...remainingLeft } = sd.left || {};
        const { [myId]: _e, ...remainingExpelled } = sd.expelled || {};
        localStorage.setItem(sdKey, JSON.stringify({ ...sd, left: remainingLeft, expelled: remainingExpelled }));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
      }
      const freshSd = JSON.parse(localStorage.getItem(sdKey) || '{}');
      freshName = freshSd.meta?.name;
      freshPic = freshSd.meta?.picture;
    } catch {}
    setProfiles(ps => {
      const existing = ps.find(p => p.id === inv.profileId);
      const originalOwnerId = inv.originalOwnerId || inv.fromId;
      const ownerDisplay = userRegistry[originalOwnerId]?.displayName || originalOwnerId;
      const ownerName = freshName || inv.profileName || 'Shared';
      const trimmedCustom = customName?.trim();
      const profileData = {
        id: inv.profileId, name: ownerName,
        ...(trimmedCustom && trimmedCustom !== ownerName ? { localName: trimmedCustom } : {}),
        icon: inv.profileIcon || 'users', active: false,
        accountIds: inv.profileAccountIds || [],
        picture: freshPic !== undefined ? freshPic : (inv.profilePicture || null),
        isDemo: inv.profileIsDemo || false, isShared: true,
        ownerId: originalOwnerId, ownerDisplay,
        members: [{ userId: originalOwnerId, displayName: ownerDisplay, permission: 'owner', accountIds: [] }],
      };
      if (existing) return ps.map(p => p.id === inv.profileId ? { ...p, ...profileData } : p);
      return [...ps, profileData];
    });
  };

  const declineProfileInvite = (inv) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: 'declined', respondedAt: Date.now() } : i));
  };

  const isUserDemo = sessionStorage.getItem('munni_last_login_method') === 'bank';

  const activateProfile = (id) => setProfiles(ps => ps.map(p => ({ ...p, active: p.id === id })));

  const createProfile = () => {
    const trimmed = newProfileName.trim();
    if (!trimmed) return;
    if (profiles.filter(p => !p.isShared).some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setNewProfileError(t('profile.duplicateName'));
      addDevLog('warn', `Profile creation blocked: duplicate name "${trimmed}"`, 'ScreenProfiles:createProfile');
      return;
    }
    const randomAv = STOCK_AVATARS[Math.floor(Math.random() * STOCK_AVATARS.length)];
    const newP = {
      id: `p_${Date.now()}`,
      name: trimmed,
      icon: 'card',
      active: true,
      accountIds: [],
      picture: randomAv.id,
      isDemo: newProfileIsDemo,
    };
    setProfiles(ps => [...ps.map(p => ({ ...p, active: false })), newP]);
    setShowNewProfile(false);
    setNewProfileName('');
    setNewProfileIsDemo(false);
    setNewProfileError('');
    nav.push('profileDetail', { id: newP.id });
  };

  const profileAccountSub = (p) => {
    const isSharedVariant = p.isShared || (p.members || []).length > 0;
    let count;
    if (isSharedVariant) {
      try {
        const sd = JSON.parse(localStorage.getItem(`munni_shared_data_${p.id}`) || '{"accounts":[]}');
        count = (sd.accounts || []).length;
      } catch { count = 0; }
      if (count === 0) count = (p.accountIds || []).filter(id => connectedAccounts.some(a => a.id === id)).length;
    } else {
      count = (p.accountIds || []).filter(id => connectedAccounts.some(a => a.id === id)).length;
    }
    const acctPart = count === 0 ? t('word.noAccounts') : `${count} ${count === 1 ? t('word.account') : t('word.accounts')}`;
    const memberCount = (p.members || []).length;
    if (memberCount > 0) return `${acctPart} · ${memberCount} ${memberCount === 1 ? t('word.member') : t('word.members')}`;
    return acctPart;
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.profiles')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap" onClick={() => setShowNewProfile(true)}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {pendingProfileInvites.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('profiles.pendingInvites')}</div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.violet||'#7B61FF'}` }}>
              {pendingProfileInvites.map((inv, i) => {
                const senderName = userRegistry[inv.fromId]?.displayName || inv.fromDisplay || inv.fromId;
                const fakeProfile = { picture: inv.profilePicture, name: inv.profileName || '?', icon: inv.profileIcon || 'users' };
                return (
                  <React.Fragment key={inv.id}>
                    {i > 0 && <Divider inset={0}/>}
                    <div style={{ padding:'13px 0' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                        <ProfileAvatar profile={fakeProfile} size={36}/>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inv.profileName || '—'}</span>
                            <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.violetSoft||'#EEE8FF', color:M.violet||'#7B61FF', textTransform:'uppercase', flexShrink:0 }}>Invite</span>
                          </div>
                          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('profile.sharedBy')} <strong>{senderName}</strong></div>
                        </div>
                      </div>
                      <div style={{ display:'flex', gap:8 }}>
                        <button className="m-tap" onClick={() => setRenameInviteSheet({ inv, name: inv.profileName || '' })}
                          style={{ flex:2, padding:'9px 0', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                          {t('friends.profileInviteJoin')}
                        </button>
                        <button className="m-tap" onClick={() => declineProfileInvite(inv)}
                          style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                          {t('friends.decline')}
                        </button>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </>
        )}
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {profiles.map((p, i) => {
            const sub = profileAccountSub(p);
            return (
              <React.Fragment key={p.id}>
                {i > 0 && <Divider inset={48}/>}
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                  <div className="m-tap" onClick={() => activateProfile(p.id)} style={{ flexShrink:0 }}>
                    <ProfileAvatar profile={p} size={36}/>
                  </div>
                  <div className="m-tap" onClick={() => activateProfile(p.id)} style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                      {p.name}
                      {p.isDemo && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase' }}>Demo</span>}
                      {p.isShared && (p.members||[]).some(m => m.userId !== myId) && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.violetSoft||'#EEE8FF', color:M.violet||'#7B61FF', textTransform:'uppercase' }}>Shared</span>}
                      {!p.isShared && (p.members||[]).length > 0 && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>Shared</span>}
                    </div>
                    <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{p.isShared ? `${t('profile.by')} ${(p.ownerDisplay || p.ownerId || '').split(' ')[0]}` : sub}</div>
                  </div>
                  {p.active && (
                    <div style={{ width:20, height:20, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name="check" size={11} color="#fff" stroke={2.5}/>
                    </div>
                  )}
                  <button className="m-iconbtn m-tap" onClick={() => nav.push('profileDetail', { id: p.id })}>
                    <I name="caretR" size={16} color={M.ink4}/>
                  </button>
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div style={{ borderRadius:12, overflow:'hidden', border:`1px solid ${M.line}`, marginBottom:16 }}>
          <div style={{ padding:'14px 16px', background:M.sageSoft }}>
            <div style={{ fontSize:13, fontWeight:600, color:M.sage, marginBottom:4 }}>{t('profiles.aboutTitle')}</div>
            <div style={{ fontSize:12, color:M.ink2, lineHeight:1.6 }}>{t('profiles.aboutDesc')}</div>
          </div>
        </div>
      </div>

      {renameInviteSheet && (
        <Sheet onClose={() => setRenameInviteSheet(null)}>
          <div style={{ padding:'4px 16px 20px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <ProfileAvatar profile={{ name: renameInviteSheet.inv.profileName, picture: renameInviteSheet.inv.profilePicture || null }} size={44}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{renameInviteSheet.inv.profileName || 'Shared profile'}</div>
                <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>
                  {t('profile.by')} <strong>{userRegistry[renameInviteSheet.inv.fromId]?.displayName || renameInviteSheet.inv.fromId}</strong>
                </div>
              </div>
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('profile.nameThisProfile')}</div>
            <input autoFocus
              value={renameInviteSheet.name}
              onChange={e => setRenameInviteSheet(prev => ({ ...prev, name: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && (acceptProfileInvite(renameInviteSheet.inv, renameInviteSheet.name), setRenameInviteSheet(null))}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:6 }}
            />
            <div style={{ fontSize:11, color:M.ink4, marginBottom:20 }}>{t('profile.nameThisProfileHint')}</div>
            <button onClick={() => { acceptProfileInvite(renameInviteSheet.inv, renameInviteSheet.name); setRenameInviteSheet(null); }}
              style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('friends.profileInviteJoin')}
            </button>
            <button onClick={() => setRenameInviteSheet(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}

      {showNewProfile && (
        <Sheet onClose={() => { setShowNewProfile(false); setNewProfileName(''); setNewProfileIsDemo(false); setNewProfileError(''); }}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('profile.newProfile')}</div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('profile.profileName')}</div>
            <input
              value={newProfileName}
              onChange={e => { setNewProfileName(e.target.value); setNewProfileError(''); }}
              onKeyDown={e => e.key === 'Enter' && createProfile()}
              placeholder={t('profile.namePlaceholder')}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${newProfileError ? M.clay : M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom: newProfileError ? 6 : 20 }}
            />
            {newProfileError && <div style={{ fontSize:12, color:M.clay, marginBottom:14 }}>{newProfileError}</div>}
            <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>{t('profile.profileType')}</div>
            <div style={{ display:'flex', gap:8, marginBottom:20 }}>
              {[{v:false,lk:'profile.typeReal',sk:'profile.typeRealSub'},{v:true,lk:'profile.typeDemo',sk:'profile.typeDemoSub'}].map(opt => {
                const disabled = opt.v === false && isUserDemo;
                return (
                  <button key={String(opt.v)} className="m-tap" onClick={() => !disabled && setNewProfileIsDemo(opt.v)}
                    style={{ flex:1, padding:'12px 8px', borderRadius:12, border:`2px solid ${newProfileIsDemo===opt.v ? M.sage : M.line}`, background: disabled ? M.line2 : newProfileIsDemo===opt.v ? M.sageSoft : M.paper2, textAlign:'center', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily:M.fontUI, boxSizing:'border-box', opacity: disabled ? 0.5 : 1 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:newProfileIsDemo===opt.v?M.sage:M.ink }}>{t(opt.lk)}</div>
                    <div style={{ fontSize:10, color:M.ink3, marginTop:2 }}>{t(opt.sk)}</div>
                  </button>
                );
              })}
            </div>
            <button onClick={createProfile}
              style={{ width:'100%', padding:'14px 0', background:newProfileName.trim() ? M.sage : M.line, color:newProfileName.trim() ? '#fff' : M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:newProfileName.trim()?'pointer':'default', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('profile.createProfile')}
            </button>
            <button onClick={() => { setShowNewProfile(false); setNewProfileName(''); setNewProfileIsDemo(false); setNewProfileError(''); }}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenProfileDetail({ params }) {
  const nav = useNav();
  const { t, lang } = useLang();
  const { profiles, setProfiles } = useProfiles();
  const [connectedAccounts] = useConnectedAccounts();
  const { allTxs: ownTxs } = useTxCtx();
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = React.useState(false);
  const [showAttachSheet, setShowAttachSheet] = React.useState(null);
  const [editingName, setEditingName] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState('');
  const [showPhotoSheet, setShowPhotoSheet] = React.useState(false);
  const [showMembersSheet, setShowMembersSheet] = React.useState(false);
  const [memberActionSheet, setMemberActionSheet] = React.useState(null); // userId or null

  const myId = React.useMemo(() => getUserId(), []);
  const [invitations, setInvitations] = useLocalStorage('munni_global_invitations', []);
  const [userRegistry] = useLocalStorage('munni_global_users', {});

  // All hooks before early return
  const profile = profiles.find(p => p.id === params?.id);
  const profileId = profile?.id || 'none';
  const [sharedData, setSharedData] = useLocalStorage(`munni_shared_data_${profileId}`, { accounts: [], txs: [] });

  // Process accepted profile invites for the owner so members appear as soon as they visit the profile detail,
  // not only when they open the members sheet (which was the previous requirement)
  React.useEffect(() => {
    // Also runs for transferred owners (isShared + memberPerms says owner)
    if (!profile || (profile.isShared && sharedData?.memberPerms?.[myId] !== 'owner')) return;
    const accepted = invitations.filter(inv =>
      inv.fromId === myId && inv.type === 'profile' && inv.profileId === profile.id && inv.status === 'accepted'
      && !(profile.members || []).some(m => m.userId === inv.toId)
    );
    if (accepted.length === 0) return;
    setProfiles(ps => ps.map(p => {
      if (p.id !== profile.id) return p;
      const newMembers = accepted.map(inv => ({
        userId: inv.toId,
        displayName: userRegistry[inv.toId]?.displayName || inv.toId,
        permission: inv.permission || 'contributor',
        accountIds: [],
      }));
      return { ...p, members: [...(p.members || []), ...newMembers] };
    }));
    setInvitations(arr => arr.map(i => accepted.some(a => a.id === i.id) ? { ...i, status: 'joined' } : i));
  }, [invitations, profileId, sharedData?.memberPerms?.[myId]]);

  // Auto-leave if expelled by another owner-permission member
  React.useEffect(() => {
    if (!sharedData?.expelled?.[myId]) return;
    setProfiles(ps => {
      const remaining = ps.filter(p => p.id !== profileId);
      if (!remaining.find(p => p.active) && remaining.length > 0) remaining[0] = { ...remaining[0], active: true };
      return remaining;
    });
    nav.pop();
  }, [sharedData?.expelled?.[myId], profileId]);

  // Sync owner's attached accounts + their txs to sharedData when the profile has members
  // (covers accounts attached before first member joined, where toggleAccount skipped the write)
  React.useEffect(() => {
    if (!profile || profile.isShared || (profile.members || []).length === 0) return;
    const acctIds = profile.accountIds || [];
    const owned = connectedAccounts.filter(a => !a.isDemo && acctIds.includes(a.id));
    if (owned.length === 0) return;
    try {
      const sd = JSON.parse(localStorage.getItem(`munni_shared_data_${profile.id}`) || '{"accounts":[],"txs":[]}');
      const existingAcctIds = new Set((sd.accounts || []).map(a => a.id));
      const toAddAccts = owned.filter(a => !existingAcctIds.has(a.id));
      const existingTxIds = new Set((sd.txs || []).map(t => t.id));
      const toAddTxs = (ownTxs || []).filter(t => acctIds.includes(t.account) && !existingTxIds.has(t.id));
      if (toAddAccts.length === 0 && toAddTxs.length === 0) return;
      setSharedData(prev => ({
        ...prev,
        accounts: toAddAccts.length > 0 ? [...(prev.accounts || []), ...toAddAccts.map(a => ({ ...a, attachedBy: myId }))] : (prev.accounts || []),
        txs: toAddTxs.length > 0 ? [...(prev.txs || []), ...toAddTxs] : (prev.txs || []),
      }));
    } catch {}
  }, [profile?.members?.length, JSON.stringify(profile?.accountIds), profileId]);

  if (!profile) return null;

  const members = profile.members || [];
  const isMemberOfShared = !!profile.isShared;
  const otherMembers = members.filter(m => m.userId !== myId);
  const myMembership = members.find(m => m.userId === myId);
  const myPerm = sharedData?.memberPerms?.[myId] || myMembership?.permission || (isMemberOfShared ? 'contributor' : 'owner');
  const canEdit = myPerm !== 'reader';
  const pendingInvitesForProfile = invitations.filter(i => i.fromId === myId && i.type === 'profile' && i.profileId === profile.id && i.status === 'pending');
  const PERM_COLOR = { reader: M.ink3, contributor: M.sage, owner: M.ochre };
  const PERM_LABEL = { reader: t('profile.permReader'), contributor: t('profile.permContributor'), owner: t('profile.permOwner') };

  const sharedAccts = sharedData?.accounts || [];
  const accountIds = profile.accountIds || [];
  const ownConnected = connectedAccounts.filter(a => !a.isDemo);
  const ownConnectedIds = new Set(ownConnected.map(a => a.id));
  const extraShared = sharedAccts.filter(a => !ownConnectedIds.has(a.id));
  const availableAccounts = profile.isDemo ? DEMO_ACCOUNTS : [...ownConnected, ...extraShared];
  const isActive = profile.active;
  const isOnly = profiles.length === 1;

  const isProfileShared = isMemberOfShared || members.length > 0;

  // Sync sharedData.meta ↔ local profile copy so both tabs see name/picture changes live
  React.useEffect(() => {
    const metaName = sharedData?.meta?.name;
    const metaPic = sharedData?.meta?.picture;
    if (!profile || (!metaName && metaPic === undefined)) return;
    const nameChanged = !profile.localName && metaName && metaName !== profile.name;
    const picChanged = metaPic !== undefined && metaPic !== profile.picture;
    if (!nameChanged && !picChanged) return;
    setProfiles(ps => ps.map(p => p.id === profile.id ? {
      ...p,
      ...(nameChanged ? { name: metaName } : {}),
      ...(picChanged ? { picture: metaPic } : {}),
    } : p));
  }, [sharedData?.meta?.name, sharedData?.meta?.picture, profileId]);

  const startEditName = () => { setNameDraft(profile.localName || profile.name); setEditingName(true); };
  const saveName = () => {
    const trimmed = nameDraft.trim();
    if (trimmed) {
      if (isMemberOfShared) {
        setProfiles(ps => ps.map(p => p.id === profile.id
          ? { ...p, localName: trimmed !== p.name ? trimmed : null }
          : p));
      } else {
        setProfiles(ps => ps.map(p => p.id === profile.id ? { ...p, name: trimmed } : p));
        if (isProfileShared) setSharedData(prev => ({ ...prev, meta: { ...(prev.meta || {}), name: trimmed } }));
      }
    }
    setEditingName(false);
  };

  const setPicture = (chosen) => {
    setProfiles(ps => ps.map(p => p.id === profile.id ? { ...p, picture: chosen } : p));
    if (isProfileShared) setSharedData(prev => ({ ...prev, meta: { ...(prev.meta || {}), picture: chosen } }));
    setShowPhotoSheet(false);
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPicture(ev.target.result);
    reader.readAsDataURL(file);
  };

  const toggleAccount = (accountId) => {
    const isInOwnIds = (profile.accountIds || []).includes(accountId);
    const isInSharedAccts = sharedAccts.some(a => a.id === accountId);
    const isCurrentlyAttached = isInOwnIds || isInSharedAccts;
    // Only update profile.accountIds for the user's own account contributions (not member-shared ones)
    if (!isInSharedAccts || isInOwnIds) {
      setProfiles(ps => ps.map(p => {
        if (p.id !== profile.id) return p;
        const ids = p.accountIds || [];
        const newIds = isCurrentlyAttached ? ids.filter(x => x !== accountId) : [...ids, accountId];
        return { ...p, accountIds: newIds };
      }));
    }
    if (members.length > 0 || isMemberOfShared) {
      const account = availableAccounts.find(a => a.id === accountId);
      if (!isCurrentlyAttached && account) {
        setSharedData(sd => {
          const existing = sd.accounts || [];
          if (existing.some(a => a.id === accountId)) return sd;
          const { attachedBy: _ab, ...cleanAcct } = account;
          const newAcct = { ...cleanAcct, attachedBy: myId };
          const acctTxs = (ownTxs || []).filter(t => t.account === accountId);
          const existingTxIds = new Set((sd.txs || []).map(t => t.id));
          const newTxs = acctTxs.filter(t => !existingTxIds.has(t.id));
          return { accounts: [...existing, newAcct], txs: [...(sd.txs || []), ...newTxs] };
        });
      } else if (isCurrentlyAttached) {
        setSharedData(sd => ({
          accounts: (sd.accounts || []).filter(a => a.id !== accountId),
          txs: (sd.txs || []).filter(t => t.account !== accountId),
        }));
      }
    }
  };

  const deleteProfile = () => {
    setProfiles(ps => {
      const remaining = ps.filter(p => p.id !== profile.id);
      if (!remaining.find(p => p.active) && remaining.length > 0) remaining[0] = { ...remaining[0], active: true };
      return remaining;
    });
    nav.pop();
  };

  const cleanupMySharedAccounts = (signalLeft = false) => {
    try {
      const sdKey = `munni_shared_data_${profile.id}`;
      const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
      const myAcctIds = new Set((sd.accounts || []).filter(a => a.attachedBy === myId).map(a => a.id));
      localStorage.setItem(sdKey, JSON.stringify({
        ...sd,
        accounts: (sd.accounts || []).filter(a => a.attachedBy !== myId),
        txs: (sd.txs || []).filter(t => !myAcctIds.has(t.account)),
        ...(signalLeft ? { left: { ...(sd.left || {}), [myId]: Date.now() } } : {}),
      }));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
    } catch {}
  };

  const makeDefaultProfile = () => ({
    id: `p_${Date.now()}`, name: getDefaultProfileName(lang), icon: 'user',
    active: true, accountIds: [], picture: 'av1', isDemo: false,
  });

  const leaveProfile = () => {
    cleanupMySharedAccounts(true);
    setProfiles(ps => {
      const remaining = ps.filter(p => p.id !== profile.id);
      if (remaining.length === 0) return [makeDefaultProfile()];
      if (!remaining.find(p => p.active)) remaining[0] = { ...remaining[0], active: true };
      return remaining;
    });
    nav.pop();
  };

  const transferAndLeave = () => {
    if (otherMembers.length === 0) return;
    const newOwner = otherMembers[0];
    try {
      const sdKey = `munni_shared_data_${profile.id}`;
      const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
      localStorage.setItem(sdKey, JSON.stringify({
        ...sd,
        meta: { ...(sd.meta || {}), newOwnerId: newOwner.userId },
        memberPerms: { ...(sd.memberPerms || {}), [newOwner.userId]: 'owner' },
      }));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
    } catch {}
    cleanupMySharedAccounts(true);
    setProfiles(ps => {
      const remaining = ps.filter(p => p.id !== profile.id);
      if (remaining.length === 0) return [makeDefaultProfile()];
      if (!remaining.find(p => p.active)) remaining[0] = { ...remaining[0], active: true };
      return remaining;
    });
    nav.pop();
  };

  // For shared profiles (invited members), the source of truth is sharedData.accounts from the owner.
  // profile.accountIds is a stale snapshot from invite time and may be missing accounts added later.
  const memberAttachedAccts = sharedAccts.filter(a => !accountIds.includes(a.id));
  const attachedAccountObjects = isMemberOfShared
    ? sharedAccts
    : [...accountIds.map(id => availableAccounts.find(a => a.id === id)).filter(Boolean), ...memberAttachedAccts];
  const attachedMain = attachedAccountObjects.filter(a => a.type === 'checking');
  const attachedSaving = attachedAccountObjects.filter(a => a.type !== 'checking');

  const renderAttachedRow = (a, i) => {
    const sharedAcctData = sharedAccts.find(s => s.id === a.id);
    const isSharedAcct = !!sharedAcctData && !ownConnectedIds.has(a.id);
    const isOwnAcct = ownConnectedIds.has(a.id);
    const canDetach = myPerm === 'owner' || isOwnAcct;
    return (
      <React.Fragment key={a.id}>
        {i > 0 && <Divider inset={50}/>}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
          <div style={{ width:36, height:36, borderRadius:10, background: a.color || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <I name={a.type==='savings'?'piggy':a.type==='invest'?'rocket':'card'} size={16} color="#fff"/>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:14, fontWeight:500 }}>{a.name}</div>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
              <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono }}>{a.iban}</div>
              {a.bankId && <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>Bank</span>}
              {isSharedAcct && <span style={{ fontSize:9, fontWeight:600, padding:'1px 6px', borderRadius:999, background:M.violetSoft||'#EEE8FF', color:M.violet||'#7B61FF' }}>Shared</span>}
            </div>
            {isProfileShared && sharedAcctData?.attachedBy && (() => {
              const attacher = userRegistry[sharedAcctData.attachedBy] || {};
              const attacherName = attacher.displayName || sharedAcctData.attachedBy;
              const isMe = sharedAcctData.attachedBy === myId;
              return <div style={{ fontSize:11, color:M.ink4, marginTop:1 }}>{t('profile.addedBy')} {isMe ? t('word.you') : attacherName}</div>;
            })()}
          </div>
          {canDetach
            ? <button className="m-tap" onClick={() => toggleAccount(a.id)}
                style={{ width:24, height:24, background:M.claySoft, border:'none', borderRadius:999, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', flexShrink:0 }}>
                <I name="x" size={11} color={M.clay}/>
              </button>
            : <I name="lock" size={14} color={M.ink4}/>
          }
        </div>
      </React.Fragment>
    );
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.profile')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {/* Avatar + name */}
        <div className="m-card" style={{ padding:'18px 16px', marginBottom:16, border:`1px solid ${M.line}`, display:'flex', flexDirection:'column', alignItems:'center', gap:10 }}>
          <button className="m-tap" onClick={() => setShowPhotoSheet(true)}
            style={{ position:'relative', background:'none', border:'none', cursor:'pointer', padding:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <ProfileAvatar profile={profile} size={72}/>
            <div style={{ position:'absolute', bottom:0, right:0, width:22, height:22, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #fff' }}>
              <I name="cam" size={11} color="#fff"/>
            </div>
          </button>
          <button className="m-tap" onClick={() => setShowPhotoSheet(true)}
            style={{ fontSize:13, fontWeight:600, color:M.sage, background:'transparent', border:'none', cursor:'pointer', fontFamily:M.fontUI, padding:'4px 12px' }}>
            {t('profile.changePhoto')}
          </button>
          <div style={{ width:'100%' }}>
            {editingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onBlur={saveName}
                onKeyDown={e => e.key==='Enter' && saveName()}
                style={{ width:'100%', fontSize:16, fontWeight:600, border:`1px solid ${M.sage}`, borderRadius:8, padding:'6px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', textAlign:'center', boxSizing:'border-box' }}
              />
            ) : (
              <div className="m-tap" onClick={startEditName} style={{ textAlign:'center' }}>
                <div style={{ fontSize:16, fontWeight:600, borderBottom:`1.5px dashed ${M.line2}`, display:'inline', paddingBottom:1 }}>{profile.localName || profile.name}</div>
                <div style={{ fontSize:10, color:M.ink4, marginTop:4 }}>{isMemberOfShared ? t('profile.tapRenameLocal') : t('profile.tapRename')}</div>
              </div>
            )}
            {isActive && (
              <div style={{ fontSize:11, color:M.sage, fontWeight:600, marginTop:3, textAlign:'center' }}>{t('profile.active')}</div>
            )}
          </div>
        </div>

        {/* Attached main accounts */}
        <div className="m-cap" style={{ marginBottom:4, paddingLeft:4 }}>{t('profile.mainAccounts')}</div>
        <div style={{ fontSize:11, color:M.ink3, marginBottom:8, paddingLeft:4 }}>{t('profile.mainAccountsSub')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {attachedMain.length === 0 && <div style={{ padding:'16px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('profile.noChecking')}</div>}
          {attachedMain.map((a, i) => renderAttachedRow(a, i))}
          {canEdit && !profile.isDemo && (
            <>
              {attachedMain.length > 0 && <Divider inset={0}/>}
              <div className="m-tap" onClick={() => setShowAttachSheet('checking')}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 0' }}>
                <I name="plus" size={16} color={M.sage}/>
                <div style={{ fontSize:13, color:M.sage, fontWeight:600 }}>{t('profile.attachAccount')}</div>
              </div>
            </>
          )}
        </div>

        {/* Attached saving & investment accounts */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('profile.savingAccounts')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {attachedSaving.length === 0 && <div style={{ padding:'16px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('profile.noSaving')}</div>}
          {attachedSaving.map((a, i) => renderAttachedRow(a, i))}
          {canEdit && !profile.isDemo && (
            <>
              {attachedSaving.length > 0 && <Divider inset={0}/>}
              <div className="m-tap" onClick={() => setShowAttachSheet('saving')}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 0' }}>
                <I name="plus" size={16} color={M.sage}/>
                <div style={{ fontSize:13, color:M.sage, fontWeight:600 }}>{t('profile.attachAccount')}</div>
              </div>
            </>
          )}
        </div>

        {/* Members */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('profile.members')}</div>
        {profile.isDemo ? (
          <div className="m-card" style={{ padding:'12px 16px', marginBottom:14, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', gap:12, opacity:0.5 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="lock" size={16} color={M.ink4}/>
            </div>
            <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:600 }}>{t('profile.demoNoInvite')}</div></div>
          </div>
        ) : (
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
            {(() => {
              // For isMemberOfShared views, the current user is rendered separately below — exclude self from this list
              const displayMembers = isMemberOfShared ? members.filter(m => m.userId !== myId) : members;
              return (
                <>
                  {displayMembers.length === 0 && pendingInvitesForProfile.length === 0 && !isMemberOfShared && !isProfileShared && (
                    <div style={{ padding:'14px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('profile.noMembers')}</div>
                  )}
                  {/* Owner self-row: visible when the original owner has members */}
                  {!isMemberOfShared && isProfileShared && (() => {
                    const myInfo = userRegistry[myId] || {};
                    const myDisplayName = myInfo.displayName || myId;
                    return (
                      <>
                        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0' }}>
                          <div style={{ width:32, height:32, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.sage }}>
                            {myDisplayName.charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {myDisplayName} <span style={{ color:M.ink4, fontWeight:400 }}>({t('word.you')})</span>
                            </div>
                          </div>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', flexShrink:0 }}>
                            {PERM_LABEL['owner']}
                          </span>
                        </div>
                        {displayMembers.length > 0 && <Divider inset={44}/>}
                      </>
                    );
                  })()}
                  {displayMembers.map((m, i) => {
                    const info = userRegistry[m.userId] || {};
                    const tappable = myPerm === 'owner';
                    const livePerm = sharedData?.memberPerms?.[m.userId] || m.permission;
                    return (
                      <React.Fragment key={m.userId}>
                        {i > 0 && <Divider inset={44}/>}
                        <div className={tappable ? 'm-tap' : ''} onClick={tappable ? () => setMemberActionSheet(m.userId) : undefined}
                          style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0', cursor: tappable ? 'pointer' : 'default' }}>
                          <div style={{ width:32, height:32, borderRadius:999, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.ink2 }}>
                            {(info.displayName||m.userId).charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.displayName||m.userId}</div>
                          </div>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:livePerm==='owner'?M.ochreSoft:livePerm==='contributor'?M.sageSoft:M.paper2, color:PERM_COLOR[livePerm]||M.ink3, textTransform:'uppercase', flexShrink:0 }}>
                            {PERM_LABEL[livePerm]||livePerm}
                          </span>
                          {tappable && <I name="caretR" size={13} color={M.ink4}/>}
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {isMemberOfShared && (() => {
                    const myInfo = userRegistry[myId] || {};
                    const myDisplayName = myInfo.displayName || myId;
                    return (
                      <>
                        {displayMembers.length > 0 && <Divider inset={44}/>}
                        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0' }}>
                          <div style={{ width:32, height:32, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.sage }}>
                            {myDisplayName.charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {myDisplayName} <span style={{ color:M.ink4, fontWeight:400 }}>({t('word.you')})</span>
                            </div>
                          </div>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:myPerm==='owner'?M.ochreSoft:myPerm==='contributor'?M.sageSoft:M.paper2, color:PERM_COLOR[myPerm]||M.ink3, textTransform:'uppercase', flexShrink:0 }}>
                            {PERM_LABEL[myPerm]||myPerm}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                  {pendingInvitesForProfile.map((inv, i) => {
                    const info = userRegistry[inv.toId] || {};
                    return (
                      <React.Fragment key={inv.id}>
                        {(displayMembers.length > 0 || isMemberOfShared || i > 0) && <Divider inset={44}/>}
                        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0' }}>
                          <div style={{ width:32, height:32, borderRadius:999, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.ochre }}>
                            {(info.displayName||inv.toId).charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.displayName||inv.toId}</div>
                          </div>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', flexShrink:0 }}>{t('friends.pending')}</span>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </>
              );
            })()}
            {myPerm === 'owner' && (
              <>
                {(members.length > 0 || pendingInvitesForProfile.length > 0 || isMemberOfShared) && <Divider inset={0}/>}
                <div className="m-tap" onClick={() => setShowMembersSheet(true)} style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 0' }}>
                  <div style={{ width:32, height:32, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18, fontWeight:400, color:M.sage, lineHeight:1 }}>
                    +
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:500, color:M.sage }}>{t('profile.addMember')}</div>
                  </div>
                  <I name="caretR" size={14} color={M.ink4}/>
                </div>
              </>
            )}
          </div>
        )}

        {(isMemberOfShared && myPerm !== 'owner') ? (
          <button onClick={() => setShowLeaveConfirm(true)}
            style={{ width:'100%', padding:'14px 0', background:M.claySoft, color:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
            {t('profile.leaveProfile')}
          </button>
        ) : otherMembers.length > 0 ? (
          <>
            <button onClick={() => setShowLeaveConfirm(true)}
              style={{ width:'100%', padding:'14px 0', background:M.claySoft, color:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
              {t('profile.transferLeave')}
            </button>
            {!isMemberOfShared && (
              <>
                <button disabled={isOnly||isActive} onClick={() => setShowDeleteConfirm(true)}
                  style={{ width:'100%', padding:'14px 0', background:(isOnly||isActive)?M.line:M.claySoft, color:(isOnly||isActive)?M.ink4:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:(isOnly||isActive)?'not-allowed':'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
                  {t('profile.deleteProfile')}
                </button>
                {(isOnly||isActive) && <div style={{ textAlign:'center', fontSize:12, color:M.ink4 }}>{isActive ? t('profile.cannotDeleteActive') : t('profile.cannotDeleteOnly')}</div>}
              </>
            )}
          </>
        ) : isMemberOfShared ? (
          <button onClick={() => setShowLeaveConfirm(true)}
            style={{ width:'100%', padding:'14px 0', background:M.claySoft, color:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
            {t('profile.leaveProfile')}
          </button>
        ) : (
          <>
            <button disabled={isOnly||isActive} onClick={() => setShowDeleteConfirm(true)}
              style={{ width:'100%', padding:'14px 0', background:(isOnly||isActive)?M.line:M.claySoft, color:(isOnly||isActive)?M.ink4:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:(isOnly||isActive)?'not-allowed':'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
              {t('profile.deleteProfile')}
            </button>
            {(isOnly||isActive) && <div style={{ textAlign:'center', fontSize:12, color:M.ink4 }}>{isActive ? t('profile.cannotDeleteActive') : t('profile.cannotDeleteOnly')}</div>}
          </>
        )}
        <div style={{ height:16 }}/>
      </div>

      {showAttachSheet && (
        <Sheet onClose={() => setShowAttachSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('profile.attachAccount')}</div>
            {(() => {
              const isChecking = showAttachSheet === 'checking';
              const attachedIds = new Set(attachedAccountObjects.map(a => a.id));
              const candidates = availableAccounts.filter(a => (isChecking ? a.type === 'checking' : a.type !== 'checking') && !attachedIds.has(a.id));
              if (candidates.length === 0) {
                return (
                  <>
                    <div style={{ textAlign:'center', color:M.ink3, fontSize:13, padding:'16px 0', marginBottom:12 }}>
                      {isChecking ? t('profile.noCheckingToAttach') : t('profile.noSavingToAttach')}
                    </div>
                    <button className="m-tap" onClick={() => { setShowAttachSheet(null); nav.push('accountsAll'); }}
                      style={{ width:'100%', padding:'12px 0 4px', display:'flex', alignItems:'center', justifyContent:'center', gap:4, background:'transparent', border:'none', cursor:'pointer', fontFamily:M.fontUI }}>
                      <span style={{ fontSize:14, fontWeight:600, color:M.sage }}>{t('profile.manageAccounts')} →</span>
                    </button>
                  </>
                );
              }
              return (
                <>
                  <div style={{ padding:'4px 0', marginBottom:8 }}>
                    {candidates.map((a, i) => (
                      <React.Fragment key={a.id}>
                        {i > 0 && <Divider inset={50}/>}
                        <div className="m-tap" onClick={() => { toggleAccount(a.id); setShowAttachSheet(null); }}
                          style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                          <div style={{ width:36, height:36, borderRadius:10, background: a.color || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                            <I name={a.type==='savings'?'piggy':a.type==='invest'?'rocket':'card'} size={16} color="#fff"/>
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500 }}>{a.name}</div>
                            <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono, marginTop:2 }}>{a.iban}</div>
                          </div>
                          <I name="plus" size={16} color={M.sage}/>
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                  <button className="m-tap" onClick={() => { setShowAttachSheet(null); nav.push('accountsAll'); }}
                    style={{ width:'100%', padding:'16px 0 4px', display:'flex', alignItems:'center', justifyContent:'center', gap:4, background:'transparent', border:'none', cursor:'pointer', fontFamily:M.fontUI }}>
                    <span style={{ fontSize:14, fontWeight:600, color:M.sage }}>{t('profile.manageAccounts')} →</span>
                  </button>
                </>
              );
            })()}
          </div>
        </Sheet>
      )}

      {showPhotoSheet && (
        <Sheet onClose={() => setShowPhotoSheet(false)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('profile.choosePhoto')}</div>
            <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:20 }}>
              {STOCK_AVATARS.map(av => (
                <button key={av.id} className="m-tap" onClick={() => setPicture(av.id)}
                  style={{ width:54, height:54, borderRadius:Math.round(54*0.28), background:av.bg, border: profile.picture===av.id ? `3px solid ${M.sage}` : '3px solid transparent', display:'flex', alignItems:'center', justifyContent:'center', fontSize:26, cursor:'pointer', boxSizing:'border-box' }}>
                  {av.emoji}
                </button>
              ))}
            </div>
            <label style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', cursor:'pointer' }}>
              <div style={{ width:40, height:40, borderRadius:10, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="box" size={18} color={M.ink2}/>
              </div>
              <div style={{ fontSize:15, fontWeight:500 }}>{t('profile.chooseLibrary')}</div>
              <input type="file" accept="image/*" onChange={handleFileChange} style={{ display:'none' }}/>
            </label>
          </div>
        </Sheet>
      )}

      {showMembersSheet && (
        <ProfileMembersSheet profile={profile} onClose={() => setShowMembersSheet(false)}/>
      )}
      {memberActionSheet && (
        <MemberActionSheet profile={profile} memberId={memberActionSheet} onClose={() => setMemberActionSheet(null)}/>
      )}

      {showDeleteConfirm && (
        <Sheet onClose={() => setShowDeleteConfirm(false)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>{t('profile.deleteConfirmTitle')}</div>
            <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:12 }}>
              {t('profile.deleteConfirmDesc')}
            </div>
            {(() => {
              const pid = profile.id;
              const safeLoad = key => { try { return JSON.parse(localStorage.getItem(key) || 'null') || []; } catch { return []; } };
              const budgets = safeLoad(`munni_budgets_${pid}`);
              const goals = safeLoad(`munni_goals_${pid}`);
              const debts = safeLoad(`munni_debts_${pid}`);
              const topics = safeLoad(`munni_topics_${pid}`);
              const items = [
                budgets.length && `${budgets.length} budget${budgets.length > 1 ? 's' : ''}`,
                goals.length && `${goals.length} goal${goals.length > 1 ? 's' : ''}`,
                debts.length && `${debts.length} debt${debts.length > 1 ? 's' : ''}`,
                topics.length && `${topics.length} allocation topic${topics.length > 1 ? 's' : ''}`,
              ].filter(Boolean);
              if (!items.length) return null;
              return (
                <div style={{ padding:'10px 12px', marginBottom:12, borderRadius:10, background:M.claySoft, border:`1px solid ${M.clay}33` }}>
                  <div style={{ fontSize:12, color:M.clay, fontWeight:600, marginBottom:4 }}>{t('profile.deleteDataAlso')}</div>
                  <div style={{ fontSize:12, color:M.ink2 }}>{items.join(' · ')}</div>
                </div>
              );
            })()}
            <div style={{ marginBottom:20 }}/>
            <button onClick={deleteProfile}
              style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('profile.deleteProfile')}
            </button>
            <button onClick={() => setShowDeleteConfirm(false)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}

      {showLeaveConfirm && (
        <Sheet onClose={() => setShowLeaveConfirm(false)}>
          <div style={{ padding:'4px 16px 8px' }}>
            {(() => {
              const isOwnerTransfer = myPerm === 'owner' && otherMembers.length > 0;
              return (
                <>
                  <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>
                    {isOwnerTransfer ? t('profile.transferLeaveConfirmTitle') : t('profile.leaveConfirmTitle')}
                  </div>
                  <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:20 }}>
                    {isOwnerTransfer ? t('profile.transferLeaveConfirmDesc') : t('profile.leaveConfirmDesc')}
                  </div>
                  <button onClick={isOwnerTransfer ? transferAndLeave : leaveProfile}
                    style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
                    {isOwnerTransfer ? t('profile.transferLeave') : t('profile.leaveProfile')}
                  </button>
                </>
              );
            })()}
            <button onClick={() => setShowLeaveConfirm(false)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function ProfileRow({ active, label, sub, icon }) {
  return (
    <div className="m-tap" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: active ? M.sage : M.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <I name={icon} size={16} color={active ? '#fff' : M.ink2}/>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{sub}</div>
      </div>
      {active ? (
        <I name="check" size={16} color={M.sage}/>
      ) : (
        <I name="caretR" size={14} color={M.ink4}/>
      )}
    </div>
  );
}

function ProfileLink({ icon, label, sub, danger, onClick }) {
  return (
    <div className="m-tap" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: M.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <I name={icon} size={16} color={danger ? M.clay : M.ink2}/>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: danger ? M.clay : M.ink }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{sub}</div>}
      </div>
      {!danger && <I name="caretR" size={14} color={M.ink4}/>}
    </div>
  );
}

export function ScreenLanguagePicker({ fromOnboarding = false, onBack }) {
  const navCtx = React.useContext(NavCtx);
  const { lang, setLang, t } = useLang();
  const [search, setSearch] = React.useState('');

  const mainLangs = [
    { code:'en', name:'English', native:'English', twemoji:'1f1ec-1f1e7' },
    { code:'nl', name:'Dutch', native:'Nederlands', twemoji:'1f1f3-1f1f1' },
    { code:'tr', name:'Turkish', native:'Türkçe', twemoji:'1f1f9-1f1f7' },
  ];

  const filteredOther = OTHER_LANGUAGES.filter(l =>
    !search || l.name.toLowerCase().includes(search.toLowerCase()) || l.native.toLowerCase().includes(search.toLowerCase())
  );

  const goBack = () => {
    if (onBack) { onBack(); return; }
    if (navCtx) { navCtx.pop(); }
  };

  const selectLang = (code) => {
    if (code === 'en' || code === 'nl' || code === 'tr') {
      setLang(code);
      goBack();
    }
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('lang.title')}
        leading={<button className="m-iconbtn m-tap" onClick={goBack}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ fontSize:13, color:M.ink3, marginBottom:20, paddingLeft:4, lineHeight:1.5 }}>
          {t('lang.subtitle')}
        </div>

        {/* Available languages */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('lang.availableNow')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:20, border:`1px solid ${M.line}` }}>
          {mainLangs.map((l, i) => (
            <React.Fragment key={l.code}>
              {i > 0 && <Divider inset={52}/>}
              <div className="m-tap" onClick={() => selectLang(l.code)}
                style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 0' }}>
                <img src={`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${l.twemoji}.svg`} width={36} height={36} style={{ borderRadius:3, flexShrink:0 }} alt={l.name}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:15, fontWeight:600 }}>{l.native}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{l.name}</div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>
                    {t('lang.available')}
                  </span>
                  {lang === l.code && (
                    <div style={{ width:20, height:20, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <I name="check" size={11} color="#fff" stroke={2.5}/>
                    </div>
                  )}
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* Other languages */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('lang.otherLanguages')}</div>
        <div style={{ position:'relative', marginBottom:10 }}>
          <I name="search" size={14} color={M.ink4} style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('lang.searchPlaceholder')}
            style={{ width:'100%', padding:'10px 12px 10px 34px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:13, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
        </div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {filteredOther.map((l, i) => (
            <React.Fragment key={l.code}>
              {i > 0 && <Divider inset={52}/>}
              <div style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 0', opacity:0.6 }}>
                <div style={{ width:40, textAlign:'center', fontSize:11, color:M.ink4, fontWeight:600, flexShrink:0, fontFamily:M.fontMono }}>{l.code.toUpperCase()}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}>{l.native}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{l.name}</div>
                </div>
                <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.line2, color:M.ink3, textTransform:'uppercase' }}>
                  {t('lang.comingSoon')}
                </span>
              </div>
            </React.Fragment>
          ))}
          {filteredOther.length === 0 && search && (
            <div style={{ padding:'20px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>No languages found</div>
          )}
        </div>
        <div style={{ height:8 }}/>
      </div>
    </div>
  );
}

export function ScreenSettings() {
  const nav = useNav();
  const { dark, setDark } = useDark();
  const { t } = useLang();
  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.settings')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>{t('settings.appearance')}</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 14, border: `1px solid ${M.line}` }}>
          <div className="m-tap" onClick={() => setDark(!dark)} style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
            <I name={dark ? 'moon' : 'sun'} size={18} color={M.ink2}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>{t('settings.darkMode')}</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{dark ? t('settings.darkModeOn') : t('settings.darkModeOff')}</div>
            </div>
            <Toggle on={dark}/>
          </div>
          <Divider inset={0}/>
          <FormRow label="Currency" value="EUR (€)" caretR/>
          <Divider inset={0}/>
          <FormRow label="Currency" value="EUR (€)" caretR/>
          <Divider inset={0}/>
          <FormRow label="Language" value="English" caretR/>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Behaviour</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 14, border: `1px solid ${M.line}` }}>
          <SettingToggle label="Auto-categorize" sub="Use AI to classify new tx" on/>
          <Divider inset={0}/>
          <SettingToggle label="Daily summary" sub="9:00 push notification" on/>
          <Divider inset={0}/>
          <SettingToggle label="Round-up to savings" sub="Round purchases up to nearest €1"/>
        </div>
      </div>
    </div>
  );
}

export function ScreenPeriods() {
  const nav = useNav();
  const { t } = useLang();
  const [selectedDay, setSelectedDay] = useLocalStorage('munni_period_day', 20);
  const [periodType, setPeriodType] = useLocalStorage('munni_period_type', 'monthly');
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  const ordinalStr = (d) => {
    if (d === 1 || d === 21) return `${d}st`;
    if (d === 2 || d === 22) return `${d}nd`;
    if (d === 3 || d === 23) return `${d}rd`;
    return `${d}th`;
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.periods')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ padding:'12px 16px', borderRadius:12, background:M.sageSoft, marginBottom:18, fontSize:13, color:M.sage, lineHeight:1.6 }}>
          <strong>What is a period?</strong> munni organises your finances in periods. A period starts on your chosen day — ideally when your salary arrives — so income and expenses always line up.
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Period type</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:20 }}>
          {[['monthly','Monthly'],['biweekly','Bi-weekly'],['weekly','Weekly']].map(([type,label]) => (
            <button key={type} className="m-tap" onClick={() => setPeriodType(type)} style={{
              height:48, borderRadius:12, border:`1.5px solid ${periodType===type?M.sage:M.line}`,
              background:periodType===type?M.sage:M.card, color:periodType===type?'#fff':M.ink,
              fontSize:13, fontWeight:periodType===type?700:400, cursor:'pointer', fontFamily:M.fontUI,
            }}>{label}</button>
          ))}
        </div>

        {periodType === 'monthly' ? (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Start day of month</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:8, marginBottom:20 }}>
              {days.map(d => (
                <button key={d} className="m-tap" onClick={() => setSelectedDay(d)} style={{
                  height:44, borderRadius:12, border:`1.5px solid ${selectedDay === d ? M.sage : M.line}`,
                  background: selectedDay === d ? M.sage : M.card,
                  color: selectedDay === d ? '#fff' : M.ink,
                  fontSize:14, fontWeight: selectedDay === d ? 700 : 400,
                  cursor:'pointer', fontFamily:M.fontUI,
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>{d}</button>
              ))}
            </div>
            <div className="m-card" style={{ padding:14, marginBottom:16, border:`1px solid ${M.line}` }}>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Current period</div>
              <div style={{ fontSize:13, color:M.ink3 }}>
                Starts on the <strong>{ordinalStr(selectedDay)}</strong> of each month.
              </div>
              <div style={{ fontSize:12, color:M.sage, marginTop:6, fontWeight:500 }}>
                {(() => { const ph = computePeriodHistory(selectedDay); const cur = ph[ph.length-1]; return cur ? cur.label : ''; })()}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Start day of week</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:6, marginBottom:20 }}>
              {DAY_NAMES.map((day, idx) => (
                <button key={idx} className="m-tap" onClick={() => setSelectedDay(idx)} style={{
                  height:44, borderRadius:12, border:`1.5px solid ${selectedDay===idx?M.sage:M.line}`,
                  background:selectedDay===idx?M.sage:M.card, color:selectedDay===idx?'#fff':M.ink,
                  fontSize:11, fontWeight:selectedDay===idx?700:400, cursor:'pointer', fontFamily:M.fontUI,
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>{day.slice(0,3)}</button>
              ))}
            </div>
            <div className="m-card" style={{ padding:14, marginBottom:16, border:`1px solid ${M.line}` }}>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Current period</div>
              <div style={{ fontSize:13, color:M.ink3 }}>
                {periodType === 'weekly' ? 'Weekly' : 'Every 2 weeks'}, starting on <strong>{DAY_NAMES[selectedDay] || 'Monday'}</strong>.
              </div>
            </div>
          </>
        )}

        <div style={{ padding:'10px 14px', borderRadius:10, background:M.ochreSoft, marginBottom:20, fontSize:12, color:M.ochre, lineHeight:1.5 }}>
          <strong>Tip:</strong> Monthly periods work best when your salary arrives on a fixed day.
        </div>

        <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={() => nav.pop()}>
          {t('action.save')}
        </button>
      </div>
    </div>
  );
}

function MunniSVG({ expr }) {
  expr = expr || 'happy';
  const p = { stroke:'#4A2E1E', strokeWidth:1.5, fill:'none', strokeLinecap:'round', strokeLinejoin:'round' };
  return (
    <svg viewBox="0 0 80 120" width="72" height="108" style={{ flexShrink:0 }}>
      {/* Papers */}
      <g transform="translate(1,64) rotate(-18)"><rect width="24" height="32" rx="2" fill="#fff" stroke="#ddd" strokeWidth="1"/><line x1="4" y1="8" x2="20" y2="8" stroke="#e5e5e5" strokeWidth="1"/><line x1="4" y1="13" x2="17" y2="13" stroke="#e5e5e5" strokeWidth="1"/><line x1="4" y1="18" x2="21" y2="18" stroke="#e5e5e5" strokeWidth="1"/></g>
      <g transform="translate(5,67) rotate(-7)"><rect width="24" height="32" rx="2" fill="#F7F4EE" stroke="#ccc" strokeWidth="1"/></g>
      <g transform="translate(9,70) rotate(-1)"><rect width="24" height="32" rx="2" fill="#fff" stroke="#bbb" strokeWidth="1"/><line x1="4" y1="8" x2="19" y2="8" stroke="#e5e5e5" strokeWidth="1"/><line x1="4" y1="13" x2="15" y2="13" stroke="#e5e5e5" strokeWidth="1"/></g>
      {/* Body */}
      <path d="M28 65 Q22 73 21 92 Q20 106 22 114 L58 114 Q60 106 59 92 Q58 73 52 65 Z" fill="#6CAE75"/>
      <path d="M36 65 L40 75 L44 65" fill="none" stroke="#5a9c63" strokeWidth="1.5"/>
      {/* Arms */}
      <path d="M28 70 Q16 81 18 96" fill="none" stroke="#F4C2A1" strokeWidth="7" strokeLinecap="round"/>
      <path d="M52 70 Q63 79 61 94" fill="none" stroke="#F4C2A1" strokeWidth="7" strokeLinecap="round"/>
      {/* Neck */}
      <rect x="36.5" y="56" width="7" height="11" rx="3" fill="#F4C2A1"/>
      {/* Head */}
      <ellipse cx="40" cy="42" rx="14" ry="16" fill="#F4C2A1"/>
      {/* Hair */}
      <path d="M26 37 Q26 23 40 21 Q54 23 54 37 Q52 26 40 24 Q28 26 26 37 Z" fill="#4A2E1E"/>
      <path d="M26 35 Q23 47 26 56" stroke="#4A2E1E" strokeWidth="5" fill="none" strokeLinecap="round"/>
      <path d="M54 35 Q57 47 54 57" stroke="#4A2E1E" strokeWidth="5" fill="none" strokeLinecap="round"/>
      <path d="M35 22 Q32 14 37 11" stroke="#4A2E1E" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      {/* Glasses */}
      <circle cx="35.5" cy="42" r="5" fill="rgba(200,220,255,0.12)" stroke="#4A2E1E" strokeWidth="1.5"/>
      <circle cx="44.5" cy="42" r="5" fill="rgba(200,220,255,0.12)" stroke="#4A2E1E" strokeWidth="1.5"/>
      <line x1="40.5" y1="42" x2="39.5" y2="42" stroke="#4A2E1E" strokeWidth="1.5"/>
      <line x1="30" y1="41" x2="28" y2="40" stroke="#4A2E1E" strokeWidth="1.5"/>
      <line x1="50" y1="41" x2="52" y2="40" stroke="#4A2E1E" strokeWidth="1.5"/>
      {/* Eyes */}
      {expr === 'tired' ? (
        <><path d="M32.5 42.5 Q35.5 44.5 38.5 42.5" {...p}/><path d="M41.5 42.5 Q44.5 44.5 47.5 42.5" {...p}/><path d="M53 34 Q55.5 30 53 28 Q50.5 30 53 34 Z" fill="#A8D4E6"/></>
      ) : expr === 'celebrating' ? (
        <><path d="M32 42 Q35.5 40 38.5 42" {...p}/><path d="M41.5 42 Q44.5 40 47.5 42" {...p}/></>
      ) : (
        <><circle cx="35.5" cy="42" r="1.8" fill="#4A2E1E"/><circle cx="44.5" cy="42" r="1.8" fill="#4A2E1E"/><circle cx="36.4" cy="41" r="0.7" fill="#fff"/><circle cx="45.4" cy="41" r="0.7" fill="#fff"/></>
      )}
      {/* Eyebrows */}
      {(expr === 'focused' || expr === 'tired') ? (
        <><path d="M32 37 Q35.5 36 38.5 37" {...p} strokeWidth="1.8"/><path d="M41.5 37 Q44.5 36 47.5 37" {...p} strokeWidth="1.8"/></>
      ) : (
        <><path d="M32 37 Q35.5 35.5 38.5 37" {...p} strokeWidth="1.2"/><path d="M41.5 37 Q44.5 35.5 47.5 37" {...p} strokeWidth="1.2"/></>
      )}
      {/* Mouth */}
      {expr === 'happy' && <path d="M36 49 Q40 52 44 49" {...p} strokeWidth="1.8"/>}
      {expr === 'excited' && <path d="M35 48.5 Q40 53 45 48.5" {...p} strokeWidth="1.8"/>}
      {expr === 'focused' && <path d="M37 49.5 Q40 48.5 43 49.5" {...p} strokeWidth="1.5"/>}
      {expr === 'tired' && <path d="M37 49 Q40 47.5 43 49" {...p} strokeWidth="1.5"/>}
      {expr === 'celebrating' && <path d="M35 48 Q40 54.5 45 48" {...p} strokeWidth="2"/>}
      {/* Blush */}
      {(expr === 'happy' || expr === 'excited' || expr === 'celebrating') && (
        <><ellipse cx="31" cy="46" rx="3.5" ry="2" fill="#FFB5B5" opacity="0.45"/><ellipse cx="49" cy="46" rx="3.5" ry="2" fill="#FFB5B5" opacity="0.45"/></>
      )}
    </svg>
  );
}

export function ScreenTutorial() {
  const nav = useNav();
  const [step, setStep] = React.useState(0);

  const STEPS = [
    { expr:'happy',       speech:"Hi! I'm Munni — your finance assistant. I'll show you the key features. It only takes a minute!", noTarget:true },
    { expr:'excited',     speech:"New bank transactions need your review! Tap the Review card to check and categorize them.", targetHint:'Review transactions' },
    { expr:'focused',     speech:"Once you're happy with the category, tap Confirm. You can bulk-apply to similar transactions too!", targetHint:'Confirm' },
    { expr:'excited',     speech:"The Allocate section shows your spending plan. Set budgets per topic and track your progress!", targetHint:'Allocate' },
    { expr:'focused',     speech:"Set your period start day to match when your salary lands — keeps income and expenses in sync.", targetHint:'Manage Periods' },
    { expr:'celebrating', speech:"You're all set! Explore munni and remember — I'm always here if you need help. 💚", noTarget:true, isLast:true },
  ];
  const cur = STEPS[step];
  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));

  const Overlay = () => <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.58)', zIndex:8, pointerEvents:'none' }}/>;

  const Spotlight = ({ children, color, onClick }) => (
    <div onClick={onClick} className="m-tap" style={{ position:'relative', zIndex:9, cursor:'pointer', borderRadius:14 }}>
      {children}
      <div style={{ position:'absolute', inset:-5, borderRadius:18, border:`2.5px solid ${color || M.sage}`, opacity:0.7, animation:'munniPulse 1.4s ease-in-out infinite', pointerEvents:'none' }}/>
    </div>
  );

  return (
    <div className="m-screen" style={{ background:M.paper }}>
      <style>{`@keyframes munniPulse{0%,100%{opacity:.8;transform:scale(1)}50%{opacity:.3;transform:scale(1.05)}}`}</style>
      <StatusBar/>

      {/* Mock screen area — fills flex space */}
      <div style={{ flex:1, position:'relative', overflow:'hidden' }}>

        {step === 0 && (
          <div style={{ height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'0 36px', textAlign:'center', gap:10 }}>
            <div style={{ width:68, height:68, borderRadius:20, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', marginBottom:4 }}>
              <I name="wallet" size={30} color={M.sage}/>
            </div>
            <div style={{ fontSize:22, fontWeight:700, color:M.ink, lineHeight:1.3 }}>Welcome to munni</div>
            <div style={{ fontSize:13, color:M.ink3, lineHeight:1.7, maxWidth:250 }}>Your smart personal finance companion — built around the way you actually get paid.</div>
          </div>
        )}

        {step === 1 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 10px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Home</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div style={{ padding:'12px 16px', borderRadius:14, background:M.card, border:`1px solid ${M.line}`, marginBottom:10, opacity:0.25 }}>
                <div style={{ fontSize:12, color:M.ink3 }}>Feb 2026 · Period overview</div>
              </div>
              <Spotlight color={M.sage} onClick={next}>
                <div style={{ borderRadius:14, background:M.sage, padding:'14px 18px', display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:36, height:36, borderRadius:11, background:'rgba(255,255,255,0.22)', display:'flex', alignItems:'center', justifyContent:'center' }}><I name="check" size={18} color="#fff" stroke={2.5}/></div>
                  <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:700, color:'#fff' }}>Review transactions</div><div style={{ fontSize:12, color:'rgba(255,255,255,0.85)', marginTop:1 }}>7 waiting</div></div>
                  <I name="arrowR" size={15} color="rgba(255,255,255,0.7)"/>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 8px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Review · 1/7</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div className="m-card" style={{ padding:18, border:`1px solid ${M.line}`, background:'#fff', marginBottom:10, opacity:0.35 }}>
                <div style={{ textAlign:'center' }}>
                  <div className="m-num" style={{ fontSize:26, fontWeight:600 }}>−€34.99</div>
                  <div style={{ fontSize:14, fontWeight:600, marginTop:6 }}>Amazon.nl</div>
                  <div style={{ marginTop:10, padding:'8px 10px', borderRadius:10, background:M.paper2 }}>
                    <div style={{ display:'flex', gap:8, alignItems:'center' }}><div style={{ width:22, height:22, borderRadius:7, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}><I name="box" size={11} color={M.sage}/></div><div style={{ fontSize:12 }}>Hobby · €34.99</div></div>
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding:'0 20px', flexShrink:0, position:'relative', zIndex:9 }}>
              <Spotlight color={M.sage} onClick={next}>
                <div style={{ height:50, borderRadius:14, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                  <I name="check" size={18} color="#fff" stroke={2.5}/>
                  <span style={{ fontSize:14, fontWeight:600, color:'#fff', fontFamily:M.fontUI }}>Confirm</span>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 10px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Home</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div style={{ padding:'12px 16px', borderRadius:14, background:M.card, border:`1px solid ${M.line}`, marginBottom:10, opacity:0.25 }}>
                <div style={{ fontSize:12, color:M.ink3 }}>Period balance · +€320</div>
              </div>
              <Spotlight color={M.violet} onClick={next}>
                <div style={{ borderRadius:14, background:M.card, border:`1px solid ${M.line}`, padding:'14px 18px', display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:36, height:36, borderRadius:11, background:M.violetSoft||'#EEE8FF', display:'flex', alignItems:'center', justifyContent:'center' }}><I name="wallet" size={18} color={M.violet}/></div>
                  <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:600 }}>Allocate</div><div style={{ fontSize:12, color:M.ink3, marginTop:1 }}>€340 left to plan</div></div>
                  <I name="arrowR" size={14} color={M.ink4}/>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <Overlay/>
            <div style={{ padding:'14px 20px 10px', fontSize:17, fontWeight:700, position:'relative', zIndex:1 }}>Profile</div>
            <div style={{ padding:'0 20px', position:'relative', zIndex:1 }}>
              <div style={{ padding:'12px 16px', borderRadius:14, background:M.card, border:`1px solid ${M.line}`, marginBottom:10, opacity:0.25 }}>
                <div style={{ fontSize:12, color:M.ink3 }}>Manage · Categories</div>
              </div>
              <Spotlight color={M.ochre} onClick={next}>
                <div style={{ borderRadius:14, background:M.card, border:`1px solid ${M.line}`, padding:'13px 16px', display:'flex', alignItems:'center', gap:12 }}>
                  <div style={{ width:34, height:34, borderRadius:10, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center' }}><I name="cal" size={16} color={M.ochre}/></div>
                  <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:500 }}>Manage Periods</div><div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>Set salary start day</div></div>
                  <I name="arrowR" size={14} color={M.ink4}/>
                </div>
              </Spotlight>
            </div>
          </>
        )}

        {step === 5 && (
          <div style={{ height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'0 36px', textAlign:'center', gap:8 }}>
            <div style={{ fontSize:52, lineHeight:1 }}>🎉</div>
            <div style={{ fontSize:22, fontWeight:700, color:M.ink, marginTop:4 }}>You're all set!</div>
            <div style={{ fontSize:13, color:M.ink3, lineHeight:1.7, maxWidth:250 }}>Explore munni — and come back to this tutorial anytime from your Profile.</div>
          </div>
        )}
      </div>

      {/* Bottom: Munni + speech bubble */}
      <div style={{ flexShrink:0, padding:'8px 20px 28px', background:M.paper, borderTop:`1px solid ${M.line2}` }}>
        <div style={{ display:'flex', justifyContent:'center', gap:5, marginBottom:12 }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{ width: i===step ? 20 : 6, height:6, borderRadius:999, background: i===step ? M.sage : i<step ? M.sage+'66' : M.line2, transition:'all 0.3s' }}/>
          ))}
        </div>

        <div style={{ display:'flex', alignItems:'flex-end', gap:10 }}>
          <MunniSVG expr={cur.expr}/>
          <div style={{ flex:1, marginBottom:2 }}>
            <div style={{ background:'#fff', border:`1.5px solid ${M.line}`, borderRadius:16, padding:'11px 13px', marginBottom:10, fontSize:13, color:M.ink, lineHeight:1.6, boxShadow:'0 2px 10px rgba(0,0,0,0.05)', position:'relative' }}>
              {cur.speech}
              <div style={{ position:'absolute', left:-8, bottom:13, width:0, height:0, borderTop:'5px solid transparent', borderBottom:'5px solid transparent', borderRight:`8px solid ${M.line}` }}/>
              <div style={{ position:'absolute', left:-6, bottom:14, width:0, height:0, borderTop:'4px solid transparent', borderBottom:'4px solid transparent', borderRight:'7px solid #fff' }}/>
            </div>
            {cur.noTarget ? (
              <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={cur.isLast ? () => nav.pop() : next}>
                {cur.isLast ? <><I name="check" size={14} color="#fff" stroke={2.5}/> Done</> : "Let's go →"}
              </button>
            ) : (
              <div style={{ fontSize:12, color:M.ink4, textAlign:'center', fontStyle:'italic' }}>
                Tap <strong style={{ color:M.ink3, fontStyle:'normal' }}>{cur.targetHint}</strong> above to continue
              </div>
            )}
          </div>
        </div>

        {step < STEPS.length - 1 && (
          <button onClick={() => nav.pop()} style={{ display:'block', margin:'10px auto 0', background:'none', border:'none', fontSize:12, color:M.ink4, cursor:'pointer', fontFamily:M.fontUI, padding:'4px 16px' }}>
            Skip tutorial
          </button>
        )}
      </div>
    </div>
  );
}

function NewCatForm({ onSave, isSub = false }) {
  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState('help-circle-outline');
  const [color, setColor] = React.useState(M.slate);
  const mdiIcons = [
    'help-circle-outline','home-outline','car-outline','heart-outline','star-outline',
    'food-outline','cart-variant','coffee-outline','television-play','hospital-box-outline',
    'shopping-outline','island','school-outline','dumbbell','baby-face-outline',
    'cash-plus','piggy-bank-outline','cellphone-link','gift-outline','book-education-outline',
    'briefcase-outline','bus-side','airplane-takeoff','medication-outline','paw-outline',
  ];
  const colors = [M.sage, M.clay, M.ochre, M.violet, M.slate, '#e07b39', '#6b8e6b', '#8e6b8e'];
  return (
    <div style={{ paddingBottom:8 }}>
      <input
        value={name} onChange={e => setName(e.target.value)}
        placeholder="Category name"
        style={{ width:'100%', boxSizing:'border-box', border:`1px solid ${M.line}`, borderRadius:10, padding:'11px 14px', fontSize:14, fontFamily:M.fontUI, marginBottom:14, outline:'none', background:M.paper2, color:M.ink }}
      />
      <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Icon</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14 }}>
        {mdiIcons.map(ic => (
          <button key={ic} className="m-tap" onClick={() => setIcon(ic)}
            style={{ width:36, height:36, borderRadius:8, background: icon===ic?M.sageSoft:M.paper2, border:`1.5px solid ${icon===ic?M.sage:M.line}`, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
            <IcoMDI name={ic} size={15} color={icon===ic?M.sage:M.ink3}/>
          </button>
        ))}
      </div>
      {!isSub && (
        <>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Color</div>
          <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
            {colors.map(clr => (
              <button key={clr} className="m-tap" onClick={() => setColor(clr)}
                style={{ width:28, height:28, borderRadius:'50%', background:clr, border:`2.5px solid ${color===clr?M.ink:'transparent'}`, cursor:'pointer' }}/>
            ))}
          </div>
        </>
      )}
      <button className="m-tap" onClick={() => name.trim() && onSave(name.trim(), icon, color)}
        disabled={!name.trim()}
        style={{ width:'100%', background:M.sage, border:'none', borderRadius:12, padding:'13px', color:'#fff', fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, opacity: name.trim()?1:0.5 }}>
        {isSub ? 'Add sub-category' : 'Add category'}
      </button>
    </div>
  );
}

function EditCatSheet({ entry, txCount = 0, onSave, onDelete, isPrebuilt = false }) {
  const [nameDraft, setNameDraft] = React.useState(entry.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const canDelete = onDelete !== null;
  const isParent = entry.isParent;
  if (showDeleteConfirm) {
    return (
      <div style={{ padding:'4px 16px 8px' }}>
        <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>Delete "{entry.name}"?</div>
        {txCount > 0 && (
          <div style={{ padding:'10px 14px', borderRadius:10, background:M.claySoft, marginBottom:14, fontSize:13, color:M.clay, lineHeight:1.5 }}>
            <strong>{txCount} transaction{txCount!==1?'s':''}</strong> using this category will be set to Uncategorized.
          </div>
        )}
        <div style={{ fontSize:13, color:M.ink3, marginBottom:20, lineHeight:1.5 }}>This action cannot be undone.</div>
        <button onClick={onDelete} style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>Delete</button>
        <button onClick={() => setShowDeleteConfirm(false)} style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>Cancel</button>
      </div>
    );
  }
  return (
    <div style={{ padding:'4px 16px 8px' }}>
      <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{isParent ? 'Edit category' : 'Edit sub-category'}</div>
      <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Name</div>
      {isPrebuilt ? (
        <div style={{ padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, marginBottom:8, color:M.ink }}>{nameDraft}</div>
      ) : (
        <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
          style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
      )}
      {isPrebuilt && <div style={{ fontSize:11, color:M.ink3, marginBottom:16, paddingLeft:2 }}>Built-in category names cannot be changed.</div>}
      {!isPrebuilt && <div style={{ marginBottom:20 }}/>}
      <button onClick={() => nameDraft.trim() && onSave(nameDraft.trim(), entry.icon, entry.color)}
        style={{ width:'100%', padding:'14px 0', background:nameDraft.trim()?M.sage:M.line, color:nameDraft.trim()?'#fff':M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:nameDraft.trim()?'pointer':'default', fontFamily:M.fontUI, marginBottom:canDelete?12:10 }}>
        Save
      </button>
      {canDelete && (
        <>
          {txCount > 0 && <div style={{ fontSize:12, color:M.ochre, marginBottom:8, textAlign:'center' }}>{txCount} transaction{txCount!==1?'s':''} will be set to uncategorized</div>}
          <button onClick={() => setShowDeleteConfirm(true)}
            style={{ width:'100%', padding:'14px 0', background:'transparent', color:M.clay, border:`1.5px solid ${M.clay}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            Delete category
          </button>
        </>
      )}
    </div>
  );
}

export function ScreenManageCategories() {
  const nav = useNav();
  const { t } = useLang();
  const { txs, setTxs } = useTxCtx();
  const { customCats, setCustomCats } = useCatCtx();
  const [premadeOverrides, setPremadeOverrides] = useLocalStorage('munni_cat_overrides', {});
  const [newParentSheet, setNewParentSheet] = React.useState(false);
  const [newSubSheet, setNewSubSheet] = React.useState(null);
  const [dragState, setDragState] = React.useState(null);
  const [dropTarget, setDropTarget] = React.useState(null);
  const [editSheet, setEditSheet] = React.useState(null);
  const [collapsedParents, setCollapsedParents] = React.useState({});
  const [txCounts, setTxCounts] = React.useState({});

  React.useEffect(() => {
    const counts = {};
    txs.forEach(t => {
      if (t.cat) counts[t.cat] = (counts[t.cat] || 0) + 1;
    });
    setTxCounts(counts);
  }, [txs]);

  // Helpers
  const customParents = customCats.filter(c => c.isParent);
  const premadeParents = Object.entries(CATEGORIES).filter(([k,v]) => v.isParent && !v.positive && k !== 'saving' && k !== 'expense');

  const getCustomSubs = (parentId) => customCats.filter(c => !c.isParent && c.parent === parentId);
  const getPremadeSubs = (parentKey) => Object.entries(CATEGORIES).filter(([k,v]) => v.parent === parentKey);
  const getCustomSubsOfPremade = (parentKey) => customCats.filter(c => !c.isParent && c.parent === parentKey);

  const deleteCustomSub = (catId) => {
    setCustomCats(prev => prev.filter(c => c.id !== catId));
    setTxs(prev => prev.map(t => {
      if (t.cat === catId) {
        const fallback = (t.amount >= 0) ? 'incomeUncategorized' : 'expenseUncategorized';
        return { ...t, cat: fallback, cats: [{ catId: fallback, amount: Math.abs(t.amount) }] };
      }
      return t;
    }));
  };

  const deleteCustomParent = (parentId) => {
    const subsToDelete = new Set(customCats.filter(c => c.parent === parentId).map(c => c.id));
    subsToDelete.add(parentId);
    setCustomCats(prev => prev.filter(c => !subsToDelete.has(c.id) && c.parent !== parentId));
    setTxs(prev => prev.map(t => {
      if (subsToDelete.has(t.cat) || t.cat === parentId) {
        const fallback = (t.amount >= 0) ? 'incomeUncategorized' : 'expenseUncategorized';
        return { ...t, cat: fallback, cats: [{ catId: fallback, amount: Math.abs(t.amount) }] };
      }
      return t;
    }));
  };

  const canDeleteParent = (parentId) => {
    const subs = getCustomSubs(parentId);
    return subs.length === 1 && subs[0].id === `${parentId}_other`;
  };

  const startDrag = (e, catId, parentId, label, icon, color) => {
    e.preventDefault();
    e.stopPropagation();
    setDragState({ catId, parentId, x: e.clientX, y: e.clientY, ghostLabel: label, ghostIcon: icon, ghostColor: color });
    setCollapsedParents(() => {
      const next = {};
      [...Object.values(CATEGORIES).filter(c => c.isParent), ...customCats.filter(c => c.isParent)].forEach(p => { next[p.id] = true; });
      return next;
    });
  };

  const moveDrag = (e) => {
    if (!dragState) return;
    setDragState(d => d ? { ...d, x: e.clientX, y: e.clientY } : null);
    const scrollEl = document.querySelector('.m-body-scroll');
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      if (e.clientY > rect.bottom - 60) scrollEl.scrollTop += 6;
      else if (e.clientY < rect.top + 60) scrollEl.scrollTop -= 6;
    }
  };

  const endDrag = () => {
    if (!dragState || !dropTarget) { setDragState(null); setDropTarget(null); setCollapsedParents({}); return; }
    const { catId } = dragState;
    let destParentId = null;
    if (dropTarget.type === 'parent') {
      destParentId = dropTarget.parentId;
      setCustomCats(prev => prev.map(c => c.id === catId ? { ...c, parent: dropTarget.parentId } : c));
    } else if (dropTarget.type === 'reorder' && dropTarget.catId !== catId) {
      destParentId = dropTarget.parentId;
      setCustomCats(prev => {
        const subs = prev.filter(c => !c.isParent && c.parent === dropTarget.parentId);
        const others = prev.filter(c => c.isParent || c.parent !== dropTarget.parentId);
        const dragIdx = subs.findIndex(c => c.id === catId);
        const targetIdx = subs.findIndex(c => c.id === dropTarget.catId);
        if (dragIdx < 0 || targetIdx < 0) return prev;
        const reordered = [...subs];
        const [item] = reordered.splice(dragIdx, 1);
        reordered.splice(targetIdx, 0, item);
        return [...others, ...reordered];
      });
    }
    setDragState(null);
    setDropTarget(null);
    setCollapsedParents({});
    // Scroll to and flash the destination parent
    if (destParentId && destParentId !== dragState.parentId) {
      setTimeout(() => {
        const el = parentRefs.current[destParentId];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setFlashCatId(catId);
        setTimeout(() => setFlashCatId(null), 1000);
      }, 50);
    }
  };

  const [flashCatId, setFlashCatId] = React.useState(null);
  const parentRefs = React.useRef({});

  const renderParentCard = (parentKey, parentCat, isCustom) => {
    const premadeSubs = isCustom ? [] : getPremadeSubs(parentKey);
    const customSubsHere = isCustom ? getCustomSubs(parentKey) : getCustomSubsOfPremade(parentKey);
    const rawSubs = isCustom ? customSubsHere : [...premadeSubs, ...customSubsHere];
    // 'other' always last
    const otherSub = rawSubs.find(s => (Array.isArray(s) ? false : s.id === `${parentKey}_other`));
    const nonOther = rawSubs.filter(s => !(Array.isArray(s) ? false : s.id === `${parentKey}_other`));
    const allSubs = otherSub ? [...nonOther, otherSub] : nonOther;
    const subCount = allSubs.length;
    const isCollapsed = !!collapsedParents[parentKey];
    const isDropTarget = dropTarget?.type === 'parent' && dropTarget.parentId === parentKey;

    return (
      <div key={parentKey} ref={el => parentRefs.current[parentKey] = el}
        data-parentkey={parentKey}
        className="m-card"
        style={{ marginBottom:12, border:`1.5px solid ${isDropTarget ? (parentCat.color || M.sage) : M.line}`, borderRadius:14, overflow:'hidden', background: isDropTarget ? (parentCat.color ? parentCat.color + '11' : M.sageSoft) : 'transparent', transition:'border-color 0.15s, background 0.15s' }}
        onPointerEnter={dragState ? () => setDropTarget({ type:'parent', parentId: parentKey }) : undefined}
      >
        {/* Parent header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:M.paper }}>
          <div style={{ width:38, height:38, borderRadius:10, background:parentCat.color||M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={parentCat.icon||'help-circle-outline'} size={18} color={isCustom?'#fff':M.ink2}/>
          </div>
          <div className={isCustom ? 'm-tap' : ''} style={{ flex:1, cursor: isCustom ? 'pointer' : 'default' }}
            onClick={isCustom ? () => setEditSheet({ catId: parentKey, parentId: null, isCustom:true, isParent: true, name: parentCat.name, icon: parentCat.icon || 'help-circle-outline', color: parentCat.color }) : undefined}
          >
            <div style={{ fontSize:15, fontWeight:600 }}>{parentCat.name}</div>
          </div>
          <span style={{ fontSize:12, color:M.ink3 }}>{subCount} subs</span>
          <button className="m-tap" onClick={() => setCollapsedParents(prev => ({ ...prev, [parentKey]: !prev[parentKey] }))}
            style={{ background:'none', border:'none', cursor:'pointer', padding:4, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition:'transform 0.2s ease', display:'flex' }}>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
          </button>
        </div>
        {/* Sub-categories */}
        <div style={{ overflow:'hidden', maxHeight: isCollapsed ? 0 : 9999, transition:'max-height 0.35s ease' }}>
          {allSubs.map((sub) => {
            const subKey = Array.isArray(sub) ? sub[0] : sub.id;
            const subCat = Array.isArray(sub) ? sub[1] : sub;
            const isCustomSub = !Array.isArray(sub);
            const isOther = isCustomSub && sub.id === `${parentKey}_other`;
            // 'other' uses parent color same as other custom subs
            const subBg = parentCat.color ? parentCat.color + '33' : M.paper2;
            const subIconColor = parentCat.color || M.ink2;
            const isFlashing = flashCatId === subKey;

            return (
              <div key={subKey}
                className={isCustomSub && !isOther ? 'm-tap' : ''}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 16px', borderTop:`1px solid ${M.line2}`,
                  background: isFlashing ? (parentCat.color || M.sage) + '22' : dropTarget?.catId === subKey ? M.sageSoft : 'transparent',
                  transition:'background 0.3s',
                  cursor: (isCustomSub && !isOther) ? 'grab' : 'default',
                  touchAction: (isCustomSub && !isOther) ? 'none' : 'auto',
                }}
                onClick={isCustomSub && !isOther ? () => setEditSheet({ catId: subKey, parentId: parentKey, isCustom: true, isParent: false, name: subCat.name, icon: subCat.icon || 'help-circle-outline' }) : undefined}
                onPointerDown={(isCustomSub && !isOther) ? (e) => startDrag(e, subKey, parentKey, subCat.name, subCat.icon, parentCat.color || M.paper2) : undefined}
                onPointerEnter={(dragState && !isOther) ? () => setDropTarget({ type:'reorder', catId: subKey, parentId: parentKey }) : undefined}
              >
                <div style={{ width:28, height:28, borderRadius:8, background: isOther ? (parentCat.color ? parentCat.color+'33' : M.paper2) : subBg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <IcoMDI name={subCat.icon||'help-circle-outline'} size={13} color={isOther ? (parentCat.color || M.ink3) : subIconColor}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:isOther?400:500, color:isOther?M.ink3:M.ink, fontStyle:isOther?'italic':'normal' }}>{subCat.name}</div>
                </div>
                {(isCustomSub && !isOther) && (
                  <div style={{ opacity:0.35, flexShrink:0 }}>
                    <I name="menu" size={13} color={M.ink3}/>
                  </div>
                )}
              </div>
            );
          })}
          {/* +Sub button at bottom, after 'other' */}
          <button className="m-tap" onClick={() => setNewSubSheet(parentKey)}
            style={{ width:'100%', padding:'10px 16px', borderTop:`1px solid ${M.line2}`, background:'transparent', border:'none', borderTopStyle:'solid', borderTopWidth:1, borderTopColor:M.line2, display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontFamily:M.fontUI, color:M.sage }}>
            <I name="plus" size={13} color={M.sage}/>
            <span style={{ fontSize:13, fontWeight:500 }}>Add sub-category</span>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="m-screen"
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <StatusBar/>
      <AppBar title={t('screen.categories')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-tap m-iconbtn" onClick={() => setNewParentSheet(true)}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">

        {/* CUSTOM section */}
        {customParents.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:8 }}>CUSTOM · {customParents.length}</div>
            {customParents.map(p => renderParentCard(p.id, p, true))}
          </>
        )}

        {/* PREMADE section */}
        <div className="m-cap" style={{ marginBottom:8, marginTop: customParents.length>0?16:0 }}>PREMADE CATEGORIES</div>
        {premadeParents.map(([k,v]) => renderParentCard(k, v, false))}

        <div style={{ height:32 }}/>
      </div>

      {/* New parent sheet */}
      <Sheet open={newParentSheet} onClose={() => setNewParentSheet(false)} title="New parent category">
        <NewCatForm
          onSave={(name, icon, color) => {
            const id = `cust_${Date.now()}`;
            setCustomCats(prev => [...prev,
              { id, name, icon: icon||'box', color: color||M.slate, isParent:true, parent:null },
              { id:`${id}_other`, name:'Other', icon:'dots-horizontal', color:M.paper2, isParent:false, parent:id }
            ]);
            setNewParentSheet(false);
          }}
        />
      </Sheet>

      {/* New sub sheet */}
      <Sheet open={!!newSubSheet} onClose={() => setNewSubSheet(null)} title="New sub-category">
        <NewCatForm
          isSub={true}
          onSave={(name, icon, color) => {
            const parentId = newSubSheet;
            setCustomCats(prev => [...prev,
              { id:`cust_${Date.now()}`, name, icon: icon||'box', color: color||M.slate, isParent:false, parent:parentId }
            ]);
            setNewSubSheet(null);
          }}
        />
      </Sheet>

      {/* Edit sheet */}
      {editSheet && (
        <Sheet onClose={() => setEditSheet(null)}>
          <EditCatSheet
            entry={editSheet}
            txCount={txCounts[editSheet.catId] || 0}
            isPrebuilt={!editSheet.isCustom}
            onSave={(name, icon, color) => {
              if (editSheet.isCustom) {
                setCustomCats(prev => prev.map(c => c.id === editSheet.catId ? { ...c, name, icon, color } : c));
              } else {
                setPremadeOverrides(prev => ({ ...prev, [editSheet.catId]: { name } }));
              }
              setEditSheet(null);
            }}
            onDelete={editSheet.isCustom ? () => {
              if (editSheet.isParent) {
                deleteCustomParent(editSheet.catId);
              } else {
                deleteCustomSub(editSheet.catId);
              }
              setEditSheet(null);
            } : null}
          />
        </Sheet>
      )}

      {/* Floating drag ghost */}
      {dragState && (
        <div style={{
          position:'fixed',
          left: dragState.x - 60,
          top: dragState.y - 22,
          transform: 'translateY(-50%)',
          zIndex: 9999,
          pointerEvents: 'none',
          display:'flex', alignItems:'center', gap:8,
          padding:'8px 14px',
          borderRadius:12,
          background: M.card,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          border:`1.5px solid ${dragState.ghostColor || M.line}`,
          opacity: 0.95,
          minWidth: 120,
        }}>
          <div style={{ width:28, height:28, borderRadius:8, background: dragState.ghostColor || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={dragState.ghostIcon || 'help-circle-outline'} size={13} color="#fff"/>
          </div>
          <div style={{ fontSize:13, fontWeight:600 }}>{dragState.ghostLabel}</div>
        </div>
      )}
    </div>
  );
}

export function InviteCards() {
  const { t } = useLang();
  const myId = React.useMemo(() => getUserId(), []);
  const [invitations, setInvitations] = useLocalStorage('munni_global_invitations', []);
  const [friendships, setFriendships] = useLocalStorage('munni_global_friendships', []);
  const [userRegistry] = useLocalStorage('munni_global_users', {});
  const [blocks, setBlocks] = useLocalStorage('munni_global_blocks', {});
  const { profiles, setProfiles } = useProfiles();
  const [declineSheet, setDeclineSheet] = React.useState(null); // { inv, isProfile, onJustDecline }
  const [renameInviteSheet, setRenameInviteSheet] = React.useState(null);

  const myBlockedSenderIds = new Set((blocks[myId] || []).map(b => b.userId));
  const pendingFriend = invitations.filter(inv => inv.toId === myId && inv.type === 'friend' && inv.status === 'pending' && !myBlockedSenderIds.has(inv.fromId));
  const pendingProfile = invitations.filter(inv => inv.toId === myId && inv.type === 'profile' && inv.status === 'pending' && !myBlockedSenderIds.has(inv.fromId));
  const allPending = [...pendingFriend, ...pendingProfile];

  // Slide-in animation for invites that arrive while the screen is already open
  const seenIdsRef = React.useRef(null);
  const [animatingIds, setAnimatingIds] = React.useState(new Set());
  React.useEffect(() => {
    const currentIds = new Set(allPending.map(i => i.id));
    if (seenIdsRef.current === null) { seenIdsRef.current = currentIds; return; }
    const newIds = allPending.filter(i => !seenIdsRef.current.has(i.id)).map(i => i.id);
    seenIdsRef.current = currentIds;
    if (newIds.length === 0) return;
    setAnimatingIds(prev => new Set([...prev, ...newIds]));
    const timer = setTimeout(() => setAnimatingIds(prev => { const n = new Set(prev); newIds.forEach(id => n.delete(id)); return n; }), 500);
    return () => clearTimeout(timer);
  }, [allPending.map(i => i.id).join(',')]);

  if (pendingFriend.length === 0 && pendingProfile.length === 0) return null;

  const respondFriend = (inv, action) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: action } : i));
    if (action === 'accepted') {
      setFriendships(list => {
        const exists = list.some(f => f.users && f.users.includes(inv.fromId) && f.users.includes(myId));
        if (exists) return list;
        return [...list, { id: `fr_${Date.now()}`, users: [inv.fromId, myId], since: Date.now() }];
      });
    }
  };

  const declineAndBlock = (inv) => {
    // Remove invite entirely so sender sees nothing (not even "declined")
    setInvitations(list => list.filter(i => i.id !== inv.id));
    const senderInfo = userRegistry[inv.fromId] || {};
    setBlocks(prev => {
      const existing = prev[myId] || [];
      if (existing.some(b => b.userId === inv.fromId)) return prev;
      return { ...prev, [myId]: [...existing, { userId: inv.fromId, displayName: senderInfo.displayName || inv.fromId, picture: senderInfo.picture || null, blockedAt: Date.now() }] };
    });
    setDeclineSheet(null);
  };

  const respondProfile = (inv, action, customName = null) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: action, respondedAt: Date.now() } : i));
    if (action === 'accepted') {
      // Clear any stale left/expelled signals for me in this profile's sharedData so
      // the owner's checkSharedSignals doesn't remove me immediately after rejoining
      try {
        const sdKey = `munni_shared_data_${inv.profileId}`;
        const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
        const hadStale = sd.left?.[myId] || sd.expelled?.[myId];
        if (hadStale) {
          const { [myId]: _l, ...remainingLeft } = sd.left || {};
          const { [myId]: _e, ...remainingExpelled } = sd.expelled || {};
          // Also pick up the latest name/picture from meta in case owner renamed since last invite
          localStorage.setItem(sdKey, JSON.stringify({ ...sd, left: remainingLeft, expelled: remainingExpelled }));
          window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
        }
        // Read fresh meta so the rejoined profile starts with the current name/picture
        const freshSd = JSON.parse(localStorage.getItem(sdKey) || '{}');
        var freshName = freshSd.meta?.name;
        var freshPic = freshSd.meta?.picture;
      } catch {}
      // Add a shared copy of the profile to the accepter's profile list
      setProfiles(ps => {
        const existing = ps.find(p => p.id === inv.profileId);
        const originalOwnerId = inv.originalOwnerId || inv.fromId;
        const ownerDisplay = userRegistry[originalOwnerId]?.displayName || originalOwnerId;
        const ownerName = freshName || inv.profileName || 'Shared';
        const trimmedCustom = customName?.trim();
        const profileData = {
          id: inv.profileId,
          name: ownerName,
          ...(trimmedCustom && trimmedCustom !== ownerName ? { localName: trimmedCustom } : {}),
          icon: inv.profileIcon || 'users',
          active: false,
          accountIds: inv.profileAccountIds || [],
          picture: freshPic !== undefined ? freshPic : (inv.profilePicture || null),
          isDemo: inv.profileIsDemo || false,
          isShared: true,
          ownerId: originalOwnerId,
          ownerDisplay,
          members: [{ userId: originalOwnerId, displayName: ownerDisplay, permission: 'owner', accountIds: [] }],
        };
        if (existing) {
          // Rejoin: update the existing entry rather than skipping
          return ps.map(p => p.id === inv.profileId ? { ...p, ...profileData } : p);
        }
        return [...ps, profileData];
      });
    }
  };

  const renderFriendInvite = (inv, onAccept, onDeclineAction) => {
    const name = userRegistry[inv.fromId]?.displayName || inv.fromId;
    const pic = userRegistry[inv.fromId]?.picture;
    const av = pic?.startsWith('av') ? STOCK_AVATARS.find(a => a.id === pic) : null;
    return (
      <div style={{ padding:'14px 0' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
          <div style={{ width:44, height:44, borderRadius:999, background: av ? av.bg : M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, overflow:'hidden' }}>
            {pic?.startsWith('data:')
              ? <img src={pic} style={{ width:44, height:44, objectFit:'cover' }}/>
              : av ? <span style={{ fontSize:22 }}>{av.emoji}</span>
              : <I name="user" size={20} color={M.sage}/>
            }
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:14, fontWeight:600 }}>{name}</div>
            <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono, marginTop:2 }}>{inv.fromId}</div>
          </div>
          <div style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase', letterSpacing:'0.04em', flexShrink:0 }}>{t('friends.friendBadge')}</div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="m-tap" onClick={onAccept}
            style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('friends.accept')}
          </button>
          <button className="m-tap" onClick={() => setDeclineSheet({ inv, isProfile: false, onJustDecline: onDeclineAction })}
            style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('friends.decline')}
          </button>
        </div>
      </div>
    );
  };

  const renderProfileInvite = (inv, onAccept, onDeclineAction) => {
    const senderName = userRegistry[inv.fromId]?.displayName || inv.fromId;
    const senderPic = userRegistry[inv.fromId]?.picture;
    const senderAv = senderPic?.startsWith('av') ? STOCK_AVATARS.find(a => a.id === senderPic) : null;
    const fakeProfile = { name: inv.profileName, picture: inv.profilePicture || null };
    return (
      <div style={{ padding:'14px 0' }}>
        <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:12 }}>
          <div style={{ position:'relative', flexShrink:0 }}>
            <ProfileAvatar profile={fakeProfile} size={48}/>
            {/* Sender badge */}
            <div style={{ position:'absolute', bottom:-4, right:-4, width:22, height:22, borderRadius:999, background: senderAv ? senderAv.bg : M.sageSoft, border:`2px solid ${M.paper}`, display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden' }}>
              {senderPic?.startsWith('data:')
                ? <img src={senderPic} style={{ width:18, height:18, objectFit:'cover' }}/>
                : senderAv ? <span style={{ fontSize:10 }}>{senderAv.emoji}</span>
                : <I name="user" size={10} color={M.sage}/>
              }
            </div>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:10, fontWeight:700, color:M.sage, textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>{t('friends.profileInviteFrom')}</div>
            <div style={{ fontSize:15, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inv.profileName || 'Shared profile'}</div>
            <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>From <strong>{senderName}</strong></div>
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="m-tap" onClick={onAccept}
            style={{ flex:2, padding:'9px 0', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('friends.profileInviteJoin')}
          </button>
          <button className="m-tap" onClick={onDeclineAction}
            style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('friends.decline')}
          </button>
        </div>
      </div>
    );
  };

  const dsInv = declineSheet?.inv;
  const dsName = dsInv ? (userRegistry[dsInv.fromId]?.displayName || dsInv.fromId) : '';

  return (
    <>
      <style>{`@keyframes slideInNotif{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('friends.pending')}</div>
      <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
        {allPending.map((inv, i) => (
          <React.Fragment key={inv.id}>
            {i > 0 && <Divider inset={0}/>}
            <div style={{ animation: animatingIds.has(inv.id) ? 'slideInNotif 0.38s cubic-bezier(0.16,1,0.3,1)' : 'none' }}>
              {inv.type === 'friend'
                ? renderFriendInvite(inv, () => respondFriend(inv, 'accepted'), () => respondFriend(inv, 'declined'))
                : renderProfileInvite(inv, () => setRenameInviteSheet({ inv, name: inv.profileName || '' }), () => respondProfile(inv, 'declined'))}
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* Rename-on-join sheet */}
      {renameInviteSheet && (
        <Sheet onClose={() => setRenameInviteSheet(null)}>
          <div style={{ padding:'4px 16px 20px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <ProfileAvatar profile={{ name: renameInviteSheet.inv.profileName, picture: renameInviteSheet.inv.profilePicture || null }} size={44}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{renameInviteSheet.inv.profileName || 'Shared profile'}</div>
                <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>
                  {t('profile.by')} <strong>{userRegistry[renameInviteSheet.inv.fromId]?.displayName || renameInviteSheet.inv.fromId}</strong>
                </div>
              </div>
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('profile.nameThisProfile')}</div>
            <input autoFocus
              value={renameInviteSheet.name}
              onChange={e => setRenameInviteSheet(prev => ({ ...prev, name: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && (respondProfile(renameInviteSheet.inv, 'accepted', renameInviteSheet.name), setRenameInviteSheet(null))}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:6 }}
            />
            <div style={{ fontSize:11, color:M.ink4, marginBottom:20 }}>{t('profile.nameThisProfileHint')}</div>
            <button onClick={() => { respondProfile(renameInviteSheet.inv, 'accepted', renameInviteSheet.name); setRenameInviteSheet(null); }}
              style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('friends.profileInviteJoin')}
            </button>
            <button onClick={() => setRenameInviteSheet(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}

      {/* Decline options sheet */}
      {declineSheet && (
        <Sheet onClose={() => setDeclineSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:15, fontWeight:700, padding:'12px 0 4px', color:M.ink }}>{dsName}</div>
            <div style={{ fontSize:12, color:M.ink4, marginBottom:16 }}>{declineSheet.isProfile ? t('friends.profileInviteFrom') : t('friends.inviteNotif')} {dsName}</div>
            <button className="m-tap" onClick={() => { declineSheet.onJustDecline(); setDeclineSheet(null); }}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="x" size={16} color={M.ink3}/>
              </div>
              <span style={{ fontSize:15, fontWeight:500, color:M.ink, fontFamily:M.fontUI }}>{t('friends.justDecline')}</span>
            </button>
            <button className="m-tap" onClick={() => declineAndBlock(declineSheet.inv)}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:'#FFF0F0', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="ban" size={16} color={M.clay}/>
              </div>
              <div style={{ flex:1, textAlign:'left' }}>
                <div style={{ fontSize:15, fontWeight:500, color:M.clay, fontFamily:M.fontUI }}>{t('friends.declineAndBlock')}</div>
                <div style={{ fontSize:11, color:M.ink4 }}>{dsName} {t('friends.blockAction').toLowerCase()}</div>
              </div>
            </button>
            <div style={{ height:8 }}/>
          </div>
        </Sheet>
      )}
    </>
  );
}

export function ScreenNotifications() {
  const nav = useNav();
  const { t } = useLang();
  const { addTxs, txs } = useTxCtx();
  const [syncing, setSyncing] = React.useState(false);
  const syncKey = React.useMemo(() => getUserSyncKey(), []);
  const [lastSyncedStr, setLastSyncedStr] = useLocalStorage(syncKey, null);
  const [newCount, setNewCount] = React.useState(0);
  const [syncedReviewCount, setSyncedReviewCount] = React.useState(0);
  const [, setNotifUnread] = useLocalStorage('munni_notif_unread', 0);

  React.useEffect(() => { setNotifUnread(0); }, []);

  const MERCHANTS_POOL = [
    { merchant:'Albert Heijn',       desc:'AH 5821',        cat:'groceries',       min:8,  max:85,  needsReview:true },
    { merchant:'Koffie ☕',          desc:'TOKI ESPRESSO',  cat:'coffee',          min:3,  max:6,   needsReview:true },
    { merchant:'NS · Sprinter',      desc:'NS REIZIGERS',   cat:'transportPublic', min:4,  max:28,  needsReview:true },
    { merchant:'Etos',               desc:'ETOS 0341',      cat:'healthcare',      min:5,  max:35,  confidence:60, needsReview:true },
    { merchant:'Vapiano',            desc:'VAPIANO 1234',   cat:'restaurants',     min:12, max:38,  needsReview:true },
    { merchant:'Coolblue',           desc:'COOLBLUE ORDER', cat:'electronics',     min:29, max:199, confidence:55, needsReview:true },
    { merchant:'Apotheek Centraal',  desc:'APOTHEEK 7842',  cat:'prescription',    min:8,  max:40,  confidence:58, needsReview:true },
  ];

  const handleSync = () => {
    setSyncing(true);
    setTimeout(() => {
      const count = Math.floor(Math.random() * 5) + 1;
      const now = new Date();
      const newTxs = Array.from({ length: count }, (_, i) => {
        const pool = MERCHANTS_POOL[Math.floor(Math.random() * MERCHANTS_POOL.length)];
        const amt = -(Math.round((pool.min + Math.random() * (pool.max - pool.min)) * 100) / 100);
        const id = `tsync_${Date.now()}_${i}`;
        const dateStr = now.toISOString().slice(0, 10);
        const loginMethod = sessionStorage.getItem('munni_last_login_method') || '';
        const accountId = loginMethod === 'bank' ? 'demo_main' : 'main';
        return { id, date: dateStr, time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, merchant: pool.merchant, desc: pool.desc, cat: pool.cat, amount: amt, account: accountId, needsReview: true, ...(pool.confidence ? { confidence: pool.confidence } : {}) };
      });
      addTxs(newTxs);
      setNewCount(count);
      setSyncedReviewCount(count);
      setLastSyncedStr(now.toISOString());
      setSyncing(false);
    }, 1200);
  };


  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.notifications')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-card" style={{ padding:16, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:14 }}>
            <div style={{ width:44, height:44, borderRadius:13, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="sync" size={20} color={M.sage}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:15, fontWeight:600 }}>{t('notif.bankSync')}</div>
              <div style={{ fontSize:12, color:M.ink3, marginTop:2 }}>{lastSyncedStr ? `${t('notif.lastSynced')} ${fmtSyncTime(lastSyncedStr)}` : t('notif.bankSyncSub')}</div>
            </div>
          </div>
          <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={handleSync} disabled={syncing}>
            {syncing ? (
              <><I name="sync" size={16} color="#fff"/> {t('notif.syncing')}</>
            ) : (
              <><I name="sync" size={16} color="#fff"/> {t('notif.syncNow')}</>
            )}
          </button>
          {newCount > 0 && (
            <div style={{ marginTop:10, borderRadius:10, overflow:'hidden', border:`1px solid ${M.ochreSoft}` }}>
              <div style={{ padding:'8px 12px', background:M.ochreSoft, fontSize:12, color:M.ochre, fontWeight:500 }}>
                {newCount === 1 ? t('notif.txSynced').replace('{n}','1') : t('notif.txsSynced').replace('{n}', newCount)}
              </div>
              <button className="m-tap" onClick={() => { setNewCount(0); nav.push('reviewSwipe'); }} style={{
                width:'100%', padding:'9px 12px', background:'#fff', border:'none', borderTop:`1px solid ${M.line2}`,
                display:'flex', alignItems:'center', gap:8, fontSize:12, fontWeight:600, color:M.ochre, cursor:'pointer',
              }}>
                <I name="sliders" size={13} color={M.ochre}/>
                {t('notif.reviewNow')}
                <I name="arrowR" size={12} color={M.ochre} style={{ marginLeft:'auto' }}/>
              </button>
            </div>
          )}
        </div>

        <InviteCards/>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('notif.recentTitle')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          {[
            { icon:'check', color:M.sage, title:t('notif.n12synced'), sub:t('notif.n12syncedSub') },
            { icon:'alert', color:M.ochre, title:t('notif.n3review'), sub:t('notif.n3reviewSub') },
            { icon:'wallet', color:M.violet, title:t('notif.salary'), sub:t('notif.salarySub') },
          ].map((n, i, a) => (
            <React.Fragment key={i}>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:n.color+'22', display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <I name={n.icon} size={15} color={n.color}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:500 }}>{n.title}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{n.sub}</div>
                </div>
              </div>
              {i < a.length - 1 && <Divider inset={44}/>}
            </React.Fragment>
          ))}
        </div>

        {/* Error log — Show Logs button */}
        <LogPanel/>
      </div>
    </div>
  );
}

const DEFAULT_DEV_LOGS = [
  { id:'l1',  level:'error', msg:'localStorage key munni_topics_p_demo parse error: Unexpected token', ts:'Today 09:18',     src:'useLocalStorage:14' },
  { id:'l2',  level:'warn',  msg:'CategoryPicker: unknown catId "custom_xyz" in profile p_demo',        ts:'Today 11:42',     src:'CategoryPicker:87' },
  { id:'l3',  level:'warn',  msg:'TxCtx: transaction t_sync_1747 has no matching account — skipped',   ts:'Yesterday 18:30', src:'TxCtx:52' },
  { id:'l4',  level:'info',  msg:'PeriodCtx: period_day changed 1→18, rebuilding period history',       ts:'Yesterday 15:02', src:'PeriodCtx:34' },
  { id:'l5',  level:'info',  msg:'AllocProvider: loaded 3 topics for profile p1',                       ts:'Yesterday 14:55', src:'AllocProvider:21' },
  { id:'l6',  level:'error', msg:'ScreenExpenses: failed to parse munni_budgets_p2 — defaulting to []', ts:'Yesterday 12:11', src:'ScreenExpenses:203' },
  { id:'l7',  level:'warn',  msg:'SyncHandler: duplicate transaction id tsync_1748 skipped',            ts:'Yesterday 10:05', src:'SyncHandler:88' },
  { id:'l8',  level:'info',  msg:'ProfilesProvider: loaded key munni_profiles_google (1 profiles)',     ts:'Yesterday 09:30', src:'ProfilesProvider:12' },
  { id:'l9',  level:'warn',  msg:'ReviewSwipe: previewTx cat "other" has no icon — using fallback',     ts:'2 days ago 16:44', src:'ReviewSwipe:61' },
  { id:'l10', level:'info',  msg:'TxCtx: 142 transactions loaded for account main',                     ts:'2 days ago 08:00', src:'TxCtx:29' },
  { id:'l11', level:'error', msg:'GoalsCtx: munni_goals_p3 corrupt — resetting to defaults',            ts:'3 days ago 20:15', src:'GoalsCtx:17' },
  { id:'l12', level:'info',  msg:'LangCtx: language changed to nl',                                     ts:'3 days ago 11:22', src:'LangCtx:8' },
];

function LogPanel() {
  const { t } = useLang();
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState('all');
  const [logs, setLogs] = useLocalStorage('munni_dev_logs', DEFAULT_DEV_LOGS);
  const [readIds, setReadIds] = useLocalStorage('munni_log_read', []);

  const errCount = logs.filter(l => l.level==='error' && !readIds.includes(l.id)).length;
  const warnCount = logs.filter(l => l.level==='warn' && !readIds.includes(l.id)).length;

  const handleOpen = () => {
    setOpen(true);
    setReadIds(logs.map(l => l.id));
  };

  const handleClear = (e) => {
    e.stopPropagation();
    setLogs([]);
    setReadIds([]);
  };

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter);
  const levelColor = { error: M.clay, warn: M.ochre, info: M.ink3 };
  const levelBg = { error: M.claySoft, warn: M.ochreSoft, info: M.paper2 };

  return (
    <div style={{ marginBottom:16 }}>
      <button className="m-tap" onClick={handleOpen} style={{
        width:'100%', padding:'12px 16px', borderRadius:14, border:`1px solid ${M.line}`,
        background:M.card, display:'flex', alignItems:'center', gap:10, cursor:'pointer',
        fontFamily:M.fontUI, textAlign:'left',
      }}>
        <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <I name="alert" size={16} color={errCount>0?M.clay:M.ink3}/>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:600, color:M.ink }}>{t('notif.devLogs')}</div>
          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{logs.length} entries</div>
        </div>
        {(errCount > 0 || warnCount > 0) && (
          <div style={{ display:'flex', gap:4 }}>
            {errCount > 0 && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.claySoft, color:M.clay }}>{errCount} error{errCount>1?'s':''}</span>}
            {warnCount > 0 && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.ochreSoft, color:M.ochre }}>{warnCount} warn</span>}
          </div>
        )}
        <I name="caretR" size={14} color={M.ink4}/>
      </button>

      {open && (
        <Sheet onClose={() => setOpen(false)}>
          <div style={{ padding:'4px 16px 0', display:'flex', alignItems:'center', marginBottom:12 }}>
            <div style={{ fontSize:17, fontWeight:700, flex:1 }}>{t('notif.devLogs')}</div>
            {logs.length > 0 && (
              <button className="m-tap" onClick={handleClear} style={{
                padding:'5px 12px', borderRadius:8, border:`1px solid ${M.clay}44`,
                background:M.claySoft, color:M.clay, fontSize:12, fontWeight:600,
                cursor:'pointer', fontFamily:M.fontUI,
              }}>{t('notif.clearLogs')}</button>
            )}
          </div>
          <div style={{ padding:'0 16px', marginBottom:12 }}>
            <div style={{ display:'flex', gap:6 }}>
              {[['all','All'],['error','Error'],['warn','Warn'],['info','Info']].map(([key,lbl]) => (
                <button key={key} className="m-tap" onClick={() => setFilter(key)} style={{
                  flex:1, padding:'6px 0', borderRadius:8, fontSize:11, fontWeight:600,
                  border:`1px solid ${filter===key?M.sage:M.line}`,
                  background:filter===key?M.sageSoft:'transparent', color:filter===key?M.sage:M.ink3,
                  cursor:'pointer', fontFamily:M.fontUI,
                }}>{lbl}</button>
              ))}
            </div>
          </div>
          <div style={{ padding:'0 16px 16px', maxHeight:320, minHeight:320, overflowY:'auto', display:'flex', flexDirection:'column', gap:8 }}>
            {filtered.length === 0 ? (
              <div style={{ padding:'24px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>{t('notif.noLogs')}</div>
            ) : filtered.map(log => (
              <div key={log.id} style={{ padding:'10px 12px', borderRadius:10, background:levelBg[log.level], border:`1px solid ${levelColor[log.level]}22`, flexShrink:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                  <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:levelColor[log.level], color:'#fff', textTransform:'uppercase' }}>{log.level}</span>
                  <span style={{ fontSize:10, color:M.ink4, flex:1 }}>{log.src}</span>
                  <span style={{ fontSize:10, color:M.ink4 }}>{log.ts}</span>
                </div>
                <div style={{ fontSize:12, color:M.ink2, fontFamily:M.fontMono, lineHeight:1.45, wordBreak:'break-word' }}>{log.msg}</div>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function SettingToggle({ label, sub, on: onProp }) {
  const [on, setOn] = React.useState(!!onProp);
  return (
    <div className="m-tap" onClick={() => setOn(!on)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: M.ink3, marginTop: 2 }}>{sub}</div>}
      </div>
      <Toggle on={on}/>
    </div>
  );
}

const DUTCH_BANKS = [
  { id:'abn',      name:'ABN AMRO',     country:'NL', bic:'ABNANL2A',  color:'#009B77', logo:'🏦' },
  { id:'ing',      name:'ING',          country:'NL', bic:'INGBNL2A',  color:'#FF6200', logo:'🦁' },
  { id:'rabo',     name:'Rabobank',     country:'NL', bic:'RABONL2U',  color:'#004A97', logo:'🏛' },
  { id:'sns',      name:'SNS Bank',     country:'NL', bic:'SNSBNL2A',  color:'#E30613', logo:'🏦' },
  { id:'asn',      name:'ASN Bank',     country:'NL', bic:'ASNBNL21',  color:'#00A651', logo:'🌿' },
  { id:'triodos',  name:'Triodos Bank', country:'NL', bic:'TRIONL2U',  color:'#00A651', logo:'♻️' },
  { id:'bunq',     name:'Bunq',         country:'NL', bic:'BUNQNL2A',  color:'#00D4A1', logo:'💚' },
  { id:'knab',     name:'Knab',         country:'NL', bic:'KNABNL2H',  color:'#E40046', logo:'💡' },
  { id:'regio',    name:'RegioBank',    country:'NL', bic:'RBRBNL21',  color:'#0070BA', logo:'🏦' },
  { id:'revolut',  name:'Revolut',      country:'EU', bic:'REVOLT21',  color:'#191C20', logo:'🔷' },
  { id:'n26',      name:'N26',          country:'EU', bic:'NTSBDEB1',  color:'#000000', logo:'⬛' },
  { id:'wise',     name:'Wise',         country:'EU', bic:'TRWIBEB1',  color:'#9FE870', logo:'🌍' },
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
                  munni uses <strong>PSD2 Open Banking</strong>. Your credentials are sent directly to {psd2Bank?.name} — we never store them.
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
            <div style={{ fontSize:13, fontWeight:600, color:M.sage }}>Read-only · PSD2 Open Banking</div>
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
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Amount (€)</div>
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
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Actual balance (€)</div>
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
              <FormRow label="Amount" value="€0,00" icon="wallet"/>
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
                <div className="m-tap" onClick={() => nav.push('profileDetail', { id: item.profileId })} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
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
                  munni uses <strong>PSD2 Open Banking</strong>. Your credentials are sent directly to {psd2Bank?.name} — we never store them.
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
          /* ── Demo user (1-click bank login): show demo accounts read-only ── */
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
          /* ── Real profile: show real accounts only ── */
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
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Amount (€)</div>
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

export function ScreenCustomizeHome() {
  const nav = useNav();
  const { t } = useLang();
  const [cards, setCards] = useLocalStorage('munni_home_cards', HOME_CARDS_DEFAULT);
  const [upcomingDays, setUpcomingDays] = useLocalStorage('munni_upcoming_days', 3);
  const [customGraphCards, setCustomGraphCards] = useLocalStorage('munni_custom_graphs', []);

  // Separate pinned cards (fixed order) from moveable cards
  const pinnedCards = cards.filter(c => c.pinned);
  const moveableCards = cards.filter(c => !c.pinned);

  const move = (idx, dir) => {
    const ns = [...moveableCards];
    const t = idx + dir;
    if (t < 0 || t >= ns.length) return;
    [ns[idx], ns[t]] = [ns[t], ns[idx]];
    setCards([...pinnedCards, ...ns]);
  };

  const toggle = (id) => {
    setCards(cs => cs.map(c => c.id === id && !c.pinned ? { ...c, visible: !c.visible } : c));
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.customize')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ fontSize:13, color:M.ink3, marginBottom:16, paddingLeft:4, lineHeight:1.5 }}>
          Choose which cards appear on your home screen and in what order. Transaction Review and Overview are always shown at the top.
        </div>

        {/* Pinned cards */}
        <div className="m-card" style={{ border:`1px solid ${M.ochre}22`, background:'#FBF6E9', marginBottom:8 }}>
          {pinnedCards.map((pc, i) => (
            <React.Fragment key={pc.id}>
              {i > 0 && <Divider inset={16}/>}
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px' }}>
                <div style={{ width:28, height:28, borderRadius:8, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="lock" size={13} color={M.ochre}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ fontSize:14, fontWeight:500 }}>{pc.label}</div>
                    <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', letterSpacing:'0.05em' }}>Pinned</span>
                  </div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{pc.sub}</div>
                </div>
                <div style={{ width:28, height:44, opacity:0.25, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3 }}>
                  <div style={{ width:16, height:1.5, borderRadius:1, background:M.ink4 }}/>
                  <div style={{ width:16, height:1.5, borderRadius:1, background:M.ink4 }}/>
                  <div style={{ width:16, height:1.5, borderRadius:1, background:M.ink4 }}/>
                </div>
              </div>
            </React.Fragment>
          ))}
        </div>

        {/* Moveable cards */}
        <div className="m-card" style={{ border:`1px solid ${M.line}` }}>
          {moveableCards.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 && <Divider inset={16}/>}
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', transition:'all 0.2s ease' }}>
                <button className="m-tap" onClick={() => toggle(s.id)} style={{
                  width:28, height:28, borderRadius:8, flexShrink:0, cursor:'pointer',
                  border:`1.5px solid ${s.visible?M.sage:M.line}`,
                  background:s.visible?M.sage:'transparent',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  {s.visible && <I name="check" size={13} color="#fff" stroke={2.5}/>}
                </button>
                <div style={{ flex:1, opacity:s.visible?1:0.5 }}>
                  <div style={{ fontSize:14, fontWeight:500 }}>{s.label}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{s.sub}</div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                  <button className="m-tap" onClick={() => move(i, -1)} style={{ width:26, height:22, borderRadius:6, border:`1px solid ${M.line}`, background:M.card, display:'flex', alignItems:'center', justifyContent:'center', cursor:i===0?'not-allowed':'pointer', opacity:i===0?0.3:1 }}>
                    <I name="arrowUp" size={11}/>
                  </button>
                  <button className="m-tap" onClick={() => move(i, 1)} style={{ width:26, height:22, borderRadius:6, border:`1px solid ${M.line}`, background:M.card, display:'flex', alignItems:'center', justifyContent:'center', cursor:i===moveableCards.length-1?'not-allowed':'pointer', opacity:i===moveableCards.length-1?0.3:1 }}>
                    <I name="arrowDn" size={11}/>
                  </button>
                </div>
              </div>
              {s.id === 'upcoming' && s.visible && !s.pinned && (
                <div style={{ padding:'10px 16px 14px', borderTop:`1px solid ${M.line2}`, background:M.paper2 }}>
                  <div style={{ fontSize:12, color:M.ink3, marginBottom:8, fontWeight:500 }}>Lookahead window</div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    {[3,7,14,30].map(n => (
                      <button key={n} className="m-tap" onClick={() => setUpcomingDays(n)} style={{
                        flex:1, height:36, borderRadius:10, fontSize:13, fontWeight:600,
                        border:`1.5px solid ${upcomingDays===n?M.sage:M.line}`,
                        background:upcomingDays===n?M.sage:'transparent',
                        color:upcomingDays===n?'#fff':M.ink2, cursor:'pointer', fontFamily:M.fontUI,
                      }}>{n}d</button>
                    ))}
                  </div>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
        <div style={{ marginTop:14, padding:14, borderRadius:12, background:M.sageSoft, display:'flex', gap:10 }}>
          <I name="help" size={16} color={M.sage}/>
          <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5, flex:1 }}>
            Pinned cards are always shown at the top. Use the checkboxes to show or hide other cards, and arrows to reorder them.
          </div>
        </div>
        <div style={{ textAlign:'center', padding:'20px 0 8px' }}>
          <button className="m-tap" onClick={() => setCards(HOME_CARDS_DEFAULT)}
            style={{ background:'none', border:'none', color:M.ink3, fontSize:13, cursor:'pointer', fontFamily:M.fontUI }}>
            Reset to default
          </button>
        </div>

        {/* Custom graph cards */}
        <div className="m-cap" style={{ marginBottom:8, marginTop:16, paddingLeft:4 }}>Custom cards · {customGraphCards.length}</div>
        {customGraphCards.length > 0 && (
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:10, border:`1px solid ${M.line}` }}>
            {customGraphCards.map((cg, i) => (
              <React.Fragment key={cg.id}>
                {i > 0 && <Divider inset={48}/>}
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                  <div style={{ width:32, height:32, borderRadius:9, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name="trending-up" size={14} color={M.sage}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:500 }}>{cg.name}</div>
                    <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>
                      {cg.metric === 'expenses' ? 'Expenses' : 'Income'} · {cg.excludeCategories?.length > 0 ? `${cg.excludeCategories.length} excluded` : 'all categories'}
                    </div>
                  </div>
                  <button className="m-tap" onClick={() => setCustomGraphCards(prev => prev.filter(x => x.id !== cg.id))}
                    style={{ background:'none', border:'none', cursor:'pointer', padding:4 }}>
                    <I name="x" size={14} color={M.ink4}/>
                  </button>
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
        <div className="m-tap m-card" onClick={() => nav.push('customGraphCreate')}
          style={{ padding:'13px 16px', marginBottom:14, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', gap:12, color:M.sage }}>
          <div style={{ width:32, height:32, borderRadius:9, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <I name="plus" size={14} color={M.sage}/>
          </div>
          <div style={{ flex:1, fontSize:14, fontWeight:600 }}>Create custom card</div>
          <I name="caretR" size={14} color={M.ink4}/>
        </div>
      </div>
    </div>
  );
}

export const ordinal = (n) => {
  const v = n % 100;
  return n + (['th','st','nd','rd'][(v-20)%10] || ['th','st','nd','rd'][v] || 'th');
};

function RecurringRow({ r, onClick }) {
  const isPaid = r.txIds?.length > 0;
  return (
    <div className="m-tap" onClick={onClick} style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
      <div style={{ width:36, height:36, borderRadius:10, background:isPaid?M.sageSoft:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', position:'relative', flexShrink:0 }}>
        <I name={r.icon} size={18} color={isPaid?M.sage:M.ink2}/>
        {isPaid && (
          <div style={{ position:'absolute', bottom:-2, right:-2, width:14, height:14, borderRadius:999, background:M.sage, border:`2px solid ${M.paper}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <I name="check" size={7} color="#fff" stroke={3}/>
          </div>
        )}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
          <div style={{ fontSize:14, fontWeight:500 }}>{r.name}</div>
          {r.luxury && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.violetSoft, color:M.violet, textTransform:'uppercase', letterSpacing:'0.05em' }}>luxury</span>}
        </div>
        <div style={{ fontSize:11, color:M.ink3 }}>
          {isPaid ? 'Paid this period' : `Due ${ordinal(r.day)} · next ${r.next}`}
          {r.until ? ` · ends ${r.until}` : ''}
        </div>
      </div>
      <div className="m-num" style={{ fontSize:14, fontWeight:600 }}>{fmtEur(r.amount)}</div>
      <I name="caretR" size={12} color={M.ink4}/>
    </div>
  );
}

function RecurringContent({ showTabBar = false }) {
  const nav   = useNav();
  const { t } = useLang();
  const [view, setView] = React.useState('period');

  const costs     = RECURRING.filter(r => r.amount < 0 && r.active);
  const fixed     = costs.filter(r => r.type === 'fixed');
  const subs      = costs.filter(r => r.type === 'subs');
  const total     = costs.reduce((s, r) => s + Math.abs(r.amount), 0);
  const paid      = costs.filter(r => r.txIds?.length).reduce((s, r) => s + Math.abs(r.amount), 0);
  const remaining = total - paid;
  const luxTotal  = subs.reduce((s, r) => s + Math.abs(r.amount), 0);
  const yearTotal = total * 12;
  const yearPaid  = total * 2;
  const yearLeft  = yearTotal - yearPaid;

  const dispTotal = view === 'period' ? total : yearTotal;
  const dispPaid  = view === 'period' ? paid  : yearPaid;
  const dispLeft  = view === 'period' ? remaining : yearLeft;

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.recurring')}
        leading={showTabBar ? null : <button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap" onClick={() => nav.push('recurringCreate')}><I name="plus" size={20}/></button>}
      />

      <div style={{ padding:'0 20px 14px', flexShrink:0 }}>
        <div style={{ display:'flex', background:M.paper2, borderRadius:12, padding:3, gap:3 }}>
          {[{id:'period',label:'This period'},{id:'year',label:'This year'}].map(v => (
            <button key={v.id} onClick={() => setView(v.id)} className="m-tap" style={{
              flex:1, height:34, borderRadius:10, border:'none', fontFamily:M.fontUI, cursor:'pointer',
              background: view===v.id ? M.card : 'transparent',
              boxShadow: view===v.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              color: view===v.id ? M.ink : M.ink3,
              fontSize:13, fontWeight: view===v.id ? 600 : 500,
            }}>{v.label}</button>
          ))}
        </div>
      </div>

      <div className="m-body-scroll">
        <div className="m-card" style={{ padding:18, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:14 }}>
            <Stat label={view==='period'?'Period total':'Year total'} value={fmtEur(dispTotal)} color={M.ink}/>
            <Stat label="Paid" value={fmtEur(dispPaid)} color={M.sage}/>
            <Stat label="Remaining" value={fmtEur(dispLeft)} color={dispLeft>0?M.ochre:M.sage}/>
          </div>
          <StackedBar segments={[
            { value:dispPaid, color:M.sage },
            { value:dispLeft, color:M.line2 },
          ]} height={6}/>
          {luxTotal > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:12 }}>
              <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.violetSoft, color:M.violet, textTransform:'uppercase', letterSpacing:'0.05em' }}>luxury</span>
              <div style={{ fontSize:11, color:M.ink3 }}>{fmtEur(luxTotal)}/period · {fmtEur(luxTotal*12)}/year</div>
            </div>
          )}
        </div>

        {RECURRING_SUGGESTIONS.length > 0 && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingLeft:4 }}>
              <div className="m-cap">Detected by AI · {RECURRING_SUGGESTIONS.length}</div>
              <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase', letterSpacing:'0.05em' }}>new</span>
            </div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, background:M.sageSoft, border:`1px solid ${M.sage}` }}>
              {RECURRING_SUGGESTIONS.map((s, i, a) => (
                <React.Fragment key={s.id}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background:'rgba(255,255,255,0.7)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name={s.icon} size={18} color={M.sage}/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:500, marginBottom:2 }}>{s.name}</div>
                      <div style={{ fontSize:11, color:M.ink3 }}>{s.pattern} · {s.confidence}% confidence</div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:6 }}>
                      <div className="m-num" style={{ fontSize:14, fontWeight:600 }}>{fmtEur(s.amount)}</div>
                      <div style={{ display:'flex', gap:6 }}>
                        <button className="m-tap" style={{ width:28, height:28, borderRadius:8, border:'none', background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                          <I name="check" size={12} color="#fff" stroke={2.5}/>
                        </button>
                        <button className="m-tap" style={{ width:28, height:28, borderRadius:8, border:`1px solid rgba(0,0,0,0.1)`, background:'rgba(255,255,255,0.6)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                          <I name="x" size={12} color={M.ink3}/>
                        </button>
                      </div>
                    </div>
                  </div>
                  {i < a.length-1 && <Divider inset={48}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}

        {fixed.length > 0 && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Fixed costs · {fixed.length}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
            {fixed.map((r, i, a) => (
              <React.Fragment key={r.id}>
                <RecurringRow r={r} onClick={() => nav.push('recurringDetail', { id:r.id })}/>
                {i < a.length-1 && <Divider inset={48}/>}
              </React.Fragment>
            ))}
          </div>
        </>}

        {subs.length > 0 && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Subscriptions · {subs.length}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
            {subs.map((r, i, a) => (
              <React.Fragment key={r.id}>
                <RecurringRow r={r} onClick={() => nav.push('recurringDetail', { id:r.id })}/>
                {i < a.length-1 && <Divider inset={48}/>}
              </React.Fragment>
            ))}
          </div>
        </>}

        {RECURRING.filter(r => r.amount < 0 && !r.active).length > 0 && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4, color:M.ink4 }}>Inactive</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:20, border:`1px solid ${M.line2}`, opacity:0.55 }}>
            {RECURRING.filter(r => r.amount < 0 && !r.active).map((r, i, a) => (
              <React.Fragment key={r.id}>
                <RecurringRow r={r} onClick={() => nav.push('recurringDetail', { id:r.id })}/>
                {i < a.length-1 && <Divider inset={48}/>}
              </React.Fragment>
            ))}
          </div>
        </>}
      </div>
      {showTabBar && <TabBar active="recurring" onChange={(t) => nav.switchTab(t)}/>}
    </div>
  );
}

export function ScreenRecurring()    { return <RecurringContent showTabBar={false}/>; }
export function ScreenRecurringTab() { return <RecurringContent showTabBar={true}/>; }

export function ScreenRecurringDetail({ params }) {
  const nav = useNav();
  const { txs: allTxs } = useTxCtx();
  const [showAddTx, setShowAddTx] = React.useState(false);
  const r = RECURRING.find(x => x.id === params?.id) || RECURRING[0];
  const txs = allTxs.filter(t => r.txIds?.includes(t.id));
  const seed = Math.abs(r.amount);
  const history = [seed*0.97, seed, seed*1.02, seed*0.99, seed*1.01, Math.abs(r.amount)];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title=""
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<>
          <button className="m-iconbtn m-tap"><I name="edit" size={18}/></button>
          <button className="m-iconbtn m-tap"><I name="more" size={18}/></button>
        </>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign:'center', padding:'8px 0 20px' }}>
          <div style={{ width:64, height:64, borderRadius:18, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
            <I name={r.icon} size={28} color={M.ink2}/>
          </div>
          <div className="m-h2">{r.name}</div>
          <div style={{ display:'flex', justifyContent:'center', gap:6, marginTop:10, flexWrap:'wrap' }}>
            <span style={{ fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:999, background:M.paper2, color:M.ink2, border:`1px solid ${M.line}` }}>
              {r.type === 'fixed' ? 'Fixed cost' : 'Subscription'}
            </span>
            {r.luxury && (
              <span style={{ fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:999, background:M.violetSoft, color:M.violet }}>Luxury</span>
            )}
            {!r.active && (
              <span style={{ fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:999, background:M.claySoft, color:M.clay }}>Inactive</span>
            )}
          </div>
        </div>

        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          <DetailRow label="Amount" value={fmtEur(r.amount)} mono/>
          <Divider inset={0}/>
          <DetailRow label="Billing day" value={`${ordinal(r.day)} of each month`}/>
          <Divider inset={0}/>
          <DetailRow label="Active since" value={r.since || '—'}/>
          <Divider inset={0}/>
          <DetailRow label="Duration" value={r.until ? `Until ${r.until}` : 'Ongoing — no end date'}/>
          <Divider inset={0}/>
          <DetailRow label="Next payment" value={r.next || '—'}/>
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
          <div className="m-cap" style={{ marginBottom:10 }}>History · 6 periods</div>
          <BarChart data={history} labels={['Sep–Oct','Oct–Nov','Nov–Dec','Dec–Jan','Jan–Feb','Feb–Mar']} showValues height={84} accent={M.sage}/>
        </div>

        {(r.type === 'subs' || r.type === 'fixed') && (
          <div className="m-card m-tap" onClick={() => nav.push('recurringDeals', { id:r.id })} style={{ padding:14, marginBottom:14, background:M.ochreSoft, border:`1px solid ${M.ochre}33`, display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:38, height:38, borderRadius:10, background:'rgba(255,255,255,0.65)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="tag" size={18} color={M.ochre}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:600 }}>Find better deals</div>
              <div style={{ fontSize:11, color:M.ink2, marginTop:2 }}>Compare alternatives and save money</div>
            </div>
            <I name="caretR" size={12} color={M.ochre}/>
          </div>
        )}

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, paddingLeft:4 }}>
          <div className="m-cap">Linked transactions · {txs.length}</div>
          <button className="m-tap" onClick={() => setShowAddTx(true)}
            style={{ display:'flex', alignItems:'center', gap:4, background:'transparent', border:'none', color:M.ink3, fontSize:12, fontWeight:600, fontFamily:M.fontUI, cursor:'pointer', padding:'4px 0' }}>
            <I name="plus" size={12} color={M.ink3}/> Add
          </button>
        </div>
        <div className="m-card" style={{ padding:'0 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {txs.length === 0 ? (
            <div className="m-tap" onClick={() => setShowAddTx(true)} style={{ padding:'20px 0', display:'flex', alignItems:'center', gap:10 }}>
              <I name="plus" size={16} color={M.ink4}/>
              <div style={{ fontSize:13, color:M.ink4 }}>Link a transaction to this recurring cost</div>
            </div>
          ) : txs.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <TxRow tx={t} showDate onClick={() => nav.push('txDetail', { id:t.id })}/>
              {i < a.length-1 && <Divider inset={50}/>}
            </React.Fragment>
          ))}
        </div>

        <button className="m-btn outline m-tap" style={{ width:'100%', marginBottom:10 }} onClick={() => setShowAddTx(true)}>
          <I name="plus" size={16}/> Add transaction
        </button>
        <button className="m-btn m-tap" style={{ width:'100%', marginBottom:20, background:'transparent', color:M.clay, borderColor:M.claySoft }}>
          Delete recurring cost
        </button>
      </div>
      {showAddTx && <RecurringAddTxSheet rid={r.id} cat={r.cat} onClose={() => setShowAddTx(false)}/>}
    </div>
  );
}

function RecurringAddTxSheet({ rid, cat, onClose }) {
  const nav = useNav();
  const { txs } = useTxCtx();
  const already = RECURRING.find(r => r.id === rid)?.txIds || [];
  const candidates = txs.filter(t => t.cat === cat && t.amount < 0 && !already.includes(t.id));
  return (
    <Sheet onClose={onClose}>
      <div style={{ padding:'4px 20px 32px', maxHeight:'72vh', overflowY:'auto' }}>
        <div className="m-h2" style={{ marginBottom:4 }}>Link a transaction</div>
        <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>Attach an existing transaction to this recurring cost.</div>
        {candidates.length === 0 ? (
          <div style={{ padding:'24px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>No unlinked transactions in this category</div>
        ) : (
          <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}`, marginBottom:16 }}>
            {candidates.slice(0, 8).map((t, i, a) => (
              <React.Fragment key={t.id}>
                <TxRow tx={t} showDate onClick={onClose}/>
                {i < a.length-1 && <Divider inset={50}/>}
              </React.Fragment>
            ))}
          </div>
        )}
        <button className="m-btn outline m-tap" style={{ width:'100%' }} onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

export function ScreenRecurringCreate() {
  const nav = useNav();
  const { t } = useLang();
  const [type,    setType]    = React.useState('subs');
  const [luxury,  setLuxury]  = React.useState(false);
  const [endless, setEndless] = React.useState(true);
  const [icon,    setIcon]    = React.useState('film');
  const icons = ['film','house','flame','health','car','shop','rocket','heart','globe','star','bag','wave'];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Add recurring"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="x" size={20}/></button>}
        trailing={<button className="m-tap" style={{ background:'transparent', border:'none', fontSize:14, fontWeight:600, color:M.sage, fontFamily:M.fontUI }} onClick={() => nav.pop()}>{t('action.save')}</button>}
      />
      <div className="m-body-scroll">
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Type</div>
        <div style={{ display:'flex', background:M.paper2, borderRadius:12, padding:3, gap:3, marginBottom:6 }}>
          {[{id:'fixed',label:'Fixed cost'},{id:'subs',label:'Subscription'}].map(t => (
            <button key={t.id} onClick={() => setType(t.id)} className="m-tap" style={{
              flex:1, height:34, borderRadius:10, border:'none', fontFamily:M.fontUI, cursor:'pointer',
              background: type===t.id ? M.card : 'transparent',
              boxShadow: type===t.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              color: type===t.id ? M.ink : M.ink3,
              fontSize:13, fontWeight: type===t.id ? 600 : 500,
            }}>{t.label}</button>
          ))}
        </div>
        <div style={{ fontSize:11, color:M.ink3, marginBottom:18, paddingLeft:4 }}>
          {type === 'fixed' ? 'Rent, utilities, insurance — predictable monthly outflows.' : 'Streaming, apps, memberships — cancellable anytime.'}
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Icon</div>
        <div style={{ display:'flex', gap:8, overflowX:'auto', paddingBottom:4, marginBottom:16 }}>
          {icons.map(ic => (
            <button key={ic} onClick={() => setIcon(ic)} className="m-tap" style={{
              flexShrink:0, width:48, height:48, borderRadius:12,
              background:icon===ic?M.ink:M.card, border:`1px solid ${icon===ic?M.ink:M.line}`,
              display:'flex', alignItems:'center', justifyContent:'center',
            }}>
              <I name={ic} size={20} color={icon===ic?'#fff':M.ink2}/>
            </button>
          ))}
        </div>

        <div className="m-card" style={{ padding:4, marginBottom:14, border:`1px solid ${M.line}` }}>
          <FormRow label="Name" value="" placeholder={type==='fixed'?'e.g. Rent':'e.g. Netflix'}/>
          <Divider inset={16}/>
          <FormRow label="Amount" value="€0,00" icon="wallet"/>
          <Divider inset={16}/>
          <FormRow label="Billing day" value="1st of the month" caretR/>
          <Divider inset={16}/>
          <FormRow label="Starting from" value="Feb 2026" caretR/>
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
          <div className="m-tap" onClick={() => setEndless(!endless)} style={{ display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>Ongoing — no end date</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>Runs indefinitely until you cancel it</div>
            </div>
            <Toggle on={endless}/>
          </div>
          {!endless && (
            <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${M.line2}` }}>
              <FormRow label="End date" value="—" caretR/>
            </div>
          )}
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:20, border:`1px solid ${M.line}` }}>
          <div className="m-tap" onClick={() => setLuxury(!luxury)} style={{ display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}>
            <div style={{ width:36, height:36, borderRadius:10, background:luxury?M.violetSoft:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="star" size={16} color={luxury?M.violet:M.ink3}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>Mark as luxury</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>Optional / non-essential spending</div>
            </div>
            <Toggle on={luxury}/>
          </div>
        </div>

        <button className="m-btn sage m-tap" style={{ width:'100%', marginBottom:18 }} onClick={() => nav.pop()}>
          Add recurring cost
        </button>
      </div>
    </div>
  );
}

export function ScreenRecurringDeals({ params }) {
  const nav = useNav();
  const r = RECURRING.find(x => x.id === params?.id) || RECURRING[0];

  const DEALS_MAP = {
    r3: [
      { id:'d1', name:'Spotify Family', price:-15.99, saving:null, desc:'Up to 6 accounts — €2.67/person', badge:'Best for groups', badgeColor:M.sage },
      { id:'d2', name:'YouTube Music', price:-9.99, saving:0, desc:'Similar library + YouTube integration', badge:'Same price', badgeColor:M.ink3 },
      { id:'d3', name:'Deezer Premium', price:-10.99, saving:-1.00, desc:'High-fidelity FLAC audio', badge:'€1 more/mo', badgeColor:M.clay },
      { id:'d4', name:'Deezer Free', price:0, saving:9.99, desc:'Ad-supported, 64 Mbit quality', badge:'Free option', badgeColor:M.sage },
    ],
    r4: [
      { id:'d1', name:'Netflix Standard with Ads', price:-7.99, saving:6.00, desc:'Full library, short ad breaks per hour', badge:'Save €6/mo', badgeColor:M.sage },
      { id:'d2', name:'Disney+', price:-8.99, saving:5.00, desc:'Disney, Marvel, Star Wars, Pixar', badge:'Save €5/mo', badgeColor:M.sage },
      { id:'d3', name:'Prime Video', price:-8.99, saving:5.00, desc:'Included with Amazon Prime', badge:'Save €5/mo', badgeColor:M.sage },
      { id:'d4', name:'Apple TV+', price:-9.99, saving:4.00, desc:'Award-winning originals only', badge:'Save €4/mo', badgeColor:M.sage },
    ],
  };

  const fallbackDeals = [
    { id:'d1', name:'Comparable plan A', price: r.amount * 0.82, saving: Math.abs(r.amount) * 0.18, desc:'Same core features at a lower tier', badge:'Save ~18%', badgeColor:M.sage },
    { id:'d2', name:'Comparable plan B', price: r.amount * 0.92, saving: Math.abs(r.amount) * 0.08, desc:'Basic tier, fewer extras', badge:'Save ~8%', badgeColor:M.sage },
    { id:'d3', name:'Annual plan', price: r.amount * 0.83, saving: Math.abs(r.amount) * 0.17, desc:'Pay once a year, 2 months free', badge:'Save 2 months', badgeColor:M.ochre },
  ];

  const deals = DEALS_MAP[r.id] || fallbackDeals;
  const annualSavings = deals.filter(d => d.saving > 0).sort((a,b) => b.saving - a.saving);
  const best = annualSavings[0];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Better deals"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-card" style={{ padding:16, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div className="m-cap" style={{ marginBottom:10 }}>Your current plan</div>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:42, height:42, borderRadius:12, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name={r.icon} size={20} color={M.ink2}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:15, fontWeight:600 }}>{r.name}</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{r.type === 'subs' ? 'Subscription' : 'Fixed cost'} · billed monthly</div>
            </div>
            <div className="m-num" style={{ fontSize:17, fontWeight:700 }}>{fmtEur(r.amount)}</div>
          </div>
          {best && (
            <div style={{ marginTop:12, padding:'10px 12px', borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', gap:10 }}>
              <I name="tag" size={14} color={M.sage}/>
              <div style={{ fontSize:12, color:M.ink2, lineHeight:1.4 }}>
                Best alternative: <span style={{ fontWeight:700, color:M.sage }}>{fmtEur(best.saving)}/month</span> saved · {fmtEur(best.saving * 12)}/year
              </div>
            </div>
          )}
        </div>

        <div className="m-cap" style={{ marginBottom:10, paddingLeft:4 }}>Alternatives · {deals.length}</div>
        <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
          {deals.map(d => {
            const bColor = d.badgeColor === M.ink3 ? M.ink3 : d.badgeColor;
            const bBg    = d.badgeColor === M.ink3 ? M.paper2 : d.badgeColor + '22';
            return (
              <div key={d.id} className="m-card" style={{ padding:16, border:`1px solid ${M.line}`, display:'flex', gap:12, alignItems:'flex-start' }}>
                <div style={{ width:42, height:42, borderRadius:12, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:16, fontWeight:700, color:M.ink2 }}>
                  {d.name[0]}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4, gap:8 }}>
                    <div style={{ fontSize:14, fontWeight:600 }}>{d.name}</div>
                    <div className="m-num" style={{ fontSize:14, fontWeight:700, flexShrink:0 }}>
                      {d.price === 0 ? 'Free' : fmtEur(d.price)}
                    </div>
                  </div>
                  <div style={{ fontSize:11, color:M.ink3, marginBottom:10, lineHeight:1.4 }}>{d.desc}</div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:999, background:bBg, color:bColor, textTransform:'uppercase', letterSpacing:'0.04em' }}>
                      {d.badge}
                    </span>
                    <button className="m-tap" style={{ fontSize:12, fontWeight:600, color:M.sage, background:'transparent', border:'none', fontFamily:M.fontUI, cursor:'pointer', padding:0 }}>
                      Explore →
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding:14, borderRadius:12, background:M.paper2, border:`1px solid ${M.line2}`, display:'flex', gap:10, marginBottom:20 }}>
          <I name="help" size={15} color={M.ink4}/>
          <div style={{ fontSize:11, color:M.ink3, lineHeight:1.5 }}>
            Prices are approximate and may vary by region or active promotions. Check the provider before switching.
          </div>
        </div>
      </div>
    </div>
  );
}
