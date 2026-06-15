import { M } from '../app/theme.jsx';

export const DEFAULT_API_URL = 'apollousa.okkes.synology.me:443';
export const DEMO_API_URL    = 'apollousa-demo.okkes.synology.me:443';

export const PROFILE_NAME_MAX = 30;
export const PROFILE_NAME_RE  = /^[\p{L}0-9 '.\-]{1,30}$/u;

export const STORAGE_KEYS = {
  lang:              'munni_lang',
  langTab:           'munni_lang_tab',
  profileEmail:      'munni_profile_email',
  globalUsers:       'munni_global_users',
  globalInvitations: 'munni_global_invitations',
  globalFriendships: 'munni_global_friendships',
  globalBlocks:      'munni_global_blocks',
  resetSignal:       'munni_reset_signal',
  sharedData:        (profileId) => `munni_shared_data_${profileId}`,
};

// av1-av8: authoritative from Profile.jsx picker; av9-av10: extra user avatars from App.jsx
export const STOCK_AVATARS = [
  { id:'av1',  emoji:'🧑',    bg:'#FF6B6B' },
  { id:'av2',  emoji:'👩',    bg:'#4ECDC4' },
  { id:'av3',  emoji:'👨',    bg:'#45B7D1' },
  { id:'av4',  emoji:'🧔',    bg:'#96CEB4' },
  { id:'av5',  emoji:'👱',    bg:'#FFEAA7' },
  { id:'av6',  emoji:'🧕',    bg:'#DDA0DD' },
  { id:'av7',  emoji:'🧑‍💼', bg:'#98D8C8' },
  { id:'av8',  emoji:'👨‍🎨', bg:'#F7DC6F' },
  { id:'av9',  emoji:'🧙',    bg:'#50C878' },
  { id:'av10', emoji:'🐱',    bg:'#FF9AA2' },
];

// Landscape/nature icons for space avatars — distinct from user STOCK_AVATARS
export const STOCK_SPACE_AVATARS = [
  { id:'sp1',  emoji:'🌊', bg:'#4FC3F7' },
  { id:'sp2',  emoji:'🌲', bg:'#66BB6A' },
  { id:'sp3',  emoji:'🌙', bg:'#7986CB' },
  { id:'sp4',  emoji:'🌞', bg:'#FFB300' },
  { id:'sp5',  emoji:'🌸', bg:'#F06292' },
  { id:'sp6',  emoji:'🏡', bg:'#FF7043' },
  { id:'sp7',  emoji:'🌿', bg:'#26A69A' },
  { id:'sp8',  emoji:'⭐', bg:'#FFA726' },
  { id:'sp9',  emoji:'🎯', bg:'#EC407A' },
  { id:'sp10', emoji:'🌈', bg:'#AB47BC' },
];

export const CURRENCIES = [
  { code:'EUR', symbol:'€',   name:'Euro' },
  { code:'USD', symbol:'$',   name:'US Dollar' },
  { code:'GBP', symbol:'£',   name:'British Pound' },
  { code:'CHF', symbol:'Fr',  name:'Swiss Franc' },
  { code:'SEK', symbol:'kr',  name:'Swedish Krona' },
  { code:'NOK', symbol:'kr',  name:'Norwegian Krone' },
  { code:'DKK', symbol:'kr',  name:'Danish Krone' },
  { code:'PLN', symbol:'zł',  name:'Polish Złoty' },
  { code:'CZK', symbol:'Kč',  name:'Czech Koruna' },
  { code:'HUF', symbol:'Ft',  name:'Hungarian Forint' },
  { code:'RON', symbol:'lei', name:'Romanian Leu' },
  { code:'TRY', symbol:'₺',   name:'Turkish Lira' },
  { code:'AUD', symbol:'A$',  name:'Australian Dollar' },
  { code:'NZD', symbol:'NZ$', name:'New Zealand Dollar' },
  { code:'CAD', symbol:'C$',  name:'Canadian Dollar' },
  { code:'BRL', symbol:'R$',  name:'Brazilian Real' },
  { code:'MXN', symbol:'MX$', name:'Mexican Peso' },
  { code:'ARS', symbol:'AR$', name:'Argentine Peso' },
  { code:'JPY', symbol:'¥',   name:'Japanese Yen',      noDecimals:true },
  { code:'KRW', symbol:'₩',   name:'South Korean Won',  noDecimals:true },
  { code:'CNY', symbol:'¥',   name:'Chinese Yuan' },
  { code:'INR', symbol:'₹',   name:'Indian Rupee' },
  { code:'SGD', symbol:'S$',  name:'Singapore Dollar' },
  { code:'AED', symbol:'AED', name:'UAE Dirham' },
  { code:'SAR', symbol:'SAR', name:'Saudi Riyal' },
  { code:'ILS', symbol:'₪',   name:'Israeli Shekel' },
  { code:'QAR', symbol:'QR',  name:'Qatari Riyal' },
  { code:'ZAR', symbol:'R',   name:'South African Rand' },
  { code:'NGN', symbol:'₦',   name:'Nigerian Naira' },
  { code:'PKR', symbol:'Rs',  name:'Pakistani Rupee' },
  { code:'IDR', symbol:'Rp',  name:'Indonesian Rupiah', noDecimals:true },
  { code:'MYR', symbol:'RM',  name:'Malaysian Ringgit' },
  { code:'THB', symbol:'฿',   name:'Thai Baht' },
  { code:'VND', symbol:'₫',   name:'Vietnamese Dong',   noDecimals:true },
  { code:'PHP', symbol:'₱',   name:'Philippine Peso' },
];

export const COUNTRY_CURRENCY = {
  NL:'EUR', DE:'EUR', BE:'EUR', FR:'EUR', ES:'EUR', IT:'EUR', PT:'EUR',
  FI:'EUR', AT:'EUR', LU:'EUR', IE:'EUR', SK:'EUR', SI:'EUR', EE:'EUR',
  LV:'EUR', LT:'EUR', CY:'EUR', MT:'EUR', GR:'EUR', HR:'EUR', AD:'EUR',
  MC:'EUR', ME:'EUR',
  GB:'GBP', TR:'TRY', PL:'PLN', SE:'SEK', NO:'NOK', DK:'DKK',
  CH:'CHF', LI:'CHF',
  CZ:'CZK', HU:'HUF', RO:'RON', BG:'EUR',
  IS:'EUR', RS:'EUR', BA:'EUR', MK:'EUR', MD:'EUR', UA:'EUR', BY:'EUR',
  RU:'EUR', AL:'EUR',
  US:'USD', CA:'CAD', BR:'BRL', MX:'MXN', AR:'ARS',
  CO:'USD', CL:'USD', PE:'USD',
  AU:'AUD', NZ:'NZD', SG:'SGD',
  JP:'JPY', KR:'KRW', CN:'CNY', IN:'INR',
  PK:'PKR', BD:'USD', ID:'IDR', MY:'MYR',
  TH:'THB', VN:'VND', PH:'PHP',
  AE:'AED', SA:'SAR', IL:'ILS', QA:'QAR',
  ZA:'ZAR', NG:'NGN', EG:'USD', GH:'USD', KE:'USD', MA:'USD',
};

export const PERM_LEVELS = ['reader', 'contributor', 'owner'];

export const PERM_COLOR = { reader: M.ink3, contributor: M.sage,     owner: M.ochre     };
export const PERM_BG    = { reader: M.paper2, contributor: M.sageSoft, owner: M.ochreSoft };

// Use instead of static PERM_LABEL object so i18n works correctly
export const permLabel = (perm, t) =>
  t(`profile.perm${perm.charAt(0).toUpperCase()}${perm.slice(1)}`);
