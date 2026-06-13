import React from 'react';
import { T } from '../../shared/testIds.js';
import { COUNTRIES, countryName } from '../../shared/data/countries.js';
import { fmtEur } from '../../shared/utils/format.js';
import { getUserId, addDevLog, computeUserDataKey, registerUserInGlobalRegistry, formatCreatorLabel } from '../../shared/utils/user.js';
import { DEMO_ACCOUNTS } from '../accounts/data.js';
import { getDefaultProfileName, computeProfileKey } from './data.js';
import { M, I, IcoMDI, IcoGoogle, IcoApple, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useNav, Sheet, TabBar, useDark } from '../../app/nav.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useLocalStorage, useSessionStorage, clearAllStorage } from '../../shared/hooks.jsx';
import { useAppCtx, useProfiles, useTxCtx, useConnectedAccounts, Stat } from '../../app/providers.jsx';
import { STOCK_AVATARS, PERM_COLOR, PERM_BG, permLabel, DEFAULT_API_URL, DEMO_API_URL, PROFILE_NAME_RE } from '../../shared/constants.js';
import { buildEffectivePerm } from '../../shared/sharedProfile.js';
import { ProfileMembersSheet, MemberActionSheet } from '../friends/Friends.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;


export function ProfileAvatar({ profile, size = 36 }) {
  const borderRadius = Math.round(size * 0.28);
  const displayPicture = profile?.localPicture || profile?.picture;
  if (displayPicture) {
    if (displayPicture.startsWith('av')) {
      const av = STOCK_AVATARS.find(a => a.id === displayPicture);
      if (av) return (
        <div style={{ width:size, height:size, borderRadius, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:size*0.5, flexShrink:0 }}>
          {av.emoji}
        </div>
      );
    }
    if (displayPicture.startsWith('data:')) {
      return <img src={displayPicture} style={{ width:size, height:size, borderRadius, objectFit:'cover', flexShrink:0 }}/>;
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
  const [loginMethod] = useSessionStorage('munni_last_login_method', '');
  const [email] = useSessionStorage('munni_profile_email', '');
  const _safeEmail = React.useMemo(() => { try { return JSON.parse(email||'""')||''; } catch { return email||''; } }, [email]);
  const _nameKey = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_name');
  const [name, setName] = useLocalStorage(_nameKey, '');
  const _firstNameKey = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_firstname');
  const _lastNameKey  = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_lastname');
  const [firstName, setFirstName] = useLocalStorage(_firstNameKey, '');
  const [lastName,  setLastName]  = useLocalStorage(_lastNameKey,  '');
  // Auto-split existing single-name into first/last on first load
  React.useEffect(() => {
    if (name && !firstName && !lastName) {
      const parts = name.trim().split(' ');
      setFirstName(parts[0] || '');
      setLastName(parts.slice(1).join(' ') || '');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || name;
  const pictureKey = React.useMemo(() => {
    if (loginMethod === 'google') return 'munni_user_picture_google';
    if (loginMethod === 'apple') return 'munni_user_picture_apple';
    if (loginMethod === 'bank') return 'munni_user_picture_bank';
    if (_safeEmail && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(_safeEmail)) return `munni_user_picture_${_safeEmail}`;
    return 'munni_user_picture';
  }, [loginMethod, _safeEmail]);
  const [userPicture, setUserPicture] = useLocalStorage(pictureKey, null);
  const _myId = React.useMemo(() => getUserId(), []);
  React.useEffect(() => { registerUserInGlobalRegistry(_myId, fullName, userPicture); }, [_myId, fullName, userPicture]);
  const { profiles } = useProfiles();
  const activeProfile = profiles.find(p => p.active) || profiles[0];
  const [connectedAccounts] = useConnectedAccounts();
  const [showReset, setShowReset] = React.useState(false);
  const { logout: logoutFn } = useAppCtx();
  const initial = (firstName || name || '?').charAt(0).toUpperCase();

  const isDemo = loginMethod === 'bank';
  const connectedBanks = connectedAccounts.filter(a => a.type === 'checking').length;
  const _lastMethod = loginMethod;
  const [_overrideEmail] = useLocalStorage('munni_email_override', null);
  const _resolvedEmail = _overrideEmail?.to || email;
  const emailDisplay = isDemo ? 'demo@munni.app' : (_resolvedEmail && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(_resolvedEmail)) ? _resolvedEmail : _lastMethod === 'google' ? t('login.signedInGoogle') : _lastMethod === 'apple' ? t('login.signedInApple') : (_resolvedEmail || '');

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.settings')} large/>
      <div className="m-body-scroll">
        {/* Identity card — tappable → ScreenUserInfo */}
        <button data-testid={T.profileSettingsBtn} className="m-tap" onClick={() => nav.push('userInfo')} style={{ display:'flex', alignItems:'center', gap:14, padding:18, marginBottom:16, background:M.paper, borderRadius:16, border:`1px solid ${M.line}`, width:'100%', textAlign:'left', cursor:'pointer' }}>
          <div style={{ position:'relative', flexShrink:0 }}>
            {userPicture ? (
              userPicture.startsWith('av')
                ? (() => { const av = STOCK_AVATARS.find(a => a.id === userPicture); return av ? <div style={{ width:52, height:52, borderRadius:999, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>{av.emoji}</div> : null; })()
                : <img src={userPicture} style={{ width:52, height:52, borderRadius:999, objectFit:'cover' }} alt=""/>
            ) : (
              <div style={{ width:52, height:52, borderRadius:999, background:`linear-gradient(135deg, ${M.sage} 0%, #3D5A42 100%)`, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:20, fontFamily:M.fontDisp }}>{initial}</div>
            )}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
              <div style={{ fontSize:17, fontWeight:600, color:M.ink }}>{fullName}</div>
              {isDemo && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', letterSpacing:'0.05em' }}>Demo</span>}
            </div>
            <div style={{ fontSize:12, color:M.ink3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{emailDisplay}</div>
          </div>
          <I name="arrowR" size={16} color={M.ink4}/>
        </button>

        {/* Manage */}
        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>{t('settings.manage')}</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 16, border: `1px solid ${M.line}` }}>
          <ProfileLink icon="user"    label={t('settings.spaces')}       sub={`${profiles.length} space${profiles.length!==1?'s':''} · ${activeProfile?.name}`} onClick={() => nav.push('spaces')} testId="spaces-nav-link"/>
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
          <ProfileLink icon="download" label={t('settings.exportData')} sub={t('settings.exportDataSub')} onClick={() => nav.push('exportData')}/>
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

        <div style={{ textAlign: 'center', fontSize: 11, color: M.ink4, padding: '12px 0 24px' }}>munni · v1.0.0 · build {__BUILD_NUMBER__}</div>
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

    </div>
  );
}

export function ScreenUserInfo() {
  const nav = useNav();
  const { t, lang } = useLang();
  const [loginMethod] = useSessionStorage('munni_last_login_method', '');
  const [email] = useSessionStorage('munni_profile_email', '');
  const _safeEmail = React.useMemo(() => { try { return JSON.parse(email||'""')||''; } catch { return email||''; } }, [email]);
  const _nameKey      = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_name');
  const _firstNameKey = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_firstname');
  const _lastNameKey  = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_lastname');
  const _countryKey   = computeUserDataKey(loginMethod, _safeEmail, 'munni_profile_country');
  const [name,      setName]      = useLocalStorage(_nameKey,      '');
  const [firstName, setFirstName] = useLocalStorage(_firstNameKey, '');
  const [lastName,  setLastName]  = useLocalStorage(_lastNameKey,  '');
  const [country,   setCountry]   = useLocalStorage(_countryKey,   '');
  const pictureKey = React.useMemo(() => {
    if (loginMethod === 'google') return 'munni_user_picture_google';
    if (loginMethod === 'apple')  return 'munni_user_picture_apple';
    if (loginMethod === 'bank')   return 'munni_user_picture_bank';
    if (_safeEmail && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(_safeEmail)) return `munni_user_picture_${_safeEmail}`;
    return 'munni_user_picture';
  }, [loginMethod, _safeEmail]);
  const [userPicture, setUserPicture] = useLocalStorage(pictureKey, null);
  const _myId = React.useMemo(() => getUserId(), []);

  const isDemo   = loginMethod === 'bank';
  const isGoogle = loginMethod === 'google';
  const isApple  = loginMethod === 'apple';
  const isOffline = loginMethod === 'offline';

  const { dark } = useDark();
  const flagStyle = dark
    ? { borderRadius:3, flexShrink:0, filter:'invert(1) hue-rotate(180deg)', display:'block' }
    : { borderRadius:3, flexShrink:0, display:'block' };
  const countryFlagUrl = (code) => {
    const [a, b] = code.toUpperCase().split('');
    const r = c => (0x1F1E6 + c.charCodeAt(0) - 65).toString(16);
    return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${r(a)}-${r(b)}.svg`;
  };

  const [draftFirst,   setDraftFirst]   = React.useState(firstName);
  const [draftLast,    setDraftLast]    = React.useState(lastName);
  const [draftCountry, setDraftCountry] = React.useState(country);
  const [showCountry,    setShowCountry]    = React.useState(false);
  const [countrySearch,  setCountrySearch]  = React.useState('');
  const [showCountryInfo,setShowCountryInfo]= React.useState(false);
  const [countryError,   setCountryError]   = React.useState('');
  React.useEffect(() => { setDraftFirst(firstName);   }, [firstName]);
  React.useEffect(() => { setDraftLast(lastName);     }, [lastName]);
  React.useEffect(() => { setDraftCountry(country);   }, [country]);

  // Offline-only state
  const [draftName, setDraftName] = React.useState(name);
  React.useEffect(() => { setDraftName(name); }, [name]);

  const offlineEncKeyKey     = computeUserDataKey(loginMethod, _safeEmail, 'munni_offline_enc_key');
  const offlineAutoBackupKey = computeUserDataKey(loginMethod, _safeEmail, 'munni_auto_backup');
  const offlineLastBackupKey = computeUserDataKey(loginMethod, _safeEmail, 'munni_last_backup_at');
  const [encKey, setEncKey] = useLocalStorage(offlineEncKeyKey, null);
  const [autoBackupSettings, setAutoBackupSettings] = useLocalStorage(offlineAutoBackupKey, null);
  const [lastBackupAt, setLastBackupAt] = useLocalStorage(offlineLastBackupKey, null);

  const [showKeyValue,    setShowKeyValue]    = React.useState(false);
  const [showKeyInfo,     setShowKeyInfo]     = React.useState(false);
  const [showRegenKey,    setShowRegenKey]    = React.useState(false);
  const [showBackup,      setShowBackup]      = React.useState(false);
  const [showRecover,     setShowRecover]     = React.useState(false);
  const [recoverStep,     setRecoverStep]     = React.useState('file');
  const [recoverFile,     setRecoverFile]     = React.useState(null);
  const [recoverKeyDraft, setRecoverKeyDraft] = React.useState('');
  const [recoverError,    setRecoverError]    = React.useState('');
  const [showAutoBackup,  setShowAutoBackup]  = React.useState(false);
  const [draftAutoFreq,   setDraftAutoFreq]   = React.useState(() => autoBackupSettings?.frequency || 'none');
  const [draftAutoLoc,    setDraftAutoLoc]    = React.useState(() => autoBackupSettings?.location  || 'device');

  const generateEncKey = React.useCallback(() => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex.match(/.{4}/g).join('-');
  }, []);

  React.useEffect(() => {
    if (!isOffline || encKey) return;
    setEncKey(generateEncKey());
  }, [isOffline, encKey, generateEncKey, setEncKey]);

  React.useEffect(() => {
    if (!isOffline || !userPicture) return;
    try {
      const profiles = JSON.parse(localStorage.getItem('munni_offline_profiles') || '[]');
      const updated = profiles.map(p => p.id === _safeEmail ? { ...p, picture: userPicture } : p);
      localStorage.setItem('munni_offline_profiles', JSON.stringify(updated));
    } catch {}
  }, [isOffline, userPicture, _safeEmail]);

  const [showPicturePicker, setShowPicturePicker] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Scroll lock: save and restore scroll position when sheets open to prevent jump
  const bodyScrollRef = React.useRef(null);
  const savedScrollRef = React.useRef(0);

  // API endpoint (moved from ScreenProfile)
  const [apiUrl, setApiUrl] = useLocalStorage('munni_api_url', '');
  const [showApiSheet, setShowApiSheet] = React.useState(false);
  const [apiDraft, setApiDraft] = React.useState('');

  // Delete account (moved from ScreenProfile)
  const [showDeleteAccount, setShowDeleteAccount] = React.useState(false);
  const [deleteAccountStep, setDeleteAccountStep] = React.useState('feedback'); // 'feedback' | 'confirm'
  const [deleteReasons, setDeleteReasons] = React.useState([]);
  const [deleteFeedbackText, setDeleteFeedbackText] = React.useState('');

  // Email change (for email-login users)
  const [showChangeEmail, setShowChangeEmail] = React.useState(false);
  const [changeEmailStep, setChangeEmailStep] = React.useState('input'); // 'input' | 'verify' | 'done'
  const [newEmailDraft, setNewEmailDraft] = React.useState('');
  const [changeEmailError, setChangeEmailError] = React.useState('');
  const [verifyCodeInput, setVerifyCodeInput] = React.useState('');
  const [overrideEmail, setOverrideEmail] = useLocalStorage('munni_email_override', null);

  const emailDisplay = React.useMemo(() => {
    if (isDemo) return 'demo@munni.app';
    if (isGoogle) { try { return JSON.parse(localStorage.getItem('munni_display_email_google')||'""') || _safeEmail || ''; } catch { return _safeEmail || ''; } }
    if (isApple)  { try { return JSON.parse(localStorage.getItem('munni_display_email_apple') ||'""') || _safeEmail || ''; } catch { return _safeEmail || ''; } }
    return (_safeEmail && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(_safeEmail)) ? _safeEmail : '';
  }, [isDemo, isGoogle, isApple, _safeEmail]);

  const fullName = [firstName, lastName].filter(Boolean).join(' ') || name;
  const initial  = (firstName || name || '?')[0].toUpperCase();

  const anySheetOpen = showApiSheet || showDeleteAccount || showChangeEmail || showPicturePicker || showCountry || showCountryInfo || showKeyInfo || showRegenKey || showBackup || showRecover || showAutoBackup;
  React.useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    if (anySheetOpen) {
      savedScrollRef.current = el.scrollTop;
      el.style.overflowY = 'hidden';
      el.scrollTop = savedScrollRef.current;
      el.style.pointerEvents = 'none';
      el.style.userSelect = 'none';
    } else {
      el.style.overflowY = '';
      el.style.pointerEvents = '';
      el.style.userSelect = '';
      requestAnimationFrame(() => { el.scrollTop = savedScrollRef.current; });
    }
  }, [anySheetOpen]);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setUserPicture(ev.target.result); setShowPicturePicker(false); };
    reader.readAsDataURL(file);
  };

  const highlightMatch = (text, query) => {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>{text.slice(0, idx)}<span style={{ background:M.sageSoft, color:M.sage, borderRadius:3, padding:'0 2px', fontWeight:700 }}>{text.slice(idx, idx + query.length)}</span>{text.slice(idx + query.length)}</>
    );
  };

  const save = () => {
    if (!draftCountry) { setCountryError(t('onboarding.errCountryRequired')); return; }
    const fn = draftFirst.trim();
    const ln = draftLast.trim();
    setFirstName(fn); setLastName(ln);
    setCountry(draftCountry);
    setName([fn, ln].filter(Boolean).join(' '));
    nav.pop();
  };

  const saveOffline = () => {
    const n = draftName.trim();
    if (!n) return;
    setName(n);
    try {
      const profiles = JSON.parse(localStorage.getItem('munni_offline_profiles') || '[]');
      const updated = profiles.map(p => p.id === _safeEmail ? { ...p, name: n } : p);
      localStorage.setItem('munni_offline_profiles', JSON.stringify(updated));
    } catch {}
    nav.pop();
  };

  const doBackup = async () => {
    const profileName = (name || 'offline-user').replace(/\s+/g, '-').toLowerCase();
    const payload = JSON.stringify({ version: 1, app: 'munni', createdAt: new Date().toISOString(), profile: name || 'offline-user', encrypted: true, data: btoa('hello world') }, null, 2);
    const blob = new Blob([payload], { type: 'application/octet-stream' });
    const fileName = `munni-backup-${profileName}-${Date.now()}.mun`;
    try {
      if (window.showSaveFilePicker) {
        const fh = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'munni backup', accept: { 'application/octet-stream': ['.mun'] } }] });
        const ws = await fh.createWritable(); await ws.write(blob); await ws.close();
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = fileName; a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch {}
    setLastBackupAt(Date.now());
    setShowBackup(false);
  };

  const doRecover = () => {
    if (!recoverKeyDraft.trim()) { setRecoverError(t('profile.recoverErrKey')); return; }
    setRecoverStep('loading');
    setTimeout(() => setRecoverStep('done'), 2200);
  };

  const renderAvatar = (size) => {
    if (userPicture?.startsWith('av')) {
      const av = STOCK_AVATARS.find(a => a.id === userPicture);
      if (av) return <div style={{ width:size, height:size, borderRadius:999, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:size*0.45 }}>{av.emoji}</div>;
    }
    if (userPicture?.startsWith('data:')) return <img src={userPicture} style={{ width:size, height:size, borderRadius:999, objectFit:'cover' }} alt=""/>;
    return <div style={{ width:size, height:size, borderRadius:999, background:`linear-gradient(135deg, ${M.sage} 0%, #3D5A42 100%)`, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:size*0.38, fontFamily:M.fontDisp }}>{initial}</div>;
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('settings.myProfile')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={(!isDemo)
          ? <button className="m-tap" onClick={isOffline ? saveOffline : save} style={{ background:'transparent', border:'none', fontSize:15, fontWeight:700, color:M.sage, cursor:'pointer', fontFamily:M.fontUI }}>{t('action.save')}</button>
          : null}
      />
      <div className="m-body-scroll" ref={bodyScrollRef}>

        {/* Avatar section */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingTop:28, paddingBottom:28 }}>
          <button className="m-tap" onClick={() => !isDemo && setShowPicturePicker(true)}
            style={{ position:'relative', background:'none', border:'none', cursor:isDemo?'default':'pointer', padding:0, marginBottom:12 }}>
            {renderAvatar(88)}
            {!isDemo && (
              <div style={{ position:'absolute', bottom:2, right:2, width:26, height:26, borderRadius:'50%', background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', border:'3px solid #fff' }}>
                <I name="cam" size={13} color="#fff"/>
              </div>
            )}
          </button>
          {!isDemo && (
            <button className="m-tap" onClick={() => setShowPicturePicker(true)}
              style={{ background:'none', border:'none', color:M.sage, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('profile.changePhoto')}
            </button>
          )}
        </div>

        {/* Name section — offline: single username; online: first + last */}
        {isOffline ? (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('settings.nameSection')}</div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <div style={{ width:70, fontSize:12, color:M.ink3, flexShrink:0 }}>{t('profile.usernameLabel')}</div>
                <input data-testid="offline-profile-username" value={draftName} onChange={e => setDraftName(e.target.value)}
                  style={{ flex:1, fontSize:16, fontFamily:M.fontUI, border:'none', background:'transparent', outline:'none', color:M.ink }}/>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('settings.nameSection')}</div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <div style={{ width:70, fontSize:12, color:M.ink3, flexShrink:0 }}>{t('settings.firstName')}</div>
                <input value={draftFirst} onChange={e => setDraftFirst(e.target.value)} disabled={isDemo}
                  style={{ flex:1, fontSize:16, fontFamily:M.fontUI, border:'none', background:'transparent', outline:'none', color:isDemo?M.ink3:M.ink }}/>
              </div>
              <Divider/>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <div style={{ width:70, fontSize:12, color:M.ink3, flexShrink:0 }}>{t('settings.lastName')}</div>
                <input value={draftLast} onChange={e => setDraftLast(e.target.value)} disabled={isDemo}
                  style={{ flex:1, fontSize:16, fontFamily:M.fontUI, border:'none', background:'transparent', outline:'none', color:isDemo?M.ink3:M.ink }}/>
              </div>
            </div>
          </>
        )}

        {isOffline ? (
          /* ── Offline-only sections: key + data ── */
          <>
            {/* Encryption key */}
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8, paddingLeft:4 }}>
              <div className="m-cap" style={{ margin:0 }}>{t('profile.offlineKeySection')}</div>
              <button data-testid={T.offlineProfileKeyInfoBtn} className="m-tap" onClick={() => setShowKeyInfo(true)}
                style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', padding:'0 2px' }}>
                <I name="info" size={14} color={M.tint}/>
              </button>
            </div>
            <div data-testid={T.offlineProfileKeySection} className="m-card" style={{ padding:'0 16px', marginBottom:20, border:`1px solid ${M.line}` }}>
              <div style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'12px 0 10px' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
                  <I name="key" size={15} color={M.ink2}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:11, color:M.ink3, marginBottom:6 }}>{t('profile.offlineKeySection')}</div>
                  {encKey ? (
                    <div style={{ fontFamily:M.fontMono, fontSize:13, lineHeight:1.8, letterSpacing:'0.06em', background:M.paper2, border:`1px solid ${M.line}`, borderRadius:8, padding:'8px 10px', color: showKeyValue ? M.ink : M.ink3 }}>
                      {(() => {
                        const blocks = encKey.split('-');
                        if (!showKeyValue) return <><div>•••• •••• •••• ••••</div><div>•••• •••• •••• ••••</div></>;
                        return <><div>{blocks.slice(0,4).join(' ')}</div><div>{blocks.slice(4,8).join(' ')}</div></>;
                      })()}
                    </div>
                  ) : <span style={{ fontSize:13, color:M.ink4 }}>—</span>}
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:2, flexShrink:0, paddingTop:2 }}>
                  <button data-testid={T.offlineProfileKeyToggle} className="m-tap" onClick={() => setShowKeyValue(v => !v)}
                    style={{ background:'none', border:'none', cursor:'pointer', padding:'4px', borderRadius:6 }}>
                    <I name={showKeyValue ? 'eyeOff' : 'eye'} size={18} color={M.ink3}/>
                  </button>
                  {encKey && (
                    <button className="m-tap" onClick={() => { navigator.clipboard?.writeText(encKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      style={{ background:copied?M.sageSoft:'none', border:'none', cursor:'pointer', padding:'4px', borderRadius:6 }}>
                      <I name={copied ? 'check' : 'copy'} size={18} color={copied ? M.sage : M.ink3}/>
                    </button>
                  )}
                </div>
              </div>
              <Divider/>
              <div data-testid={T.offlineProfileKeyRegen} className="m-tap" onClick={() => setShowRegenKey(true)}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'13px 0', cursor:'pointer' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="refresh" size={15} color={M.ink2}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{t('profile.offlineKeyRegen')}</div>
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>

            {/* Data section: Backup / Recover / Auto-backup */}
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('profile.offlineDataSection')}</div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:24, border:`1px solid ${M.line}` }}>
              <div data-testid={T.offlineProfileBackupBtn} className="m-tap" onClick={() => setShowBackup(true)}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', cursor:'pointer' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="download" size={16} color={M.sage}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{t('profile.offlineBackupBtn')}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('profile.offlineBackupSub')}</div>
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
              <Divider/>
              <div data-testid={T.offlineProfileRecoverBtn} className="m-tap" onClick={() => { setRecoverStep('file'); setRecoverFile(null); setRecoverKeyDraft(''); setRecoverError(''); setShowRecover(true); }}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', cursor:'pointer' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="upload" size={16} color={M.ink2}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{t('profile.offlineRecoverBtn')}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('profile.offlineRecoverSub')}</div>
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
              <Divider/>
              <div data-testid={T.offlineProfileAutoBackupBtn} className="m-tap" onClick={() => { setDraftAutoFreq(autoBackupSettings?.frequency || 'none'); setDraftAutoLoc(autoBackupSettings?.location || 'device'); setShowAutoBackup(true); }}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', cursor:'pointer' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="clock" size={16} color={M.ink2}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{t('profile.offlineAutoBackupBtn')}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>
                    {(() => {
                      const freq = autoBackupSettings?.frequency;
                      const loc = autoBackupSettings?.location;
                      const freqLabel = freq ? t(`profile.autoBackup${freq.charAt(0).toUpperCase()+freq.slice(1)}`) : t('profile.autoBackupNone');
                      const locPart = (freq && freq !== 'none' && loc) ? ` · ${t(`profile.autoBackup${loc === 'device' ? 'Device' : loc === 'gdrive' ? 'GDrive' : loc === 'onedrive' ? 'OneDrive' : 'Dropbox'}`)}` : '';
                      const baseLine = autoBackupSettings ? `${freqLabel}${locPart}` : t('profile.offlineAutoBackupSub');
                      if (lastBackupAt) {
                        const d = new Date(lastBackupAt);
                        const dateStr = d.toLocaleString(lang === 'nl' ? 'nl-NL' : lang === 'tr' ? 'tr-TR' : 'en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
                        return `${baseLine} · ${t('profile.autoBackupLastAt').replace('{date}', dateStr)}`;
                      }
                      return baseLine;
                    })()}
                  </div>
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>

            {/* Delete account (reuse existing) */}
            <div className="m-card" style={{ padding:'0 16px', marginBottom:24, border:`1px solid ${M.line}` }}>
              <div className="m-tap" onClick={() => setShowDeleteAccount(true)}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:M.claySoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="trash" size={16} color={M.clay}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:500, color:M.clay }}>{t('settings.deleteAccount')}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('settings.deleteAccountSub')}</div>
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>
          </>
        ) : (
          /* ── Online / demo sections ── */
          <>
            {/* Country */}
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8, paddingLeft:4 }}>
              <div className="m-cap" style={{ margin:0 }}>{t('profile.country')}</div>
              <button className="m-tap" onClick={() => setShowCountryInfo(true)}
                style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', padding:'0 2px' }}>
                <I name="info" size={14} color={M.tint}/>
              </button>
            </div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:countryError ? 6 : 20, border:`1px solid ${countryError ? M.clay : M.line}` }}>
              <div
                data-testid={T.profileCountryBtn}
                className={isDemo ? '' : 'm-tap'}
                onClick={isDemo ? undefined : () => { setCountrySearch(''); setShowCountry(true); }}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', cursor: isDemo ? 'default' : 'pointer' }}
              >
                <div style={{ width:32, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  {draftCountry ? <img src={countryFlagUrl(draftCountry)} width={24} height={24} style={flagStyle} alt={draftCountry}/> : <I name="globe" size={16} color={M.ink3}/>}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  {draftCountry ? (
                    <div style={{ fontSize:15, color:M.ink }}>{countryName(COUNTRIES.find(c => c.code === draftCountry), lang)}</div>
                  ) : (
                    <div style={{ fontSize:15, color:M.ink4 }}>{t('profile.countryPlaceholder')}</div>
                  )}
                </div>
                {!isDemo && <I name="caretR" size={14} color={M.ink4}/>}
              </div>
            </div>
            {countryError && <div data-testid={T.profileCountryErr} style={{ fontSize:11, color:M.clay, marginBottom:16, paddingLeft:4 }}>{countryError}</div>}

            {/* Account info */}
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('settings.account')}</div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:8, border:`1px solid ${M.line}` }}>
              {(() => {
                const canChangeEmail = !isGoogle && !isApple && !isDemo;
                return (
                  <div className={canChangeEmail ? 'm-tap' : ''}
                    onClick={canChangeEmail ? () => { setNewEmailDraft(''); setChangeEmailStep('input'); setChangeEmailError(''); setVerifyCodeInput(''); setShowChangeEmail(true); } : undefined}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                    <div style={{ width:20, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      {isGoogle ? <IcoGoogle size={16}/> : isApple ? <IcoApple size={16} color={M.ink}/> : <I name="user" size={16} color={M.ink3}/>}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:11, color:M.ink3, marginBottom:2 }}>{t('login.email')}</div>
                      <div style={{ fontSize:14, color:M.ink, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{overrideEmail?.to || emailDisplay || '—'}</div>
                    </div>
                    {canChangeEmail ? <I name="caretR" size={14} color={M.ink4}/> : <I name="lock" size={13} color={M.ink4}/>}
                  </div>
                );
              })()}
              <Divider/>
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                <div style={{ width:20, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="user" size={16} color={M.ink3}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:11, color:M.ink3, marginBottom:2 }}>{t('settings.userId')}</div>
                  <div style={{ fontSize:13, color:M.ink2, fontFamily:M.fontMono, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{_myId}</div>
                </div>
                <button className="m-tap" onClick={() => { navigator.clipboard?.writeText(_myId); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                  style={{ background:copied?M.sageSoft:M.paper2, border:`1px solid ${copied?M.sage:M.line}`, borderRadius:8, padding:'4px 10px', fontSize:11, fontWeight:600, color:copied?M.sage:M.ink3, cursor:'pointer', fontFamily:M.fontUI, flexShrink:0 }}>
                  {copied ? t('settings.copied') : t('settings.copyId')}
                </button>
              </div>
            </div>

            <div style={{ textAlign:'center', fontSize:11, color:M.ink4, paddingBottom:20 }}>
              {isGoogle ? t('login.signedInGoogle') : isApple ? t('login.signedInApple') : isDemo ? 'Demo account' : t('login.connectedEmail')}
            </div>

            {/* API endpoint */}
            {!isDemo && (
              <>
                <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('settings.apiUrl')}</div>
                <div className="m-card" style={{ padding:'0 16px', marginBottom:24, border:`1px solid ${M.line}` }}>
                  <div className="m-tap" onClick={() => { setApiDraft(apiUrl); setShowApiSheet(true); }}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                    <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name="server" size={16} color={M.ink2}/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:500, color:M.ink }}>{t('settings.apiUrl')}</div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{apiUrl || t('settings.apiUrlDefault')}</div>
                    </div>
                    <I name="caretR" size={14} color={M.ink4}/>
                  </div>
                </div>
              </>
            )}

            {/* Delete account */}
            {!isDemo && (
              <div className="m-card" style={{ padding:'0 16px', marginBottom:24, border:`1px solid ${M.line}` }}>
                <div className="m-tap" onClick={() => setShowDeleteAccount(true)}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
              <div style={{ width:32, height:32, borderRadius:9, background:M.claySoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="trash" size={16} color={M.clay}/>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:500, color:M.clay }}>{t('settings.deleteAccount')}</div>
                <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('settings.deleteAccountSub')}</div>
              </div>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
          </div>
        )}
          </>
        )}
      </div>

      {/* Country picker */}
      {showCountry && (
        <Sheet onClose={() => setShowCountry(false)}>
          <div style={{ padding:'0 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:12 }}>{t('profile.country')}</div>
            <input
              data-testid={T.profileCountrySearch}
              value={countrySearch}
              onChange={e => setCountrySearch(e.target.value)}
              placeholder="Search…"
              style={{ width:'100%', boxSizing:'border-box', padding:'9px 14px', borderRadius:10, border:`1.5px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink, marginBottom:4 }}
            />
          </div>
          <div data-testid={T.profileCountrySheet} style={{ overflowY:'auto', maxHeight:340, paddingBottom:16 }}>
            {COUNTRIES.filter(c => !countrySearch || countryName(c, lang).toLowerCase().includes(countrySearch.toLowerCase()) || c.native.toLowerCase().includes(countrySearch.toLowerCase())).map(c => (
              <div key={c.code} className="m-tap"
                onClick={() => { setDraftCountry(c.code); setShowCountry(false); setCountryError(''); }}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 20px', cursor:'pointer' }}>
                <img src={countryFlagUrl(c.code)} width={24} height={24} style={{ ...flagStyle, flexShrink:0 }} alt={c.code}/>
                <span style={{ flex:1, fontSize:15, color:M.ink }}>{highlightMatch(countryName(c, lang), countrySearch.trim())}</span>
                {draftCountry === c.code && <I name="check" size={16} color={M.sage}/>}
              </div>
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

      {/* Picture picker */}
      {showPicturePicker && (
        <Sheet onClose={() => setShowPicturePicker(false)}>
          <div style={{ padding:'0 16px 16px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('profile.picTitle')}</div>
            <label style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0', cursor:'pointer', borderBottom:`1px solid ${M.line2}`, marginBottom:14 }}>
              <div style={{ width:40, height:40, borderRadius:10, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="cam" size={18} color={M.ink2}/>
              </div>
              <div style={{ fontSize:15, fontWeight:500 }}>{t('profile.chooseLibrary')}</div>
              <input type="file" accept="image/*" onChange={handleFileChange} style={{ display:'none' }}/>
            </label>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10, marginBottom:16 }}>
              {STOCK_AVATARS.map(av => (
                <button key={av.id} className="m-tap" onClick={() => { setUserPicture(av.id); setShowPicturePicker(false); }}
                  style={{ width:'100%', aspectRatio:'1', borderRadius:14, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:26, border:`2px solid ${userPicture === av.id ? M.sage : 'transparent'}`, cursor:'pointer' }}>
                  {av.emoji}
                </button>
              ))}
            </div>
            {userPicture && (
              <button className="m-tap" onClick={() => { setUserPicture(null); setShowPicturePicker(false); }}
                style={{ width:'100%', padding:'12px 0', background:M.paper2, color:M.clay, border:`1px solid ${M.line}`, borderRadius:12, fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                {t('profile.removePic')}
              </button>
            )}
          </div>
        </Sheet>
      )}

      {/* Change email sheet */}
      {showChangeEmail && (
        <Sheet onClose={() => setShowChangeEmail(false)}>
          <div style={{ padding:'0 16px 24px' }}>
            {changeEmailStep === 'input' && (<>
              <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{t('settings.changeEmail')}</div>
              <div style={{ fontSize:13, color:M.ink3, marginBottom:20 }}>{t('settings.changeEmailStep1Sub')}</div>
              <input className="m-input" value={newEmailDraft} onChange={e => { setNewEmailDraft(e.target.value); setChangeEmailError(''); }}
                placeholder={t('login.email')} type="email" autoFocus
                style={{ width:'100%', marginBottom:8, boxSizing:'border-box', height:48 }}/>
              {changeEmailError && <div style={{ fontSize:12, color:M.clay, marginBottom:8 }}>{changeEmailError}</div>}
              <button className="m-btn sage m-tap" onClick={() => {
                if (!EMAIL_RE.test(newEmailDraft.trim().toLowerCase())) { setChangeEmailError(t('login.errInvalidEmail')); return; }
                setChangeEmailStep('verify');
              }} style={{ width:'100%', marginTop:8 }}>{t('login.continue')}</button>
            </>)}
            {changeEmailStep === 'verify' && (<>
              <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{t('settings.changeEmailVerify')}</div>
              <div style={{ fontSize:13, color:M.ink3, marginBottom:4 }}>{t('settings.changeEmailVerifySub').replace('{email}', newEmailDraft)}</div>
              <div style={{ fontSize:12, color:M.sage, marginBottom:20, fontWeight:600 }}>Demo code: 123456</div>
              <input className="m-input" value={verifyCodeInput} onChange={e => { setVerifyCodeInput(e.target.value); setChangeEmailError(''); }}
                placeholder="000000" type="text" inputMode="numeric" maxLength={6} autoFocus
                style={{ width:'100%', marginBottom:8, letterSpacing:4, textAlign:'center', fontSize:20, fontWeight:700, boxSizing:'border-box', height:48 }}/>
              {changeEmailError && <div style={{ fontSize:12, color:M.clay, marginBottom:8 }}>{changeEmailError}</div>}
              <button className="m-btn sage m-tap" onClick={() => {
                if (verifyCodeInput !== '123456') { setChangeEmailError(t('login.errInvalidCode')); return; }
                const oldEmail = emailDisplay || _safeEmail;
                setOverrideEmail({ from: oldEmail, to: newEmailDraft });
                setChangeEmailStep('done');
              }} style={{ width:'100%', marginTop:8 }}>{t('action.confirm')}</button>
            </>)}
            {changeEmailStep === 'done' && (<>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'24px 0 8px', gap:12 }}>
                <div style={{ width:56, height:56, borderRadius:'50%', background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <I name="check" size={28} color={M.sage}/>
                </div>
                <div style={{ fontSize:17, fontWeight:700, textAlign:'center' }}>{t('settings.changeEmailSaved')}</div>
                <div style={{ fontSize:13, color:M.ink3, textAlign:'center' }}>{newEmailDraft}</div>
              </div>
              <button className="m-btn sage m-tap" onClick={() => setShowChangeEmail(false)}
                style={{ width:'100%', marginTop:16 }}>{t('action.done')}</button>
            </>)}
          </div>
        </Sheet>
      )}

      {/* API endpoint sheet */}
      {showApiSheet && (
        <Sheet onClose={() => setShowApiSheet(false)}>
          <div style={{ padding:'0 16px 24px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{t('settings.apiUrl')}</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>{t('settings.apiUrlSub')}</div>
            <input className="m-input" value={apiDraft} onChange={e => setApiDraft(e.target.value)}
              placeholder={t('settings.apiUrlDefault')} type="url"
              style={{ width:'100%', marginBottom:16, boxSizing:'border-box', height:48 }}/>
            <div style={{ display:'flex', gap:10 }}>
              <button className="m-btn outline m-tap" onClick={() => { const url = loginMethod === 'bank' ? DEMO_API_URL : DEFAULT_API_URL; setApiUrl(url); setApiDraft(url); setShowApiSheet(false); }}
                style={{ flex:1 }}>{t('action.reset')}</button>
              <button className="m-btn sage m-tap" onClick={() => { setApiUrl(apiDraft.trim()); setShowApiSheet(false); }}
                style={{ flex:2 }}>{t('action.save')}</button>
            </div>
          </div>
        </Sheet>
      )}

      {/* Delete account sheet */}
      {showDeleteAccount && (
        <Sheet onClose={() => { setShowDeleteAccount(false); setDeleteAccountStep('feedback'); setDeleteReasons([]); setDeleteFeedbackText(''); }}>
          <div style={{ padding:'0 16px 24px' }}>
            {deleteAccountStep === 'feedback' ? (<>
              <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{t('settings.deleteAccountFeedbackTitle')}</div>
              <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>{t('settings.deleteAccountFeedbackSub')}</div>
              {[
                'settings.deleteReasonPrivacy',
                'settings.deleteReasonSwitching',
                'settings.deleteReasonNotUseful',
                'settings.deleteReasonMissingFeature',
                'settings.deleteReasonOther',
              ].map(key => (
                <div key={key} className="m-tap" onClick={() => setDeleteReasons(prev => prev.includes(key) ? prev.filter(r => r !== key) : [...prev, key])}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'11px 0', borderBottom:`1px solid ${M.line2}` }}>
                  <div style={{ width:20, height:20, borderRadius:6, border:`2px solid ${deleteReasons.includes(key) ? M.sage : M.line}`, background:deleteReasons.includes(key) ? M.sage : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 0.12s' }}>
                    {deleteReasons.includes(key) && <I name="check" size={10} color="#fff" stroke={3}/>}
                  </div>
                  <div style={{ fontSize:14, color:M.ink }}>{t(key)}</div>
                </div>
              ))}
              <textarea value={deleteFeedbackText} onChange={e => setDeleteFeedbackText(e.target.value)}
                placeholder={t('settings.deleteAccountFeedbackPlaceholder')}
                rows={3} style={{ width:'100%', boxSizing:'border-box', marginTop:12, padding:'10px 12px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:13, fontFamily:M.fontUI, background:M.paper2, color:M.ink, outline:'none', resize:'none', lineHeight:1.5 }}/>
              <button className="m-btn m-tap" onClick={() => setDeleteAccountStep('confirm')}
                style={{ width:'100%', marginTop:16, background:M.clay, color:'#fff' }}>{t('settings.deleteAccountFeedbackContinue')}</button>
              <button className="m-btn outline m-tap" onClick={() => { setShowDeleteAccount(false); setDeleteAccountStep('feedback'); }}
                style={{ width:'100%', marginTop:10 }}>{t('action.cancel')}</button>
            </>) : (<>
              <div style={{ width:48, height:48, borderRadius:'50%', background:M.claySoft, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 16px' }}>
                <I name="trash" size={22} color={M.clay}/>
              </div>
              <div style={{ fontSize:17, fontWeight:700, textAlign:'center', marginBottom:8 }}>{t('settings.deleteAccount')}</div>
              <div style={{ fontSize:13, color:M.ink3, textAlign:'center', marginBottom:24 }}>{t('settings.deleteAccountBody')}</div>
              <button className="m-tap" onClick={() => {
                if (isOffline && _safeEmail) {
                  const profiles = JSON.parse(localStorage.getItem('munni_offline_profiles') || '[]');
                  const updated = profiles.filter(p => p.id !== _safeEmail);
                  if (updated.length > 0) {
                    localStorage.setItem('munni_offline_profiles', JSON.stringify(updated));
                  } else {
                    localStorage.removeItem('munni_offline_profiles');
                  }
                  Object.keys(localStorage).filter(k => k.startsWith('munni_') && k.includes(_safeEmail)).forEach(k => localStorage.removeItem(k));
                } else {
                  Object.keys(localStorage).filter(k => k.startsWith('munni_')).forEach(k => localStorage.removeItem(k));
                }
                Object.keys(sessionStorage).filter(k => k.startsWith('munni_')).forEach(k => sessionStorage.removeItem(k));
                window.location.reload();
              }} style={{ width:'100%', padding:'14px 0', background:M.clay, border:'none', borderRadius:13, fontSize:15, fontWeight:700, color:'#fff', cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
                {t('settings.deleteAccountConfirm')}
              </button>
              <button className="m-btn outline m-tap" onClick={() => setDeleteAccountStep('feedback')}
                style={{ width:'100%' }}>{t('action.back')}</button>
            </>)}
          </div>
        </Sheet>
      )}

      {/* Key info sheet */}
      {isOffline && showKeyInfo && (
        <Sheet onClose={() => setShowKeyInfo(false)}>
          <div data-testid={T.offlineProfileKeyInfoSheet} style={{ padding:'0 16px 24px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
              <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="key" size={18} color={M.sage}/>
              </div>
              <div style={{ fontSize:17, fontWeight:700, color:M.ink }}>{t('profile.offlineKeyInfoTitle')}</div>
            </div>
            <div style={{ fontSize:14, color:M.ink2, lineHeight:1.65 }}>{t('profile.offlineKeyInfoBody')}</div>
          </div>
        </Sheet>
      )}

      {/* Regenerate key warning sheet */}
      {isOffline && showRegenKey && (
        <Sheet onClose={() => setShowRegenKey(false)}>
          <div data-testid={T.offlineProfileRegenSheet} style={{ padding:'0 16px 24px' }}>
            <div style={{ width:48, height:48, borderRadius:'50%', background:'#FFF3CD', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px' }}>
              <I name="alert" size={22} color="#B8860B"/>
            </div>
            <div style={{ fontSize:17, fontWeight:700, textAlign:'center', marginBottom:10, color:M.ink }}>{t('profile.offlineRegenTitle')}</div>
            <div style={{ fontSize:14, color:M.ink2, lineHeight:1.6, marginBottom:24 }}>{t('profile.offlineRegenWarning')}</div>
            <button data-testid={T.offlineProfileRegenConfirm} className="m-btn m-tap" onClick={() => { setEncKey(generateEncKey()); setShowKeyValue(false); setShowRegenKey(false); }}
              style={{ width:'100%', marginBottom:10, background:M.clay, color:'#fff' }}>{t('profile.offlineRegenConfirm')}</button>
            <button className="m-btn outline m-tap" onClick={() => setShowRegenKey(false)} style={{ width:'100%' }}>{t('action.cancel')}</button>
          </div>
        </Sheet>
      )}

      {/* Backup sheet */}
      {isOffline && showBackup && (
        <Sheet onClose={() => setShowBackup(false)}>
          <div data-testid={T.offlineProfileBackupSheet} style={{ padding:'0 16px 24px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
              <div style={{ width:38, height:38, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="download" size={18} color={M.sage}/>
              </div>
              <div style={{ fontSize:17, fontWeight:700, color:M.ink }}>{t('profile.backupTitle')}</div>
            </div>
            <div style={{ fontSize:14, color:M.ink2, lineHeight:1.6, marginBottom:16 }}>{t('profile.backupKeyNote')}</div>
            <div style={{ background:M.paper2, borderRadius:10, padding:'10px 14px', marginBottom:20, border:`1px solid ${M.line}` }}>
              <div style={{ fontSize:11, color:M.ink3, marginBottom:4 }}>{t('profile.offlineKeySection')}</div>
              <div style={{ fontSize:13, fontFamily:M.fontMono, color:M.ink2, letterSpacing:'0.04em' }}>{encKey || '—'}</div>
            </div>
            <button data-testid={T.offlineProfileBackupConfirm} className="m-btn sage m-tap" onClick={doBackup} style={{ width:'100%', marginBottom:10 }}>{t('profile.backupConfirm')}</button>
            <button className="m-btn outline m-tap" onClick={() => setShowBackup(false)} style={{ width:'100%' }}>{t('action.cancel')}</button>
          </div>
        </Sheet>
      )}

      {/* Recover sheet */}
      {isOffline && showRecover && (
        <Sheet onClose={() => { setShowRecover(false); setRecoverStep('file'); setRecoverFile(null); setRecoverKeyDraft(''); setRecoverError(''); }}>
          <div data-testid={T.offlineProfileRecoverSheet} style={{ padding:'0 16px 24px' }}>
            {recoverStep === 'file' && (<>
              <div style={{ fontSize:17, fontWeight:700, marginBottom:4, color:M.ink }}>{t('profile.recoverTitle')}</div>
              <div style={{ fontSize:13, color:M.ink3, marginBottom:20 }}>{t('profile.recoverSelectFileSub')}</div>
              <label data-testid={T.offlineProfileRecoverFilePick} className="m-tap"
                style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:M.paper2, borderRadius:12, border:`1.5px dashed ${recoverFile ? M.sage : M.line}`, cursor:'pointer', marginBottom:20 }}>
                <div style={{ width:36, height:36, borderRadius:9, background:recoverFile ? M.sageSoft : M.paper2, border:`1px solid ${recoverFile ? M.sage : M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name="upload" size={16} color={recoverFile ? M.sage : M.ink3}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  {recoverFile
                    ? <><div style={{ fontSize:12, color:M.ink3, marginBottom:2 }}>{t('profile.recoverFileSelected')}</div><div style={{ fontSize:14, color:M.ink, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{recoverFile.name}</div></>
                    : <div style={{ fontSize:14, color:M.ink3 }}>{t('profile.recoverSelectFile')}</div>}
                </div>
                <input type="file" accept=".mun" onChange={e => setRecoverFile(e.target.files?.[0] || null)} style={{ display:'none' }}/>
              </label>
              <button className="m-btn sage m-tap" onClick={() => { if (recoverFile) setRecoverStep('key'); }} style={{ width:'100%', opacity: recoverFile ? 1 : 0.5 }}>{t('login.continue')}</button>
            </>)}
            {recoverStep === 'key' && (<>
              <div style={{ fontSize:17, fontWeight:700, marginBottom:4, color:M.ink }}>{t('profile.recoverTitle')}</div>
              <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>{t('profile.recoverKeyLabel')}</div>
              <input data-testid={T.offlineProfileRecoverKeyInput} className="m-input" value={recoverKeyDraft}
                onChange={e => { setRecoverKeyDraft(e.target.value); setRecoverError(''); }}
                placeholder={t('profile.recoverKeyPlaceholder')} autoFocus
                style={{ width:'100%', marginBottom:8, boxSizing:'border-box', height:48, fontFamily:M.fontMono, letterSpacing:'0.05em' }}/>
              {recoverError && <div style={{ fontSize:12, color:M.clay, marginBottom:8 }}>{recoverError}</div>}
              <button data-testid={T.offlineProfileRecoverStart} className="m-btn sage m-tap" onClick={doRecover} style={{ width:'100%', marginTop:8 }}>{t('profile.recoverBtn')}</button>
            </>)}
            {recoverStep === 'loading' && (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'32px 0 16px', gap:14 }}>
                <div style={{ width:56, height:56, borderRadius:'50%', background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <div style={{ animation:'munniSpin 1.4s linear infinite' }}>
                    <I name="refresh" size={26} color={M.sage}/>
                  </div>
                </div>
                <div style={{ fontSize:16, fontWeight:600, color:M.ink, textAlign:'center' }}>{t('offline.recoverLoading')}</div>
                <div style={{ fontSize:13, color:M.ink3, textAlign:'center' }}>{t('offline.recoverLoadingSub')}</div>
              </div>
            )}
            {recoverStep === 'done' && (
              <div data-testid={T.offlineProfileRecoverSuccess} style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'24px 0 8px', gap:12 }}>
                <div style={{ width:56, height:56, borderRadius:'50%', background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <I name="check" size={28} color={M.sage}/>
                </div>
                <div style={{ fontSize:17, fontWeight:700, textAlign:'center', color:M.ink }}>{t('profile.recoverSuccess')}</div>
                <div style={{ fontSize:13, color:M.ink3, textAlign:'center' }}>{t('profile.recoverSuccessSub')}</div>
                <button className="m-btn sage m-tap" onClick={() => { setShowRecover(false); setRecoverStep('file'); }} style={{ width:'100%', marginTop:12 }}>{t('action.done')}</button>
              </div>
            )}
          </div>
        </Sheet>
      )}

      {/* Auto-backup sheet */}
      {isOffline && showAutoBackup && (
        <Sheet onClose={() => setShowAutoBackup(false)}>
          <div data-testid={T.offlineProfileAutoBackupSheet} style={{ padding:'0 16px 24px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:20, color:M.ink }}>{t('profile.autoBackupTitle')}</div>

            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('profile.autoBackupFreq')}</div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:20, border:`1px solid ${M.line}` }}>
              {['none','daily','weekly','monthly'].map((freq, idx, arr) => (
                <React.Fragment key={freq}>
                  <div className="m-tap" onClick={() => setDraftAutoFreq(freq)}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0', cursor:'pointer' }}>
                    <div style={{ flex:1, fontSize:14, color:M.ink }}>{t(`profile.autoBackup${freq.charAt(0).toUpperCase()+freq.slice(1)}`)}</div>
                    {draftAutoFreq === freq && <I name="check" size={16} color={M.sage}/>}
                  </div>
                  {idx < arr.length-1 && <Divider/>}
                </React.Fragment>
              ))}
            </div>

            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('profile.autoBackupLoc')}</div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:24, border:`1px solid ${M.line}` }}>
              {[['device','Device'],['gdrive','GDrive'],['onedrive','OneDrive'],['dropbox','Dropbox']].map(([loc, tKey], idx, arr) => (
                <React.Fragment key={loc}>
                  <div className="m-tap" onClick={() => setDraftAutoLoc(loc)}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0', cursor:'pointer' }}>
                    <div style={{ flex:1, fontSize:14, color:M.ink }}>{t(`profile.autoBackup${tKey}`)}</div>
                    {draftAutoLoc === loc && <I name="check" size={16} color={M.sage}/>}
                  </div>
                  {idx < arr.length-1 && <Divider/>}
                </React.Fragment>
              ))}
            </div>

            <button data-testid={T.offlineProfileAutoBackupSave} className="m-btn sage m-tap" onClick={() => { setAutoBackupSettings({ enabled: draftAutoFreq !== 'none', frequency:draftAutoFreq, location:draftAutoLoc }); setShowAutoBackup(false); }}
              style={{ width:'100%' }}>{t('profile.autoBackupSave')}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenExportData() {
  const nav = useNav();
  const { t } = useLang();
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', background:M.paper }}>
      <AppBar title={t('settings.exportData')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'0 32px 48px', gap:16 }}>
        <div style={{ width:72, height:72, borderRadius:20, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <I name="download" size={32} color={M.sage}/>
        </div>
        <div style={{ fontSize:18, fontWeight:700, color:M.ink, textAlign:'center' }}>{t('settings.exportData')}</div>
        <div style={{ fontSize:14, color:M.ink3, textAlign:'center', lineHeight:1.5 }}>{t('settings.exportDataWipDesc')}</div>
      </div>
    </div>
  );
}

export function ScreenSpaces() {
  const nav = useNav();
  const { t } = useLang();
  const { profiles, setProfiles } = useProfiles();
  const [connectedAccounts] = useConnectedAccounts();
  const [showNewProfile, setShowNewProfile] = React.useState(false);
  const [newProfileName, setNewProfileName] = React.useState('');
  const [newProfileIsDemo, setNewProfileIsDemo] = React.useState(() => sessionStorage.getItem('munni_last_login_method') === 'bank');
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
      const creatorId = inv.originalCreatorId || originalOwnerId;
      const ownerDisplay = userRegistry[creatorId]?.displayName || userRegistry[originalOwnerId]?.displayName || originalOwnerId;
      const ownerName = freshName || inv.profileName || 'Shared';
      const trimmedCustom = customName?.trim();
      const profileData = {
        id: inv.profileId, name: ownerName,
        ...(trimmedCustom && trimmedCustom !== ownerName ? { localName: trimmedCustom } : {}),
        icon: inv.profileIcon || 'users', active: false,
        accountIds: inv.profileAccountIds || [],
        picture: freshPic !== undefined ? freshPic : (inv.profilePicture || null),
        isDemo: inv.profileIsDemo || false, isShared: true,
        creatorId, ownerId: originalOwnerId, ownerDisplay,
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
    if (trimmed.length > 30) { setNewProfileError(t('space.nameTooLong')); return; }
    if (!PROFILE_NAME_RE.test(trimmed)) { setNewProfileError(t('space.nameInvalidChars')); return; }
    if (profiles.filter(p => !p.isShared).some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setNewProfileError(t('space.duplicateName'));
      addDevLog('warn', `Space creation blocked: duplicate name "${trimmed}"`, 'ScreenSpaces:createSpace');
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
    setNewProfileIsDemo(sessionStorage.getItem('munni_last_login_method') === 'bank');
    setNewProfileError('');
    nav.push('spaceDetail', { id: newP.id });
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
    <div data-testid="spaces-screen" className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.spaces')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button data-testid="profile-new-btn" className="m-iconbtn m-tap" onClick={() => setShowNewProfile(true)}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {pendingProfileInvites.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('spaces.pendingInvites')}</div>
            <div data-testid="space-invite-section" className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.violet||'#7B61FF'}` }}>
              {pendingProfileInvites.map((inv, i) => {
                const senderName = userRegistry[inv.fromId]?.displayName || inv.fromDisplay || inv.fromId;
                const fakeProfile = { picture: inv.profilePicture, name: inv.profileName || '?', icon: inv.profileIcon || 'users' };
                return (
                  <React.Fragment key={inv.id}>
                    {i > 0 && <Divider inset={0}/>}
                    <div data-testid="space-invite-row" style={{ padding:'13px 0' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                        <ProfileAvatar profile={fakeProfile} size={36}/>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inv.profileName || '—'}</span>
                            <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.violetSoft||'#EEE8FF', color:M.violet||'#7B61FF', textTransform:'uppercase', flexShrink:0 }}>Invite</span>
                          </div>
                          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('space.sharedBy')} <strong>{senderName}</strong></div>
                        </div>
                      </div>
                      <div style={{ display:'flex', gap:8 }}>
                        <button className="m-tap" onClick={() => setRenameInviteSheet({ inv, name: inv.profileName || '' })}
                          style={{ flex:2, padding:'9px 0', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                          {t('space.inviteJoin')}
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
                <div data-testid="space-row" style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                  <div className="m-tap" onClick={() => activateProfile(p.id)} style={{ flexShrink:0 }}>
                    <ProfileAvatar profile={p} size={36}/>
                  </div>
                  <div className="m-tap" onClick={() => activateProfile(p.id)} style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                      {p.localName || p.name}
                      {p.isDemo && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase' }}>Demo</span>}
                      {p.isShared && (p.members||[]).some(m => m.userId !== myId) && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.violetSoft||'#EEE8FF', color:M.violet||'#7B61FF', textTransform:'uppercase' }}>Shared</span>}
                      {!p.isShared && (p.members||[]).length > 0 && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>Shared</span>}
                    </div>
                    <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{p.isShared ? `${t('space.by')} ${formatCreatorLabel(p.creatorId || p.ownerId, p.ownerDisplay, userRegistry)}` : sub}</div>
                  </div>
                  {p.active && (
                    <div style={{ width:20, height:20, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name="check" size={11} color="#fff" stroke={2.5}/>
                    </div>
                  )}
                  <button data-testid="space-row-detail-btn" className="m-iconbtn m-tap" onClick={() => nav.push('spaceDetail', { id: p.id })}>
                    <I name="caretR" size={16} color={M.ink4}/>
                  </button>
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div style={{ borderRadius:12, overflow:'hidden', border:`1px solid ${M.line}`, marginBottom:16 }}>
          <div style={{ padding:'14px 16px', background:M.sageSoft }}>
            <div style={{ fontSize:13, fontWeight:600, color:M.sage, marginBottom:4 }}>{t('spaces.aboutTitle')}</div>
            <div style={{ fontSize:12, color:M.ink2, lineHeight:1.6 }}>{t('spaces.aboutDesc')}</div>
          </div>
        </div>
      </div>

      {renameInviteSheet && (
        <Sheet onClose={() => setRenameInviteSheet(null)}>
          <div data-testid="space-rename-invite-sheet" style={{ padding:'4px 16px 20px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <ProfileAvatar profile={{ name: renameInviteSheet.inv.profileName, picture: renameInviteSheet.inv.profilePicture || null }} size={44}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{renameInviteSheet.inv.profileName || 'Shared profile'}</div>
                <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>
                  {t('space.by')} <strong>{userRegistry[renameInviteSheet.inv.fromId]?.displayName || renameInviteSheet.inv.fromId}</strong>
                </div>
              </div>
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('space.nameThisSpace')}</div>
            <input autoFocus
              value={renameInviteSheet.name}
              onChange={e => setRenameInviteSheet(prev => ({ ...prev, name: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && (acceptProfileInvite(renameInviteSheet.inv, renameInviteSheet.name), setRenameInviteSheet(null))}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:6 }}
            />
            <div style={{ fontSize:11, color:M.ink4, marginBottom:20 }}>{t('space.nameThisSpaceHint')}</div>
            <button onClick={() => { acceptProfileInvite(renameInviteSheet.inv, renameInviteSheet.name); setRenameInviteSheet(null); }}
              style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('space.inviteJoin')}
            </button>
            <button onClick={() => setRenameInviteSheet(null)}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}

      {showNewProfile && (
        <Sheet onClose={() => { setShowNewProfile(false); setNewProfileName(''); setNewProfileIsDemo(sessionStorage.getItem('munni_last_login_method') === 'bank'); setNewProfileError(''); }}>
          <div data-testid="space-new-sheet" style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('space.new')}</div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('space.name')}</div>
            <input
              data-testid="space-new-name-input"
              value={newProfileName}
              onChange={e => { setNewProfileName(e.target.value); setNewProfileError(''); }}
              onKeyDown={e => e.key === 'Enter' && createProfile()}
              placeholder={t('space.namePlaceholder')}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${newProfileError ? M.clay : M.line}`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom: newProfileError ? 6 : 20 }}
            />
            {newProfileError && <div data-testid="space-new-error" style={{ fontSize:12, color:M.clay, marginBottom:14 }}>{newProfileError}</div>}
            <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>{t('space.type')}</div>
            <div style={{ display:'flex', gap:8, marginBottom:20 }}>
              {[{v:false,lk:'space.typeReal',sk:'space.typeRealSub',tid:'space-new-type-real'},{v:true,lk:'space.typeDemo',sk:'space.typeDemoSub',tid:'space-new-type-demo'}].map(opt => {
                const disabled = opt.v === false && isUserDemo;
                return (
                  <button data-testid={opt.tid} key={String(opt.v)} className="m-tap" onClick={() => !disabled && setNewProfileIsDemo(opt.v)}
                    style={{ flex:1, padding:'12px 8px', borderRadius:12, border:`2px solid ${newProfileIsDemo===opt.v ? M.sage : M.line}`, background: disabled ? M.line2 : newProfileIsDemo===opt.v ? M.sageSoft : M.paper2, textAlign:'center', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily:M.fontUI, boxSizing:'border-box', opacity: disabled ? 0.5 : 1 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:newProfileIsDemo===opt.v?M.sage:M.ink }}>{t(opt.lk)}</div>
                    <div style={{ fontSize:10, color:M.ink3, marginTop:2 }}>{t(opt.sk)}</div>
                  </button>
                );
              })}
            </div>
            <button data-testid="space-new-create-btn" onClick={createProfile}
              style={{ width:'100%', padding:'14px 0', background:newProfileName.trim() ? M.sage : M.line, color:newProfileName.trim() ? '#fff' : M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:newProfileName.trim()?'pointer':'default', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('space.create')}
            </button>
            <button onClick={() => { setShowNewProfile(false); setNewProfileName(''); setNewProfileIsDemo(sessionStorage.getItem('munni_last_login_method') === 'bank'); setNewProfileError(''); }}
              style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              {t('action.cancel')}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenSpaceDetail({ params }) {
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
  const [nameError, setNameError] = React.useState('');
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
    // Write new member permissions to sharedData so all other members can sync their lists
    setSharedData(sd => {
      const updated = { ...(sd.memberPerms || {}) };
      accepted.forEach(inv => { if (!updated[inv.toId]) updated[inv.toId] = inv.permission || 'contributor'; });
      return { ...sd, memberPerms: updated };
    });
    setInvitations(arr => arr.map(i => accepted.some(a => a.id === i.id) ? { ...i, status: 'joined' } : i));
  }, [invitations, profileId, sharedData?.memberPerms?.[myId]]);

  // Auto-leave if expelled by another owner-permission member
  React.useEffect(() => {
    if (!sharedData?.expelled?.[myId]) return;
    const expelledName = profile?.name;
    setProfiles(ps => {
      const remaining = ps.filter(p => p.id !== profileId);
      if (remaining.length === 0) {
        const method = sessionStorage.getItem('munni_last_login_method') || 'email';
        const emailRaw = sessionStorage.getItem('munni_profile_email');
        const email = (() => { try { return JSON.parse(emailRaw) || ''; } catch { return ''; } })();
        const newProfile = { id: `p_${Date.now()}`, name: getDefaultProfileName(lang), icon: 'user', active: true, accountIds: [], isDemo: false, creatorId: myId };
        try { localStorage.setItem(computeProfileKey(method, email), JSON.stringify([newProfile])); } catch {}
        return [newProfile];
      }
      if (!remaining.find(p => p.active)) remaining[0] = { ...remaining[0], active: true };
      return remaining;
    });
    if (expelledName) {
      nav.setKickNotif(t('space.kickedFrom').replace('{name}', expelledName));
      setTimeout(() => nav.setKickNotif(null), 4500);
    }
    nav.switchTab('home');
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
  const hasOtherOwner = otherMembers.some(m => (sharedData?.memberPerms?.[m.userId] || m.permission) === 'owner');
  const myMembership = members.find(m => m.userId === myId);
  const myPerm = buildEffectivePerm(sharedData, myId, myMembership?.permission, !isMemberOfShared);
  const canEdit = myPerm !== 'reader';
  const pendingInvitesForProfile = invitations.filter(i => i.fromId === myId && i.type === 'profile' && i.profileId === profile.id && i.status === 'pending');
  const sharedAccts = sharedData?.accounts || [];
  const accountIds = profile.accountIds || [];
  const ownConnected = connectedAccounts.filter(a => !a.isDemo);
  const ownConnectedIds = new Set(ownConnected.map(a => a.id));
  const extraShared = sharedAccts.filter(a => !ownConnectedIds.has(a.id));
  const availableAccounts = profile.isDemo ? DEMO_ACCOUNTS : [...ownConnected, ...extraShared];
  const isActive = profile.active;
  const isOnly = profiles.length === 1;

  const isProfileShared = isMemberOfShared || members.length > 0;

  // Sync sharedData.meta â†” local profile copy so both tabs see name/picture changes live
  React.useEffect(() => {
    const metaName = sharedData?.meta?.name;
    const metaPic = sharedData?.meta?.picture;
    if (!profile || (!metaName && metaPic === undefined)) return;
    const nameChanged = !profile.localName && metaName && metaName !== profile.name;
    const picChanged = !profile.localPicture && metaPic !== undefined && metaPic !== profile.picture;
    if (!nameChanged && !picChanged) return;
    setProfiles(ps => ps.map(p => p.id === profile.id ? {
      ...p,
      ...(nameChanged ? { name: metaName } : {}),
      ...(picChanged ? { picture: metaPic } : {}),
    } : p));
  }, [sharedData?.meta?.name, sharedData?.meta?.picture, profileId]);

  const startEditName = () => { setNameDraft(profile.localName || profile.name); setNameError(''); setEditingName(true); };
  const saveName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) { setEditingName(false); return; }
    if (trimmed.length > 30) { setNameError(t('space.nameTooLong')); return; }
    if (!PROFILE_NAME_RE.test(trimmed)) { setNameError(t('space.nameInvalidChars')); return; }
    if (!isMemberOfShared) {
      const isDuplicate = profiles
        .filter(p => !p.isShared && p.id !== profile.id)
        .some(p => p.name.toLowerCase() === trimmed.toLowerCase());
      if (isDuplicate) { setNameError(t('space.duplicateName')); return; }
    }
    setNameError('');
    if (isMemberOfShared) {
      setProfiles(ps => ps.map(p => p.id === profile.id
        ? { ...p, localName: trimmed !== p.name ? trimmed : null }
        : p));
    } else {
      setProfiles(ps => ps.map(p => p.id === profile.id ? { ...p, name: trimmed } : p));
      if (isProfileShared) setSharedData(prev => ({ ...prev, meta: { ...(prev.meta || {}), name: trimmed } }));
    }
    setEditingName(false);
  };

  const setPicture = (chosen) => {
    if (isMemberOfShared) {
      setProfiles(ps => ps.map(p => p.id === profile.id ? { ...p, localPicture: chosen !== p.picture ? chosen : null } : p));
    } else {
      setProfiles(ps => ps.map(p => p.id === profile.id ? { ...p, picture: chosen } : p));
      if (isProfileShared) setSharedData(prev => ({ ...prev, meta: { ...(prev.meta || {}), picture: chosen } }));
    }
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
          return { ...sd, accounts: [...existing, newAcct], txs: [...(sd.txs || []), ...newTxs] };
        });
      } else if (isCurrentlyAttached) {
        setSharedData(sd => ({
          ...sd,
          accounts: (sd.accounts || []).filter(a => a.id !== accountId),
          txs: (sd.txs || []).filter(t => t.account !== accountId),
          detached: { ...(sd.detached || {}), [accountId]: Date.now() },
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
    active: true, accountIds: [], picture: 'av1', isDemo: false, creatorId: myId,
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
              return <div style={{ fontSize:11, color:M.ink4, marginTop:1 }}>{t('space.addedBy')} {isMe ? t('word.you') : attacherName}</div>;
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
    <div data-testid="space-detail-screen" className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.space')}
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
              <>
                <input
                  data-testid="space-detail-name-input"
                  autoFocus
                  value={nameDraft}
                  onChange={e => { setNameDraft(e.target.value); setNameError(''); }}
                  onBlur={saveName}
                  onKeyDown={e => e.key==='Enter' && saveName()}
                  style={{ width:'100%', fontSize:16, fontWeight:600, border:`1px solid ${nameError ? M.clay : M.sage}`, borderRadius:8, padding:'6px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', textAlign:'center', boxSizing:'border-box' }}
                />
                {nameError && <div data-testid="space-detail-name-error" style={{ fontSize:11, color:M.clay, marginTop:4, textAlign:'center' }}>{nameError}</div>}
              </>
            ) : (
              <div data-testid="space-detail-name" className="m-tap" onClick={startEditName} style={{ textAlign:'center' }}>
                <div style={{ fontSize:16, fontWeight:600, borderBottom:`1.5px dashed ${M.line2}`, display:'inline', paddingBottom:1 }}>{profile.localName || profile.name}</div>
                <div style={{ fontSize:10, color:M.ink4, marginTop:4 }}>{isMemberOfShared ? t('space.tapRenameLocal') : t('space.tapRename')}</div>
              </div>
            )}
            {isMemberOfShared && (profile.creatorId || profile.ownerId) && (
              <div style={{ fontSize:12, color:M.ink3, marginTop:4, textAlign:'center' }}>
                {t('space.by')} <span style={{ fontWeight:600 }}>{formatCreatorLabel(profile.creatorId || profile.ownerId, profile.ownerDisplay, userRegistry)}</span>
              </div>
            )}
            {isActive && (
              <div style={{ fontSize:11, color:M.sage, fontWeight:600, marginTop:3, textAlign:'center' }}>{t('space.active')}</div>
            )}
          </div>
        </div>

        {/* Attached main accounts */}
        <div className="m-cap" style={{ marginBottom:4, paddingLeft:4 }}>{t('space.mainAccounts')}</div>
        <div style={{ fontSize:11, color:M.ink3, marginBottom:8, paddingLeft:4 }}>{t('space.mainAccountsSub')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {attachedMain.length === 0 && <div style={{ padding:'16px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('space.noChecking')}</div>}
          {attachedMain.map((a, i) => renderAttachedRow(a, i))}
          {canEdit && (
            <>
              {attachedMain.length > 0 && <Divider inset={0}/>}
              <div className="m-tap" onClick={() => setShowAttachSheet('checking')}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 0' }}>
                <I name="plus" size={16} color={M.sage}/>
                <div style={{ fontSize:13, color:M.sage, fontWeight:600 }}>{t('space.attachAccount')}</div>
              </div>
            </>
          )}
        </div>

        {/* Attached saving & investment accounts */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('space.savingAccounts')}</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {attachedSaving.length === 0 && <div style={{ padding:'16px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('space.noSaving')}</div>}
          {attachedSaving.map((a, i) => renderAttachedRow(a, i))}
          {canEdit && (
            <>
              {attachedSaving.length > 0 && <Divider inset={0}/>}
              <div className="m-tap" onClick={() => setShowAttachSheet('saving')}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 0' }}>
                <I name="plus" size={16} color={M.sage}/>
                <div style={{ fontSize:13, color:M.sage, fontWeight:600 }}>{t('space.attachAccount')}</div>
              </div>
            </>
          )}
        </div>

        {/* Members */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('space.members')}</div>
        {profile.isDemo ? (
          <div className="m-card" style={{ padding:'12px 16px', marginBottom:14, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', gap:12, opacity:0.5 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="lock" size={16} color={M.ink4}/>
            </div>
            <div style={{ flex:1 }}><div style={{ fontSize:14, fontWeight:600 }}>{t('space.demoNoInvite')}</div></div>
          </div>
        ) : (
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
            {(() => {
              // For isMemberOfShared views, the current user is rendered separately below — exclude self from this list
              const displayMembers = isMemberOfShared ? members.filter(m => m.userId !== myId) : members;
              return (
                <>
                  {displayMembers.length === 0 && pendingInvitesForProfile.length === 0 && !isMemberOfShared && !isProfileShared && (
                    <div style={{ padding:'14px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>{t('space.noMembers')}</div>
                  )}
                  {/* Owner self-row: visible when the original owner has members */}
                  {!isMemberOfShared && isProfileShared && (() => {
                    const myInfo = userRegistry[myId] || {};
                    const myDisplayName = myInfo.displayName || myId;
                    return (
                      <>
                        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0', opacity:0.5, pointerEvents:'none' }}>
                          <div style={{ width:32, height:32, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.sage }}>
                            {myDisplayName.charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {myDisplayName} <span style={{ color:M.ink4, fontWeight:400 }}>({t('word.you')})</span>
                            </div>
                          </div>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:myPerm==='owner'?M.ochreSoft:myPerm==='contributor'?M.sageSoft:M.paper2, color:PERM_COLOR[myPerm]||M.ink3, textTransform:'uppercase', flexShrink:0 }}>
                            {permLabel(myPerm, t)||myPerm}
                          </span>
                        </div>
                        {displayMembers.length > 0 && <Divider inset={44}/>}
                      </>
                    );
                  })()}
                  {displayMembers.map((m, i) => {
                    const info = userRegistry[m.userId] || {};
                    const tappable = myPerm === 'owner';
                    const livePerm = buildEffectivePerm(sharedData, m.userId, m.permission);
                    return (
                      <React.Fragment key={m.userId}>
                        {i > 0 && <Divider inset={44}/>}
                        <div data-testid="member-row" className={tappable ? 'm-tap' : ''} onClick={tappable ? () => setMemberActionSheet(m.userId) : undefined}
                          style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0', cursor: tappable ? 'pointer' : 'default' }}>
                          <div style={{ width:32, height:32, borderRadius:999, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.ink2 }}>
                            {(info.displayName||m.userId).charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.displayName||m.userId}</div>
                          </div>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:livePerm==='owner'?M.ochreSoft:livePerm==='contributor'?M.sageSoft:M.paper2, color:PERM_COLOR[livePerm]||M.ink3, textTransform:'uppercase', flexShrink:0 }}>
                            {permLabel(livePerm, t)||livePerm}
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
                        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0', opacity:0.5, pointerEvents:'none' }}>
                          <div style={{ width:32, height:32, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.sage }}>
                            {myDisplayName.charAt(0).toUpperCase()}
                          </div>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {myDisplayName} <span style={{ color:M.ink4, fontWeight:400 }}>({t('word.you')})</span>
                            </div>
                          </div>
                          <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:myPerm==='owner'?M.ochreSoft:myPerm==='contributor'?M.sageSoft:M.paper2, color:PERM_COLOR[myPerm]||M.ink3, textTransform:'uppercase', flexShrink:0 }}>
                            {permLabel(myPerm, t)||myPerm}
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
                    <div style={{ fontSize:14, fontWeight:500, color:M.sage }}>{t('space.addMember')}</div>
                  </div>
                  <I name="caretR" size={14} color={M.ink4}/>
                </div>
              </>
            )}
          </div>
        )}

        {(isMemberOfShared && myPerm !== 'owner') ? (
          <button data-testid="space-detail-leave-btn" onClick={() => setShowLeaveConfirm(true)}
            style={{ width:'100%', padding:'14px 0', background:M.claySoft, color:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
            {t('space.leave')}
          </button>
        ) : otherMembers.length > 0 ? (
          <>
            <button data-testid="space-detail-leave-btn" onClick={() => setShowLeaveConfirm(true)}
              style={{ width:'100%', padding:'14px 0', background:M.claySoft, color:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
              {hasOtherOwner ? t('space.leave') : t('space.transferLeave')}
            </button>
            {!hasOtherOwner && (
              <>
                <button data-testid="space-detail-delete-btn" disabled={isOnly||isActive} onClick={() => setShowDeleteConfirm(true)}
                  style={{ width:'100%', padding:'14px 0', background:(isOnly||isActive)?M.line:M.claySoft, color:(isOnly||isActive)?M.ink4:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:(isOnly||isActive)?'not-allowed':'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
                  {t('space.delete')}
                </button>
                {(isOnly||isActive) && <div style={{ textAlign:'center', fontSize:12, color:M.ink4 }}>{isActive ? t('space.cannotDeleteActive') : t('space.cannotDeleteOnly')}</div>}
              </>
            )}
          </>
        ) : isMemberOfShared ? (
          <button data-testid="space-detail-leave-btn" onClick={() => setShowLeaveConfirm(true)}
            style={{ width:'100%', padding:'14px 0', background:M.claySoft, color:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
            {t('space.leave')}
          </button>
        ) : (
          <>
            <button data-testid="space-detail-delete-btn" disabled={isOnly||isActive} onClick={() => setShowDeleteConfirm(true)}
              style={{ width:'100%', padding:'14px 0', background:(isOnly||isActive)?M.line:M.claySoft, color:(isOnly||isActive)?M.ink4:M.clay, border:'none', borderRadius:12, fontSize:15, fontWeight:600, cursor:(isOnly||isActive)?'not-allowed':'pointer', fontFamily:M.fontUI, marginBottom:8 }}>
              {t('space.delete')}
            </button>
            {(isOnly||isActive) && <div style={{ textAlign:'center', fontSize:12, color:M.ink4 }}>{isActive ? t('space.cannotDeleteActive') : t('space.cannotDeleteOnly')}</div>}
          </>
        )}
        <div style={{ height:16 }}/>
      </div>

      {showAttachSheet && (
        <Sheet onClose={() => setShowAttachSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('space.attachAccount')}</div>
            {(() => {
              const isChecking = showAttachSheet === 'checking';
              const attachedIds = new Set(attachedAccountObjects.map(a => a.id));
              const candidates = availableAccounts.filter(a => (isChecking ? a.type === 'checking' : a.type !== 'checking') && !attachedIds.has(a.id));
              if (candidates.length === 0) {
                return (
                  <>
                    <div style={{ textAlign:'center', color:M.ink3, fontSize:13, padding:'16px 0', marginBottom:12 }}>
                      {isChecking ? t('space.noCheckingToAttach') : t('space.noSavingToAttach')}
                    </div>
                    <button className="m-tap" onClick={() => { setShowAttachSheet(null); nav.push('accountsAll'); }}
                      style={{ width:'100%', padding:'12px 0 4px', display:'flex', alignItems:'center', justifyContent:'center', gap:4, background:'transparent', border:'none', cursor:'pointer', fontFamily:M.fontUI }}>
                      <span style={{ fontSize:14, fontWeight:600, color:M.sage }}>{t('space.manageAccounts')} {'→'}</span>
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
                    <span style={{ fontSize:14, fontWeight:600, color:M.sage }}>{t('space.manageAccounts')} {'→'}</span>
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
          <div data-testid="space-delete-sheet" style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>{t('space.deleteConfirmTitle')}</div>
            <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:12 }}>
              {t('space.deleteConfirmDesc')}
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
                  <div style={{ fontSize:12, color:M.clay, fontWeight:600, marginBottom:4 }}>{t('space.deleteDataAlso')}</div>
                  <div style={{ fontSize:12, color:M.ink2 }}>{items.join(' · ')}</div>
                </div>
              );
            })()}
            <div style={{ marginBottom:20 }}/>
            <button onClick={deleteProfile}
              style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
              {t('space.delete')}
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
          <div data-testid="space-leave-sheet" style={{ padding:'4px 16px 8px' }}>
            {(() => {
              const isOwnerTransfer = myPerm === 'owner' && otherMembers.length > 0 && !hasOtherOwner;
              return (
                <>
                  <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>
                    {isOwnerTransfer ? t('space.transferLeaveConfirmTitle') : t('space.leaveConfirmTitle')}
                  </div>
                  <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, marginBottom:20 }}>
                    {isOwnerTransfer ? t('space.transferLeaveConfirmDesc') : t('space.leaveConfirmDesc')}
                  </div>
                  <button onClick={isOwnerTransfer ? transferAndLeave : leaveProfile}
                    style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>
                    {isOwnerTransfer ? t('space.transferLeave') : t('space.leave')}
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

function ProfileLink({ icon, label, sub, danger, onClick, testId }) {
  return (
    <div data-testid={testId} className="m-tap" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
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

