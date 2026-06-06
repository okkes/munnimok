import React from 'react';
import { T } from './testIds.js';
import { getUserId, computeProfileKey, getDefaultProfiles, initPerUserData, registerUserInGlobalRegistry, computeUserDataKey } from './data.jsx';
import { IOSDevice } from './IOSFrame.jsx';
import { M, I, IcoGoogle, IcoApple, Divider, StatusBar, AppBar } from './theme.jsx';
import { DarkCtx, NavProvider, useNav, Sheet } from './nav.jsx';
import { useLang, LangProvider } from './i18n.jsx';
import { useLocalStorage, useSessionStorage } from './hooks.jsx';
import { AppCtx, CatProvider, ProfilesProvider, useProfiles, TxProvider, RecurProvider, AllocProvider, useConnectedAccounts, ScreenAllocate, ScreenAllocateTopic, ScreenAllocateAddTopic, ResetSignalListener } from './providers.jsx';
import { ScreenStub } from './screens/Stub.jsx';
import { ScreenHome } from './screens/Home.jsx';
import { ScreenTransactions, ScreenTxDetail, ScreenExpenses, ScreenCategoryDrill } from './screens/Tx.jsx';
import { ScreenEvents, ScreenEventDetail, ScreenEventCreate } from './screens/Events.jsx';
import { ScreenProfile, ScreenProfiles, ScreenProfileDetail } from './screens/Profile.jsx';
import { ScreenLanguagePicker, ScreenSettings, ScreenPeriods, ScreenTutorial, ScreenNotifications, ScreenManageCategories, ScreenCustomizeHome } from './screens/Settings.jsx';
import { ScreenAccounts, ScreenSavings, ScreenSavingsDetail, ScreenSavingAccounts, ScreenAccountsAll, ScreenIntegrations, ScreenIntegrationLogin, ScreenIntegrationReceipts } from './screens/Accounts.jsx';
import { ScreenRecurringTab, ScreenRecurringDetail, ScreenRecurringCreate, ScreenRecurringDeals } from './screens/Recurring.jsx';
import { ScreenBudgets, ScreenBudgetDetail, ScreenBudgetCreate } from './screens/Budgets.jsx';
import { ScreenInvestment, ScreenInvestmentConnect } from './screens/Investment.jsx';
import { ScreenGoals, ScreenGoalDetail } from './screens/Goals.jsx';
import { ScreenReviewSwipe, ScreenLinkReimburse } from './screens/Review.jsx';
import { ScreenIncome, ScreenInvested, ScreenInsights, ScreenDebts, ScreenLogin, ScreenSignupGate, ScreenSignupProd, ScreenCustomGraphCreate, ScreenSignupDemo } from './screens/Extra.jsx';
import { ScreenFriends } from './screens/Friends.jsx';


export const SCREEN_REGISTRY = {
  txDetail:       ({params}) => <ScreenTxDetail params={params}/>,
  expenses:       () => <ScreenExpenses/>,
  categoryDrill:  ({params}) => <ScreenCategoryDrill params={params}/>,
  linkReimburse:  ({params}) => <ScreenLinkReimburse params={params}/>,
  search:         () => <ScreenStub title="Search"/>,
  sync:           () => <ScreenStub title="Sync"/>,
  notifications:  () => <ScreenNotifications/>,
  periods:        () => <ScreenPeriods/>,
  tutorial:       () => <ScreenTutorial/>,
  manageCategories: () => <ScreenManageCategories/>,
  budgets:        () => <ScreenBudgets/>,
  budgetDetail:   ({params}) => <ScreenBudgetDetail params={params}/>,
  budgetCreate:   () => <ScreenBudgetCreate/>,
  goals:          () => <ScreenGoals/>,
  goalDetail:     ({params}) => <ScreenGoalDetail params={params}/>,
  reviewSwipe:    () => <ScreenReviewSwipe/>,
  recurringDetail:   ({params}) => <ScreenRecurringDetail params={params}/>,
  recurringCreate:   () => <ScreenRecurringCreate/>,
  recurringDeals:    ({params}) => <ScreenRecurringDeals params={params}/>,
  customizeHome:     () => <ScreenCustomizeHome/>,
  allocate:          () => <ScreenAllocate/>,
  allocateTopic:     ({params}) => <ScreenAllocateTopic params={params}/>,
  allocateAddTopic:  () => <ScreenAllocateAddTopic/>,
  investment:     () => <ScreenInvestment/>,
  investmentConnect: () => <ScreenInvestmentConnect/>,
  eventDetail:    ({params}) => <ScreenEventDetail params={params}/>,
  eventCreate:    () => <ScreenEventCreate/>,
  accounts:       () => <ScreenAccounts/>,
  accountsAll:    () => <ScreenAccountsAll/>,
  profiles:       () => <ScreenProfiles/>,
  profileDetail:  ({params}) => <ScreenProfileDetail params={params}/>,
  integrations:   ({params}) => <ScreenIntegrations params={params}/>,
  integrationLogin: ({params}) => <ScreenIntegrationLogin params={params}/>,
  integrationReceipts: ({params}) => <ScreenIntegrationReceipts params={params}/>,
  savings:        () => <ScreenSavings/>,
  savingsDetail:  ({params}) => <ScreenSavingsDetail params={params}/>,
  savingAccounts: () => <ScreenSavingAccounts/>,
  settings:       () => <ScreenSettings/>,
  income:         () => <ScreenIncome/>,
  invested:       () => <ScreenInvested/>,
  debts:          () => <ScreenDebts/>,
  login:          () => <ScreenLogin/>,
  signupGate:     () => <ScreenSignupGate/>,
  signupProd:     () => <ScreenSignupProd/>,
  signupDemo:     () => <ScreenSignupDemo/>,
  language:       () => <ScreenLanguagePicker/>,
  customGraphCreate: () => <ScreenCustomGraphCreate/>,
  friends:           () => <ScreenFriends/>,
};

function TabRoot() {
  const nav = useNav();
  if (nav.tab === 'home')      return <ScreenHome/>;
  if (nav.tab === 'tx')        return <ScreenTransactions/>;
  if (nav.tab === 'recurring') return <ScreenRecurringTab/>;
  if (nav.tab === 'events')    return <ScreenEvents/>;
  if (nav.tab === 'insights')  return <ScreenInsights/>;
  if (nav.tab === 'profile')   return <ScreenProfile/>;
  return null;
}

function Router() {
  const nav = useNav();
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: M.paper, overflow: 'hidden' }}>
      <TabRoot/>
      {nav.stack.map((entry, i) => {
        const Comp = SCREEN_REGISTRY[entry.screen];
        if (!Comp) return null;
        return (
          <div key={i} style={{
            position: 'absolute', inset: 0, background: M.paper,
            animation: 'mSlideIn 0.28s cubic-bezier(.2,.7,.2,1) both',
          }}>
            <Comp params={entry.params}/>
          </div>
        );
      })}
    </div>
  );
}

function ScreenTerms({ onBack, showPrivacy = false }) {
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
          ['Data storage', 'Data is stored securely using end-to-end encryption. Bank credentials are never stored on our servers â€” they are transmitted directly to your bank via PSD2.'],
          ['Your rights', 'You have the right to access, correct, or delete your data at any time. Contact privacy@munni.app to exercise these rights.'],
          ['Cookies', 'We use essential cookies only for authentication and session management. We do not use tracking or advertising cookies.'],
          ['Contact', 'For privacy questions: privacy@munni.app'],
        ],
      },
      nl: {
        title: 'Privacybeleid', updated: 'Laatst bijgewerkt: januari 2026',
        sections: [
          ['Gegevens die we verzamelen', 'munni verzamelt alleen de gegevens die nodig zijn voor financiÃ«le trackingdiensten: banktransactiegegevens via PSD2 Open Banking (alleen-lezen), rekeningbalansen en gebruikersvoorkeuren. We verzamelen nooit wachtwoorden of betaalkaartgegevens.'],
          ['Hoe we uw gegevens gebruiken', 'Uw financiÃ«le gegevens worden uitsluitend gebruikt voor het leveren van de munni-service. We verkopen, verhuren of delen uw persoonlijke gegevens niet met derden voor marketingdoeleinden.'],
          ['Gegevensopslag', 'Gegevens worden veilig opgeslagen met end-to-end-encryptie. Bankreferenties worden nooit op onze servers opgeslagen â€” ze worden via PSD2 rechtstreeks naar uw bank verzonden.'],
          ['Uw rechten', 'U heeft het recht om uw gegevens op elk moment in te zien, te corrigeren of te verwijderen. Neem contact op met privacy@munni.app om deze rechten uit te oefenen.'],
          ['Cookies', 'We gebruiken alleen essentiÃ«le cookies voor verificatie en sessiebeheer. We gebruiken geen tracking- of advertentiecookies.'],
          ['Contact', 'Voor privacyvragen: privacy@munni.app'],
        ],
      },
      tr: {
        title: 'Gizlilik PolitikasÄ±', updated: 'Son gÃ¼ncelleme: Ocak 2026',
        sections: [
          ['TopladÄ±ÄŸÄ±mÄ±z veriler', "munni, finansal izleme hizmetleri sunmak iÃ§in yalnÄ±zca gerekli verileri toplar: PSD2 AÃ§Ä±k BankacÄ±lÄ±k aracÄ±lÄ±ÄŸÄ±yla banka iÅŸlem verileri (salt okunur), hesap bakiyeleri ve kullanÄ±cÄ± tercihleri. HiÃ§bir zaman ÅŸifre veya Ã¶deme kartÄ± numarasÄ± toplamayÄ±z."],
          ['Verilerinizi nasÄ±l kullanÄ±yoruz', 'Finansal verileriniz yalnÄ±zca munni hizmetini saÄŸlamak iÃ§in kullanÄ±lÄ±r. KiÅŸisel verilerinizi pazarlama amacÄ±yla Ã¼Ã§Ã¼ncÃ¼ taraflara satmaz, kiralamaz veya paylaÅŸmayÄ±z.'],
          ['Veri depolama', 'Veriler uÃ§tan uca ÅŸifreleme ile gÃ¼venli bir ÅŸekilde depolanÄ±r. Banka kimlik bilgileri sunucularÄ±mÄ±zda hiÃ§bir zaman saklanmaz â€” PSD2 aracÄ±lÄ±ÄŸÄ±yla doÄŸrudan bankanÄ±za iletilir.'],
          ['HaklarÄ±nÄ±z', 'Verilerinize eriÅŸme, dÃ¼zeltme veya silme hakkÄ±na sahipsiniz. Bu haklarÄ± kullanmak iÃ§in privacy@munni.app ile iletiÅŸime geÃ§in.'],
          ['Ã‡erezler', 'YalnÄ±zca kimlik doÄŸrulama ve oturum yÃ¶netimi iÃ§in temel Ã§erezler kullanÄ±yoruz. Ä°zleme veya reklam Ã§erezleri kullanmÄ±yoruz.'],
          ['Ä°letiÅŸim', 'Gizlilik sorularÄ± iÃ§in: privacy@munni.app'],
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
          ['Servicebeschrijving', 'munni is een persoonlijke financiÃ«n-applicatie die via PSD2 Open Banking verbinding maakt met uw bankrekeningen voor alleen-lezen transactietracking, budgettering en financiÃ«le inzichten.'],
          ['Alleen-lezen toegang', 'munni heeft alleen-lezen toegang tot uw bankrekeningen. Wij kunnen nooit betalingen, overboekingen of andere financiÃ«le transacties namens u initiÃ«ren.'],
          ['Gebruikersverantwoordelijkheden', 'U bent verantwoordelijk voor de beveiliging van uw accountgegevens en voor alle activiteiten die plaatsvinden onder uw account.'],
          ['Nauwkeurigheid van gegevens', 'Hoewel we streven naar nauwkeurige financiÃ«le gegevens, is munni niet aansprakelijk voor fouten in gegevens van derde bancaire instellingen.'],
          ['Beperking van aansprakelijkheid', 'munni wordt geleverd zoals het is en wij geven geen garanties met betrekking tot de nauwkeurigheid of volledigheid van de service.'],
          ['Wijzigingen in de voorwaarden', 'We kunnen deze voorwaarden van tijd tot tijd bijwerken. Voortgezet gebruik van munni na wijzigingen houdt acceptatie van de nieuwe voorwaarden in.'],
          ['Contact', 'Voor vragen: legal@munni.app'],
        ],
      },
      tr: {
        title: 'KullanÄ±m ÅžartlarÄ±', updated: 'Son gÃ¼ncelleme: Ocak 2026',
        sections: [
          ['Kabul', "munni'yi kullanarak bu KullanÄ±m ÅžartlarÄ±nÄ± kabul etmiÅŸ olursunuz. Kabul etmiyorsanÄ±z, lÃ¼tfen hizmeti kullanmayÄ±n."],
          ['Hizmet aÃ§Ä±klamasÄ±', "munni, salt okunur iÅŸlem takibi, bÃ¼tÃ§eleme ve finansal iÃ§gÃ¶rÃ¼ler saÄŸlamak iÃ§in PSD2 AÃ§Ä±k BankacÄ±lÄ±k aracÄ±lÄ±ÄŸÄ±yla banka hesaplarÄ±nÄ±za baÄŸlanan kiÅŸisel bir finans yÃ¶netimi uygulamasÄ±dÄ±r."],
          ['Salt okunur eriÅŸim', "munni, banka hesaplarÄ±nÄ±za salt okunur eriÅŸime sahiptir. AdÄ±nÄ±za hiÃ§bir zaman Ã¶deme, transfer veya finansal iÅŸlem baÅŸlatamayÄ±z."],
          ['KullanÄ±cÄ± sorumluluklarÄ±', 'Hesap kimlik bilgilerinizin gÃ¼venliÄŸinden ve hesabÄ±nÄ±z altÄ±nda gerÃ§ekleÅŸen tÃ¼m faaliyetlerden siz sorumlusunuz.'],
          ['Veri doÄŸruluÄŸu', 'DoÄŸru finansal veriler saÄŸlamak iÃ§in Ã§aba gÃ¶stersek de, munni Ã¼Ã§Ã¼ncÃ¼ taraf bankacÄ±lÄ±k kurumlarÄ±nÄ±n saÄŸladÄ±ÄŸÄ± verilerdeki hatalardan sorumlu deÄŸildir.'],
          ['Sorumluluk sÄ±nÄ±rlamasÄ±', 'munni olduÄŸu gibi sunulmaktadÄ±r ve hizmetin doÄŸruluÄŸu ya da eksiksizliÄŸi konusunda herhangi bir garanti vermeyiz.'],
          ['Åžartlarda deÄŸiÅŸiklikler', "Bu ÅŸartlarÄ± zaman zaman gÃ¼ncelleyebiliriz. DeÄŸiÅŸikliklerden sonra munni'yi kullanmaya devam etmek, yeni ÅŸartlarÄ±n kabulÃ¼ anlamÄ±na gelir."],
          ['Ä°letiÅŸim', 'Sorular iÃ§in: legal@munni.app'],
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
}

function ScreenLoginGate({ onLogin }) {
  // mode: 'login'|'email-input'|'email-verify'|'google-loading'|'apple-loading'
  //       'signup'|'signup-google'|'signup-apple'|'signup-email'|'signup-email-verify'
  //       'signup-bank'|'terms'|'privacy'|'language'
  const [mode, setMode] = React.useState('login');
  const { t, lang } = useLang();
  const [emailInput, setEmailInput] = React.useState(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem('munni_profile_email') || '""');
      return (v && !['google@munni.app','apple@munni.app','bank@munni.app'].includes(v)) ? v : '';
    } catch { return ''; }
  });
  const [signupEmailInput, setSignupEmailInput] = React.useState('');
  const [signupName, setSignupName] = React.useState('');
  const [verifyDigits, setVerifyDigits] = React.useState(['','','','','','']);
  const [autoFilling, setAutoFilling] = React.useState(false);
  const [loadingMethod, setLoadingMethod] = React.useState(null);
  const [loginError, setLoginError] = React.useState(null);
  const [signupError, setSignupError] = React.useState(null);
  const [noAccountMethod, setNoAccountMethod] = React.useState(null);

  const hasOpenedBefore = localStorage.getItem('munni_opened_before') === 'true';
  const getSignupMethods = () => { try { return JSON.parse(localStorage.getItem('munni_signup_methods') || '[]'); } catch { return []; } };
  const getSignupEmails = () => { try { return JSON.parse(localStorage.getItem('munni_signup_emails') || '[]'); } catch { return []; } };

  const MODE_BACK = { signup:'login', 'signup-email':'signup', 'signup-email-verify':'signup-email', 'email-verify':'login', 'no-account':'login', 'signup-bank':'login', 'email-input':'login', language:'login' };
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  React.useEffect(() => {
    if (!MODE_BACK[mode]) return;
    window.history.pushState({ munniLoginMode: mode }, '');
    const handlePop = () => { const prev = MODE_BACK[modeRef.current]; if (prev) setMode(prev); };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, [mode]);

  const doLogin = (method, email, displayName, activateDemo = false, signupLang = 'en') => {
    const methods = [...new Set([...getSignupMethods(), method])];
    localStorage.setItem('munni_signup_methods', JSON.stringify(methods));
    sessionStorage.setItem('munni_last_login_method', method);
    window.dispatchEvent(new CustomEvent('munni-ss', { detail: { key: 'munni_last_login_method' } }));
    localStorage.setItem('munni_opened_before', 'true');
    sessionStorage.setItem('munni_profile_email', JSON.stringify(email || ''));
    window.dispatchEvent(new CustomEvent('munni-ss', { detail: { key: 'munni_profile_email' } }));
    const userId = getUserId();
    const name = displayName || (method === 'google' ? 'Google van der Berg' : method === 'apple' ? 'Apple van der Berg' : method === 'bank' ? 'Demo User' : email || userId);
    const nameKey = computeUserDataKey(method, email, 'munni_profile_name');
    localStorage.setItem(nameKey, JSON.stringify(name));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: nameKey } }));
    initPerUserData(method, email, signupLang);
    if (activateDemo) {
      // Always reset demo profiles to clean Demo default so demo user is never stale
      const profileKey = computeProfileKey(method, email || '');
      localStorage.setItem(profileKey, JSON.stringify(getDefaultProfiles('bank')));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: profileKey } }));
    }
    registerUserInGlobalRegistry(userId, name);
    sessionStorage.setItem('munni_session_active', 'true');
    onLogin();
  };

  // Google login/signup
  const handleGoogle = (isSignup = false) => {
    setLoginError(null); setSignupError(null);
    setLoadingMethod('google');
    setTimeout(() => {
      setLoadingMethod(null);
      const methods = getSignupMethods();
      if (isSignup) {
        if (methods.includes('google')) { setSignupError(t('login.errGoogleExists')); return; }
        doLogin('google', 'google@munni.app', 'Google van der Berg');
      } else {
        if (!methods.includes('google')) { setNoAccountMethod('google'); setMode('no-account'); return; }
        doLogin('google', '', null);
      }
    }, 1400);
  };

  // Apple login/signup
  const handleApple = (isSignup = false) => {
    setLoginError(null); setSignupError(null);
    setLoadingMethod('apple');
    setTimeout(() => {
      setLoadingMethod(null);
      const methods = getSignupMethods();
      if (isSignup) {
        if (methods.includes('apple')) { setSignupError(t('login.errAppleExists')); return; }
        doLogin('apple', 'apple@munni.app', 'Apple van der Berg');
      } else {
        if (!methods.includes('apple')) { setNoAccountMethod('apple'); setMode('no-account'); return; }
        doLogin('apple', '', null);
      }
    }, 1400);
  };

  // Email continue â†’ go to verify
  const handleEmailContinue = () => {
    setLoginError(null);
    const methods = getSignupMethods();
    const emails = getSignupEmails();
    if (!methods.includes('email') || !emails.includes(emailInput.toLowerCase().trim())) {
      setLoginError(t('login.emailNotFound'));
      return;
    }
    setMode('email-verify');
    setVerifyDigits(['','','','','','']);
    setAutoFilling(false);
    setTimeout(() => {
      setAutoFilling(true);
      const digits = ['4','2','7','1','8','3'];
      const fill = (idx) => {
        if (idx >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => doLogin('email', emailInput.trim().toLowerCase(), null), 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[idx]=digits[idx]; return n; });
        setTimeout(() => fill(idx + 1), 100);
      };
      setTimeout(() => fill(0), 300);
    }, 200);
  };

  // Signup email
  const handleSignupEmail = () => {
    setSignupError(null);
    const trimmedName = signupName.trim();
    if (!trimmedName || trimmedName.length < 2) { setSignupError(t('login.errNameRequired')); return; }
    if (trimmedName.length > 50) { setSignupError('Name is too long (max 50 characters).'); return; }
    const email = signupEmailInput.trim().toLowerCase();
    if (!email.includes('@')) { setSignupError(t('login.errInvalidEmail')); return; }
    const emails = getSignupEmails();
    if (emails.includes(email)) { setSignupError(t('login.errEmailExists')); return; }
    setMode('signup-email-verify');
    setVerifyDigits(['','','','','','']);
    setAutoFilling(false);
    setTimeout(() => {
      setAutoFilling(true);
      const digits = ['7','3','9','2','5','1'];
      const fill = (idx) => {
        if (idx >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => {
            const updatedEmails = [...emails, email];
            localStorage.setItem('munni_signup_emails', JSON.stringify(updatedEmails));
            doLogin('email', email, signupName.trim(), false, lang);
          }, 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[idx]=digits[idx]; return n; });
        setTimeout(() => fill(idx + 1), 100);
      };
      setTimeout(() => fill(0), 300);
    }, 200);
  };

  if (mode === 'language') return <ScreenLanguagePicker fromOnboarding={true} onBack={() => setMode('login')}/>;
  if (mode === 'terms') return <ScreenTerms onBack={() => setMode('login')} showPrivacy={false}/>;
  if (mode === 'privacy') return <ScreenTerms onBack={() => setMode('login')} showPrivacy={true}/>;

  const Divr = () => (
    <div style={{ display:'flex', alignItems:'center', gap:12, margin:'4px 0' }}>
      <div style={{ flex:1, height:1, background:M.line2 }}/><div style={{ fontSize:12, color:M.ink4 }}>{t('login.or')}</div><div style={{ flex:1, height:1, background:M.line2 }}/>
    </div>
  );

  // Loading overlay
  if (loadingMethod) {
    const isGoogle = loadingMethod === 'google';
    return (
      <div className="m-screen m-fade" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:24, padding:40, background: isGoogle ? M.paper : '#111' }}>
        <div style={{ width:80, height:80, borderRadius:24, background: isGoogle ? '#fff' : '#1C1C1E', display:'flex', alignItems:'center', justifyContent:'center', boxShadow: isGoogle ? '0 4px 24px rgba(66,133,244,0.18)' : '0 4px 24px rgba(0,0,0,0.5)' }}>
          {isGoogle ? <IcoGoogle size={44}/> : <IcoApple size={40} color="#fff"/>}
        </div>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:18, fontWeight:600, color: isGoogle ? M.ink : '#fff', marginBottom:6 }}>{t('login.signingIn')} {isGoogle ? 'Google' : 'Apple'}â€¦</div>
          <div style={{ fontSize:13, color: isGoogle ? M.ink3 : 'rgba(255,255,255,0.5)' }}>{t('login.subtitle')}</div>
        </div>
        <div style={{ display:'flex', gap:7, marginTop:4 }}>
          {[0,1,2].map(i => <div key={i} style={{ width:8, height:8, borderRadius:'50%', background: isGoogle ? '#4285F4' : '#fff', animation:`mFadeIn 0.6s ${i*0.2}s infinite alternate` }}/>)}
        </div>
      </div>
    );
  }

  // No account found (Google / Apple)
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
  if (mode === 'email-verify' || mode === 'signup-email-verify') {
    const emailForDisplay = mode === 'email-verify' ? emailInput : signupEmailInput;
    return (
      <div className="m-screen">
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode(mode === 'email-verify' ? 'login' : 'signup-email')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>{t('login.checkEmail')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:28, lineHeight:1.5 }}>
            {t('login.codeSentTo')} <strong>{emailForDisplay}</strong>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'center', marginBottom:24 }}>
            {verifyDigits.map((d, i) => (
              <div key={i} style={{ width:44, height:52, borderRadius:12, border:`2px solid ${d ? M.sage : M.line}`, background:d ? M.sageSoft : M.paper2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, fontWeight:700, fontFamily:M.fontMono, color:M.ink, transition:'all 0.15s ease' }}>
                {d || ''}
              </div>
            ))}
          </div>
          {autoFilling && <div style={{ textAlign:'center', fontSize:12, color:M.sage }}>{t('login.autoFilling')}</div>}
        </div>
      </div>
    );
  }

  // Email input
  if (mode === 'email-input') {
    return (
      <div className="m-screen">
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>{t('login.signInTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>{t('login.signInSub')}</div>
          <input
            value={emailInput} onChange={e => { setEmailInput(e.target.value); setLoginError(null); }}
            type="email" placeholder={t('login.emailPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'14px 16px', borderRadius:12, border:`1.5px solid ${loginError?M.clay:M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:loginError?8:16, color:M.ink }}
          />
          {loginError && <div style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setSignupEmailInput(emailInput); setMode('signup-email'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>{t('login.createAccount')}</button></div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%' }} onClick={handleEmailContinue}>{t('login.continue')}</button>
        </div>
      </div>
    );
  }

  // Signup email
  if (mode === 'signup-email') {
    return (
      <div className="m-screen">
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode('signup')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>{t('login.createAccountTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>{t('login.createAccountEmailSub')}</div>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('login.fullName')}</div>
          <input value={signupName} onChange={e => { setSignupName(e.target.value); setSignupError(null); }} placeholder={t('login.namePlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:`1.5px solid ${signupError && (!signupName.trim() || signupName.trim().length < 2) ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:12, color:M.ink }}/>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('login.email')}</div>
          <input value={signupEmailInput} onChange={e => { setSignupEmailInput(e.target.value); setSignupError(null); }} type="email" placeholder={t('login.emailPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:`1.5px solid ${signupError?M.clay:M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:signupError?8:20, color:M.ink }}/>
          {signupError && <div style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{signupError}</div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%', opacity:signupEmailInput.trim() ? 1 : 0.5 }} onClick={handleSignupEmail} disabled={!signupEmailInput.trim()}>
            {t('login.sendCode')}
          </button>
        </div>
      </div>
    );
  }

  // Signup screen
  if (mode === 'signup') {
    return (
      <div className="m-screen">
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('login.signIn')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:24, marginBottom:16 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:4 }}>{t('login.createAccountTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>{t('login.createAccountSub')}</div>
          {signupError && <div style={{ padding:'10px 14px', borderRadius:10, background:M.claySoft, marginBottom:14, fontSize:13, color:M.clay, lineHeight:1.4 }}>{signupError}</div>}
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleGoogle(true)}>
              <IcoGoogle size={20}/> {t('login.google')}
            </button>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleApple(true)}>
              <IcoApple size={20} color={M.ink}/> {t('login.apple')}
            </button>
            <Divr/>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:10 }} onClick={() => { setSignupEmailInput(''); setSignupError(null); setMode('signup-email'); }}>
              <I name="edit" size={18}/> {t('login.signUpEmail')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Signup bank
  if (mode === 'signup-bank') {
    return (
      <div className="m-screen">
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'20px 24px 32px', overflowY:'auto' }}>
          <div className="m-h2" style={{ marginBottom:4 }}>Connect your bank</div>
          <div style={{ fontSize:14, color:M.ink2, marginBottom:24, lineHeight:1.5 }}>Read-only via Open Banking. ING, Rabobank, ABN AMRO, N26 and 200+ more.</div>
          {['ING','Rabobank','ABN AMRO','N26','bunq','ASN Bank'].map((bank) => (
            <div key={bank} className="m-tap" onClick={() => doLogin('bank', 'bank@munni.app', 'Bank van der Berg')} style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 0', borderBottom:`1px solid ${M.line2}` }}>
              <div style={{ width:38, height:38, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="card" size={17} color={M.ink3}/>
              </div>
              <div style={{ flex:1, fontSize:14, fontWeight:500 }}>{bank}</div>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Main login screen
  return (
    <div className="m-screen">
      <StatusBar/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '28px 24px 32px', overflowY:'auto' }}>
        <div style={{ marginBottom: 32 }}>
          <div className="m-logo" style={{ fontSize: 28, marginBottom: 14 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom: 6 }}>
            {hasOpenedBefore ? t('login.welcome') : t('login.welcomeFirst')}
          </div>
          <div style={{ fontSize: 14, color: M.ink3 }}>{t('login.subtitle')}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button data-testid={T.loginGoogleBtn} className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={() => handleGoogle(false)}>
            <IcoGoogle size={20}/> {t('login.google')}
          </button>
          <button data-testid={T.loginAppleBtn} className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={() => handleApple(false)}>
            <IcoApple size={20} color={M.ink}/> {t('login.apple')}
          </button>
          <Divr/>
          <input
            data-testid={T.loginEmailInput}
            value={emailInput} onChange={e => { setEmailInput(e.target.value); setLoginError(null); }}
            type="email" placeholder={t('login.emailPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'14px 16px', borderRadius:12, border:`1.5px solid ${loginError?M.clay:M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
          />
          {loginError && <div style={{ fontSize:12, color:M.clay, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setSignupEmailInput(emailInput); setMode('signup-email'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>{t('login.createAccount')}</button></div>}
          <button data-testid={T.loginEmailSubmit} className="m-btn sage m-tap" style={{ height:52, width:'100%', opacity:emailInput.trim()?1:0.5 }} onClick={handleEmailContinue} disabled={!emailInput.trim()}>
            {t('login.continue')}
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 20 }}/>

        <div style={{ textAlign: 'center', marginBottom:10 }}>
          <div style={{ fontSize: 12, color: M.ink4, marginBottom: 8 }}>{t('login.noAccount')}</div>
          <button className="m-tap" onClick={() => { setLoginError(null); setMode('signup'); }}
            style={{ background: 'transparent', border: 'none', fontSize: 13, fontWeight: 600, color: M.sage, cursor: 'pointer', fontFamily: M.fontUI }}>
            {t('login.createAccount')}
          </button>
        </div>

        <button data-testid={T.loginDemoBtn} className="m-tap" onClick={() => doLogin('bank', 'bank@munni.app', 'Demo van der Berg', true)}
          style={{ background: 'transparent', border: 'none', fontSize: 12, color: M.ink4, cursor: 'pointer', marginTop: 8, fontFamily: M.fontUI, textAlign: 'center' }}>
          {t('login.demoUser')}
        </button>

        <div style={{ fontSize: 11, color: M.ink4, textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
          {t('login.termsIntro')}{' '}
          <button onClick={() => setMode('terms')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>{t('login.termsLinkText')}</button>
          {' '}{t('login.termsAnd')}{' '}
          <button onClick={() => setMode('privacy')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>{t('login.termsPrivacy')}</button>
          {(()=>{ const s=t('login.termsSuffix'); return (s && s!=='login.termsSuffix') ? <>{' '}{s}</> : null; })()}
        </div>
        <div style={{ textAlign:'center', marginTop:14 }}>
          <button className="m-tap" onClick={() => setMode('language')}
            style={{ background:'transparent', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, textDecoration:'underline' }}>
            ðŸŒ {t('login.changeLanguage')}
          </button>
        </div>
      </div>
    </div>
  );
}
export function App() {
  const [dark, setDark] = useLocalStorage('munni_dark', false);
  const [loggedIn, setLoggedIn] = React.useState(() => sessionStorage.getItem('munni_session_active') === 'true');
  const isMobile = React.useMemo(() => window.matchMedia('(max-width: 430px)').matches, []);

  const appContent = (
    <AppCtx.Provider value={{ logout: () => { sessionStorage.removeItem('munni_session_active'); setLoggedIn(false); } }}>
    <ResetSignalListener/>
    <div className="m m-app" style={{ width:'100%', height:'100%', background: M.paper, filter: dark ? 'invert(0.93) hue-rotate(180deg)' : 'none', transition:'filter 0.3s' }}>
      {loggedIn ? (
        <CatProvider>
          <ProfilesProvider>
            <TxProvider>
              <RecurProvider>
                <AllocProvider>
                  <NavProvider initial="home">
                    <Router/>
                  </NavProvider>
                </AllocProvider>
              </RecurProvider>
            </TxProvider>
          </ProfilesProvider>
        </CatProvider>
      ) : (
        <ScreenLoginGate onLogin={() => setLoggedIn(true)}/>
      )}
    </div>
    </AppCtx.Provider>
  );

  return (
    <DarkCtx.Provider value={{ dark, setDark }}>
      <LangProvider>
        {isMobile ? appContent : <IOSDevice>{appContent}</IOSDevice>}
      </LangProvider>
    </DarkCtx.Provider>
  );
}
