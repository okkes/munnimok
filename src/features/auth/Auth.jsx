import React from 'react';
import { T } from '../../shared/testIds.js';
import { COUNTRIES, countryName } from '../../shared/data/countries.js';
import { M, I, IcoGoogle, IcoApple, StatusBar, Divider } from '../../app/theme.jsx';
import { Sheet, useDark } from '../../app/nav.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { DUTCH_BANKS, generateBankIban, DUTCH_BANKS as _DB } from '../accounts/data.js';

function seededIban(bank, seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; }
  h = Math.abs(h);
  const bic4 = (bank.bic || bank.id).toUpperCase().slice(0, 4);
  const n = String(1000000000 + (h % 9000000000));
  const check = 10 + (h % 89);
  return `NL${check} ${bic4} ${n.slice(0,4)} ${n.slice(4,8)} ${n.slice(8,10)}`;
}
import { STOCK_AVATARS } from '../../shared/constants.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function highlightMatch(text, query) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>{text.slice(0, idx)}<span style={{ background:M.sageSoft, color:M.sage, borderRadius:3, padding:'0 2px', fontWeight:700 }}>{text.slice(idx, idx + query.length)}</span>{text.slice(idx + query.length)}</>
  );
}

const countryFlagUrl = (code) => {
  const [a, b] = code.toUpperCase().split('');
  const r = c => (0x1F1E6 + c.charCodeAt(0) - 65).toString(16);
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${r(a)}-${r(b)}.svg`;
};

export function ScreenSignupOnboarding({ signup, onComplete, onBack }) {
  const { t, lang } = useLang();
  const { dark } = useDark();
  const flagStyle = dark
    ? { borderRadius:3, flexShrink:0, filter:'invert(1) hue-rotate(180deg)', display:'block' }
    : { borderRadius:3, flexShrink:0, display:'block' };
  const isGoogle = signup.method === 'google';
  const isApple  = signup.method === 'apple';
  const isSSO    = isGoogle || isApple;

  // Main form state
  const [firstName,      setFirstName]     = React.useState(signup.firstName || '');
  const [lastName,       setLastName]      = React.useState(signup.lastName  || '');
  const [email,          setEmail]         = React.useState(signup.displayEmail || '');
  const [connectedBanks, setConnectedBanks] = React.useState(
    () => (signup.banks || []).map((id, i) => ({ id, uid: `init_${i}` }))
  );
  const [apiUrl,         setApiUrl]        = React.useState(signup.apiUrl || '');
  const [country,        setCountry]       = React.useState('');
  const [showCountry,    setShowCountry]   = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      try {
        const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
        const text = await r.text();
        const match = text.match(/^loc=([A-Z]{2})$/m);
        const code = match?.[1];
        if (!cancelled && code && COUNTRIES.some(c => c.code === code)) {
          setCountry(code);
        }
      } catch {}
    };
    detect();
    return () => { cancelled = true; };
  }, []);
  const [countrySearch,  setCountrySearch] = React.useState('');
  const [picture,        setPicture]       = React.useState(signup.picture || null);
  const [bankPsd2Step,   setBankPsd2Step]  = React.useState(null); // null | 'consent' | 'connecting' | 'done'
  const [showApiInfo,    setShowApiInfo]   = React.useState(false);
  const [showCountryInfo,setShowCountryInfo]= React.useState(false);
  const [onboardingStep, setOnboardingStep] = React.useState(1); // 1 = profile, 2 = bank
  const stepRef = React.useRef(1);
  const [showPicker,     setShowPicker]    = React.useState(false);
  const [errors,         setErrors]        = React.useState({});
  const fileInputRef = React.useRef(null);
  const step1ScrollRef  = React.useRef(null);
  const step1SavedScroll = React.useRef(0);

  // Bank sub-screen state
  const [bankSubScreen, setBankSubScreen] = React.useState(null); // null | 'search' | 'credentials'
  const [pendingBank,   setPendingBank]   = React.useState(null);
  const [bankSearch,    setBankSearch]    = React.useState('');
  const [bankCreds,     setBankCreds]     = React.useState({ username:'', password:'', accountNumber:'' });
  const [credsError,    setCredsError]    = React.useState('');
  const subScreenRef = React.useRef(null);
  const skipPopsRef  = React.useRef(0);
  const connectedBanksRef = React.useRef(connectedBanks);
  React.useEffect(() => { connectedBanksRef.current = connectedBanks; }, [connectedBanks]);

  // Scroll lock for step-1 overlays
  React.useEffect(() => {
    const el = step1ScrollRef.current;
    if (!el) return;
    const anyOpen = showCountry || showApiInfo || showPicker || showCountryInfo;
    if (anyOpen) {
      step1SavedScroll.current = el.scrollTop;
      el.style.overflowY = 'hidden';
      el.scrollTop = step1SavedScroll.current;
    } else {
      el.style.overflowY = '';
      requestAnimationFrame(() => { el.scrollTop = step1SavedScroll.current; });
    }
  }, [showCountry, showApiInfo, showPicker, showCountryInfo]);


  const filteredBanks = React.useMemo(() => {
    const q = bankSearch.toLowerCase().trim();
    if (!q) return DUTCH_BANKS;
    return DUTCH_BANKS.filter(b => b.name.toLowerCase().includes(q) || b.bic.toLowerCase().includes(q));
  }, [bankSearch]);

  // Popstate: handles main back + bank sub-screen back
  React.useEffect(() => {
    window.history.pushState({ munniLoginMode: 'signup-onboarding' }, '');
    const handlePop = () => {
      if (skipPopsRef.current > 0) { skipPopsRef.current = 0; return; }
      if (subScreenRef.current === 'credentials') {
        subScreenRef.current = 'search';
        setBankSubScreen('search');
        setBankPsd2Step(null);
      } else if (subScreenRef.current === 'search') {
        subScreenRef.current = null;
        setBankSubScreen(null);
      } else if (stepRef.current === 2) {
        stepRef.current = 1;
        setOnboardingStep(1);
      } else {
        // Step 1 is a point-of-no-return — block browser back by re-pushing state
        window.history.pushState({ munniLoginMode: 'signup-onboarding' }, '');
      }
    };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  const openBankSearch = () => {
    subScreenRef.current = 'search';
    setBankSubScreen('search');
    setBankSearch('');
    window.history.pushState({ munniLoginMode: 'bank-search' }, '');
  };

  const openBankCredentials = (bank) => {
    subScreenRef.current = 'credentials';
    setBankSubScreen('credentials');
    setBankPsd2Step(null);
    setPendingBank(bank);
    setBankCreds({ username:'demo.user@munni.app', password:'••••••••', accountNumber: generateBankIban(bank) });
    setCredsError('');
    window.history.pushState({ munniLoginMode: 'bank-credentials' }, '');
  };

  const backFromSearch = () => {
    skipPopsRef.current = 1;
    subScreenRef.current = null;
    setBankSubScreen(null);
    setBankPsd2Step(null);
    window.history.go(-1);
  };

  const backFromCredentials = () => {
    skipPopsRef.current = 1;
    subScreenRef.current = 'search';
    setBankSubScreen('search');
    setBankPsd2Step(null);
    window.history.go(-1);
  };

  const addBank = (bankId, iban) => {
    setConnectedBanks(prev => [...prev, { id: bankId, uid: `${Date.now()}_${Math.random()}`, iban: iban || '' }]);
  };
  const removeBank = (uid) => {
    setConnectedBanks(prev => prev.filter(b => b.uid !== uid));
  };

  const handleBankConnect = () => {
    if (!bankCreds.username.trim()) { setCredsError(t('onboarding.errLoginRequired')); return; }
    if (!bankCreds.password.trim()) { setCredsError(t('onboarding.errPasswordRequired')); return; }
    setBankPsd2Step('consent');
  };

  const handlePsd2Authorise = () => {
    setBankPsd2Step('connecting');
    setTimeout(() => setBankPsd2Step('done'), 1800);
  };

  const handlePsd2Done = () => {
    addBank(pendingBank.id, bankCreds.accountNumber);
    skipPopsRef.current = 1;
    subScreenRef.current = null;
    setBankSubScreen(null);
    setBankPsd2Step(null);
    setPendingBank(null);
    window.history.go(-2);
  };

  const handlePsd2Cancel = () => {
    skipPopsRef.current = 1;
    subScreenRef.current = null;
    setBankSubScreen(null);
    setBankPsd2Step(null);
    setPendingBank(null);
    window.history.go(-2);
  };

  const validate = () => {
    const errs = {};
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn) errs.firstName = t('onboarding.errFirstNameRequired');
    else if (fn.length > 50) errs.firstName = t('login.errNameTooLong');
    if (!ln) errs.lastName = t('onboarding.errLastNameRequired');
    else if (ln.length > 50) errs.lastName = t('login.errNameTooLong');
    if (!country) errs.country = t('onboarding.errCountryRequired');
    if (!isSSO) {
      if (!EMAIL_RE.test(email.trim().toLowerCase())) errs.email = t('login.errInvalidEmail');
    }
    return errs;
  };

  const handleComplete = () => {
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    onComplete({
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      country,
      email:     isSSO ? signup.displayEmail : email.trim().toLowerCase(),
      apiUrl:    apiUrl.trim(),
      picture,
      connectedBanks: connectedBanks.map(b => {
        const bank = DUTCH_BANKS.find(bk => bk.id === b.id);
        return { ...b, iban: b.iban || (bank ? seededIban(bank, b.uid) : '') };
      }),
    });
  };

  const handleContinue = () => {
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    stepRef.current = 2;
    setOnboardingStep(2);
    window.history.pushState({ munniLoginMode: 'signup-bank' }, '');
  };

  const backFromStep2 = () => {
    skipPopsRef.current = 1;
    stepRef.current = 1;
    setOnboardingStep(1);
    window.history.go(-1);
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setPicture(ev.target.result); setShowPicker(false); };
    reader.readAsDataURL(file);
  };

  const avatarInitial = firstName ? firstName[0].toUpperCase() : null;

  const renderAvatar = () => {
    if (picture && picture.startsWith('av')) {
      const av = STOCK_AVATARS.find(a => a.id === picture);
      if (av) return (
        <div style={{ width:72, height:72, borderRadius:999, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>
          {av.emoji}
        </div>
      );
    }
    if (picture && picture.startsWith('data:')) {
      return <img src={picture} style={{ width:72, height:72, borderRadius:999, objectFit:'cover' }} alt="avatar"/>;
    }
    if (isGoogle) return (
      <div style={{ width:72, height:72, borderRadius:999, background:'#f8f9fa', border:`1.5px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <IcoGoogle size={36}/>
      </div>
    );
    if (isApple) return (
      <div style={{ width:72, height:72, borderRadius:999, background:M.paper2, border:`1.5px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
        <IcoApple size={32} color={M.ink}/>
      </div>
    );
    return (
      <div style={{ width:72, height:72, borderRadius:999, background:`linear-gradient(135deg, ${M.sage} 0%, #3D5A42 100%)`, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:28, fontFamily:M.fontDisp }}>
        {avatarInitial ? avatarInitial : <I name="user" size={32} color="#fff"/>}
      </div>
    );
  };

  // ── Bank search sub-screen ──────────────────────────────────────────
  if (bankSubScreen === 'search') {
    return (
      <div data-testid={T.bankSearchScreen} key="bank-search" className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
        <StatusBar/>
        <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
          <button className="m-tap" onClick={backFromSearch}
            style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
            <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
          </button>
          <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink, fontFamily:M.fontUI }}>
            {t('onboarding.selectBankTitle')}
          </div>
          <div style={{ minWidth:60 }}/>
        </div>

        <div style={{ padding:'12px 20px 8px', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, background:M.paper2, boxSizing:'border-box' }}>
            <I name="search" size={16} color={M.ink4}/>
            <input
              data-testid={T.bankSearchInput}
              autoFocus
              value={bankSearch}
              onChange={e => setBankSearch(e.target.value)}
              placeholder={t('onboarding.searchBank')}
              style={{ flex:1, border:'none', background:'transparent', fontSize:14, fontFamily:M.fontUI, outline:'none', color:M.ink, padding:0 }}
            />
          </div>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'0 20px 16px' }}>
          <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}` }}>
            {filteredBanks.length === 0
              ? <div data-testid={T.bankSearchNoResults} style={{ padding:'24px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('onboarding.noResults')}</div>
              : filteredBanks.map((bank, i) => {
                  const connCount = connectedBanks.filter(b => b.id === bank.id).length;
                  return (
                    <React.Fragment key={bank.id}>
                      {i > 0 && <Divider inset={48}/>}
                      <div data-testid={T.bankListRow} className="m-tap" onClick={() => openBankCredentials(bank)}
                        style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                        <div style={{ width:36, height:36, borderRadius:10, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18 }}>{bank.logo}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{highlightMatch(bank.name, bankSearch.trim())}</div>
                          <div style={{ fontSize:11, color:M.ink3, marginTop:1, fontFamily:M.fontMono }}>{highlightMatch(bank.bic, bankSearch.trim())}</div>
                        </div>
                        {connCount > 0 ? (
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:M.sageSoft, color:M.sage }}>{connCount}×</span>
                            <I name="caretR" size={14} color={M.sage}/>
                          </div>
                        ) : (
                          <I name="caretR" size={14} color={M.ink4}/>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })
            }
          </div>
        </div>
      </div>
    );
  }

  // ── Bank credentials sub-screen ─────────────────────────────────────
  if (bankSubScreen === 'credentials' && pendingBank) {
    const bank = pendingBank;

    // Consent step
    if (bankPsd2Step === 'consent') {
      return (
        <div data-testid={T.bankConsentScreen} key="bank-consent" className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
          <StatusBar/>
          <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
            <button className="m-tap" onClick={handlePsd2Cancel}
              style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
              <I name="x" size={18} color={M.tint}/>
            </button>
            <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink, fontFamily:M.fontUI }}>{t('onboarding.consent.title')}</div>
            <div style={{ minWidth:60 }}/>
          </div>
          <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', gap:20, overflowY:'auto' }}>
            <div style={{ textAlign:'center' }}>
              <div style={{ width:64, height:64, borderRadius:18, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32, margin:'0 auto 12px' }}>{bank.logo}</div>
              <div style={{ fontSize:13, color:M.ink3 }}>{t('onboarding.consent.subtitle')}</div>
            </div>
            <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}` }}>
              {[
                { icon:'card', title:t('onboarding.consent.accountInfo'), sub:t('onboarding.consent.accountInfoSub') },
                { icon:'list', title:t('onboarding.consent.txHistory'), sub:t('onboarding.consent.txHistorySub') },
              ].map((item, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <Divider/>}
                  <div style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name={item.icon} size={18} color={M.sage}/>
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{item.title}</div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{item.sub}</div>
                    </div>
                    <I name="check" size={16} color={M.sage}/>
                  </div>
                </React.Fragment>
              ))}
            </div>
            <div style={{ fontSize:12, color:M.ink3, textAlign:'center', lineHeight:1.5 }}>{t('onboarding.consent.footer')}</div>
            <button data-testid={T.bankConsentAuthorise} className="m-btn sage m-tap" onClick={handlePsd2Authorise} style={{ marginTop:'auto' }}>{t('onboarding.consent.authorise')}</button>
            <button className="m-btn outline m-tap" onClick={handlePsd2Cancel}>{t('action.cancel')}</button>
          </div>
        </div>
      );
    }

    // Connecting step
    if (bankPsd2Step === 'connecting') {
      return (
        <div data-testid={T.bankConnectingScreen} key="bank-connecting" className="m-screen" style={{ display:'flex', flexDirection:'column' }}>
          <StatusBar/>
          <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
            <div style={{ minWidth:60 }}/>
            <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink, fontFamily:M.fontUI }}>{bank.name}</div>
            <div style={{ minWidth:60 }}/>
          </div>
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, textAlign:'center', padding:'24px' }}>
            <div style={{ width:64, height:64, borderRadius:18, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{bank.logo}</div>
            <div style={{ display:'flex', gap:8 }}>
              {[0,1,2].map(i => <div key={i} style={{ width:8, height:8, borderRadius:999, background:M.sage, animation:`pulse 1.2s ease-in-out ${i*0.4}s infinite` }}/>)}
            </div>
            <div style={{ fontSize:15, fontWeight:600, color:M.ink }}>{t('onboarding.connecting.title').replace('{bank}', bank.name)}</div>
            <div style={{ fontSize:12, color:M.ink3 }}>{t('onboarding.connecting.subtitle')}</div>
          </div>
        </div>
      );
    }

    // Done step
    if (bankPsd2Step === 'done') {
      return (
        <div data-testid={T.bankDoneScreen} key="bank-done" className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
          <StatusBar/>
          <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
            <div style={{ minWidth:60 }}/>
            <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink, fontFamily:M.fontUI }}>Connected</div>
            <div style={{ minWidth:60 }}/>
          </div>
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, textAlign:'center', padding:'24px' }}>
            <div style={{ width:80, height:80, borderRadius:24, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <I name="check" size={36} color={M.sage} stroke={2.5}/>
            </div>
            <div className="m-h2">{t('onboarding.done.title')}</div>
            <div style={{ fontSize:13, color:M.ink3, lineHeight:1.5, maxWidth:260 }}>{t('onboarding.done.subtitle').replace('{bank}', bank.name)}</div>
            <button data-testid={T.bankDoneBtn} className="m-btn sage m-tap" onClick={handlePsd2Done} style={{ marginTop:8 }}>{t('action.done')}</button>
          </div>
        </div>
      );
    }

    // Login / credentials step (default)
    return (
      <div data-testid={T.bankCredsScreen} key="bank-credentials" className="m-screen m-fade" style={{ display:'flex', flexDirection:'column' }}>
        <StatusBar/>
        <div style={{ display:'flex', alignItems:'center', padding:'12px 20px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
          <button className="m-tap" onClick={backFromCredentials}
            style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:4, color:M.tint, fontFamily:M.fontUI, fontSize:15, padding:'4px 0', minWidth:60 }}>
            <I name="arrowL" size={16} color={M.tint}/>{t('action.back')}
          </button>
          <div style={{ flex:1, textAlign:'center', fontWeight:600, fontSize:16, color:M.ink, fontFamily:M.fontUI }}>
            {bank.name}
          </div>
          <div style={{ minWidth:60 }}/>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'24px 24px 40px' }}>
          {/* Bank identity */}
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:10, marginBottom:24 }}>
            <div style={{ width:64, height:64, borderRadius:18, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{bank.logo}</div>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:15, fontWeight:600, color:M.ink }}>{t('onboarding.connectSubtitle')}</div>
              <div style={{ fontSize:12, color:M.ink3, marginTop:2, fontFamily:M.fontMono }}>{bank.bic}</div>
            </div>
          </div>

          {/* PSD2 note */}
          <div style={{ padding:'10px 12px', borderRadius:10, background:M.sageSoft, marginBottom:20, display:'flex', gap:10, alignItems:'flex-start' }}>
            <I name="lock" size={14} color={M.sage}/>
            <div style={{ fontSize:11, color:M.sageDk, lineHeight:1.5 }}>{t('onboarding.bankPSD2Note')}</div>
          </div>

          {/* Credentials form */}
          <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}`, marginBottom:20 }}>
            <div style={{ padding:'14px 0' }}>
              <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>{t('onboarding.loginName')}</div>
              <input
                data-testid={T.bankCredsUsername}
                value={bankCreds.username}
                onChange={e => { setBankCreds(p => ({...p, username:e.target.value})); setCredsError(''); }}
                placeholder={t('onboarding.loginNamePlaceholder')}
                style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1.5px solid ${credsError && !bankCreds.username.trim() ? M.clay : M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
              />
            </div>
            <Divider/>
            <div style={{ padding:'14px 0' }}>
              <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>{t('onboarding.bankPassword')}</div>
              <input
                type="password"
                value={bankCreds.password}
                onChange={e => setBankCreds(p => ({...p, password:e.target.value}))}
                placeholder={t('onboarding.bankPasswordPlaceholder')}
                style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1.5px solid ${credsError && !bankCreds.password.trim() ? M.clay : M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
              />
            </div>
            <Divider/>
            <div style={{ padding:'14px 0' }}>
              <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>{t('onboarding.accountNumberLabel')}</div>
              <input
                value={bankCreds.accountNumber}
                onChange={e => setBankCreds(p => ({...p, accountNumber:e.target.value}))}
                placeholder={t('onboarding.accountNumberPlaceholder')}
                style={{ width:'100%', boxSizing:'border-box', padding:'10px 12px', borderRadius:10, border:`1.5px solid ${M.line}`, fontSize:14, fontFamily:M.fontMono, background:M.paper2, outline:'none', color:M.ink }}
              />
            </div>
          </div>

          {credsError && <div data-testid={T.bankCredsError} style={{ fontSize:12, color:M.clay, marginBottom:12, textAlign:'center' }}>{credsError}</div>}

          <button data-testid={T.bankCredsConnect} className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700 }} onClick={handleBankConnect}>
            {t('onboarding.connectBtn')}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: bank connect ────────────────────────────────────────────
  if (onboardingStep === 2) {
    return (
      <div data-testid={T.onboardStep2} key="signup-bank" className="m-screen m-fade" style={{ position:'relative' }}>
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0, minHeight:40 }}>
          {connectedBanks.length === 0 && (
            <button className="m-tap" onClick={backFromStep2} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
              <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
            </button>
          )}
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'20px 24px 40px' }}>
          <div className="m-logo" style={{ fontSize:20, marginBottom:14 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:4 }}>{t('onboarding.bankStepTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:20, lineHeight:1.5 }}>{t('onboarding.bankStepSub')}</div>

          {/* Primary CTA: add bank */}
          {connectedBanks.length === 0 ? (
            <button data-testid={T.onboardAddBank} className="m-btn sage m-tap" style={{ width:'100%', height:54, fontSize:15, marginBottom:12 }} onClick={openBankSearch}>
              <I name="plus" size={18} color="#fff"/>
              {t('onboarding.addBank')}
            </button>
          ) : (
            <div style={{ marginBottom:12 }}>
              <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}`, marginBottom:10 }}>
                {connectedBanks.map((entry, i) => {
                  const bank = DUTCH_BANKS.find(b => b.id === entry.id);
                  if (!bank) return null;
                  const sameBeforeCount = connectedBanks.slice(0, i).filter(b => b.id === entry.id).length;
                  const label = sameBeforeCount > 0 ? `${bank.name} (${sameBeforeCount + 1})` : bank.name;
                  return (
                    <React.Fragment key={entry.uid}>
                      {i > 0 && <Divider inset={48}/>}
                      <div data-testid={T.onboardBankRow} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0' }}>
                        <div style={{ width:36, height:36, borderRadius:10, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:18 }}>{bank.logo}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{label}</div>
                          <div style={{ fontSize:11, color:M.ink3, marginTop:1, fontFamily:M.fontMono }}>{entry.iban || seededIban(bank, entry.uid)}</div>
                        </div>
                        <button data-testid="onboard-remove-bank" className="m-tap" onClick={() => removeBank(entry.uid)}
                          style={{ background:'none', border:'none', cursor:'pointer', padding:4, display:'flex', alignItems:'center' }}>
                          <I name="x" size={14} color={M.ink4}/>
                        </button>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
              <button data-testid={T.onboardAddAnotherBank} className="m-tap" onClick={openBankSearch}
                style={{ width:'100%', padding:'11px 16px', borderRadius:12, border:`1.5px dashed ${M.line2}`, background:'transparent', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:8, fontFamily:M.fontUI, boxSizing:'border-box' }}>
                <I name="plus" size={15} color={M.tint}/>
                <span style={{ fontSize:14, fontWeight:500, color:M.tint }}>{t('onboarding.addAnotherBank')}</span>
              </button>
            </div>
          )}

          {connectedBanks.length > 0 && (
            <button data-testid={T.onboardComplete} className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700, marginBottom:12 }} onClick={handleComplete}>
              {t('onboarding.complete')}
            </button>
          )}
          {connectedBanks.length === 0 && (
            <div style={{ textAlign:'center', marginBottom:4 }}>
              <button data-testid={T.onboardBankSkip} className="m-tap" onClick={handleComplete}
                style={{ background:'none', border:'none', fontSize:13, color:M.ink4, cursor:'pointer', fontFamily:M.fontUI, padding:'10px 0' }}>
                {t('onboarding.bankSkip')}
              </button>
            </div>
          )}

          {/* PSD2 footnote — subtle, below CTA */}
          <div style={{ display:'flex', gap:7, alignItems:'flex-start', marginTop:connectedBanks.length === 0 ? 8 : 10 }}>
            <I name="lock" size={11} color={M.ink4}/>
            <div style={{ fontSize:10, color:M.ink4, lineHeight:1.55 }}>{t('onboarding.bankPSD2Note')}</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1: profile details ─────────────────────────────────────────
  return (
    <div data-testid={T.onboardStep1} key="signup-onboarding" className="m-screen m-fade" style={{ position:'relative' }}>
      <StatusBar/>

      <div ref={step1ScrollRef} style={{ flex:1, overflowY:'auto', padding:'20px 24px 40px' }}>

        <div className="m-logo" style={{ fontSize:20, marginBottom:14 }}>munni<span className="dot">.</span></div>
        <div className="m-h2" style={{ marginBottom:4 }}>{t('onboarding.title')}</div>
        <div style={{ fontSize:13, color:M.ink3, marginBottom:24, lineHeight:1.5 }}>
          {isGoogle ? t('onboarding.subtitleGoogle') : isApple ? t('onboarding.subtitleApple') : t('onboarding.subtitleEmail')}
        </div>

        {/* Avatar */}
        <div style={{ display:'flex', justifyContent:'center', marginBottom:24 }}>
          <button data-testid={T.onboardAvatarBtn} className="m-tap" onClick={() => setShowPicker(true)} style={{ position:'relative', background:'none', border:'none', cursor:'pointer', padding:0 }}>
            {renderAvatar()}
            <div style={{ position:'absolute', bottom:2, right:2, width:22, height:22, borderRadius:'50%', background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #fff' }}>
              <I name="cam" size={11} color="#fff"/>
            </div>
          </button>
        </div>

        {/* Name */}
        <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:14 }}>
          <div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('onboarding.firstName')}</div>
            <input
              data-testid={T.onboardFirstName}
              value={firstName}
              onChange={e => { setFirstName(e.target.value); setErrors(p => ({...p, firstName:undefined})); }}
              placeholder={t('onboarding.firstNamePlaceholder')}
              style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', borderRadius:12, border:`1.5px solid ${errors.firstName ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
            />
            {errors.firstName && <div data-testid={T.onboardFirstNameErr} style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.firstName}</div>}
          </div>
          <div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('onboarding.lastName')}</div>
            <input
              data-testid={T.onboardLastName}
              value={lastName}
              onChange={e => { setLastName(e.target.value); setErrors(p => ({...p, lastName:undefined})); }}
              placeholder={t('onboarding.lastNamePlaceholder')}
              style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', borderRadius:12, border:`1.5px solid ${errors.lastName ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
            />
            {errors.lastName && <div data-testid={T.onboardLastNameErr} style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.lastName}</div>}
          </div>
        </div>

        {/* Email */}
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('login.email')}</div>
          {isSSO ? (
            <div style={{ padding:'12px 14px', borderRadius:12, background:M.paper2, border:`1.5px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, color:M.ink3, display:'flex', alignItems:'center', gap:8 }}>
              {isGoogle ? <IcoGoogle size={13}/> : <IcoApple size={13} color={M.ink3}/>}
              <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{signup.displayEmail}</span>
              <I name="lock" size={13} color={M.ink4}/>
            </div>
          ) : (
            <div style={{ padding:'12px 14px', borderRadius:12, background:M.paper2, border:`1.5px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, color:M.ink3, display:'flex', alignItems:'center', gap:8 }}>
              <I name="user" size={13} color={M.ink3}/>
              <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{email}</span>
              <I name="lock" size={13} color={M.ink4}/>
            </div>
          )}
        </div>

        {/* Country */}
        <div style={{ marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
            <div style={{ fontSize:12, color:M.ink3 }}>{t('profile.country')}</div>
            <button className="m-tap" onClick={() => setShowCountryInfo(true)}
              style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', padding:'0 2px' }}>
              <I name="info" size={14} color={M.tint}/>
            </button>
          </div>
          <button
            data-testid={T.onboardCountryBtn}
            className="m-tap"
            onClick={() => { setCountrySearch(''); setShowCountry(true); }}
            style={{ width:'100%', padding:'12px 14px', borderRadius:12, border:`1.5px solid ${errors.country ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color: country ? M.ink : M.ink4, cursor:'pointer', display:'flex', alignItems:'center', gap:8, textAlign:'left', boxSizing:'border-box' }}
          >
            {country ? (
              <>
                <img src={countryFlagUrl(country)} width={24} height={24} style={flagStyle} alt={country}/>
                <span style={{ flex:1 }}>{countryName(COUNTRIES.find(c => c.code === country), lang)}</span>
              </>
            ) : (
              <span style={{ flex:1 }}>{t('profile.countryPlaceholder')}</span>
            )}
            <I name="caretR" size={14} color={M.ink4}/>
          </button>
          {errors.country && <div data-testid={T.onboardCountryErr} style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.country}</div>}
        </div>

        {/* API endpoint */}
        <div style={{ marginBottom:24 }}>
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
            <div style={{ fontSize:12, color:M.ink3 }}>{t('onboarding.apiUrl')}</div>
            <button data-testid={T.onboardApiInfoBtn} className="m-tap" onClick={() => setShowApiInfo(true)}
              style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', padding:'0 2px' }}>
              <I name="info" size={14} color={M.tint}/>
            </button>
          </div>
          <input
            value={apiUrl}
            onChange={e => setApiUrl(e.target.value)}
            placeholder={t('onboarding.apiUrlPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', borderRadius:12, border:`1.5px solid ${M.line}`, fontSize:13, fontFamily:M.fontMono, background:M.paper2, outline:'none', color:M.ink }}
          />
        </div>

        <button data-testid={T.onboardContinue} className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700 }} onClick={handleContinue}>
          {t('login.continue')}
        </button>
      </div>

      {/* API info overlay */}
      {showApiInfo && (
        <div data-testid={T.onboardApiInfoSheet} style={{ position:'absolute', inset:0, background:'rgba(27,26,23,0.45)', display:'flex', flexDirection:'column', justifyContent:'flex-end', zIndex:100, animation:'fadeIn 0.22s ease' }}
          onClick={() => setShowApiInfo(false)}>
          <div style={{ background:M.paper, borderTopLeftRadius:24, borderTopRightRadius:24, padding:'8px 24px 40px', animation:'mSheetUp 0.32s cubic-bezier(.2,.7,.2,1)' }} onClick={e => e.stopPropagation()}>
            <div style={{ width:36, height:4, borderRadius:999, background:M.line, margin:'0 auto 20px' }}/>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <I name="info" size={18} color={M.tint}/>
              <div style={{ fontSize:15, fontWeight:600, color:M.ink }}>{t('onboarding.apiUrl')}</div>
            </div>
            <div style={{ fontSize:14, color:M.ink2, lineHeight:1.6 }}>{t('onboarding.apiInfo')}</div>
          </div>
        </div>
      )}

      {/* Country picker */}
      {showCountry && (
        <Sheet onClose={() => setShowCountry(false)}>
          <div style={{ padding:'0 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:12 }}>{t('profile.country')}</div>
            <input
              data-testid={T.onboardCountrySheet}
              value={countrySearch}
              onChange={e => setCountrySearch(e.target.value)}
              placeholder="Search…"
              style={{ width:'100%', boxSizing:'border-box', padding:'9px 14px', borderRadius:10, border:`1.5px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink, marginBottom:4 }}
            />
          </div>
          <div style={{ overflowY:'auto', maxHeight:340, paddingBottom:16 }}>
            {COUNTRIES.filter(c => !countrySearch || countryName(c, lang).toLowerCase().includes(countrySearch.toLowerCase()) || c.native.toLowerCase().includes(countrySearch.toLowerCase())).map(c => (
              <button key={c.code} className="m-tap"
                onClick={() => { setCountry(c.code); setShowCountry(false); setErrors(prev => ({ ...prev, country: undefined })); }}
                style={{ width:'100%', display:'flex', alignItems:'center', gap:12, padding:'12px 20px', background:'transparent', border:'none', cursor:'pointer', fontFamily:M.fontUI }}>
                <img src={countryFlagUrl(c.code)} width={24} height={24} style={{ ...flagStyle, flexShrink:0 }} alt={c.code}/>
                <span style={{ flex:1, textAlign:'left', fontSize:15, color:M.ink }}>{highlightMatch(countryName(c, lang), countrySearch.trim())}</span>
                {country === c.code && <I name="check" size={16} color={M.sage}/>}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {/* Country info sheet */}
      {showCountryInfo && (
        <Sheet onClose={() => setShowCountryInfo(false)}>
          <div style={{ padding:'0 16px 16px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
              <I name="info" size={18} color={M.tint}/>
              <div style={{ fontSize:15, fontWeight:600, color:M.ink }}>{t('profile.country')}</div>
            </div>
            <div style={{ fontSize:14, color:M.ink2, lineHeight:1.6 }}>{t('profile.countryInfo')}</div>
          </div>
        </Sheet>
      )}

      {/* Avatar picker overlay */}
      {showPicker && (
        <div data-testid={T.onboardAvatarPicker} style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', flexDirection:'column', justifyContent:'flex-end', zIndex:100 }}
          onClick={() => setShowPicker(false)}>
          <div style={{ background:M.paper, borderRadius:'20px 20px 0 0', padding:'16px 20px 32px' }} onClick={e => e.stopPropagation()}>
            <div style={{ width:36, height:4, borderRadius:2, background:M.line2, margin:'0 auto 16px' }}/>
            <div style={{ fontSize:14, fontWeight:600, color:M.ink, marginBottom:16 }}>{t('profile.picTitle')}</div>
            <label style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0', cursor:'pointer', borderBottom:`1px solid ${M.line2}`, marginBottom:14 }}>
              <div style={{ width:40, height:40, borderRadius:10, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="cam" size={18} color={M.ink2}/>
              </div>
              <div style={{ fontSize:15, fontWeight:500, color:M.ink }}>{t('profile.chooseLibrary')}</div>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} style={{ display:'none' }}/>
            </label>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10 }}>
              {STOCK_AVATARS.map(av => (
                <button key={av.id} className="m-tap" onClick={() => { setPicture(av.id); setShowPicker(false); }}
                  style={{ width:'100%', aspectRatio:'1', borderRadius:14, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:28, border:`2px solid ${picture === av.id ? M.sage : 'transparent'}`, cursor:'pointer' }}>
                  {av.emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
