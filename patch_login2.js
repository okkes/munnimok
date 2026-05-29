// patch_login2.js
const fs = require('fs');
let c = fs.readFileSync('munni.html', 'utf8').replace(/\r\n/g, '\n');

function rep(from, to) {
  if (c.indexOf(from) === -1) { console.warn('NOT FOUND:', from.slice(0, 80)); return; }
  c = c.replace(from, to);
  console.log('✓', from.slice(0, 70));
}

// ============================================================
// 1. Translations — add new keys
// ============================================================

// English
rep(
  `'login.errInvalidEmail':'Please enter a valid email address.',
    'lang.availableNow':'Available now',`,
  `'login.errInvalidEmail':'Please enter a valid email address.',
    'login.errNameRequired':'Name must be at least 2 characters.',
    'login.signedInGoogle':'Signed in with Google',
    'login.signedInApple':'Signed in with Apple',
    'login.connectedEmail':'Connected account',
    'lang.availableNow':'Available now',`
);

// Dutch
rep(
  `'login.errInvalidEmail':'Voer een geldig e-mailadres in.',
    'lang.availableNow':'Nu beschikbaar',`,
  `'login.errInvalidEmail':'Voer een geldig e-mailadres in.',
    'login.errNameRequired':'Naam moet minimaal 2 tekens bevatten.',
    'login.signedInGoogle':'Aangemeld via Google',
    'login.signedInApple':'Aangemeld via Apple',
    'login.connectedEmail':'Gekoppeld account',
    'lang.availableNow':'Nu beschikbaar',`
);

// Turkish
rep(
  `'login.errInvalidEmail':'Lütfen geçerli bir e-posta adresi girin.',
    'lang.availableNow':'Şu an mevcut',`,
  `'login.errInvalidEmail':'Lütfen geçerli bir e-posta adresi girin.',
    'login.errNameRequired':'Ad en az 2 karakter olmalıdır.',
    'login.signedInGoogle':'Google ile giriş yapıldı',
    'login.signedInApple':'Apple ile giriş yapıldı',
    'login.connectedEmail':'Bağlı hesap',
    'lang.availableNow':'Şu an mevcut',`
);

// ============================================================
// 2. Verify code: fix fill order (param instead of closure var)
// ============================================================

// handleEmailContinue fill loop
rep(
  `      const code = '4', digits = ['4','2','7','1','8','3'];
      let i = 0;
      const fill = () => {
        if (i >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => doLogin('email', emailInput.trim().toLowerCase(), null), 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[i]=digits[i]; return n; });
        i++; setTimeout(fill, 100);
      };
      setTimeout(fill, 300);`,
  `      const digits = ['4','2','7','1','8','3'];
      const fill = (idx) => {
        if (idx >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => doLogin('email', emailInput.trim().toLowerCase(), null), 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[idx]=digits[idx]; return n; });
        setTimeout(() => fill(idx + 1), 100);
      };
      setTimeout(() => fill(0), 300);`
);

// handleSignupEmail fill loop
rep(
  `      const digits = ['7','3','9','2','5','1'];
      let i = 0;
      const fill = () => {
        if (i >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => {
            const updatedEmails = [...emails, email];
            localStorage.setItem('munni_signup_emails', JSON.stringify(updatedEmails));
            doLogin('email', email, signupName.trim() || 'munni User');
          }, 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[i]=digits[i]; return n; });
        i++; setTimeout(fill, 100);
      };
      setTimeout(fill, 300);`,
  `      const digits = ['7','3','9','2','5','1'];
      const fill = (idx) => {
        if (idx >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => {
            const updatedEmails = [...emails, email];
            localStorage.setItem('munni_signup_emails', JSON.stringify(updatedEmails));
            doLogin('email', email, signupName.trim());
          }, 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[idx]=digits[idx]; return n; });
        setTimeout(() => fill(idx + 1), 100);
      };
      setTimeout(() => fill(0), 300);`
);

// ============================================================
// 3. doLogin: track last login method; don't overwrite name for
//    Google/Apple logins (only set it on signup, first time)
// ============================================================
rep(
  `  const doLogin = (method, email, displayName, activateDemo = false) => {
    const methods = [...new Set([...getSignupMethods(), method])];
    localStorage.setItem('munni_signup_methods', JSON.stringify(methods));
    localStorage.setItem('munni_opened_before', 'true');
    localStorage.setItem('munni_profile_email', email || '');
    if (displayName) localStorage.setItem('munni_profile_name', displayName);`,
  `  const doLogin = (method, email, displayName, activateDemo = false) => {
    const methods = [...new Set([...getSignupMethods(), method])];
    localStorage.setItem('munni_signup_methods', JSON.stringify(methods));
    localStorage.setItem('munni_last_login_method', method);
    localStorage.setItem('munni_opened_before', 'true');
    localStorage.setItem('munni_profile_email', email || '');
    if (displayName) localStorage.setItem('munni_profile_name', displayName);`
);

// Google login (not signup) — don't overwrite existing name
rep(
  `      if (!methods.includes('google')) { setNoAccountMethod('google'); setMode('no-account'); return; }
        doLogin('google', '', 'Google User');`,
  `      if (!methods.includes('google')) { setNoAccountMethod('google'); setMode('no-account'); return; }
        doLogin('google', '', null);`
);

// Apple login (not signup) — don't overwrite existing name
rep(
  `      if (!methods.includes('apple')) { setNoAccountMethod('apple'); setMode('no-account'); return; }
        doLogin('apple', '', 'Apple User');`,
  `      if (!methods.includes('apple')) { setNoAccountMethod('apple'); setMode('no-account'); return; }
        doLogin('apple', '', null);`
);

// ============================================================
// 4. Signup name validation (min 2 chars, not empty)
// ============================================================
rep(
  `  const handleSignupEmail = () => {
    setSignupError(null);
    const email = signupEmailInput.trim().toLowerCase();
    if (!email.includes('@')) { setSignupError(t('login.errInvalidEmail')); return; }`,
  `  const handleSignupEmail = () => {
    setSignupError(null);
    const trimmedName = signupName.trim();
    if (!trimmedName || trimmedName.length < 2) { setSignupError(t('login.errNameRequired')); return; }
    if (trimmedName.length > 50) { setSignupError('Name is too long (max 50 characters).'); return; }
    const email = signupEmailInput.trim().toLowerCase();
    if (!email.includes('@')) { setSignupError(t('login.errInvalidEmail')); return; }`
);

// Also add name field border feedback on error in signup-email screen
rep(
  `<input value={signupName} onChange={e => setSignupName(e.target.value)} placeholder={t('login.namePlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:\`1.5px solid \${M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:12, color:M.ink }}/>`,
  `<input value={signupName} onChange={e => { setSignupName(e.target.value); setSignupError(null); }} placeholder={t('login.namePlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:\`1.5px solid \${signupError && (!signupName.trim() || signupName.trim().length < 2) ? M.clay : M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:12, color:M.ink }}/>`
);

// ============================================================
// 5. ScreenProfile: fix name default + use last login method
// ============================================================
rep(
  `  const [name, setName] = useLocalStorage('munni_profile_name', 'Demo van der Berg');`,
  `  const [name, setName] = useLocalStorage('munni_profile_name', '');`
);

// initial avatar letter: handle empty name
rep(
  `  const initial = name.charAt(0).toUpperCase();`,
  `  const initial = (name || '?').charAt(0).toUpperCase();`
);

// Use last login method (not accumulated methods list) + i18n
rep(
  `  const _loginMethods = (() => { try { return JSON.parse(localStorage.getItem('munni_signup_methods') || '[]'); } catch { return []; } })();
  const emailDisplay = isDemo ? 'demo@munni.app' : (['google@munni.app','apple@munni.app','bank@munni.app'].includes(email) || !email) ? (_loginMethods.includes('google') ? 'Signed in with Google' : _loginMethods.includes('apple') ? 'Signed in with Apple' : email || '') : email;`,
  `  const _lastMethod = localStorage.getItem('munni_last_login_method') || '';
  const emailDisplay = isDemo ? 'demo@munni.app' : (email && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(email)) ? email : _lastMethod === 'google' ? t('login.signedInGoogle') : _lastMethod === 'apple' ? t('login.signedInApple') : (email || '');`
);

// ============================================================
// 6. ScreenTerms: browser back button + multi-language content
// ============================================================
rep(
  `function ScreenTerms({ onBack, showPrivacy = false }) {
  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={showPrivacy ? 'Privacy Policy' : 'Terms of Service'}
        leading={<button className="m-iconbtn m-tap" onClick={onBack}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll" style={{ fontSize:13, color:M.ink2, lineHeight:1.7 }}>
        {showPrivacy ? (
          <div>
            <div className="m-h3" style={{ marginBottom:8 }}>Privacy Policy</div>
            <div style={{ fontSize:11, color:M.ink3, marginBottom:16 }}>Last updated: January 2026</div>
            <p><strong>1. Data we collect</strong><br/>munni collects only the data necessary to provide financial tracking services: bank transaction data via PSD2 Open Banking (read-only), account balances, and user preferences. We never collect passwords or payment card numbers.</p>
            <p><strong>2. How we use your data</strong><br/>Your financial data is used solely to provide the munni service. We do not sell, rent, or share your personal data with third parties for marketing purposes.</p>
            <p><strong>3. Data storage</strong><br/>Data is stored securely using end-to-end encryption. Bank credentials are never stored on our servers — they are transmitted directly to your bank via PSD2.</p>
            <p><strong>4. Your rights</strong><br/>You have the right to access, correct, or delete your data at any time. Contact privacy@munni.app to exercise these rights.</p>
            <p><strong>5. Cookies</strong><br/>We use essential cookies only for authentication and session management. We do not use tracking or advertising cookies.</p>
            <p><strong>6. Contact</strong><br/>For privacy questions: privacy@munni.app</p>
          </div>
        ) : (
          <div>
            <div className="m-h3" style={{ marginBottom:8 }}>Terms of Service</div>
            <div style={{ fontSize:11, color:M.ink3, marginBottom:16 }}>Last updated: January 2026</div>
            <p><strong>1. Acceptance</strong><br/>By using munni, you agree to these Terms of Service. If you do not agree, please do not use the service.</p>
            <p><strong>2. Service description</strong><br/>munni is a personal finance management application that connects to your bank accounts via PSD2 Open Banking to provide read-only transaction tracking, budgeting, and financial insights.</p>
            <p><strong>3. Read-only access</strong><br/>munni has read-only access to your bank accounts. We can never initiate payments, transfers, or any financial transactions on your behalf.</p>
            <p><strong>4. User responsibilities</strong><br/>You are responsible for maintaining the security of your account credentials and for all activities that occur under your account.</p>
            <p><strong>5. Data accuracy</strong><br/>While we strive to provide accurate financial data, munni is not liable for any errors in data provided by third-party banking institutions.</p>
            <p><strong>6. Limitation of liability</strong><br/>munni is provided "as is" and we make no warranties regarding the accuracy or completeness of the service.</p>
            <p><strong>7. Changes to terms</strong><br/>We may update these terms from time to time. Continued use of munni after changes constitutes acceptance of the new terms.</p>
            <p><strong>8. Contact</strong><br/>For questions: legal@munni.app</p>
          </div>
        )}
      </div>
    </div>
  );
}`,
  `function ScreenTerms({ onBack, showPrivacy = false }) {
  const { lang } = useLang();

  React.useEffect(() => {
    window.history.pushState({ munniScreen: showPrivacy ? 'privacy' : 'terms' }, '');
    const handlePop = () => onBack();
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  const CONTENT = {
    privacy: {
      en: {
        title: 'Privacy Policy', updated: 'Last updated: January 2026',
        sections: [
          ['Data we collect', 'munni collects only the data necessary to provide financial tracking services: bank transaction data via PSD2 Open Banking (read-only), account balances, and user preferences. We never collect passwords or payment card numbers.'],
          ['How we use your data', 'Your financial data is used solely to provide the munni service. We do not sell, rent, or share your personal data with third parties for marketing purposes.'],
          ['Data storage', 'Data is stored securely using end-to-end encryption. Bank credentials are never stored on our servers — they are transmitted directly to your bank via PSD2.'],
          ['Your rights', 'You have the right to access, correct, or delete your data at any time. Contact privacy@munni.app to exercise these rights.'],
          ['Cookies', 'We use essential cookies only for authentication and session management. We do not use tracking or advertising cookies.'],
          ['Contact', 'For privacy questions: privacy@munni.app'],
        ],
      },
      nl: {
        title: 'Privacybeleid', updated: 'Laatst bijgewerkt: januari 2026',
        sections: [
          ['Gegevens die we verzamelen', 'munni verzamelt alleen de gegevens die nodig zijn voor financiële trackingdiensten: banktransactiegegevens via PSD2 Open Banking (alleen-lezen), rekeningbalansen en gebruikersvoorkeuren. We verzamelen nooit wachtwoorden of betaalkaartgegevens.'],
          ['Hoe we uw gegevens gebruiken', 'Uw financiële gegevens worden uitsluitend gebruikt voor het leveren van de munni-service. We verkopen, verhuren of delen uw persoonlijke gegevens niet met derden voor marketingdoeleinden.'],
          ['Gegevensopslag', 'Gegevens worden veilig opgeslagen met end-to-end-encryptie. Bankreferenties worden nooit op onze servers opgeslagen — ze worden via PSD2 rechtstreeks naar uw bank verzonden.'],
          ['Uw rechten', 'U heeft het recht om uw gegevens op elk moment in te zien, te corrigeren of te verwijderen. Neem contact op met privacy@munni.app om deze rechten uit te oefenen.'],
          ['Cookies', 'We gebruiken alleen essentiële cookies voor verificatie en sessiebeheer. We gebruiken geen tracking- of advertentiecookies.'],
          ['Contact', 'Voor privacyvragen: privacy@munni.app'],
        ],
      },
      tr: {
        title: 'Gizlilik Politikası', updated: 'Son güncelleme: Ocak 2026',
        sections: [
          ['Topladığımız veriler', "munni, finansal izleme hizmetleri sunmak için yalnızca gerekli verileri toplar: PSD2 Açık Bankacılık aracılığıyla banka işlem verileri (salt okunur), hesap bakiyeleri ve kullanıcı tercihleri. Hiçbir zaman şifre veya ödeme kartı numarası toplamayız."],
          ['Verilerinizi nasıl kullanıyoruz', 'Finansal verileriniz yalnızca munni hizmetini sağlamak için kullanılır. Kişisel verilerinizi pazarlama amacıyla üçüncü taraflara satmaz, kiralamaz veya paylaşmayız.'],
          ['Veri depolama', 'Veriler uçtan uca şifreleme ile güvenli bir şekilde depolanır. Banka kimlik bilgileri sunucularımızda hiçbir zaman saklanmaz — PSD2 aracılığıyla doğrudan bankanıza iletilir.'],
          ['Haklarınız', 'Verilerinize erişme, düzeltme veya silme hakkına sahipsiniz. Bu hakları kullanmak için privacy@munni.app ile iletişime geçin.'],
          ['Çerezler', 'Yalnızca kimlik doğrulama ve oturum yönetimi için temel çerezler kullanıyoruz. İzleme veya reklam çerezleri kullanmıyoruz.'],
          ['İletişim', 'Gizlilik soruları için: privacy@munni.app'],
        ],
      },
    },
    terms: {
      en: {
        title: 'Terms of Service', updated: 'Last updated: January 2026',
        sections: [
          ['Acceptance', 'By using munni, you agree to these Terms of Service. If you do not agree, please do not use the service.'],
          ['Service description', 'munni is a personal finance management application that connects to your bank accounts via PSD2 Open Banking to provide read-only transaction tracking, budgeting, and financial insights.'],
          ['Read-only access', 'munni has read-only access to your bank accounts. We can never initiate payments, transfers, or any financial transactions on your behalf.'],
          ['User responsibilities', 'You are responsible for maintaining the security of your account credentials and for all activities that occur under your account.'],
          ['Data accuracy', 'While we strive to provide accurate financial data, munni is not liable for any errors in data provided by third-party banking institutions.'],
          ['Limitation of liability', 'munni is provided "as is" and we make no warranties regarding the accuracy or completeness of the service.'],
          ['Changes to terms', 'We may update these terms from time to time. Continued use of munni after changes constitutes acceptance of the new terms.'],
          ['Contact', 'For questions: legal@munni.app'],
        ],
      },
      nl: {
        title: 'Gebruiksvoorwaarden', updated: 'Laatst bijgewerkt: januari 2026',
        sections: [
          ['Acceptatie', 'Door munni te gebruiken, gaat u akkoord met deze Gebruiksvoorwaarden. Als u niet akkoord gaat, gebruik de service dan niet.'],
          ['Servicebeschrijving', 'munni is een persoonlijke financiën-applicatie die via PSD2 Open Banking verbinding maakt met uw bankrekeningen voor alleen-lezen transactietracking, budgettering en financiële inzichten.'],
          ['Alleen-lezen toegang', 'munni heeft alleen-lezen toegang tot uw bankrekeningen. Wij kunnen nooit betalingen, overboekingen of andere financiële transacties namens u initiëren.'],
          ['Gebruikersverantwoordelijkheden', 'U bent verantwoordelijk voor de beveiliging van uw accountgegevens en voor alle activiteiten die plaatsvinden onder uw account.'],
          ['Nauwkeurigheid van gegevens', 'Hoewel we streven naar nauwkeurige financiële gegevens, is munni niet aansprakelijk voor fouten in gegevens van derde bancaire instellingen.'],
          ['Beperking van aansprakelijkheid', 'munni wordt geleverd zoals het is en wij geven geen garanties met betrekking tot de nauwkeurigheid of volledigheid van de service.'],
          ['Wijzigingen in de voorwaarden', 'We kunnen deze voorwaarden van tijd tot tijd bijwerken. Voortgezet gebruik van munni na wijzigingen houdt acceptatie van de nieuwe voorwaarden in.'],
          ['Contact', 'Voor vragen: legal@munni.app'],
        ],
      },
      tr: {
        title: 'Kullanım Şartları', updated: 'Son güncelleme: Ocak 2026',
        sections: [
          ['Kabul', "munni'yi kullanarak bu Kullanım Şartlarını kabul etmiş olursunuz. Kabul etmiyorsanız, lütfen hizmeti kullanmayın."],
          ['Hizmet açıklaması', "munni, salt okunur işlem takibi, bütçeleme ve finansal içgörüler sağlamak için PSD2 Açık Bankacılık aracılığıyla banka hesaplarınıza bağlanan kişisel bir finans yönetimi uygulamasıdır."],
          ['Salt okunur erişim', "munni, banka hesaplarınıza salt okunur erişime sahiptir. Adınıza hiçbir zaman ödeme, transfer veya finansal işlem başlatamayız."],
          ['Kullanıcı sorumlulukları', 'Hesap kimlik bilgilerinizin güvenliğinden ve hesabınız altında gerçekleşen tüm faaliyetlerden siz sorumlusunuz.'],
          ['Veri doğruluğu', 'Doğru finansal veriler sağlamak için çaba göstersek de, munni üçüncü taraf bankacılık kurumlarının sağladığı verilerdeki hatalardan sorumlu değildir.'],
          ['Sorumluluk sınırlaması', 'munni olduğu gibi sunulmaktadır ve hizmetin doğruluğu ya da eksiksizliği konusunda herhangi bir garanti vermeyiz.'],
          ['Şartlarda değişiklikler', "Bu şartları zaman zaman güncelleyebiliriz. Değişikliklerden sonra munni'yi kullanmaya devam etmek, yeni şartların kabulü anlamına gelir."],
          ['İletişim', 'Sorular için: legal@munni.app'],
        ],
      },
    },
  };

  const key = showPrivacy ? 'privacy' : 'terms';
  const data = CONTENT[key][lang] || CONTENT[key].en;

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={data.title}
        leading={<button className="m-iconbtn m-tap" onClick={onBack}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll" style={{ fontSize:13, color:M.ink2, lineHeight:1.7 }}>
        <div>
          <div className="m-h3" style={{ marginBottom:8 }}>{data.title}</div>
          <div style={{ fontSize:11, color:M.ink3, marginBottom:16 }}>{data.updated}</div>
          {data.sections.map(([heading, body], i) => (
            <p key={i}><strong>{i + 1}. {heading}</strong><br/>{body}</p>
          ))}
        </div>
      </div>
    </div>
  );
}`
);

fs.writeFileSync('munni.html', c.replace(/\n/g, '\r\n'), 'utf8');
console.log('\nDone.');
