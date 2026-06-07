import React from 'react';
import { M, I, IcoGoogle, IcoApple, StatusBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { DUTCH_BANKS } from '../accounts/data.js';
import { STOCK_AVATARS } from '../../shared/constants.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ScreenSignupOnboarding({ signup, onComplete, onBack }) {
  const { t } = useLang();
  const isGoogle = signup.method === 'google';
  const isApple  = signup.method === 'apple';
  const isSSO    = isGoogle || isApple;

  const [firstName,     setFirstName]     = React.useState(signup.firstName || '');
  const [lastName,      setLastName]      = React.useState(signup.lastName  || '');
  const [email,         setEmail]         = React.useState(signup.displayEmail || '');
  const [selectedBanks, setSelectedBanks] = React.useState(() => new Set(signup.banks || []));
  const [apiUrl,        setApiUrl]        = React.useState(signup.apiUrl || '');
  const [showAdvanced,  setShowAdvanced]  = React.useState(false);
  const [picture,       setPicture]       = React.useState(signup.picture || null);
  const [showPicker,    setShowPicker]    = React.useState(false);
  const [errors,        setErrors]        = React.useState({});

  React.useEffect(() => {
    window.history.pushState({ munniLoginMode: 'signup-onboarding' }, '');
    const handlePop = () => onBack();
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  const toggleBank = (bankId) => {
    setSelectedBanks(prev => {
      const next = new Set(prev);
      if (next.has(bankId)) next.delete(bankId); else next.add(bankId);
      return next;
    });
  };

  const validate = () => {
    const errs = {};
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn) errs.firstName = t('onboarding.errFirstNameRequired');
    else if (fn.length > 50) errs.firstName = t('login.errNameTooLong');
    if (!ln) errs.lastName = t('onboarding.errLastNameRequired');
    else if (ln.length > 50) errs.lastName = t('login.errNameTooLong');
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
      email:     isSSO ? signup.displayEmail : email.trim().toLowerCase(),
      apiUrl:    apiUrl.trim(),
      picture,
      selectedBanks: [...selectedBanks],
    });
  };

  const avatarInitial = (firstName || 'G')[0].toUpperCase();

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
        {avatarInitial}
      </div>
    );
  };

  return (
    <div key="signup-onboarding" className="m-screen m-fade" style={{ position:'relative' }}>
      <StatusBar/>

      {/* Back button */}
      <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
        <button className="m-tap" onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
          <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
        </button>
      </div>

      {/* Scrollable content */}
      <div style={{ flex:1, overflowY:'auto', padding:'20px 24px 40px' }}>

        {/* Logo + title */}
        <div className="m-logo" style={{ fontSize:20, marginBottom:14 }}>munni<span className="dot">.</span></div>
        <div className="m-h2" style={{ marginBottom:4 }}>{t('onboarding.title')}</div>
        <div style={{ fontSize:13, color:M.ink3, marginBottom:24, lineHeight:1.5 }}>
          {isGoogle ? t('onboarding.subtitleGoogle') : isApple ? t('onboarding.subtitleApple') : t('onboarding.subtitleEmail')}
        </div>

        {/* Avatar picker button */}
        <div style={{ display:'flex', justifyContent:'center', marginBottom:24 }}>
          <button className="m-tap" onClick={() => setShowPicker(true)} style={{ position:'relative', background:'none', border:'none', cursor:'pointer', padding:0 }}>
            {renderAvatar()}
            <div style={{ position:'absolute', bottom:2, right:2, width:22, height:22, borderRadius:'50%', background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #fff' }}>
              <I name="cam" size={11} color="#fff"/>
            </div>
          </button>
        </div>

        {/* First / Last name */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
          <div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('onboarding.firstName')}</div>
            <input
              value={firstName}
              onChange={e => { setFirstName(e.target.value); setErrors(p => ({...p, firstName:undefined})); }}
              placeholder={t('onboarding.firstNamePlaceholder')}
              style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', borderRadius:12, border:`1.5px solid ${errors.firstName ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
            />
            {errors.firstName && <div style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.firstName}</div>}
          </div>
          <div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('onboarding.lastName')}</div>
            <input
              value={lastName}
              onChange={e => { setLastName(e.target.value); setErrors(p => ({...p, lastName:undefined})); }}
              placeholder={t('onboarding.lastNamePlaceholder')}
              style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', borderRadius:12, border:`1.5px solid ${errors.lastName ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
            />
            {errors.lastName && <div style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.lastName}</div>}
          </div>
        </div>

        {/* Email */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('login.email')}</div>
          {isSSO ? (
            <div style={{ padding:'12px 14px', borderRadius:12, background:M.paper2, border:`1.5px solid ${M.line}`, fontSize:14, fontFamily:M.fontUI, color:M.ink3, display:'flex', alignItems:'center', gap:8 }}>
              {isGoogle ? <IcoGoogle size={13}/> : <IcoApple size={13} color={M.ink3}/>}
              <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{signup.displayEmail}</span>
              <I name="lock" size={13} color={M.ink4}/>
            </div>
          ) : (
            <>
              <input
                value={email}
                onChange={e => { setEmail(e.target.value); setErrors(p => ({...p, email:undefined})); }}
                type="email"
                placeholder={t('login.emailPlaceholder')}
                style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', borderRadius:12, border:`1.5px solid ${errors.email ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
              />
              {errors.email && <div style={{ fontSize:11, color:M.clay, marginTop:4 }}>{errors.email}</div>}
            </>
          )}
        </div>

        {/* Bank accounts */}
        <div style={{ marginBottom:24 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
            <div style={{ fontSize:13, fontWeight:600, color:M.ink }}>{t('onboarding.bankAccounts')}</div>
            {!isSSO && <span style={{ fontSize:11, color:M.ink4 }}>(optional)</span>}
            {isSSO && selectedBanks.size > 0 && (
              <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.sageSoft, color:M.sage }}>
                {t('onboarding.connected')}
              </span>
            )}
          </div>
          <div style={{ padding:'10px 12px', borderRadius:10, background:M.sageSoft, marginBottom:12, display:'flex', gap:10, alignItems:'flex-start' }}>
            <I name="lock" size={14} color={M.sage}/>
            <div style={{ fontSize:11, color:M.sageDk, lineHeight:1.5 }}>{t('onboarding.bankPSD2Note')}</div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {DUTCH_BANKS.map(bank => {
              const isSel = selectedBanks.has(bank.id);
              return (
                <button key={bank.id} className="m-tap" onClick={() => toggleBank(bank.id)}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'11px 14px', borderRadius:12, background:isSel ? M.sageSoft : M.paper2, border:`1.5px solid ${isSel ? M.sage : M.line}`, cursor:'pointer', textAlign:'left', width:'100%' }}>
                  <div style={{ width:34, height:34, borderRadius:9, background:`${bank.color}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0 }}>{bank.logo}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:500, color:M.ink }}>{bank.name}</div>
                    <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono }}>{bank.bic}</div>
                  </div>
                  <div style={{ width:20, height:20, borderRadius:'50%', border:`1.5px solid ${isSel ? M.sage : M.line}`, background:isSel ? M.sage : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    {isSel && <I name="check" size={11} color="#fff" stroke={2.5}/>}
                  </div>
                </button>
              );
            })}
          </div>
          {!isSSO && (
            <button className="m-tap" onClick={handleComplete}
              style={{ background:'none', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, padding:'10px 0 0', textDecoration:'underline', display:'block' }}>
              {t('onboarding.skipBank')} →
            </button>
          )}
        </div>

        {/* Advanced section */}
        <div style={{ marginBottom:28, borderRadius:12, border:`1px solid ${M.line}`, overflow:'hidden' }}>
          <button className="m-tap" onClick={() => setShowAdvanced(v => !v)}
            style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'13px 16px', background:M.paper2, border:'none', cursor:'pointer', textAlign:'left' }}>
            <I name="sliders" size={15} color={M.ink3}/>
            <div style={{ flex:1, fontSize:13, fontWeight:500, color:M.ink2 }}>{t('onboarding.advanced')}</div>
            <I name={showAdvanced ? 'caretU' : 'caretD'} size={13} color={M.ink4}/>
          </button>
          {showAdvanced && (
            <div style={{ padding:'4px 16px 16px', background:M.paper }}>
              <div style={{ height:1, background:M.line, marginBottom:14 }}/>
              <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('onboarding.apiUrl')}</div>
              <input
                value={apiUrl}
                onChange={e => setApiUrl(e.target.value)}
                placeholder={t('onboarding.apiUrlPlaceholder')}
                style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px', borderRadius:10, border:`1.5px solid ${M.line}`, fontSize:13, fontFamily:M.fontMono, background:M.paper2, outline:'none', color:M.ink }}
              />
            </div>
          )}
        </div>

        {/* CTA */}
        <button className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700 }} onClick={handleComplete}>
          {t('onboarding.complete')}
        </button>
      </div>

      {/* Avatar picker overlay */}
      {showPicker && (
        <div
          style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', flexDirection:'column', justifyContent:'flex-end', zIndex:100 }}
          onClick={() => setShowPicker(false)}
        >
          <div style={{ background:M.paper, borderRadius:'20px 20px 0 0', padding:'16px 20px 32px' }} onClick={e => e.stopPropagation()}>
            <div style={{ width:36, height:4, borderRadius:2, background:M.line2, margin:'0 auto 16px' }}/>
            <div style={{ fontSize:14, fontWeight:600, color:M.ink, marginBottom:16 }}>{t('profile.picTitle')}</div>
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
