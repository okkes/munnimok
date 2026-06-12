import React from 'react';
import munniLogoUrl from '../../assets/logos/asset-logo-dark.png';
import assetBgUrl from '../../assets/assets-login-background-cropped.png';
import leafOnlyUrl from '../../assets/logos/asset-logo-leaf-only.png';
import { T } from '../shared/testIds.js';
import { getUserId, registerUserInGlobalRegistry, computeUserDataKey } from '../shared/utils/user.js';
import { DUTCH_BANKS } from '../features/accounts/data.js';
import { DEFAULT_API_URL, DEMO_API_URL, STOCK_AVATARS } from '../shared/constants.js';
import { computeProfileKey, getDefaultProfiles, initPerUserData } from '../features/profile/data.js';
import { IOSDevice } from './IOSFrame.jsx';
import { M, I, IcoGoogle, IcoApple, Divider, StatusBar, AppBar } from './theme.jsx';
import { DarkCtx, NavProvider, useNav, Sheet, useDark } from './nav.jsx';
import { DevModeProvider, DevPanel } from './DevMode.jsx';
import { useLang, LangProvider } from '../shared/i18n.jsx';
import { useLocalStorage, useSessionStorage } from '../shared/hooks.jsx';
import { AppCtx, CatProvider, ProfilesProvider, useProfiles, TxProvider, RecurProvider, AllocProvider, useConnectedAccounts, ScreenAllocate, ScreenAllocateTopic, ScreenAllocateAddTopic, ResetSignalListener } from './providers.jsx';
import { ScreenStub } from '../features/extra/Stub.jsx';
import { ScreenHome } from '../features/home/Home.jsx';
import { ScreenTransactions, ScreenTxDetail, ScreenExpenses, ScreenCategoryDrill } from '../features/transactions/Tx.jsx';
import { ScreenEvents, ScreenEventDetail, ScreenEventCreate } from '../features/events/Events.jsx';
import { ScreenProfile, ScreenSpaces, ScreenSpaceDetail, ScreenUserInfo, ScreenExportData } from '../features/profile/Profile.jsx';
import { ScreenLanguagePicker, ScreenSettings, ScreenPeriods, ScreenTutorial, ScreenNotifications, ScreenManageCategories, ScreenCustomizeHome } from '../features/settings/Settings.jsx';
import { ScreenAccounts, ScreenSavings, ScreenSavingsDetail, ScreenSavingAccounts, ScreenAccountsAll, ScreenIntegrations, ScreenIntegrationLogin, ScreenIntegrationReceipts } from '../features/accounts/Accounts.jsx';
import { ScreenRecurringTab, ScreenRecurringDetail, ScreenRecurringCreate, ScreenRecurringDeals } from '../features/recurring/Recurring.jsx';
import { ScreenBudgets, ScreenBudgetDetail, ScreenBudgetCreate } from '../features/budgets/Budgets.jsx';
import { ScreenInvestment, ScreenInvestmentConnect } from '../features/investments/Investment.jsx';
import { ScreenGoals, ScreenGoalDetail } from '../features/goals/Goals.jsx';
import { ScreenReviewSwipe, ScreenLinkReimburse } from '../features/review/Review.jsx';
import { ScreenIncome, ScreenInvested, ScreenInsights, ScreenDebts, ScreenCustomGraphCreate } from '../features/extra/Extra.jsx';
import { ScreenFriends } from '../features/friends/Friends.jsx';
import { ScreenSignupOnboarding } from '../features/auth/Auth.jsx';


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
  spaces:       () => <ScreenSpaces/>,
  spaceDetail:  ({params}) => <ScreenSpaceDetail params={params}/>,
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
  language:       () => <ScreenLanguagePicker/>,
  customGraphCreate: () => <ScreenCustomGraphCreate/>,
  friends:           () => <ScreenFriends/>,
  userInfo:          () => <ScreenUserInfo/>,
  exportData:        () => <ScreenExportData/>,
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
  const topKey = nav.stack.length > 0 ? nav.stack[nav.stack.length - 1].screen : nav.tab;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: M.paper, overflow: 'hidden' }}>
      <DevPanel screenKey={topKey}/>
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
        title: 'Gizlilik PolitikasÄ±', updated: 'Son güncelleme: Ocak 2026',
        sections: [
          ['TopladÄ±ÄŸÄ±mÄ±z veriler', "munni, finansal izleme hizmetleri sunmak için yalnÄ±zca gerekli verileri toplar: PSD2 AçÄ±k BankacÄ±lÄ±k aracÄ±lÄ±ÄŸÄ±yla banka iÅŸlem verileri (salt okunur), hesap bakiyeleri ve kullanÄ±cÄ± tercihleri. Hiçbir zaman ÅŸifre veya ödeme kartÄ± numarasÄ± toplamayÄ±z."],
          ['Verilerinizi nasÄ±l kullanÄ±yoruz', 'Finansal verileriniz yalnÄ±zca munni hizmetini saÄŸlamak için kullanÄ±lÄ±r. KiÅŸisel verilerinizi pazarlama amacÄ±yla üçüncü taraflara satmaz, kiralamaz veya paylaÅŸmayÄ±z.'],
          ['Veri depolama', 'Veriler uçtan uca ÅŸifreleme ile güvenli bir ÅŸekilde depolanÄ±r. Banka kimlik bilgileri sunucularÄ±mÄ±zda hiçbir zaman saklanmaz — PSD2 aracÄ±lÄ±ÄŸÄ±yla doÄŸrudan bankanÄ±za iletilir.'],
          ['HaklarÄ±nÄ±z', 'Verilerinize eriÅŸme, düzeltme veya silme hakkÄ±na sahipsiniz. Bu haklarÄ± kullanmak için privacy@munni.app ile iletiÅŸime geçin.'],
          ['Çerezler', 'YalnÄ±zca kimlik doÄŸrulama ve oturum yönetimi için temel çerezler kullanÄ±yoruz. Ä°zleme veya reklam çerezleri kullanmÄ±yoruz.'],
          ['Ä°letiÅŸim', 'Gizlilik sorularÄ± için: privacy@munni.app'],
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
        title: 'KullanÄ±m ÅžartlarÄ±', updated: 'Son güncelleme: Ocak 2026',
        sections: [
          ['Kabul', "munni'yi kullanarak bu KullanÄ±m ÅžartlarÄ±nÄ± kabul etmiÅŸ olursunuz. Kabul etmiyorsanÄ±z, lütfen hizmeti kullanmayÄ±n."],
          ['Hizmet açÄ±klamasÄ±', "munni, salt okunur iÅŸlem takibi, bütçeleme ve finansal içgörüler saÄŸlamak için PSD2 AçÄ±k BankacÄ±lÄ±k aracÄ±lÄ±ÄŸÄ±yla banka hesaplarÄ±nÄ±za baÄŸlanan kiÅŸisel bir finans yönetimi uygulamasÄ±dÄ±r."],
          ['Salt okunur eriÅŸim', "munni, banka hesaplarÄ±nÄ±za salt okunur eriÅŸime sahiptir. AdÄ±nÄ±za hiçbir zaman ödeme, transfer veya finansal iÅŸlem baÅŸlatamayÄ±z."],
          ['KullanÄ±cÄ± sorumluluklarÄ±', 'Hesap kimlik bilgilerinizin güvenliÄŸinden ve hesabÄ±nÄ±z altÄ±nda gerçekleÅŸen tüm faaliyetlerden siz sorumlusunuz.'],
          ['Veri doÄŸruluÄŸu', 'DoÄŸru finansal veriler saÄŸlamak için çaba göstersek de, munni üçüncü taraf bankacÄ±lÄ±k kurumlarÄ±nÄ±n saÄŸladÄ±ÄŸÄ± verilerdeki hatalardan sorumlu deÄŸildir.'],
          ['Sorumluluk sÄ±nÄ±rlamasÄ±', 'munni olduÄŸu gibi sunulmaktadÄ±r ve hizmetin doÄŸruluÄŸu ya da eksiksizliÄŸi konusunda herhangi bir garanti vermeyiz.'],
          ['Åžartlarda deÄŸiÅŸiklikler', "Bu ÅŸartlarÄ± zaman zaman güncelleyebiliriz. DeÄŸiÅŸikliklerden sonra munni'yi kullanmaya devam etmek, yeni ÅŸartlarÄ±n kabulü anlamÄ±na gelir."],
          ['Ä°letiÅŸim', 'Sorular için: legal@munni.app'],
        ],
      },
    },
  };

  const key = showPrivacy ? 'privacy' : 'terms';
  const data = CONTENT[key][lang] || CONTENT[key].en;

  return (
    <div data-testid={T.termsScreen} className="m-screen" style={{ position: 'relative' }}>
      <DevPanel screenKey={key}/>
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

const VERIFY_DIGITS_LOGIN  = ['4','2','7','1','8','3'];
const VERIFY_DIGITS_SIGNUP = ['7','3','9','2','5','1'];
const RESERVED_EMAILS = ['google@munni.app','apple@munni.app','bank@munni.app'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ScreenLoginGate({ onLogin }) {
  // mode: 'login'|'email-input'|'email-verify'|'google-loading'|'apple-loading'
  //       'signup'|'signup-google'|'signup-apple'|'signup-email'|'signup-email-verify'
  //       'signup-bank'|'terms'|'privacy'|'language'
  const { t, lang, setLang } = useLang();
  const { dark } = useDark();
  const [emailInput, setEmailInput] = React.useState(() => {
    try {
      const v = JSON.parse(sessionStorage.getItem('munni_profile_email') || '""');
      return (v && !['google@munni.app','apple@munni.app','bank@munni.app'].includes(v)) ? v : '';
    } catch { return ''; }
  });
  const [signupEmailInput, setSignupEmailInput] = React.useState('');
  const [verifyDigits, setVerifyDigits] = React.useState(['','','','','','']);
  const [autoFilling, setAutoFilling] = React.useState(false);
  const [loadingMethod, setLoadingMethod] = React.useState(null);
  const [loginError, setLoginError] = React.useState(null);
  const [signupError, setSignupError] = React.useState(null);
  const [noAccountMethod, setNoAccountMethod] = React.useState(null);
  const [showLangDropdown, setShowLangDropdown] = React.useState(false);
  const [pendingSignup, setPendingSignup] = React.useState(null);
  const [mode, setMode] = React.useState(() => {
    try {
      const offProfiles = JSON.parse(localStorage.getItem('munni_offline_profiles') || '[]');
      const onlineMethods = JSON.parse(localStorage.getItem('munni_signup_methods') || '[]');
      if (offProfiles.length > 0 && onlineMethods.length === 0) return 'offline-select';
    } catch {}
    return 'login';
  });
  const loadingTimerRef = React.useRef(null);

  // Signup in-progress helpers (detect unfinished registration on next login/signup attempt)
  const getSignupInProgress = () => { try { return JSON.parse(localStorage.getItem('munni_signup_in_progress') || 'null'); } catch { return null; } };
  const saveSignupInProgress = (ps) => { try { localStorage.setItem('munni_signup_in_progress', JSON.stringify({ method:ps.method, canonicalEmail:ps.canonicalEmail, displayEmail:ps.displayEmail, backMode:ps.backMode })); } catch {} };
  const clearSignupInProgress = () => localStorage.removeItem('munni_signup_in_progress');

  // Offline mode helpers
  const getOfflineProfiles = () => { try { return JSON.parse(localStorage.getItem('munni_offline_profiles') || '[]'); } catch { return []; } };
  const [offlineName,      setOfflineName]      = React.useState('');
  const [offlineNameError, setOfflineNameError] = React.useState('');
  const [offlinePicture,   setOfflinePicture]   = React.useState('av1');
  const [showOfflinePicker,setShowOfflinePicker]= React.useState(false);

  // Offline recover flow (pre-login)
  const [offlineRecoverStep,  setOfflineRecoverStep]  = React.useState('file'); // 'file' | 'key' | 'loading' | 'done'
  const [offlineRecoverFile,  setOfflineRecoverFile]  = React.useState(null);
  const [offlineRecoverKey,   setOfflineRecoverKey]   = React.useState('');
  const [offlineRecoverError, setOfflineRecoverError] = React.useState('');

  const doOfflineLogin = (profile) => {
    sessionStorage.setItem('munni_last_login_method', 'offline');
    window.dispatchEvent(new CustomEvent('munni-ss', { detail: { key: 'munni_last_login_method' } }));
    sessionStorage.setItem('munni_profile_email', JSON.stringify(profile.id));
    window.dispatchEvent(new CustomEvent('munni-ss', { detail: { key: 'munni_profile_email' } }));
    initPerUserData('offline', profile.id, lang);
    const nameKey = computeUserDataKey('offline', profile.id, 'munni_profile_name');
    if (!localStorage.getItem(nameKey)) {
      localStorage.setItem(nameKey, JSON.stringify(profile.name));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: nameKey } }));
    }
    if (profile.picture) {
      const picKey = `munni_user_picture_${profile.id}`;
      if (!localStorage.getItem(picKey)) {
        localStorage.setItem(picKey, JSON.stringify(profile.picture));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: picKey } }));
      }
    }
    localStorage.setItem('munni_opened_before', 'true');
    sessionStorage.setItem('munni_session_active', 'true');
    onLogin();
  };

  const handleCreateOfflineProfile = () => {
    const name = offlineName.trim();
    if (!name) { setOfflineNameError(t('offline.errNameRequired')); return; }
    const existing = getOfflineProfiles();
    if (existing.some(p => p.name.trim().toLowerCase() === name.toLowerCase())) {
      setOfflineNameError(t('offline.errDuplicateName'));
      return;
    }
    const id = `offline_${Date.now()}`;
    const newProfile = { id, name, picture: offlinePicture, createdAt: Date.now() };
    localStorage.setItem('munni_offline_profiles', JSON.stringify([...existing, newProfile]));
    setOfflineName(''); setOfflineNameError(''); setOfflinePicture('av1');
    doOfflineLogin(newProfile);
  };

  const hasOpenedBefore = localStorage.getItem('munni_opened_before') === 'true';
  const getSignupMethods = () => { try { return JSON.parse(localStorage.getItem('munni_signup_methods') || '[]'); } catch { return []; } };
  const getSignupEmails = () => { try { return JSON.parse(localStorage.getItem('munni_signup_emails') || '[]'); } catch { return []; } };

  const MODE_BACK = { signup:'login', 'signup-email':'signup', 'signup-email-verify':'signup-email', 'email-verify':'login', 'no-account':'login', 'email-input':'login', language:'login', 'offline-info':'login', 'offline-select':'login', 'offline-create':'offline-select', 'offline-recover':'offline-create' };
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  React.useEffect(() => {
    if (!MODE_BACK[mode]) return;
    window.history.pushState({ munniLoginMode: mode }, '');
    const handlePop = () => { const prev = MODE_BACK[modeRef.current]; if (prev) setMode(prev); };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, [mode]);

  React.useEffect(() => {
    if (!loadingMethod) return;
    window.history.pushState({ munniLoginMode: 'loading' }, '');
    const handlePop = () => { clearTimeout(loadingTimerRef.current); setLoadingMethod(null); };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, [loadingMethod]);

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
      const profileKey = computeProfileKey(method, email || '');
      localStorage.setItem(profileKey, JSON.stringify(getDefaultProfiles('bank')));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: profileKey } }));
      localStorage.setItem('munni_api_url', JSON.stringify(DEMO_API_URL));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: 'munni_api_url' } }));
    }
    registerUserInGlobalRegistry(userId, name);
    sessionStorage.setItem('munni_session_active', 'true');
    onLogin();
  };

  // Google login/signup
  const handleGoogle = (isSignup = false) => {
    setLoginError(null); setSignupError(null);
    setLoadingMethod('google');
    loadingTimerRef.current = setTimeout(() => {
      setLoadingMethod(null);
      const methods = getSignupMethods();
      if (isSignup) {
        if (methods.includes('google')) { setSignupError(t('login.errGoogleExists')); return; }
        const _gPs = { method:'google', displayEmail:'munni-demo@gmail.com', canonicalEmail:'google@munni.app', firstName:'Google', lastName:'van der Berg', banks:['ing'], apiUrl:DEFAULT_API_URL, picture:'av3', backMode:'signup' };
        setPendingSignup(_gPs); saveSignupInProgress(_gPs);
        setMode('signup-onboarding');
      } else {
        if (!methods.includes('google')) {
          const inProg = getSignupInProgress();
          if (inProg && inProg.method === 'google') { setPendingSignup(inProg); setMode('signup-onboarding'); return; }
          setNoAccountMethod('google'); setMode('no-account'); return;
        }
        doLogin('google', '', null);
      }
    }, 1400);
  };

  // Apple login/signup
  const handleApple = (isSignup = false) => {
    setLoginError(null); setSignupError(null);
    setLoadingMethod('apple');
    loadingTimerRef.current = setTimeout(() => {
      setLoadingMethod(null);
      const methods = getSignupMethods();
      if (isSignup) {
        if (methods.includes('apple')) { setSignupError(t('login.errAppleExists')); return; }
        const _aPs = { method:'apple', displayEmail:'munni-demo@hotmail.com', canonicalEmail:'apple@munni.app', firstName:'Apple', lastName:'van der Mac', banks:['abn'], apiUrl:DEFAULT_API_URL, picture:'av4', backMode:'signup' };
        setPendingSignup(_aPs); saveSignupInProgress(_aPs);
        setMode('signup-onboarding');
      } else {
        if (!methods.includes('apple')) {
          const inProg = getSignupInProgress();
          if (inProg && inProg.method === 'apple') { setPendingSignup(inProg); setMode('signup-onboarding'); return; }
          setNoAccountMethod('apple'); setMode('no-account'); return;
        }
        doLogin('apple', '', null);
      }
    }, 1400);
  };

  // Email continue - go to verify
  const handleEmailContinue = () => {
    setLoginError(null);
    const methods = getSignupMethods();
    const emails = getSignupEmails();
    const input = emailInput.toLowerCase().trim();

    // Check email override (changed email)
    let resolvedEmail = input;
    try {
      const override = JSON.parse(localStorage.getItem("munni_email_override") || "null");
      if (override && typeof override === 'object') {
        if (override.to && override.to.toLowerCase() === input) {
          resolvedEmail = override.from ? override.from.toLowerCase() : input;
        }
      }
    } catch {}

    if (!methods.includes('email') || !emails.includes(resolvedEmail)) {
      // If this email has an unfinished registration, redirect to complete it
      const inProg = getSignupInProgress();
      if (inProg && inProg.method === 'email' && inProg.canonicalEmail === resolvedEmail) {
        const resumePs = { method:'email', displayEmail:resolvedEmail, canonicalEmail:resolvedEmail, firstName:'', lastName:'', banks:[], apiUrl:DEFAULT_API_URL, picture:null, backMode:'login' };
        setPendingSignup(resumePs);
        saveSignupInProgress(resumePs);
        setMode('signup-onboarding');
        return;
      }
      setLoginError(t('login.emailNotFound'));
      return;
    }
    setMode('email-verify');
    setVerifyDigits(['','','','','','']);
    setAutoFilling(false);
    setTimeout(() => {
      setAutoFilling(true);
      const digits = VERIFY_DIGITS_LOGIN;
      const fill = (idx) => {
        if (idx >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => doLogin('email', resolvedEmail, null), 800);
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
    const email = signupEmailInput.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { setSignupError(t('login.errInvalidEmail')); return; }
    if (RESERVED_EMAILS.includes(email)) { setSignupError(t('login.errEmailReserved')); return; }
    const emails = getSignupEmails();
    if (emails.includes(email)) { setSignupError(t('login.errEmailExists')); return; }
    // If this email has an unfinished registration, skip re-verification and resume
    const inProg = getSignupInProgress();
    if (inProg && inProg.method === 'email' && inProg.canonicalEmail === email) {
      const resumePs = { method:'email', displayEmail:email, canonicalEmail:email, firstName:'', lastName:'', banks:[], apiUrl:DEFAULT_API_URL, picture:null, backMode:'signup-email' };
      setPendingSignup(resumePs);
      saveSignupInProgress(resumePs);
      setMode('signup-onboarding');
      return;
    }
    setMode('signup-email-verify');
    setVerifyDigits(['','','','','','']);
    setAutoFilling(false);
    setTimeout(() => {
      setAutoFilling(true);
      const digits = VERIFY_DIGITS_SIGNUP;
      const fill = (idx) => {
        if (idx >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => {
            const _ePs = { method:'email', displayEmail:email, canonicalEmail:email, firstName:'', lastName:'', banks:[], apiUrl:DEFAULT_API_URL, picture:null, backMode:'signup-email' };
            setPendingSignup(_ePs); saveSignupInProgress(_ePs);
            setMode('signup-onboarding');
          }, 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[idx]=digits[idx]; return n; });
        setTimeout(() => fill(idx + 1), 100);
      };
      setTimeout(() => fill(0), 300);
    }, 200);
  };

  if (mode === 'language') return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <DevPanel screenKey="language"/>
      <ScreenLanguagePicker fromOnboarding={true} onBack={() => setMode('login')}/>
    </div>
  );
  if (mode === 'terms') return <ScreenTerms onBack={() => setMode('login')} showPrivacy={false}/>;
  if (mode === 'privacy') return <ScreenTerms onBack={() => setMode('login')} showPrivacy={true}/>;
  if (mode === 'signup-onboarding' && pendingSignup) {
    const handleOnboardingComplete = (data) => {
      const { firstName, lastName, apiUrl: newApiUrl, picture: newPicture } = data;
      const { method, canonicalEmail, backMode } = pendingSignup;
      const isSSO = method === 'google' || method === 'apple';
      const finalEmail = isSSO ? canonicalEmail : data.email;
      // Store SSO display email (munni-demo@gmail.com etc.) for ScreenUserInfo
      if (isSSO && data.email) {
        localStorage.setItem(`munni_display_email_${method}`, JSON.stringify(data.email));
      }
      // For email method: register email
      if (method === 'email') {
        const emails = getSignupEmails();
        if (!emails.includes(finalEmail)) {
          localStorage.setItem('munni_signup_emails', JSON.stringify([...emails, finalEmail]));
        }
      }
      // Store first/last name + country
      const fnKey = computeUserDataKey(method, finalEmail, 'munni_profile_firstname');
      const lnKey = computeUserDataKey(method, finalEmail, 'munni_profile_lastname');
      const ctKey = computeUserDataKey(method, finalEmail, 'munni_profile_country');
      localStorage.setItem(fnKey, JSON.stringify(firstName));
      localStorage.setItem(lnKey, JSON.stringify(lastName));
      if (data.country) localStorage.setItem(ctKey, JSON.stringify(data.country));
      if (newApiUrl && newApiUrl.trim()) {
        localStorage.setItem('munni_api_url', JSON.stringify(newApiUrl.trim()));
      }
      // Store picture
      if (newPicture) {
        const pKey = method === 'google' ? 'munni_user_picture_google'
          : method === 'apple' ? 'munni_user_picture_apple'
          : `munni_user_picture_${finalEmail}`;
        localStorage.setItem(pKey, JSON.stringify(newPicture));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: pKey } }));
      }
      // Initialise per-user data FIRST so the schema-version is set before doLogin calls
      // initPerUserData again — otherwise it would overwrite the bank accounts we save below.
      initPerUserData(method, finalEmail, lang);
      // Save connected banks as bank accounts so they appear in Settings > Accounts
      if (data.connectedBanks && data.connectedBanks.length > 0) {
        const acctKey = computeUserDataKey(method, finalEmail, 'munni_bank_accounts');
        const bankAccounts = data.connectedBanks.map((b, i) => {
          const bank = DUTCH_BANKS.find(bk => bk.id === b.id);
          return {
            id: `acct_${b.id}_${i}`,
            name: `${bank ? bank.name : b.id}`,
            iban: b.iban || '',
            balance: 0,
            type: 'checking',
            color: bank?.color || '#4A6A4F',
          };
        });
        localStorage.setItem(acctKey, JSON.stringify(bankAccounts));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: acctKey } }));
        // Attach the new account IDs to the active profile
        const profileKey = computeProfileKey(method, finalEmail);
        try {
          const profiles = JSON.parse(localStorage.getItem(profileKey) || 'null')
            || getDefaultProfiles(method, lang);
          const idx = Math.max(0, profiles.findIndex(p => p.active));
          if (profiles[idx]) {
            const merged = [...new Set([...(profiles[idx].accountIds || []), ...bankAccounts.map(a => a.id)])];
            profiles[idx] = { ...profiles[idx], accountIds: merged };
            localStorage.setItem(profileKey, JSON.stringify(profiles));
            window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: profileKey } }));
          }
        } catch {}
      }
      const displayName = [firstName, lastName].filter(Boolean).join(' ');
      clearSignupInProgress();
      setPendingSignup(null);
      doLogin(method, finalEmail, displayName, false, lang);
    };
    return (
      <div style={{ position:'relative', height:'100%', overflow:'hidden' }}>
        <DevPanel screenKey="signup-onboarding"/>
        <ScreenSignupOnboarding
          signup={pendingSignup}
          onComplete={handleOnboardingComplete}
          onBack={() => { setPendingSignup(null); setMode(pendingSignup.backMode || 'signup'); }}
        />
      </div>
    );
  }

  const Divr = () => (
    <div style={{ display:'flex', alignItems:'center', gap:12, margin:'4px 0' }}>
      <div style={{ flex:1, height:1, background:M.line2 }}/><div style={{ fontSize:12, color:M.ink4 }}>{t('login.or')}</div><div style={{ flex:1, height:1, background:M.line2 }}/>
    </div>
  );

  // Loading overlay
  if (loadingMethod) {
    const isGoogle = loadingMethod === 'google';
    return (
      <div key="loading" data-testid={T.loginSsoLoading} className="m-screen m-fade" style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:24, padding:40, background: M.paper }}>
        <div style={{ width:80, height:80, borderRadius:24, background: isGoogle ? M.sageSoft : M.paper2, display:'flex', alignItems:'center', justifyContent:'center', boxShadow: isGoogle ? '0 4px 24px rgba(66,133,244,0.18)' : '0 4px 20px rgba(0,0,0,0.08)' }}>
          {isGoogle ? <IcoGoogle size={44}/> : <IcoApple size={40} color={M.ink}/>}
        </div>
        <div style={{ textAlign:'center' }}>
          <div style={{ fontSize:18, fontWeight:600, color: M.ink, marginBottom:6 }}>{t('login.signingIn')} {isGoogle ? 'Google' : 'Apple'}…</div>
          <div style={{ fontSize:13, color: M.ink3 }}>{t('login.subtitle')}</div>
        </div>
        <div style={{ display:'flex', gap:7, marginTop:4 }}>
          {[0,1,2].map(i => <div key={i} style={{ width:8, height:8, borderRadius:'50%', background: isGoogle ? '#4285F4' : M.ink2, animation:`mFadeIn 0.6s ${i*0.2}s infinite alternate` }}/>)}
        </div>
      </div>
    );
  }

  // No account found (Google / Apple)
  if (mode === 'no-account') {
    const isGoogle = noAccountMethod === 'google';
    return (
      <div key="no-account" data-testid={T.loginNoAccount} className="m-screen m-fade" style={{ position: 'relative' }}><DevPanel screenKey="no-account"/>
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
      <div key={mode} className="m-screen m-fade" style={{ position: 'relative' }}><DevPanel screenKey={mode}/>
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
          {autoFilling && <div data-testid={T.verifyAutoFilling} style={{ textAlign:'center', fontSize:12, color:M.sage }}>{t('login.autoFilling')}</div>}
        </div>
      </div>
    );
  }

  // Email input
  if (mode === 'email-input') {
    return (
      <div key="email-input" className="m-screen m-fade" style={{ position: 'relative' }}><DevPanel screenKey="email-input"/>
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
          {loginError && <div data-testid={T.loginError} style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setSignupEmailInput(emailInput); setMode('signup-email'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>{t('login.createAccount')}</button></div>}
          <button data-testid={T.emailInputContinue} className="m-btn sage m-tap" style={{ height:52, width:'100%' }} onClick={handleEmailContinue}>{t('login.continue')}</button>
        </div>
      </div>
    );
  }

  // Signup email
  if (mode === 'signup-email') {
    return (
      <div key="signup-email" className="m-screen m-fade" style={{ position: 'relative' }}><DevPanel screenKey="signup-email"/>
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
          <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>{t('login.email')}</div>
          <input value={signupEmailInput} onChange={e => { setSignupEmailInput(e.target.value); setSignupError(null); }} type="email" placeholder={t('login.emailPlaceholder')}
            style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:`1.5px solid ${signupError ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:signupError?8:20, color:M.ink }}/>
          {signupError && (
            <div data-testid={T.signupEmailError} style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>
              {signupError}
              {signupError === t('login.errEmailExists') && (
                <button data-testid={T.signupSignInInstead} onClick={() => { setSignupError(null); setEmailInput(signupEmailInput); setMode('email-input'); }}
                  style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12, marginLeft:4 }}>{t('login.signInInstead')}</button>
              )}
            </div>
          )}
          <button data-testid={T.signupSendCode} className="m-btn sage m-tap" style={{ height:52, width:'100%', opacity:signupEmailInput.trim() ? 1 : 0.5 }} onClick={handleSignupEmail} disabled={!signupEmailInput.trim()}>
            {t('login.sendCode')}
          </button>
        </div>
      </div>
    );
  }

  // Signup screen
  if (mode === 'signup') {
    return (
      <div key="signup" className="m-screen m-fade" style={{ position: 'relative' }}><DevPanel screenKey="signup"/>
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
          {(() => {
            const methods = getSignupMethods();
            const googleTaken = methods.includes('google');
            const appleTaken = methods.includes('apple');
            return (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <div>
                  <button data-testid={T.signupPickGoogle} className={`m-btn outline m-tap${googleTaken?' disabled':''}`} disabled={googleTaken}
                    style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12, width:'100%', opacity:googleTaken?0.45:1, cursor:googleTaken?'not-allowed':'pointer' }}
                    onClick={() => !googleTaken && handleGoogle(true)}>
                    <IcoGoogle size={20}/> {t('login.google')}
                  </button>
                  {googleTaken && <div style={{ fontSize:11, color:M.ink3, marginTop:4, paddingLeft:2, lineHeight:1.4 }}>{t('login.ssoAlreadyUsed')}</div>}
                </div>
                <div>
                  <button data-testid={T.signupPickApple} className={`m-btn outline m-tap${appleTaken?' disabled':''}`} disabled={appleTaken}
                    style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12, width:'100%', opacity:appleTaken?0.45:1, cursor:appleTaken?'not-allowed':'pointer' }}
                    onClick={() => !appleTaken && handleApple(true)}>
                    <IcoApple size={20} color={M.ink}/> {t('login.apple')}
                  </button>
                  {appleTaken && <div style={{ fontSize:11, color:M.ink3, marginTop:4, paddingLeft:2, lineHeight:1.4 }}>{t('login.ssoAlreadyUsed')}</div>}
                </div>
                <Divr/>
                <button data-testid={T.signupPickEmail} className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:10 }} onClick={() => { setSignupEmailInput(''); setSignupError(null); setMode('signup-email'); }}>
                  <I name="edit" size={18}/> {t('login.signUpEmail')}
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

  // ── Offline info screen ────────────────────────────────────────────
  if (mode === 'offline-info') {
    const limits = [
      [t('offline.limit1'), t('offline.limit1Sub')],
      [t('offline.limit2'), t('offline.limit2Sub')],
      [t('offline.limit3'), t('offline.limit3Sub')],
      [t('offline.limit4'), t('offline.limit4Sub')],
    ];
    return (
      <div data-testid={T.offlineInfoScreen} key="offline-info" className="m-screen m-fade" style={{ position:'relative' }}><DevPanel screenKey="offline-info"/>
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode('login')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'24px 24px 48px' }}>
          <div className="m-logo" style={{ fontSize:20, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:24 }}>
            <div style={{ width:44, height:44, borderRadius:14, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="lock" size={20} color={M.sage}/>
            </div>
            <div>
              <div className="m-h2" style={{ marginBottom:2 }}>{t('offline.infoTitle')}</div>
              <div style={{ fontSize:13, color:M.ink3 }}>{t('offline.infoSubtitle')}</div>
            </div>
          </div>

          <div style={{ marginBottom:20 }}>
            <div style={{ display:'flex', gap:12, alignItems:'flex-start', padding:'12px 0', borderBottom:`1px solid ${M.line2}` }}>
              <div style={{ width:20, height:20, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1 }}>
                <I name="check" size={11} color={M.sage}/>
              </div>
              <div>
                <div style={{ fontSize:14, fontWeight:600, color:M.ink }}>{t('offline.infoOwnership')}</div>
                <div style={{ fontSize:12, color:M.ink3, marginTop:3, lineHeight:1.5 }}>{t('offline.infoOwnershipSub')}</div>
              </div>
            </div>
            {limits.map(([title, sub], i) => (
              <div key={i} style={{ display:'flex', gap:12, alignItems:'flex-start', padding:'12px 0', borderBottom:`1px solid ${M.line2}` }}>
                <div style={{ width:20, height:20, borderRadius:999, background:M.claySoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:1 }}>
                  <div style={{ width:8, height:1.5, borderRadius:1, background:M.clay }}/>
                </div>
                <div>
                  <div style={{ fontSize:14, fontWeight:600, color:M.ink2 }}>{title}</div>
                  <div style={{ fontSize:12, color:M.ink3, marginTop:3, lineHeight:1.5 }}>{sub}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ padding:'12px 16px', borderRadius:12, background:M.ochreSoft, border:`1px solid ${M.ochreSoft}`, marginBottom:28 }}>
            <div style={{ fontSize:12, color:M.ink2, lineHeight:1.6 }}>{t('offline.pricing')}</div>
          </div>

          <button data-testid={T.offlineInfoCta} className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700, marginBottom:12 }}
            onClick={() => { const ps = getOfflineProfiles(); setMode(ps.length > 0 ? 'offline-select' : 'offline-create'); }}>
            {t('offline.infoCta')}
          </button>
          <button data-testid={T.offlineInfoBack} className="m-tap" onClick={() => setMode('login')}
            style={{ width:'100%', textAlign:'center', background:'none', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, padding:'8px 0' }}>
            {t('offline.infoBack')}
          </button>
        </div>
      </div>
    );
  }

  // ── Offline profile selector ────────────────────────────────────────
  if (mode === 'offline-select') {
    const offProfiles = getOfflineProfiles();
    return (
      <div data-testid={T.offlineSelectScreen} key="offline-select" className="m-screen m-fade" style={{ position:'relative' }}><DevPanel screenKey="offline-select"/>
        <StatusBar/>
        <div style={{ flex:1, overflowY:'auto', padding:'40px 24px 48px' }}>
          <div className="m-logo" style={{ fontSize:20, marginBottom:28, textAlign:'center' }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ textAlign:'center', marginBottom:32 }}>{t('offline.selectTitle')}</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:20, marginBottom:32 }}>
            {offProfiles.map(p => {
              const av = STOCK_AVATARS.find(a => a.id === p.picture);
              return (
                <button key={p.id} className="m-tap" onClick={() => doOfflineLogin(p)}
                  style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, background:'none', border:'none', cursor:'pointer', fontFamily:M.fontUI, padding:0 }}>
                  <div style={{ width:68, height:68, borderRadius:999, background:av?.bg || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:30, border:`2px solid ${M.line}` }}>
                    {av ? av.emoji : <span style={{ fontSize:22, fontWeight:700, color:M.sage }}>{p.name.charAt(0).toUpperCase()}</span>}
                  </div>
                  <div style={{ fontSize:13, fontWeight:600, color:M.ink, textAlign:'center', wordBreak:'break-word', width:'100%', lineHeight:1.3 }}>{p.name}</div>
                </button>
              );
            })}
            <button data-testid={T.offlineAddProfile} className="m-tap" onClick={() => { setOfflineName(''); setOfflineNameError(''); setOfflinePicture('av1'); setMode('offline-create'); }}
              style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, background:'none', border:'none', cursor:'pointer', fontFamily:M.fontUI, padding:0 }}>
              <div style={{ width:68, height:68, borderRadius:999, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', border:`2px dashed ${M.line}` }}>
                <I name="plus" size={22} color={M.ink3}/>
              </div>
              <div style={{ fontSize:13, color:M.ink3, textAlign:'center' }}>{t('offline.addProfile')}</div>
            </button>
          </div>
          <div style={{ textAlign:'center' }}>
            <button className="m-tap" onClick={() => setMode('login')}
              style={{ background:'none', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, textDecoration:'underline' }}>
              {t('offline.infoBack')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Offline profile creator ─────────────────────────────────────────
  if (mode === 'offline-create') {
    return (
      <div data-testid={T.offlineCreateScreen} key="offline-create" className="m-screen m-fade" style={{ position:'relative' }}><DevPanel screenKey="offline-create"/>
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode('offline-select')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'24px 24px 48px' }}>
          <div className="m-logo" style={{ fontSize:20, marginBottom:16 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:4 }}>{t('offline.createTitle')}</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:28, lineHeight:1.5 }}>{t('offline.infoSubtitle')}</div>

          <div style={{ display:'flex', justifyContent:'center', marginBottom:24 }}>
            <button className="m-tap" onClick={() => setShowOfflinePicker(true)}
              style={{ position:'relative', background:'none', border:'none', cursor:'pointer', padding:0 }}>
              {(() => { const av = STOCK_AVATARS.find(a => a.id === offlinePicture); return av ? (
                <div style={{ width:80, height:80, borderRadius:999, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:36 }}>{av.emoji}</div>
              ) : null; })()}
              <div style={{ position:'absolute', bottom:2, right:2, width:24, height:24, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #fff' }}>
                <I name="cam" size={11} color="#fff"/>
              </div>
            </button>
          </div>

          <div style={{ marginBottom:offlineNameError ? 6 : 20 }}>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('offline.createNameLabel')}</div>
            <input
              data-testid={T.offlineCreateName}
              value={offlineName}
              onChange={e => { setOfflineName(e.target.value); setOfflineNameError(''); }}
              placeholder={t('offline.createNamePlaceholder')}
              style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:`1.5px solid ${offlineNameError ? M.clay : M.line}`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink }}
            />
            {offlineNameError && <div style={{ fontSize:11, color:M.clay, marginTop:4 }}>{offlineNameError}</div>}
          </div>

          <button data-testid={T.offlineCreateCta} className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700 }} onClick={handleCreateOfflineProfile}>
            {t('offline.createCta')}
          </button>

          <div style={{ display:'flex', alignItems:'center', gap:8, margin:'20px 0 4px' }}>
            <div style={{ flex:1, height:1, background:M.line }}/>
            <div style={{ fontSize:12, color:M.ink4 }}>{t('common.or')}</div>
            <div style={{ flex:1, height:1, background:M.line }}/>
          </div>

          <button data-testid={T.offlineCreateRecoverBtn} className="m-btn outline m-tap"
            style={{ width:'100%', height:50, fontSize:14, fontWeight:600 }}
            onClick={() => { setOfflineRecoverStep('file'); setOfflineRecoverFile(null); setOfflineRecoverKey(''); setOfflineRecoverError(''); setMode('offline-recover'); }}>
            {t('offline.recoverBtn')}
          </button>
          <div style={{ fontSize:11, color:M.ink4, textAlign:'center', marginTop:6 }}>{t('offline.recoverSub')}</div>
        </div>

        {showOfflinePicker && (
          <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', flexDirection:'column', justifyContent:'flex-end', zIndex:100 }}
            onClick={() => setShowOfflinePicker(false)}>
            <div style={{ background:M.paper, borderRadius:'20px 20px 0 0', padding:'16px 20px 32px' }} onClick={e => e.stopPropagation()}>
              <div style={{ width:36, height:4, borderRadius:2, background:M.line2, margin:'0 auto 16px' }}/>
              <div style={{ fontSize:14, fontWeight:600, color:M.ink, marginBottom:16 }}>{t('profile.picTitle')}</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10 }}>
                {STOCK_AVATARS.map(av => (
                  <button key={av.id} className="m-tap" onClick={() => { setOfflinePicture(av.id); setShowOfflinePicker(false); }}
                    style={{ width:'100%', aspectRatio:'1', borderRadius:14, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:28, border:`2px solid ${offlinePicture === av.id ? M.sage : 'transparent'}`, cursor:'pointer' }}>
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

  if (mode === 'offline-recover') {
    const doOfflineRecover = () => {
      if (!offlineRecoverKey.trim()) { setOfflineRecoverError(t('offline.recoverErrKey')); return; }
      setOfflineRecoverStep('loading');
      setTimeout(() => {
        setOfflineRecoverStep('done');
      }, 2400);
    };
    const doFinishRecover = () => {
      const id = `offline_${Date.now()}`;
      let restoredName = 'Recovered Profile';
      try {
        const parsed = JSON.parse(offlineRecoverFile ? 'null' : 'null');
        if (parsed?.profile) restoredName = parsed.profile;
      } catch {}
      const newProfile = { id, name: restoredName, picture: 'av1', createdAt: Date.now() };
      const existing = getOfflineProfiles();
      localStorage.setItem('munni_offline_profiles', JSON.stringify([...existing, newProfile]));
      setOfflineRecoverStep('file'); setOfflineRecoverFile(null); setOfflineRecoverKey(''); setOfflineRecoverError('');
      doOfflineLogin(newProfile);
    };
    return (
      <div data-testid={T.offlineRecoverScreen} key="offline-recover" className="m-screen m-fade" style={{ position:'relative' }}><DevPanel screenKey="offline-recover"/>
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode('offline-create')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> {t('action.back')}
          </button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'24px 24px 48px' }}>
          <div className="m-logo" style={{ fontSize:20, marginBottom:16 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:4 }}>{t('offline.recoverScreenTitle')}</div>

          {offlineRecoverStep === 'file' && (<>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:28, lineHeight:1.5 }}>{t('offline.recoverStep1Sub')}</div>
            <label data-testid={T.offlineRecoverFilePick} className="m-tap"
              style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:M.paper2, borderRadius:14, border:`1.5px dashed ${offlineRecoverFile ? M.sage : M.line}`, cursor:'pointer', marginBottom:24 }}>
              <div style={{ width:40, height:40, borderRadius:10, background:offlineRecoverFile ? M.sageSoft : M.paper2, border:`1px solid ${offlineRecoverFile ? M.sage : M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <I name="upload" size={18} color={offlineRecoverFile ? M.sage : M.ink3}/>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                {offlineRecoverFile
                  ? <><div style={{ fontSize:11, color:M.ink3, marginBottom:2 }}>{t('profile.recoverFileSelected')}</div><div style={{ fontSize:14, color:M.ink, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{offlineRecoverFile.name}</div></>
                  : <div style={{ fontSize:14, color:M.ink3 }}>{t('profile.recoverSelectFile')}</div>}
              </div>
              <input type="file" accept=".mun" onChange={e => setOfflineRecoverFile(e.target.files?.[0] || null)} style={{ display:'none' }}/>
            </label>
            <button className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700, opacity: offlineRecoverFile ? 1 : 0.5 }}
              onClick={() => { if (offlineRecoverFile) setOfflineRecoverStep('key'); }}>
              {t('login.continue')}
            </button>
          </>)}

          {offlineRecoverStep === 'key' && (<>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:28, lineHeight:1.5 }}>{t('offline.recoverStep2Sub')}</div>
            <div style={{ marginBottom: offlineRecoverError ? 6 : 20 }}>
              <div style={{ fontSize:12, color:M.ink3, marginBottom:5 }}>{t('profile.offlineKeySection')}</div>
              <input
                data-testid={T.offlineRecoverKeyInput}
                value={offlineRecoverKey}
                onChange={e => { setOfflineRecoverKey(e.target.value); setOfflineRecoverError(''); }}
                placeholder={t('offline.recoverKeyPlaceholder')}
                style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px', borderRadius:12, border:`1.5px solid ${offlineRecoverError ? M.clay : M.line}`, fontSize:14, fontFamily:M.fontMono, background:M.paper2, outline:'none', color:M.ink, letterSpacing:'0.05em' }}
              />
              {offlineRecoverError && <div style={{ fontSize:11, color:M.clay, marginTop:4 }}>{offlineRecoverError}</div>}
            </div>
            <button data-testid={T.offlineRecoverStart} className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700 }} onClick={doOfflineRecover}>
              {t('profile.recoverBtn')}
            </button>
          </>)}

          {offlineRecoverStep === 'loading' && (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingTop:32, gap:16 }}>
              <div style={{ width:72, height:72, borderRadius:'50%', background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <div style={{ animation:'munniSpin 1.4s linear infinite' }}>
                  <I name="refresh" size={32} color={M.sage}/>
                </div>
              </div>
              <div style={{ fontSize:17, fontWeight:600, color:M.ink, textAlign:'center' }}>{t('offline.recoverLoading')}</div>
              <div style={{ fontSize:13, color:M.ink3, textAlign:'center' }}>{t('offline.recoverLoadingSub')}</div>
            </div>
          )}

          {offlineRecoverStep === 'done' && (
            <div data-testid={T.offlineRecoverSuccess} style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingTop:24, gap:14 }}>
              <div style={{ width:72, height:72, borderRadius:'50%', background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="check" size={32} color={M.sage}/>
              </div>
              <div style={{ fontSize:20, fontWeight:700, color:M.ink, textAlign:'center' }}>{t('offline.recoverDone')}</div>
              <div style={{ fontSize:14, color:M.ink3, textAlign:'center' }}>{t('offline.recoverDoneSub')}</div>
              <button className="m-btn sage m-tap" style={{ height:54, width:'100%', fontSize:16, fontWeight:700, marginTop:12 }} onClick={doFinishRecover}>
                {t('offline.recoverDoneBtn')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Main login screen
  const langNames = { en: 'English', nl: 'Nederlands', tr: 'Türkçe' };
  const langFlags = { en: '1f1ec-1f1e7', nl: '1f1f3-1f1f1', tr: '1f1f9-1f1f7' };
  const flagStyle = dark ? { borderRadius:3, flexShrink:0, filter:'invert(1) hue-rotate(180deg)' } : { borderRadius:3, flexShrink:0 };
  return (
    <div key="login" className="m-screen m-fade" style={{ position:'relative', background:M.paper }}><DevPanel screenKey="login"/>
      {showLangDropdown && <div style={{ position:'fixed', inset:0, zIndex:98 }} onClick={() => setShowLangDropdown(false)}/>}

      <div style={{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column' }}>
        <StatusBar/>

        {/* Hero: img in flow, height driven by PNG aspect ratio — no fixed pixels */}
        <div style={{ position:'relative', flexShrink:0 }}>
          <img src={assetBgUrl} alt="" aria-hidden="true" style={{ display:'block', width:'100%', height:'auto' }}/>

          {/* Logo + language trigger row – overlaid at top of image */}
          <div style={{ position:'absolute', top:0, left:0, right:0, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 20px 0', zIndex:99 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <img src={munniLogoUrl} style={{ width:44, height:44, objectFit:'contain', flexShrink:0 }} alt="munni"/>
              <span className="m-logo" style={{ fontSize:22, fontWeight:700, color:M.brand, fontFamily:M.fontBrand, letterSpacing:'0.01em' }}>munni<span style={{ opacity:0.5 }}>.</span></span>
            </div>
            <div style={{ position:'relative' }}>
              <button data-testid="login-lang-trigger" className="m-tap" onClick={() => setShowLangDropdown(v => !v)}
                style={{ background:M.paper, border:`1px solid ${M.line}`, borderRadius:20, padding:'6px 12px 6px 10px', fontSize:12, color:M.ink2, cursor:'pointer', fontFamily:M.fontUI, display:'flex', alignItems:'center', gap:6, boxShadow:'0 2px 12px rgba(0,0,0,0.12)' }}>
                <img src={`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${langFlags[lang]}.svg`} width={16} height={16} style={{ borderRadius:2, flexShrink:0 }} alt=""/>
                <span>{langNames[lang] || 'English'}</span>
                {showLangDropdown ? <I name="caretU" size={11} color={M.brand}/> : <I name="caretD" size={11} color={M.brand}/>}
              </button>
              {showLangDropdown && (
                <div style={{ position:'absolute', right:0, top:'calc(100% + 8px)', background:M.paper, borderRadius:14, boxShadow:'0 8px 32px rgba(0,0,0,0.18)', border:`1px solid ${M.line}`, minWidth:185, overflow:'hidden', zIndex:200 }}>
                  {[{ code:'en', label:'English' }, { code:'nl', label:'Nederlands' }, { code:'tr', label:'Türkçe' }].map((l, idx, arr) => (
                    <button key={l.code} className="m-tap" onClick={() => { setLang(l.code); setShowLangDropdown(false); }}
                      style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 16px', width:'100%', background:'none', border:'none', borderBottom: idx < arr.length-1 ? `1px solid ${M.line2}` : 'none', cursor:'pointer', fontFamily:M.fontUI, fontSize:14, color:M.ink, boxSizing:'border-box' }}>
                      <img src={`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${langFlags[l.code]}.svg`} width={24} height={24} style={flagStyle} alt=""/>
                      <span style={{ flex:1, textAlign:'left' }}>{l.label}</span>
                      {lang === l.code && <I name="check" size={14} color={M.sage}/>}
                    </button>
                  ))}
                  <div style={{ height:1, background:M.line2 }}/>
                  <button data-testid={T.loginLangBtn} className="m-tap" onClick={() => { setShowLangDropdown(false); setMode('language'); }}
                    style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'9px 16px', width:'100%', background:M.paper2, border:'none', cursor:'pointer', fontFamily:M.fontUI, fontSize:12, color:M.ink3, boxSizing:'border-box' }}>
                    {t('login.langMore')}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Heading – upper-left, below the header row */}
          <div style={{ position:'absolute', top:62, left:0, padding:'0 22px', zIndex:4 }}>
            <div style={{ maxWidth:175, fontSize:44, fontWeight:800, color:M.brand, lineHeight:1.06, letterSpacing:'-0.03em', fontFamily:M.fontDisp }}>
              {hasOpenedBefore ? t('login.welcome') : t('login.welcomeFirst')}
            </div>
            <div style={{ maxWidth:175, fontSize:12, color:M.ink3, marginTop:8, lineHeight:1.5 }}>
              {t('login.subtitle')}
            </div>
          </div>
        </div>

        {/* Form area */}
        <div style={{ padding:'18px 20px 20px', display:'flex', flexDirection:'column', gap:10, flex:1 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <button data-testid={T.loginAppleBtn} className="m-btn outline m-tap" style={{ height:52, justifyContent:'center', gap:6, fontSize:11, padding:'0 6px', background:'#FFFFFF', boxShadow:'0 2px 10px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05)' }} onClick={() => handleApple(false)}>
              <IcoApple size={16} color={M.ink}/> {t('login.apple')}
            </button>
            <button data-testid={T.loginGoogleBtn} className="m-btn outline m-tap" style={{ height:52, justifyContent:'center', gap:6, fontSize:11, padding:'0 6px', background:'#FFFFFF', boxShadow:'0 2px 10px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05)' }} onClick={() => handleGoogle(false)}>
              <IcoGoogle size={16}/> {t('login.google')}
            </button>
          </div>
          <Divr/>
          <div style={{ position:'relative' }}>
            <div style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}>
              <I name="mail" size={16} color={M.ink3}/>
            </div>
            <input
              data-testid={T.loginEmailInput}
              value={emailInput} onChange={e => { setEmailInput(e.target.value); setLoginError(null); }}
              type="email" placeholder={t('login.emailPlaceholder')}
              style={{ width:'100%', boxSizing:'border-box', padding:'14px 16px 14px 42px', borderRadius:12, border:`1.5px solid ${loginError?M.clay:M.line}`, fontSize:15, fontFamily:M.fontUI, background:'#FFFFFF', outline:'none', color:M.ink }}
            />
          </div>
          {loginError && <div data-testid={T.loginError} style={{ fontSize:12, color:M.clay, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setSignupEmailInput(emailInput); setMode('signup-email'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>{t('login.createAccount')}</button></div>}
          <button data-testid={T.loginEmailSubmit} className="m-btn m-tap" style={{ height:52, width:'100%', opacity:emailInput.trim()?1:0.5, background:M.brand, color:'#fff', border:'none', borderRadius:14, fontSize:15, fontWeight:600, fontFamily:M.fontUI, cursor:'pointer', position:'relative', overflow:'hidden' }} onClick={handleEmailContinue} disabled={!emailInput.trim()}>
            {t('login.continue')}
            <img src={leafOnlyUrl} alt="" aria-hidden="true" style={{ position:'absolute', right:-10, bottom:-8, width:72, height:72, objectFit:'contain', objectPosition:'right bottom', opacity:0.22, pointerEvents:'none' }}/>
          </button>
          <button data-testid={T.loginCreateAccount} className="m-tap" onClick={() => { setLoginError(null); setMode('signup'); }}
            style={{ background:'transparent', border:'none', fontSize:13, cursor:'pointer', fontFamily:M.fontUI, textAlign:'center', width:'100%', padding:'4px 0 2px' }}>
            <span style={{ color:M.ink3 }}>{t('login.noAccount')}</span>
            {' '}
            <span style={{ color:M.brand, fontWeight:600 }}>{t('login.signUpBtn')}</span>
          </button>

          <div style={{ flex:1, minHeight:8 }}/>

          <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:8 }}>
            <button data-testid={T.loginOfflineBtn} className="m-tap" onClick={() => setMode('offline-info')}
              style={{ background:'rgba(8,55,43,0.05)', border:'1px solid rgba(8,55,43,0.10)', borderRadius:12, padding:'11px 14px', fontSize:13, color:M.brand, cursor:'pointer', fontFamily:M.fontUI, display:'flex', alignItems:'center', gap:10, width:'100%', boxSizing:'border-box' }}>
              <I name="lock" size={15} color={M.brand}/>
              <span style={{ flex:1, textAlign:'left' }}>{t('offline.loginBtn')}</span>
              <I name="caretR" size={13} color={M.brand}/>
            </button>
            <button data-testid={T.loginDemoBtn} className="m-tap" onClick={() => doLogin('bank', 'bank@munni.app', 'Demo van der Berg', true)}
              style={{ background:'rgba(8,55,43,0.05)', border:'1px solid rgba(8,55,43,0.10)', borderRadius:12, padding:'11px 14px', fontSize:13, color:M.brand, cursor:'pointer', fontFamily:M.fontUI, display:'flex', alignItems:'center', gap:10, width:'100%', boxSizing:'border-box' }}>
              <I name="eye" size={15} color={M.brand}/>
              <span style={{ flex:1, textAlign:'left' }}>{t('login.demoUser')}</span>
              <I name="caretR" size={13} color={M.brand}/>
            </button>
          </div>

          <div style={{ fontSize:11, color:M.ink4, textAlign:'center', lineHeight:1.6 }}>
            {t('login.termsIntro')}{' '}
            <button data-testid={T.loginTermsLink} onClick={() => setMode('terms')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>{t('login.termsLinkText')}</button>
            {' '}{t('login.termsAnd')}{' '}
            <button data-testid={T.loginPrivacyLink} onClick={() => setMode('privacy')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>{t('login.termsPrivacy')}</button>
            {(()=>{ const s=t('login.termsSuffix'); return (s && s!=='login.termsSuffix') ? <>{' '}{s}</> : null; })()}
          </div>
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
    <DevModeProvider>
      <DarkCtx.Provider value={{ dark, setDark }}>
        <LangProvider>
          {isMobile ? appContent : <IOSDevice>{appContent}</IOSDevice>}
        </LangProvider>
      </DarkCtx.Provider>
    </DevModeProvider>
  );
}
