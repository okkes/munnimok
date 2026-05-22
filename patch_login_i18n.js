// patch_login_i18n.js — login/i18n/flags overhaul
const fs = require('fs');
let c = fs.readFileSync('munni.html', 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  if (c.indexOf(from) === -1) { console.warn('NOT FOUND:', from.slice(0, 80)); return; }
  c = c.replace(from, to);
  console.log('✓', from.slice(0, 70));
}

// ===========================================================
// 1. Add IcoGoogle + IcoApple components (before CatIcon)
// ===========================================================
rep(
`function CatIcon({ cat, size = 20, color }) {`,
`function IcoGoogle({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ display:'block', flexShrink:0 }}>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}
function IcoApple({ size = 20, color = 'currentColor' }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={color} style={{ display:'block', flexShrink:0 }}>
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
    </svg>
  );
}
function CatIcon({ cat, size = 20, color }) {`
);

// ===========================================================
// 2. Translation keys — English
// ===========================================================
rep(
  `'login.or':'or','login.signIn':'Sign in',`,
  `'login.or':'or','login.signIn':'Sign in',
    'login.welcomeFirst':'Welcome',
    'login.termsIntro':'By continuing you agree to our',
    'login.termsLinkText':'Terms of Service','login.termsAnd':'and',
    'login.termsPrivacy':'Privacy Policy','login.termsSuffix':'',
    'login.signingIn':'Signing in with',
    'login.noAccountTitle':'No account found',
    'login.noAccountSub':'We couldn\'t find an account linked to your account.',
    'login.noAccountDesc':'Go back and try a different sign-in method, or continue to create a new account.',
    'login.noAccountBack':'Back to login','login.noAccountContinue':'Create account',
    'login.noAccountCustom':'Sign up with email instead',
    'login.createAccountTitle':'Create account','login.createAccountSub':'Choose how to sign up',
    'login.signUpEmail':'Sign up with email',
    'login.createAccountEmailSub':'Sign up with your email address',
    'login.fullName':'Full name','login.namePlaceholder':'Your name',
    'login.emailPlaceholder':'sample@munni.app',
    'login.sendCode':'Send verification code',
    'login.checkEmail':'Check your email',
    'login.codeSentTo':'We sent a 6-digit code to',
    'login.autoFilling':'Auto-filling code…',
    'login.signInTitle':'Sign in','login.signInSub':'Enter your email address',
    'login.emailNotFound':'No account found. Create one instead?',
    'login.errGoogleExists':'A Google account is already registered. Sign in instead.',
    'login.errAppleExists':'An Apple account is already registered. Sign in instead.',
    'login.errEmailExists':'This email is already registered. Sign in instead.',
    'login.errInvalidEmail':'Please enter a valid email address.',
    'lang.availableNow':'Available now',`
);

// Dutch
rep(
  `'login.or':'of','login.signIn':'Aanmelden',`,
  `'login.or':'of','login.signIn':'Aanmelden',
    'login.welcomeFirst':'Welkom',
    'login.termsIntro':'Door door te gaan ga je akkoord met onze',
    'login.termsLinkText':'Gebruiksvoorwaarden','login.termsAnd':'en',
    'login.termsPrivacy':'Privacybeleid','login.termsSuffix':'',
    'login.signingIn':'Aanmelden bij',
    'login.noAccountTitle':'Geen account gevonden',
    'login.noAccountSub':'Er is geen account gevonden dat is gekoppeld aan jouw account.',
    'login.noAccountDesc':'Ga terug en probeer een andere methode, of ga door om een nieuw account aan te maken.',
    'login.noAccountBack':'Terug naar inloggen','login.noAccountContinue':'Account aanmaken',
    'login.noAccountCustom':'Aanmelden met e-mail',
    'login.createAccountTitle':'Account aanmaken','login.createAccountSub':'Kies hoe je wilt aanmelden',
    'login.signUpEmail':'Aanmelden met e-mail',
    'login.createAccountEmailSub':'Aanmelden met je e-mailadres',
    'login.fullName':'Volledige naam','login.namePlaceholder':'Je naam',
    'login.emailPlaceholder':'voorbeeld@munni.app',
    'login.sendCode':'Verificatiecode versturen',
    'login.checkEmail':'Controleer je e-mail',
    'login.codeSentTo':'We hebben een 6-cijferige code gestuurd naar',
    'login.autoFilling':'Code wordt ingevuld…',
    'login.signInTitle':'Aanmelden','login.signInSub':'Voer je e-mailadres in',
    'login.emailNotFound':'Geen account gevonden. Wil je er een aanmaken?',
    'login.errGoogleExists':'Er is al een Google account geregistreerd. Log in.',
    'login.errAppleExists':'Er is al een Apple account geregistreerd. Log in.',
    'login.errEmailExists':'Dit e-mailadres is al geregistreerd. Log in.',
    'login.errInvalidEmail':'Voer een geldig e-mailadres in.',
    'lang.availableNow':'Nu beschikbaar',`
);

// Turkish
rep(
  `'login.or':'veya','login.signIn':'Giriş yap',`,
  `'login.or':'veya','login.signIn':'Giriş yap',
    'login.welcomeFirst':'Hoş geldiniz',
    'login.termsIntro':'Devam ederek',
    'login.termsLinkText':'Kullanım Şartlarını','login.termsAnd':'ve',
    'login.termsPrivacy':'Gizlilik Politikasını','login.termsSuffix':'kabul etmiş olursunuz',
    'login.signingIn':'Giriş yapılıyor:',
    'login.noAccountTitle':'Hesap bulunamadı',
    'login.noAccountSub':'Hesabınıza bağlı bir hesap bulunamadı.',
    'login.noAccountDesc':'Geri dönüp farklı bir yöntem deneyebilir veya yeni hesap oluşturmak için devam edebilirsiniz.',
    'login.noAccountBack':'Girişe geri dön','login.noAccountContinue':'Hesap oluştur',
    'login.noAccountCustom':'E-posta ile kayıt ol',
    'login.createAccountTitle':'Hesap oluştur','login.createAccountSub':'Nasıl kayıt olmak istediğinizi seçin',
    'login.signUpEmail':'E-posta ile kayıt ol',
    'login.createAccountEmailSub':'E-posta adresinizle kayıt olun',
    'login.fullName':'Ad Soyad','login.namePlaceholder':'Adınız',
    'login.emailPlaceholder':'ornek@munni.app',
    'login.sendCode':'Doğrulama kodu gönder',
    'login.checkEmail':'E-postanızı kontrol edin',
    'login.codeSentTo':'Şu adrese 6 haneli bir kod gönderdik:',
    'login.autoFilling':'Kod otomatik dolduruluyor…',
    'login.signInTitle':'Giriş yap','login.signInSub':'E-posta adresinizi girin',
    'login.emailNotFound':'Bu e-posta için hesap bulunamadı. Hesap oluşturmak ister misiniz?',
    'login.errGoogleExists':'Bir Google hesabı zaten kayıtlı. Giriş yapın.',
    'login.errAppleExists':'Bir Apple hesabı zaten kayıtlı. Giriş yapın.',
    'login.errEmailExists':'Bu e-posta adresi zaten kayıtlı. Giriş yapın.',
    'login.errInvalidEmail':'Lütfen geçerli bir e-posta adresi girin.',
    'lang.availableNow':'Şu an mevcut',`
);

// ===========================================================
// 3. Fix 'Available now' hardcoded header in language picker
// ===========================================================
rep(
  `<div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Available now</div>`,
  `<div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('lang.availableNow')}</div>`
);

// ===========================================================
// 4. Fix welcome: first visit = 'Welcome', return = 'Welcome back'
// ===========================================================
rep(
  `{hasOpenedBefore ? 'Welcome back' : t('login.welcome')}`,
  `{hasOpenedBefore ? t('login.welcome') : t('login.welcomeFirst')}`
);

// ===========================================================
// 5. emailInput initial state: use stored email or empty
// ===========================================================
rep(
  `const [emailInput, setEmailInput] = React.useState('custom@munni.app');`,
  `const [emailInput, setEmailInput] = React.useState(localStorage.getItem('munni_profile_email') || '');`
);

// ===========================================================
// 5b. Add noAccountMethod state
// ===========================================================
rep(
  `  const [loginError, setLoginError] = React.useState(null);
  const [signupError, setSignupError] = React.useState(null);`,
  `  const [loginError, setLoginError] = React.useState(null);
  const [signupError, setSignupError] = React.useState(null);
  const [noAccountMethod, setNoAccountMethod] = React.useState(null);`
);

// ===========================================================
// 6. handleGoogle: no-account → new mode instead of toast
// ===========================================================
rep(
  `if (!methods.includes('google')) { setLoginError('No account found for this Google account. Continue to sign up?'); return; }`,
  `if (!methods.includes('google')) { setNoAccountMethod('google'); setMode('no-account'); return; }`
);

// handleGoogle signup error → i18n
rep(
  `if (methods.includes('google')) { setSignupError('A Google account is already registered. Sign in instead.'); return; }`,
  `if (methods.includes('google')) { setSignupError(t('login.errGoogleExists')); return; }`
);

// ===========================================================
// 7. handleApple: no-account → new mode instead of toast
// ===========================================================
rep(
  `if (!methods.includes('apple')) { setLoginError('No account found for this Apple ID. Continue to sign up?'); return; }`,
  `if (!methods.includes('apple')) { setNoAccountMethod('apple'); setMode('no-account'); return; }`
);

// handleApple signup error → i18n
rep(
  `if (methods.includes('apple')) { setSignupError('An Apple account is already registered. Sign in instead.'); return; }`,
  `if (methods.includes('apple')) { setSignupError(t('login.errAppleExists')); return; }`
);

// ===========================================================
// 8. handleEmailContinue error → i18n
// ===========================================================
rep(
  `setLoginError('No account found for this email. Did you mean to create an account?');`,
  `setLoginError(t('login.emailNotFound'));`
);

// handleSignupEmail errors → i18n
rep(
  `if (!email.includes('@')) { setSignupError('Please enter a valid email address.'); return; }`,
  `if (!email.includes('@')) { setSignupError(t('login.errInvalidEmail')); return; }`
);
rep(
  `if (emails.includes(email)) { setSignupError('This email is already registered. Sign in instead.'); return; }`,
  `if (emails.includes(email)) { setSignupError(t('login.errEmailExists')); return; }`
);

// ===========================================================
// 9. Verification timing: 1200→300, 250→100 (handleEmailContinue)
// ===========================================================
rep(
  `        i++; setTimeout(fill, 250);
      };
      setTimeout(fill, 1200);
    }, 200);
  };

  // Signup email`,
  `        i++; setTimeout(fill, 100);
      };
      setTimeout(fill, 300);
    }, 200);
  };

  // Signup email`
);

// Verification timing (handleSignupEmail)
rep(
  `        i++; setTimeout(fill, 250);
      };
      setTimeout(fill, 1200);
    }, 200);
  };

  if (mode === 'language')`,
  `        i++; setTimeout(fill, 100);
      };
      setTimeout(fill, 300);
    }, 200);
  };

  if (mode === 'language')`
);

// ===========================================================
// 10. Branded loading screen (Google blue / Apple dark)
// ===========================================================
rep(
  `  // Loading overlay
  if (loadingMethod) {
    return (
      <div className="m-screen" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16, padding:40 }}>
        <div className="m-logo" style={{ fontSize:24, marginBottom:8 }}>munni<span className="dot">.</span></div>
        <div style={{ fontSize:14, color:M.ink3 }}>Signing in with {loadingMethod === 'google' ? 'Google' : 'Apple'}…</div>
        <div style={{ display:'flex', gap:6, marginTop:8 }}>
          {[0,1,2].map(i => <div key={i} style={{ width:8, height:8, borderRadius:'50%', background:M.sage, animation:\`mFadeIn 0.6s \${i*0.2}s infinite alternate\` }}/>)}
        </div>
      </div>
    );
  }`,
  `  // Loading overlay
  if (loadingMethod) {
    const isGoogle = loadingMethod === 'google';
    return (
      <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:24, padding:40, background: isGoogle ? M.paper : '#111' }}>
        <div style={{ width:80, height:80, borderRadius:24, background: isGoogle ? '#fff' : '#1C1C1E', display:'flex', alignItems:'center', justifyContent:'center', boxShadow: isGoogle ? '0 4px 24px rgba(66,133,244,0.18)' : '0 4px 24px rgba(0,0,0,0.5)' }}>
          {isGoogle ? <IcoGoogle size={44}/> : <IcoApple size={40} color="#fff"/>}
        </div>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:18, fontWeight:600, color: isGoogle ? M.ink : '#fff', marginBottom:6 }}>{t('login.signingIn')} {isGoogle ? 'Google' : 'Apple'}…</div>
          <div style={{ fontSize:13, color: isGoogle ? M.ink3 : 'rgba(255,255,255,0.5)' }}>{t('login.subtitle')}</div>
        </div>
        <div style={{ display:'flex', gap:7, marginTop:4 }}>
          {[0,1,2].map(i => <div key={i} style={{ width:8, height:8, borderRadius:'50%', background: isGoogle ? '#4285F4' : '#fff', animation:\`mFadeIn 0.6s \${i*0.2}s infinite alternate\` }}/>)}
        </div>
      </div>
    );
  }`
);

// ===========================================================
// 11. Add no-account view (insert before email-verify block)
// ===========================================================
rep(
  `  // Email verification
  if (mode === 'email-verify' || mode === 'signup-email-verify') {`,
  `  // No account found (Google / Apple)
  if (mode === 'no-account') {
    const isGoogle = noAccountMethod === 'google';
    return (
      <div className="m-screen m-fade">
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => { setMode('login'); setNoAccountMethod(null); }} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'32px 24px 40px', alignItems:'center' }}>
          <div style={{ width:72, height:72, borderRadius:20, background: isGoogle ? '#f8f9fa' : '#1C1C1E', display:'flex', alignItems:'center', justifyContent:'center', marginBottom:24, boxShadow: isGoogle ? '0 4px 16px rgba(66,133,244,0.15)' : '0 4px 16px rgba(0,0,0,0.2)' }}>
            {isGoogle ? <IcoGoogle size={38}/> : <IcoApple size={34} color="#fff"/>}
          </div>
          <div className="m-h2" style={{ marginBottom:10, textAlign:'center' }}>{t('login.noAccountTitle')}</div>
          <div style={{ fontSize:14, color:M.ink3, marginBottom:8, textAlign:'center', lineHeight:1.6 }}>{t('login.noAccountSub')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:36, textAlign:'center', lineHeight:1.6 }}>{t('login.noAccountDesc')}</div>
          <div style={{ width:'100%', display:'flex', flexDirection:'column', gap:10 }}>
            <button className="m-btn sage m-tap" style={{ height:52, width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:10 }} onClick={() => { isGoogle ? handleGoogle(true) : handleApple(true); }}>
              {isGoogle ? <IcoGoogle size={18}/> : <IcoApple size={18} color="#fff"/>}
              <span>{t('login.noAccountContinue')} {isGoogle ? 'Google' : 'Apple'}</span>
            </button>
            <button className="m-btn outline m-tap" style={{ height:48, width:'100%' }} onClick={() => { setNoAccountMethod(null); setSignupEmailInput(''); setSignupError(null); setMode('signup-email'); }}>
              {t('login.noAccountCustom')}
            </button>
            <button className="m-tap" onClick={() => { setMode('login'); setNoAccountMethod(null); }} style={{ background:'transparent', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, textDecoration:'underline', padding:'10px 0', textAlign:'center' }}>
              {t('login.noAccountBack')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Email verification
  if (mode === 'email-verify' || mode === 'signup-email-verify') {`
);

// ===========================================================
// 12. email-verify: Back goes to 'login' not 'email-input'
// ===========================================================
rep(
  `onClick={() => setMode(mode === 'email-verify' ? 'email-input' : 'signup-email')}`,
  `onClick={() => setMode(mode === 'email-verify' ? 'login' : 'signup-email')}`
);

// email-verify: Back button text + screen strings → i18n
rep(
  `<I name="arrowL" size={16} color={M.ink3}/> Back
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>Check your email</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:28, lineHeight:1.5 }}>
            We sent a 6-digit code to <strong>{emailForDisplay}</strong>
          </div>`,
  `<I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>{t('login.checkEmail')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:28, lineHeight:1.5 }}>
            {t('login.codeSentTo')} <strong>{emailForDisplay}</strong>
          </div>`
);

rep(
  `{autoFilling && <div style={{ textAlign:'center', fontSize:12, color:M.sage }}>Auto-filling code…</div>}`,
  `{autoFilling && <div style={{ textAlign:'center', fontSize:12, color:M.sage }}>{t('login.autoFilling')}</div>}`
);

// ===========================================================
// 13. email-input mode: back button + strings → i18n
// ===========================================================
rep(
  `<button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> Back
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>Sign in</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>Enter your email address</div>`,
  `<button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>{t('login.signInTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>{t('login.signInSub')}</div>`
);

rep(
  `type="email" placeholder="your@email.com"
            style={{ width:'100%', boxSizing:'border-box', padding:'14px 16px', borderRadius:12, border:\`1.5px solid \${loginError?M.clay:M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:loginError?8:16, color:M.ink }}`,
  `type="email" placeholder={t('login.emailPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'14px 16px', borderRadius:12, border:\`1.5px solid \${loginError?M.clay:M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:loginError?8:16, color:M.ink }}`
);

rep(
  `{loginError && <div style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setMode('signup-email'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>Create account →</button></div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%' }} onClick={handleEmailContinue}>Continue</button>`,
  `{loginError && <div style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setMode('signup-email'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>{t('login.createAccount')}</button></div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%' }} onClick={handleEmailContinue}>{t('login.continue')}</button>`
);

// ===========================================================
// 14. signup-email screen → i18n
// ===========================================================
rep(
  `<button className="m-tap" onClick={() => setMode('signup')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> Back
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>Create account</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>Sign up with your email address</div>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Full name</div>
          <input value={signupName} onChange={e => setSignupName(e.target.value)} placeholder="Your name"
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:\`1.5px solid \${M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:12, color:M.ink }}/>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Email address</div>
          <input value={signupEmailInput} onChange={e => { setSignupEmailInput(e.target.value); setSignupError(null); }} type="email" placeholder="your@email.com"
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:\`1.5px solid \${signupError?M.clay:M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:signupError?8:20, color:M.ink }}/>
          {signupError && <div style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{signupError}</div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%', opacity:signupEmailInput.trim() ? 1 : 0.5 }} onClick={handleSignupEmail} disabled={!signupEmailInput.trim()}>
            Send verification code
          </button>`,
  `<button className="m-tap" onClick={() => setMode('signup')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>{t('login.createAccountTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>{t('login.createAccountEmailSub')}</div>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('login.fullName')}</div>
          <input value={signupName} onChange={e => setSignupName(e.target.value)} placeholder={t('login.namePlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:\`1.5px solid \${M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:12, color:M.ink }}/>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('login.email')}</div>
          <input value={signupEmailInput} onChange={e => { setSignupEmailInput(e.target.value); setSignupError(null); }} type="email" placeholder={t('login.emailPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:\`1.5px solid \${signupError?M.clay:M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:signupError?8:20, color:M.ink }}/>
          {signupError && <div style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{signupError}</div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%', opacity:signupEmailInput.trim() ? 1 : 0.5 }} onClick={handleSignupEmail} disabled={!signupEmailInput.trim()}>
            {t('login.sendCode')}
          </button>`
);

// ===========================================================
// 15. signup screen → i18n + IcoGoogle/IcoApple
// ===========================================================
rep(
  `<button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> Sign in
          </button>`,
  `<button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('login.signIn')}
          </button>`
);

rep(
  `<div className="m-h2" style={{ marginBottom:4 }}>Create account</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>Choose how to sign up</div>`,
  `<div className="m-h2" style={{ marginBottom:4 }}>{t('login.createAccountTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>{t('login.createAccountSub')}</div>`
);

rep(
  `<button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleGoogle(true)}>
              <I name="g" size={20}/> Continue with Google
            </button>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleApple(true)}>
              <I name="apple" size={20}/> Continue with Apple
            </button>
            <Divr/>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:10 }} onClick={() => { setSignupEmailInput(''); setSignupError(null); setMode('signup-email'); }}>
              <I name="edit" size={18}/> Sign up with email
            </button>`,
  `<button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleGoogle(true)}>
              <IcoGoogle size={20}/> {t('login.google')}
            </button>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleApple(true)}>
              <IcoApple size={20} color={M.ink}/> {t('login.apple')}
            </button>
            <Divr/>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:10 }} onClick={() => { setSignupEmailInput(''); setSignupError(null); setMode('signup-email'); }}>
              <I name="edit" size={18}/> {t('login.signUpEmail')}
            </button>`
);

// ===========================================================
// 16. Main login screen: inline email field + real logos + fix terms
// ===========================================================
rep(
  `        {loginError && (
          <div style={{ padding:'10px 14px', borderRadius:10, background:M.ochreSoft, marginBottom:12, fontSize:13, color:M.ochre, lineHeight:1.4 }}>
            {loginError}
            <button onClick={() => { setLoginError(null); setMode('signup'); }} style={{ display:'block', marginTop:6, background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12, padding:0 }}>Create account instead →</button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={() => handleGoogle(false)}>
            <I name="g" size={20}/> {t('login.google')}
          </button>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={() => handleApple(false)}>
            <I name="apple" size={20}/> {t('login.apple')}
          </button>
          <Divr/>
          <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:10 }} onClick={() => { setLoginError(null); setMode('email-input'); }}>
            <I name="edit" size={18}/> {t('login.email')}
          </button>
        </div>`,
  `        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={() => handleGoogle(false)}>
            <IcoGoogle size={20}/> {t('login.google')}
          </button>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={() => handleApple(false)}>
            <IcoApple size={20} color={M.ink}/> {t('login.apple')}
          </button>
          <Divr/>
          <input
            value={emailInput} onChange={e => { setEmailInput(e.target.value); setLoginError(null); }}
            type="email" placeholder={t('login.emailPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'14px 16px', borderRadius:12, border:\`1.5px solid \${loginError?M.clay:M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
          />
          {loginError && <div style={{ fontSize:12, color:M.clay, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setMode('signup'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>{t('login.createAccount')}</button></div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%', opacity:emailInput.trim()?1:0.5 }} onClick={handleEmailContinue} disabled={!emailInput.trim()}>
            {t('login.continue')}
          </button>
        </div>`
);

// Fix terms text → i18n with clickable links
rep(
  `        <div style={{ fontSize: 11, color: M.ink4, textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
          By continuing you agree to our{' '}
          <button onClick={() => setMode('terms')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>Terms of Service</button>
          {' '}and{' '}
          <button onClick={() => setMode('privacy')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>Privacy Policy</button>
        </div>`,
  `        <div style={{ fontSize: 11, color: M.ink4, textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
          {t('login.termsIntro')}{' '}
          <button onClick={() => setMode('terms')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>{t('login.termsLinkText')}</button>
          {' '}{t('login.termsAnd')}{' '}
          <button onClick={() => setMode('privacy')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>{t('login.termsPrivacy')}</button>
          {t('login.termsSuffix') ? <>{' '}{t('login.termsSuffix')}</> : null}
        </div>`
);

// ===========================================================
// 17. Language picker: Twemoji image flags (cross-platform)
// ===========================================================
rep(
  `  const mainLangs = [
    { code:'en', name:'English', native:'English', flag:'🇬🇧' },
    { code:'nl', name:'Dutch', native:'Nederlands', flag:'🇳🇱' },
    { code:'tr', name:'Turkish', native:'Türkçe', flag:'🇹🇷' },
  ];`,
  `  const mainLangs = [
    { code:'en', name:'English', native:'English', twemoji:'1f1ec-1f1e7' },
    { code:'nl', name:'Dutch', native:'Nederlands', twemoji:'1f1f3-1f1f1' },
    { code:'tr', name:'Turkish', native:'Türkçe', twemoji:'1f1f9-1f1f7' },
  ];`
);

rep(
  `<div style={{ fontSize:28, width:40, textAlign:'center', flexShrink:0 }}>{l.flag}</div>`,
  `<img src={\`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/\${l.twemoji}.svg\`} width={36} height={36} style={{ borderRadius:3, flexShrink:0 }} alt={l.name}/>`
);

// ===========================================================
// 18. Settings user card: show login method instead of fake email
// ===========================================================
rep(
  `  const [email] = useLocalStorage('munni_profile_email', 'demo@munni.app');`,
  `  const [email] = useLocalStorage('munni_profile_email', '');`
);

rep(
  `  const isDemo = activeProfile?.id === 'p_demo' || activeProfile?.isDemo;
  const connectedBanks = connectedAccounts.filter(a => a.type === 'checking').length;`,
  `  const isDemo = activeProfile?.id === 'p_demo' || activeProfile?.isDemo;
  const connectedBanks = connectedAccounts.filter(a => a.type === 'checking').length;
  const _loginMethods = (() => { try { return JSON.parse(localStorage.getItem('munni_signup_methods') || '[]'); } catch { return []; } })();
  const emailDisplay = isDemo ? 'demo@munni.app' : (['google@munni.app','apple@munni.app','bank@munni.app'].includes(email) || !email) ? (_loginMethods.includes('google') ? 'Signed in with Google' : _loginMethods.includes('apple') ? 'Signed in with Apple' : email || '') : email;`
);

rep(
  `            <div style={{ fontSize: 12, color: M.ink3 }}>{email}</div>`,
  `            <div style={{ fontSize: 12, color: M.ink3 }}>{emailDisplay}</div>`
);

// ===========================================================
// 19. doLogin: always store email (even empty for social logins)
// ===========================================================
rep(
  `    if (email) localStorage.setItem('munni_profile_email', email);`,
  `    localStorage.setItem('munni_profile_email', email || '');`
);

// Pass empty string for Google/Apple logins
rep(
  `doLogin('google', 'google@munni.app', 'Google User');
      }
    }, 1400);
  };

  // Apple login/signup`,
  `doLogin('google', '', 'Google User');
      }
    }, 1400);
  };

  // Apple login/signup`
);

rep(
  `doLogin('apple', 'apple@munni.app', 'Apple User');
      }
    }, 1400);
  };

  // Email continue → go to verify`,
  `doLogin('apple', '', 'Apple User');
      }
    }, 1400);
  };

  // Email continue → go to verify`
);

// ===========================================================
// 20. Divr 'or' → t('login.or') (inside ScreenLoginGate)
// ===========================================================
rep(
  `<div style={{ flex:1, height:1, background:M.line2 }}/><div style={{ fontSize:12, color:M.ink4 }}>or</div><div style={{ flex:1, height:1, background:M.line2 }}/>`,
  `<div style={{ flex:1, height:1, background:M.line2 }}/><div style={{ fontSize:12, color:M.ink4 }}>{t('login.or')}</div><div style={{ flex:1, height:1, background:M.line2 }}/>`
);

fs.writeFileSync('munni.html', c.replace(/\n/g, '\r\n'), 'utf8');
console.log('\nDone.');
