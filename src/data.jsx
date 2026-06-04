export const CATEGORIES = {
  // ── Income ──────────────────────────────────────────────────
  income:                 { id:'income',                 name:'Income',             icon:'cash-plus', group:'Income',      isParent:true, positive:true },
  incomeUncategorized:    { id:'incomeUncategorized',    name:'Uncategorized',      icon:'help-circle-outline',            group:'Income',      parent:'income', positive:true },
  reimburse:              { id:'reimburse',              name:'Reimbursement',      icon:'cash-refund',           group:'Income',      parent:'income', positive:true },
  salary:                 { id:'salary',                 name:'Salary',             icon:'office-building-outline',         group:'Income',      parent:'income', positive:true },
  freelance:              { id:'freelance',              name:'Freelance Work',     icon:'home-city-outline',            group:'Income',      parent:'income', positive:true },
  rental:                 { id:'rental',                 name:'Rental Income',      icon:'store-clock-outline',          group:'Income',      parent:'income', positive:true },
  investIncome:           { id:'investIncome',           name:'Investment Income',  icon:'chart-timeline-variant',         group:'Income',      parent:'income', positive:true },
  incomeOther:            { id:'incomeOther',            name:'Other Income',       icon:'cash-plus', group:'Income',      parent:'income', positive:true },
  // ── Saving ──────────────────────────────────────────────────
  saving:                 { id:'saving',                 name:'Saving',             icon:'piggy-bank-outline',          group:'Saving',      isParent:true },
  savingWithdraw:         { id:'savingWithdraw',         name:'Withdrawal',         icon:'bank-remove',           group:'Saving',      parent:'saving' },
  savingDeposit:          { id:'savingDeposit',          name:'Deposit',            icon:'bank-plus',          group:'Saving',      parent:'saving' },
  // ── Expense (default) ───────────────────────────────────────
  expense:                { id:'expense',                name:'Expense',            icon:'cash-remove', group:'Expense',     isParent:true },
  expenseReimburse:       { id:'expenseReimburse',       name:'Reimbursement',      icon:'cash-refund',           group:'Expense',     parent:'expense' },
  expenseUncategorized:   { id:'expenseUncategorized',   name:'Uncategorized',      icon:'help-circle-outline',            group:'Expense',     parent:'expense' },
  // ── Housing ─────────────────────────────────────────────────
  housing:                { id:'housing',                name:'Housing',            icon:'home-outline',          group:'Housing',     isParent:true, color:'#E67E22' },
  housingRent:            { id:'housingRent',            name:'Rent & Mortgage',    icon:'home-import-outline',          group:'Housing',     parent:'housing' },
  housingUtility:         { id:'housingUtility',         name:'Utility',            icon:'home-lightning-bolt-outline',          group:'Housing',     parent:'housing' },
  housingMaintenance:     { id:'housingMaintenance',     name:'Maintenance',        icon:'wrench-outline',            group:'Housing',     parent:'housing' },
  housingStorage:         { id:'housingStorage',         name:'Storage Area',       icon:'warehouse',            group:'Housing',     parent:'housing' },
  housingOther:           { id:'housingOther',           name:'Other',              icon:'home-outline',          group:'Housing',     parent:'housing' },
  // ── Transportation ──────────────────────────────────────────
  transport:              { id:'transport',              name:'Transportation',     icon:'bus-side',            group:'Transportation', isParent:true, color:'#3498DB' },
  transportCar:           { id:'transportCar',           name:'Car Payment',        icon:'car-outline',            group:'Transportation', parent:'transport' },
  transportFuel:          { id:'transportFuel',          name:'Gas & Fuel',         icon:'gas-station-outline',          group:'Transportation', parent:'transport' },
  transportPublic:        { id:'transportPublic',        name:'Public Transport',   icon:'train-car',            group:'Transportation', parent:'transport' },
  transportOther:         { id:'transportOther',         name:'Other',              icon:'bus-side',            group:'Transportation', parent:'transport' },
  // ── Consumption ─────────────────────────────────────────────
  consumption:            { id:'consumption',            name:'Consumption',        icon:'food-outline',           group:'Consumption', isParent:true, color:'#27AE60' },
  groceries:              { id:'groceries',              name:'Grocery',            icon:'cart-variant',           group:'Consumption', parent:'consumption' },
  breakfast:              { id:'breakfast',              name:'Breakfast & Brunch', icon:'bread-slice-outline',           group:'Consumption', parent:'consumption' },
  restaurants:            { id:'restaurants',            name:'Dining Out',         icon:'room-service-outline',           group:'Consumption', parent:'consumption' },
  takeout:                { id:'takeout',                name:'Takeout & Delivery', icon:'food-takeout-box-outline',           group:'Consumption', parent:'consumption' },
  sweets:                 { id:'sweets',                 name:'Sweets & Treats',    icon:'candy-outline',           group:'Consumption', parent:'consumption' },
  alcohol:                { id:'alcohol',                name:'Alcohol & Tobacco',  icon:'smoking',            group:'Consumption', parent:'consumption' },
  coffee:                 { id:'coffee',                 name:'Coffee',             icon:'coffee-outline',          group:'Consumption', parent:'consumption' },
  consumptionOther:       { id:'consumptionOther',       name:'Other',              icon:'food-outline',           group:'Consumption', parent:'consumption' },
  // ── Personal Care ───────────────────────────────────────────
  personalCare:           { id:'personalCare',           name:'Personal Care',      icon:'mirror',           group:'Personal Care', isParent:true, color:'#9B59B6' },
  haircut:                { id:'haircut',                name:'Haircut',            icon:'content-cut',           group:'Personal Care', parent:'personalCare' },
  toiletry:               { id:'toiletry',               name:'Toiletry',           icon:'toothbrush',         group:'Personal Care', parent:'personalCare' },
  beautyProduct:          { id:'beautyProduct',          name:'Health & Beauty',    icon:'hair-dryer-outline',         group:'Personal Care', parent:'personalCare' },
  personalCareOther:      { id:'personalCareOther',      name:'Other',              icon:'mirror',           group:'Personal Care', parent:'personalCare' },
  // ── Entertainment ───────────────────────────────────────────
  entertainment:          { id:'entertainment',          name:'Entertainment',      icon:'drama-masks',           group:'Entertainment', isParent:true, color:'#E74C3C' },
  movie:                  { id:'movie',                  name:'Movie',              icon:'popcorn',           group:'Entertainment', parent:'entertainment' },
  concerts:               { id:'concerts',               name:'Concerts & Shows',   icon:'curtains',           group:'Entertainment', parent:'entertainment' },
  sportingEvent:          { id:'sportingEvent',          name:'Sporting Event',     icon:'soccer-field',           group:'Entertainment', parent:'entertainment' },
  gambling:               { id:'gambling',               name:'Gambling',           icon:'slot-machine-outline',           group:'Entertainment', parent:'entertainment' },
  hobby:                  { id:'hobby',                  name:'Hobby',              icon:'checkerboard',            group:'Entertainment', parent:'entertainment' },
  videoGame:              { id:'videoGame',              name:'Video Game',         icon:'gamepad-square-outline',            group:'Entertainment', parent:'entertainment' },
  dating:                 { id:'dating',                 name:'Dating',             icon:'heart-multiple-outline',           group:'Entertainment', parent:'entertainment' },
  subs:                   { id:'subs',                   name:'Streaming Service',  icon:'television-play',           group:'Entertainment', parent:'entertainment' },
  entertainmentOther:     { id:'entertainmentOther',     name:'Other',              icon:'drama-masks',           group:'Entertainment', parent:'entertainment' },
  // ── Sport ───────────────────────────────────────────────────
  sport:                  { id:'sport',                  name:'Sport',              icon:'tennis',            group:'Sport',       isParent:true, color:'#1ABC9C' },
  gym:                    { id:'gym',                    name:'Gym Membership',     icon:'dumbbell',            group:'Sport',       parent:'sport' },
  sportsEquipment:        { id:'sportsEquipment',        name:'Sports Equipment',   icon:'biathlon',            group:'Sport',       parent:'sport' },
  sportOther:             { id:'sportOther',             name:'Other',              icon:'tennis',            group:'Sport',       parent:'sport' },
  // ── Shopping ────────────────────────────────────────────────
  shopping:               { id:'shopping',               name:'Shopping',           icon:'shopping-outline',           group:'Shopping',    isParent:true, color:'#F39C12' },
  clothing:               { id:'clothing',               name:'Clothing',           icon:'tshirt-crew-outline',           group:'Shopping',    parent:'shopping' },
  electronics:            { id:'electronics',            name:'Electronic',         icon:'cellphone-link',            group:'Shopping',    parent:'shopping' },
  homeGoods:              { id:'homeGoods',              name:'Home Goods',         icon:'sofa-single-outline',          group:'Shopping',    parent:'shopping' },
  gift:                   { id:'gift',                   name:'Gift',               icon:'gift-outline',           group:'Shopping',    parent:'shopping' },
  intimateUtility:        { id:'intimateUtility',        name:'Intimate Utility',   icon:'account-heart-outline',           group:'Shopping',    parent:'shopping' },
  festivity:              { id:'festivity',              name:'Festivity',          icon:'party-popper',           group:'Shopping',    parent:'shopping' },
  houseGarden:            { id:'houseGarden',            name:'House & Garden',     icon:'watering-can-outline',          group:'Shopping',    parent:'shopping' },
  homeAutomation:         { id:'homeAutomation',         name:'Home Automation',    icon:'robot-outline',            group:'Shopping',    parent:'shopping' },
  childCare:              { id:'childCare',              name:'Child Care',         icon:'baby-face-outline',           group:'Shopping',    parent:'shopping' },
  shoppingOther:          { id:'shoppingOther',          name:'Other',              icon:'shopping-outline',           group:'Shopping',    parent:'shopping' },
  // ── Holiday ─────────────────────────────────────────────────
  holiday:                { id:'holiday',                name:'Holiday',            icon:'island',          group:'Holiday',     isParent:true, color:'#16A085' },
  flight:                 { id:'flight',                 name:'Flight',             icon:'airplane-takeoff',          group:'Holiday',     parent:'holiday' },
  hotel:                  { id:'hotel',                  name:'Hotel & Airbnb',     icon:'bed-outline',          group:'Holiday',     parent:'holiday' },
  carRental:              { id:'carRental',              name:'Car Rental',         icon:'car-key',            group:'Holiday',     parent:'holiday' },
  activity:               { id:'activity',               name:'Activity',           icon:'map-marker-outline',           group:'Holiday',     parent:'holiday' },
  holidayOther:           { id:'holidayOther',           name:'Other',              icon:'island',          group:'Holiday',     parent:'holiday' },
  // ── Education ───────────────────────────────────────────────
  education:              { id:'education',              name:'Education',          icon:'school-outline',            group:'Education',   isParent:true, color:'#2980B9' },
  tuition:                { id:'tuition',                name:'Tuition',            icon:'account-cash-outline',         group:'Education',   parent:'education' },
  course:                 { id:'course',                 name:'Course',             icon:'human-male-board',           group:'Education',   parent:'education' },
  book:                   { id:'book',                   name:'Book',               icon:'book-education-outline',            group:'Education',   parent:'education' },
  schoolSupply:           { id:'schoolSupply',           name:'School Supply',      icon:'notebook-edit-outline',           group:'Education',   parent:'education' },
  certificate:            { id:'certificate',            name:'Certificate',        icon:'certificate-outline',            group:'Education',   parent:'education' },
  newspaper:              { id:'newspaper',              name:'Newspaper',          icon:'newspaper-variant-outline',            group:'Education',   parent:'education' },
  educationOther:         { id:'educationOther',         name:'Other',              icon:'school-outline',            group:'Education',   parent:'education' },
  // ── Healthcare ──────────────────────────────────────────────
  healthcare:             { id:'healthcare',             name:'Healthcare',         icon:'hospital-box-outline',         group:'Healthcare',  isParent:true, color:'#E91E63' },
  doctorVisit:            { id:'doctorVisit',            name:'Doctor Visit',       icon:'stethoscope',         group:'Healthcare',  parent:'healthcare' },
  dental:                 { id:'dental',                 name:'Dental Work',        icon:'tooth-outline',         group:'Healthcare',  parent:'healthcare' },
  prescription:           { id:'prescription',           name:'Prescription',       icon:'pill',         group:'Healthcare',  parent:'healthcare' },
  healthInsurance:        { id:'healthInsurance',        name:'Health Insurance',   icon:'shield-check-outline',           group:'Healthcare',  parent:'healthcare' },
  healthUtility:          { id:'healthUtility',          name:'Health Utility',     icon:'face-mask-outline',         group:'Healthcare',  parent:'healthcare' },
  mentalCare:             { id:'mentalCare',             name:'Mental Care',        icon:'meditation',         group:'Healthcare',  parent:'healthcare' },
  healthcareOther:        { id:'healthcareOther',        name:'Other',              icon:'hospital-box-outline',         group:'Healthcare',  parent:'healthcare' },
  // ── Pet ─────────────────────────────────────────────────────
  pet:                    { id:'pet',                    name:'Pet',                icon:'fishbowl-outline',            group:'Pet',         isParent:true, color:'#795548' },
  petFood:                { id:'petFood',                name:'Pet Food',           icon:'food-drumstick-outline',           group:'Pet',         parent:'pet' },
  petSupply:              { id:'petSupply',              name:'Pet Supply',         icon:'paw-outline',            group:'Pet',         parent:'pet' },
  petInsurance:           { id:'petInsurance',           name:'Pet Insurance',      icon:'shield-bug-outline',           group:'Pet',         parent:'pet' },
  petOther:               { id:'petOther',               name:'Other',              icon:'fishbowl-outline',            group:'Pet',         parent:'pet' },
  // ── Extra ───────────────────────────────────────────────────
  extra:                  { id:'extra',                  name:'Extra',              icon:'archive-plus-outline',            group:'Extra',       isParent:true, color:'#607D8B' },
  birthday:               { id:'birthday',               name:'Birthday',           icon:'cake-variant-outline',           group:'Extra',       parent:'extra' },
  funeralInsurance:       { id:'funeralInsurance',       name:'Funeral Insurance',  icon:'shield-cross-outline',           group:'Extra',       parent:'extra' },
  charity:                { id:'charity',                name:'Charity',            icon:'handshake-outline',           group:'Extra',       parent:'extra' },
  taxes:                  { id:'taxes',                  name:'Taxes',              icon:'bank-transfer-in',           group:'Extra',       parent:'extra' },
  fee:                    { id:'fee',                    name:'Fee',                icon:'credit-card-check-outline',           group:'Extra',       parent:'extra' },
  workExpense:            { id:'workExpense',            name:'Work Expense',       icon:'briefcase-outline',            group:'Extra',       parent:'extra' },
  familyCare:             { id:'familyCare',             name:'Family Care',        icon:'account-child-outline',           group:'Extra',       parent:'extra' },
  lendMoney:              { id:'lendMoney',              name:'Lend Money',         icon:'hand-coin-outline',           group:'Extra',       parent:'extra' },
  cashWithdraw:           { id:'cashWithdraw',           name:'Cash Withdraw',      icon:'atm',           group:'Extra',       parent:'extra' },
  fines:                  { id:'fines',                  name:'Fines',              icon:'account-tie-hat-outline',          group:'Extra',       parent:'extra' },
  secret:                 { id:'secret',                 name:'Secret',             icon:'incognito',           group:'Extra',       parent:'extra' },
  invest:                 { id:'invest',                 name:'Investment',         icon:'chart-timeline-variant',         group:'Extra',       parent:'extra' },
  extraOther:             { id:'extraOther',             name:'Other',              icon:'archive-plus-outline',            group:'Extra',       parent:'extra' },
};

export let _catExt = {};

export function catPath(cat) {
  if (!cat) return '—';
  const par = cat.parent && (CATEGORIES[cat.parent] || _catExt[cat.parent]);
  if (par) return `${par.name} → ${cat.name}`;
  if (cat.isParent) return cat.name;
  return `${cat.group} → ${cat.name}`;
}

export const _GROUP_KEYS = {
  'Income':'cat.income','Saving':'cat.saving','Expense':'cat.expense',
  'Housing':'cat.housing','Transportation':'cat.transport','Consumption':'cat.consumption',
  'Personal Care':'cat.personalCare','Entertainment':'cat.entertainment',
  'Sport':'cat.sport','Shopping':'cat.shopping','Holiday':'cat.holiday',
  'Education':'cat.education','Healthcare':'cat.healthcare','Pet':'cat.pet','Extra':'cat.extra',
};
export function catNameT(catId, t) {
  const key = 'cat.' + catId;
  const tr = t(key);
  if (tr !== key) return tr;
  return (CATEGORIES[catId] || _catExt[catId] || {}).name || catId;
}
export function catPathT(cat, t) {
  if (!cat) return '—';
  const nm = catNameT(cat.id, t);
  const par = cat.parent && (CATEGORIES[cat.parent] || _catExt[cat.parent]);
  if (par) return `${catNameT(par.id, t)} → ${nm}`;
  if (cat.isParent) return nm;
  const gTr = t(_GROUP_KEYS[cat.group] || ('cat.'+cat.group));
  const g = (gTr && gTr !== (_GROUP_KEYS[cat.group] || ('cat.'+cat.group))) ? gTr : cat.group;
  return `${g} → ${nm}`;
}

export function fmtSyncTime(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d)) return null;
  const lang = localStorage.getItem('munni_lang') || 'en';
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  const JUST_NOW = { en:'just now', nl:'zojuist', tr:'az önce' };
  const MIN_AGO  = { en:(n)=>`${n} min ago`, nl:(n)=>`${n} min geleden`, tr:(n)=>`${n} dk önce` };
  const YEST     = { en:'yesterday', nl:'gisteren', tr:'dün' };
  if (diff < 60) return JUST_NOW[lang] || JUST_NOW.en;
  if (diff < 3600) return (MIN_AGO[lang] || MIN_AGO.en)(Math.floor(diff / 60));
  const hm = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const nowD = new Date();
  const dayDiff = Math.floor((nowD.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (dayDiff === 0) return hm;
  if (dayDiff === 1) return `${YEST[lang] || YEST.en} ${hm}`;
  const day = d.getDate();
  const mon = d.toLocaleString('en-GB', { month: 'short' }).toLowerCase();
  if (d.getFullYear() === new Date().getFullYear()) return `${day} ${mon}, ${hm}`;
  return `${day} ${mon} ${d.getFullYear()}, ${hm}`;
}

export function getUserSyncKey() {
  const m = sessionStorage.getItem('munni_last_login_method') || 'default';
  return `munni_last_synced_${m}`;
}

function getUserAccountsKey() {
  const m = sessionStorage.getItem('munni_last_login_method') || 'default';
  return `munni_bank_accounts_${m}`;
}

export function getUserId() {
  const m = sessionStorage.getItem('munni_last_login_method') || '';
  if (m === 'google') return 'ggl-0001';
  if (m === 'apple') return 'apl-0001';
  if (m === 'bank') return 'dmo-0001';
  // Email user: generate/retrieve random ID
  try {
    const email = JSON.parse(sessionStorage.getItem('munni_profile_email') || '""') || '';
    if (email && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(email)) {
      const regKey = 'munni_user_ids';
      const reg = JSON.parse(localStorage.getItem(regKey) || '{}');
      if (!reg[email]) {
        reg[email] = Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
        localStorage.setItem(regKey, JSON.stringify(reg));
      }
      return reg[email];
    }
  } catch {}
  return 'usr-0000';
}

export function registerUserInGlobalRegistry(userId, displayName, picture) {
  try {
    const reg = JSON.parse(localStorage.getItem('munni_global_users') || '{}');
    const prev = reg[userId] || {};
    reg[userId] = { ...prev, displayName: displayName || userId, updatedAt: Date.now(), ...(picture !== undefined ? { picture } : {}) };
    localStorage.setItem('munni_global_users', JSON.stringify(reg));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: 'munni_global_users' } }));
  } catch {}
}

export function addDevLog(level, msg, src) {
  const KEY = 'munni_dev_logs';
  try {
    const existing = JSON.parse(localStorage.getItem(KEY) || 'null');
    const arr = Array.isArray(existing) ? existing : [];
    const now = new Date();
    const ts = `Today ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const log = { id: `log_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, level, msg, src: src || 'app', ts };
    const updated = [log, ...arr].slice(0, 200);
    localStorage.setItem(KEY, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: KEY } }));
    if (level === 'error' || level === 'warn') {
      const unreadKey = 'munni_notif_unread';
      const cur = parseInt(localStorage.getItem(unreadKey) || '0', 10) || 0;
      localStorage.setItem(unreadKey, JSON.stringify(cur + 1));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: unreadKey } }));
    }
  } catch {}
}

export const DEMO_ACCOUNT_IDS = ['demo_main', 'demo_save'];
// Real accounts for google user
export const REAL_ACCOUNTS = [
  { id: 'main', name: 'Main · ING',        iban: 'NL47 INGB 0004 0000 4231', balance: 5240.18, type: 'checking', color: '#ff6200' },
  { id: 'save', name: 'Savings · ING',     iban: 'NL47 INGB 0007 7000 7782', balance: 3120.50, type: 'savings',  color: '#A8782B' },
  { id: 'inv',  name: 'Brokerage · DEGIRO',iban: 'NL47 DEGR 0001 0000 1015', balance: 365.00,  type: 'invest',  color: '#5E4A78' },
];
// Demo accounts — separate IDs, clearly labelled demo, only usable by demo profiles
export const DEMO_ACCOUNTS = [
  { id: 'demo_main', name: 'Demo Checking · ING', iban: 'NL00 DEMO 0000 0001 00', balance: 3420.55, type: 'checking', color: '#4A6A4F', isDemo: true },
  { id: 'demo_save', name: 'Demo Savings · ING',  iban: 'NL00 DEMO 0000 0002 00', balance: 8150.00, type: 'savings',  color: '#A8782B', isDemo: true },
];
export const APPLE_ACCOUNTS = [
  { id: 'abn_main', name: 'Betaalrekening · ABN AMRO', iban: 'NL47 ABNA 0428 7312 8940', balance: 3820.45, type: 'checking', color: '#009B77' },
  { id: 'abn_save', name: 'Spaarrekening · ABN AMRO',  iban: 'NL47 ABNA 0561 2849 3012', balance: 12450.00, type: 'savings',  color: '#A8782B' },
];
export const ACCOUNTS = DEMO_ACCOUNTS; // backward compat alias

export function getDefaultAccounts(method) {
  if (method === 'google') return REAL_ACCOUNTS.map(a => ({ ...a }));
  if (method === 'apple')  return APPLE_ACCOUNTS.map(a => ({ ...a }));
  if (method === 'bank')   return DEMO_ACCOUNTS.map(a => ({ ...a }));
  return [];
}


const _D0 = new Date();
const D = (n) => {
  const d = new Date(_D0);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

export const TRANSACTIONS = [
  { id: 't1',  date: D(1), time: '13:24', merchant: 'Vapiano',           desc: 'VAPIANO 1234 AMSTERDAM',     cat: 'restaurants', cats:[{catId:'restaurants',amount:14.40},{catId:'alcohol',amount:4.00}], amount: -18.40, account: 'main', confidence: 92 },
  { id: 't2',  date: D(1), time: '11:08', merchant: 'Albert Heijn',      desc: 'AH 5821 AMS-CENTRAAL',       cat: 'groceries',   cats:[{catId:'groceries',amount:35.10},{catId:'toiletry',amount:7.00}], amount: -42.10, account: 'main', confidence: 99, hasReceipt: true },
  { id: 't3',  date: D(1), time: '08:00', merchant: 'Acme Salary',       desc: 'ACME BV PAYROLL FEB',        cat: 'salary',      amount: 2480.00, account: 'main' },
  { id: 't4',  date: D(2), time: '20:14', merchant: 'Spotify',           desc: 'SPOTIFY P34520',             cat: 'subs',        amount: -9.99,  account: 'main', recurring: true },
  { id: 't5',  date: D(2), time: '17:38', merchant: 'NS · Sprinter',     desc: 'NS REIZIGERS 2026',          cat: 'transportPublic', amount: -12.20, account: 'main' },
  { id: 't6',  date: D(2), time: '12:50', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842',              cat: 'healthcare',  amount: -8.50,  account: 'main', confidence: 71, needsReview: true },
  { id: 't7',  date: D(2), time: '19:20', merchant: 'Friend · Tikkie',   desc: 'TIKKIE J. DE VRIES',         cat: 'reimburse',   amount: 9.20,   account: 'main', linkedTo: 't1' },
  { id: 't8',  date: D(3), time: '21:00', merchant: 'Amazon.nl',         desc: 'AMZN MKTPLC 49281',          cat: 'hobby',       amount: -34.99, account: 'main', confidence: 54, needsReview: true },
  { id: 't9',  date: D(3), time: '09:00', merchant: 'Rent · Stadgenoot', desc: 'STADGENOOT HUUR FEB',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 't10', date: D(3), time: '08:30', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 't11', date: D(5), time: '20:00', merchant: "L'Osteria",         desc: "L'OSTERIA AMS",              cat: 'restaurants', amount: -32.00, account: 'main' },
  { id: 't12', date: D(6), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -28.40, account: 'main' },
  { id: 't13', date: D(7), time: '10:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 't14', date: D(9), time: '16:00', merchant: 'Etos',              desc: 'ETOS 0341',                  cat: 'healthcare',  amount: -14.20, account: 'main', needsReview: true },
  { id: 't15', date: D(11), time: '20:30', merchant: 'Vapiano',           desc: 'VAPIANO 1234',               cat: 'restaurants', amount: -22.50, account: 'main' },
  { id: 't16', date: D(14), time: '12:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -38.10, account: 'main' },
  { id: 't17', date: D(16), time: '21:30', merchant: 'Five Guys',         desc: 'FIVEGUYS AMS',               cat: 'restaurants', amount: -22.50, account: 'main' },
  { id: 't18', date: D(18), time: '08:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true, needsReview: true },
  { id: 't19', date: D(20), time: '14:00', merchant: 'NS · OV Chip',      desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -38.20, account: 'main' },
  { id: 't20', date: D(22), time: '20:00', merchant: 'Sushi Place',       desc: 'SUSHITIME AMS',              cat: 'restaurants', amount: -22.50, account: 'main' },
  { id: 't21', date: D(24), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -56.20, account: 'main' },
  { id: 't22', date: D(26), time: '15:00', merchant: 'Bol.com',           desc: 'BOL.COM 02938',              cat: 'hobby',       amount: -45.00, account: 'main', needsReview: true },
  { id: 't23', date: D(28), time: '09:00', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 't24', date: D(30), time: '08:00', merchant: 'Eneco',             desc: 'ENECO ENERGIE',              cat: 'housingUtility', amount: -65.00, account: 'main', recurring: true },
  { id: 't25', date: D(1), time: '10:22', merchant: 'Coolblue',           desc: 'COOLBLUE 887731',            cat: 'hobby',      amount: -149.99, account: 'main', confidence: 61, needsReview: true },
  { id: 't26', date: D(2), time: '14:05', merchant: 'Kruidvat',           desc: 'KRUIDVAT 0281',              cat: 'healthcare', amount: -12.40,  account: 'main', confidence: 58, needsReview: true },
  { id: 't27', date: D(3), time: '18:30', merchant: 'Amazon.nl',          desc: 'AMZN MKTPLC 50128',          cat: 'hobby',      amount: -22.00,  account: 'main', confidence: 49, needsReview: true },
  { id: 't28', date: D(4), time: '09:15', merchant: 'MediaMarkt',         desc: 'MEDIAMARKT AMS',             cat: 'hobby',      amount: -89.00,  account: 'main', confidence: 55, needsReview: true },
  { id: 't29', date: D(5), time: '16:40', merchant: 'Apotheek Centraal',  desc: 'APOTHEEK 7842',              cat: 'healthcare', amount: -23.90,  account: 'main', confidence: 67, needsReview: true },
  { id: 't30', date: D(6), time: '13:00', merchant: 'HEMA',               desc: 'HEMA AMSTERDAM',             cat: 'hobby',      amount: -18.50,  account: 'main', confidence: 52, needsReview: true },
  { id: 't31', date: D(7), time: '11:30', merchant: 'Kruidvat',           desc: 'KRUIDVAT 0281',              cat: 'healthcare', amount: -8.90,   account: 'main', confidence: 60, needsReview: true },
  { id: 't32', date: D(8), time: '17:00', merchant: 'Etos',               desc: 'ETOS 0341',                  cat: 'healthcare', amount: -19.80,  account: 'main', confidence: 64, needsReview: true },
  { id: 't33', date: D(9), time: '14:20', merchant: 'Coolblue',           desc: 'COOLBLUE 884290',            cat: 'hobby',      amount: -59.99,  account: 'main', confidence: 53, needsReview: true },
  { id: 't34', date: D(10), time: '20:10', merchant: 'Amazon.nl',          desc: 'AMZN MKTPLC 49900',          cat: 'hobby',      amount: -36.50,  account: 'main', confidence: 47, needsReview: true },
  { id: 't35', date: D(1), time: '15:30', merchant: 'Intersport Amsterdam Zuid', desc: 'INTERSPORT STADIUM SHOPPING CENTER NL', cat: 'sportsEquipment', amount: -89.99, account: 'main' },
  { id: 't36', date: D(2), time: '11:45', merchant: 'H&M Nederland B.V.', desc: 'HM NETHERLANDS ONLINE SHOP ORDER #923847', cat: 'clothing', amount: -34.50, account: 'main' },
  { id: 't37', date: D(4), time: '20:00', merchant: 'Tandartspraktijk Centrum', desc: 'TANDARTSPR CENTRUM AMS PERIODIEK CONTROL', cat: 'dental', amount: -55.00, account: 'main', confidence: 62, needsReview: true },
  { id: 't38', date: D(5), time: '19:30', merchant: 'DJI Online Store', desc: 'DJI EUROPE B.V. ONLINE PURCHASE DRONE PARTS', cat: 'electronics', amount: -219.00, account: 'main' },
  { id: 't39', date: D(6), time: '09:00', merchant: 'Gemeente Amsterdam', desc: 'GEMEENTE AMSTERDAM PARKEERBELASTING NAHEFFING', cat: 'fines', amount: -68.00, account: 'main' },
  // Same-merchant + same-amount edge case test
  { id: 'tb1', date: D(1), time: '09:30', merchant: 'Jumbo', desc: 'JUMBO SUPERMARKT 0042', cat: 'groceries', amount: -23.50, account: 'main', confidence: 58, needsReview: true },
  { id: 'tb2', date: D(2), time: '16:15', merchant: 'Jumbo', desc: 'JUMBO SUPERMARKT 0042', cat: 'groceries', amount: -23.50, account: 'main', confidence: 56, needsReview: true },
  // Same-merchant bulk review demo — Apotheek Centraal
  { id: 'ta1',  date: D(32), time: '14:30', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -14.80, account: 'main', confidence: 55, needsReview: true },
  { id: 'ta2',  date: D(40), time: '11:00', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -22.50, account: 'main', confidence: 60, needsReview: true },
  { id: 'ta3',  date: D(53), time: '16:20', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -9.30,  account: 'main', confidence: 52, needsReview: true },
  { id: 'ta4',  date: D(66), time: '13:45', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -18.60, account: 'main', confidence: 58, needsReview: true },
  { id: 'ta5',  date: D(76), time: '10:10', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -7.20,  account: 'main', confidence: 49, needsReview: true },
  { id: 'ta6',  date: D(89), time: '15:00', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -31.40, account: 'main', confidence: 63, needsReview: true },
  { id: 'ta7',  date: D(101), time: '09:30', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -12.90, account: 'main', confidence: 56, needsReview: true },
  { id: 'ta8',  date: D(112), time: '17:45', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -8.40,  account: 'main', confidence: 51, needsReview: true },
  { id: 'ta9',  date: D(128), time: '12:20', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -24.70, account: 'main', confidence: 67, needsReview: true },
  { id: 'ta10', date: D(144), time: '14:00', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -16.50, account: 'main', confidence: 54, needsReview: true },
  { id: 'ta11', date: D(162), time: '11:30', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -11.20, account: 'main', confidence: 59, needsReview: true },
  { id: 'ta12', date: D(178), time: '16:40', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -28.90, account: 'main', confidence: 61, needsReview: true },
  { id: 'ta13', date: D(191), time: '10:50', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -6.80,  account: 'main', confidence: 47, needsReview: true },
  { id: 'ta14', date: D(204), time: '13:15', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -19.40, account: 'main', confidence: 53, needsReview: true },
  { id: 'ta15', date: D(216), time: '15:30', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -33.60, account: 'main', confidence: 65, needsReview: true },
  { id: 'ta16', date: D(229), time: '09:00', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -14.10, account: 'main', confidence: 58, needsReview: true },
  { id: 'ta17', date: D(244), time: '17:20', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'prescription', amount: -9.70,  account: 'main', confidence: 50, needsReview: true },
  { id: 'ta18', date: D(256), time: '12:40', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842 NL', cat: 'healthcare', amount: -21.30, account: 'main', confidence: 55, needsReview: true },
  // Nov 2025
  { id: 'n1',  date: D(93), time: '08:00', merchant: 'Acme Salary',       desc: 'ACME BV PAYROLL NOV',        cat: 'salary',      amount: 2480.00, account: 'main' },
  { id: 'n2',  date: D(94), time: '19:30', merchant: 'Albert Heijn',      desc: 'AH 5821 AMS',                cat: 'groceries',   amount: -52.40, account: 'main' },
  { id: 'n3',  date: D(94), time: '09:99', merchant: 'Spotify',           desc: 'SPOTIFY P34520',             cat: 'subs',        amount: -9.99,  account: 'main', recurring: true },
  { id: 'n4',  date: D(95), time: '00:00', merchant: 'Rent · Stadgenoot', desc: 'STADGENOOT HUUR NOV',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 'n5',  date: D(96), time: '12:30', merchant: 'Vapiano',           desc: 'VAPIANO 1234',               cat: 'restaurants', amount: -21.50, account: 'main' },
  { id: 'n6',  date: D(97), time: '20:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true },
  { id: 'n7',  date: D(98), time: '08:30', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'n8',  date: D(99), time: '11:00', merchant: 'NS · Sprinter',     desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -28.60, account: 'main' },
  { id: 'n9',  date: D(99), time: '21:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 'n10', date: D(101), time: '18:00', merchant: 'Eneco',             desc: 'ENECO ENERGIE',              cat: 'housingUtility', amount: -65.00, account: 'main', recurring: true },
  { id: 'n11', date: D(102), time: '14:20', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -43.20, account: 'main' },
  { id: 'n12', date: D(103), time: '12:00', merchant: 'Five Guys',         desc: 'FIVEGUYS AMS',               cat: 'restaurants', amount: -19.50, account: 'main' },
  { id: 'n13', date: D(104), time: '10:30', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'n14', date: D(106), time: '16:00', merchant: 'Bol.com',           desc: 'BOL.COM 02100',              cat: 'hobby',       amount: -32.99, account: 'main' },
  { id: 'n15', date: D(108), time: '09:00', merchant: 'Kruidvat',          desc: 'KRUIDVAT 0281',              cat: 'healthcare',  amount: -11.50, account: 'main' },
  { id: 'n16', date: D(110), time: '14:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -58.80, account: 'main' },
  // Dec 2025
  { id: 'd1',  date: D(63), time: '08:00', merchant: 'Acme Salary',       desc: 'ACME BV PAYROLL DEC',        cat: 'salary',      amount: 2480.00, account: 'main' },
  { id: 'd2',  date: D(64), time: '19:00', merchant: 'Spotify',           desc: 'SPOTIFY P34520',             cat: 'subs',        amount: -9.99,  account: 'main', recurring: true },
  { id: 'd3',  date: D(65), time: '00:00', merchant: 'Rent · Stadgenoot', desc: 'STADGENOOT HUUR DEC',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 'd4',  date: D(66), time: '20:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -67.30, account: 'main' },
  { id: 'd5',  date: D(67), time: '21:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true },
  { id: 'd6',  date: D(69), time: '12:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 'd7',  date: D(69), time: '19:30', merchant: 'Vapiano',           desc: 'VAPIANO XMAS DINNER',        cat: 'restaurants', amount: -45.00, account: 'main' },
  { id: 'd8',  date: D(71), time: '10:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -89.50, account: 'main' },
  { id: 'd9',  date: D(73), time: '16:00', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'd10', date: D(74), time: '20:30', merchant: 'H&M Nederland',     desc: 'HM ONLINE ORDER WINTER',     cat: 'clothing',    amount: -78.50, account: 'main' },
  { id: 'd11', date: D(75), time: '11:30', merchant: 'Eneco',             desc: 'ENECO ENERGIE',              cat: 'housingUtility', amount: -65.00, account: 'main', recurring: true },
  { id: 'd12', date: D(76), time: '14:00', merchant: 'Bol.com',           desc: 'BOL.COM XMAS GIFTS',         cat: 'hobby',       amount: -124.00, account: 'main' },
  { id: 'd13', date: D(77), time: '09:30', merchant: 'NS · Sprinter',     desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -19.40, account: 'main' },
  { id: 'd14', date: D(59), time: '19:30', merchant: 'L\'Osteria',        desc: "L'OSTERIA AMS HOLIDAY",      cat: 'restaurants', amount: -58.00, account: 'main' },
  { id: 'd15', date: D(57), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821 XMAS',               cat: 'groceries',   amount: -112.40, account: 'main' },
  { id: 'd16', date: D(55), time: '15:00', merchant: 'MediaMarkt',        desc: 'MEDIAMARKT AMS BOXING DAY',  cat: 'electronics', amount: -199.00, account: 'main' },
  { id: 'd17', date: D(51), time: '21:00', merchant: 'Sushi Place',       desc: 'SUSHITIME NYE',              cat: 'restaurants', amount: -35.50, account: 'main' },
  // Jan 2026
  { id: 'j1',  date: D(32), time: '08:00', merchant: 'Acme Salary',       desc: 'ACME BV PAYROLL JAN',        cat: 'salary',      amount: 2480.00, account: 'main' },
  { id: 'j2',  date: D(33), time: '19:00', merchant: 'Spotify',           desc: 'SPOTIFY P34520',             cat: 'subs',        amount: -9.99,  account: 'main', recurring: true },
  { id: 'j3',  date: D(34), time: '00:00', merchant: 'Rent · Stadgenoot', desc: 'STADGENOOT HUUR JAN',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 'j4',  date: D(35), time: '20:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true },
  { id: 'j5',  date: D(38), time: '09:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 'j6',  date: D(38), time: '11:30', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -61.20, account: 'main' },
  { id: 'j7',  date: D(39), time: '18:20', merchant: 'Eneco',             desc: 'ENECO ENERGIE',              cat: 'housingUtility', amount: -65.00, account: 'main', recurring: true },
  { id: 'j8',  date: D(40), time: '14:00', merchant: 'NS · Sprinter',     desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -22.40, account: 'main' },
  { id: 'j9',  date: D(41), time: '20:00', merchant: 'Vapiano',           desc: 'VAPIANO 1234',               cat: 'restaurants', amount: -28.50, account: 'main' },
  { id: 'j10', date: D(42), time: '09:30', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'j11', date: D(43), time: '19:00', merchant: 'Amazon.nl',         desc: 'AMZN MKTPLC',                cat: 'hobby',       amount: -54.99, account: 'main' },
  { id: 'j12', date: D(45), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -44.30, account: 'main' },
  { id: 'j13', date: D(47), time: '16:00', merchant: 'Etos',              desc: 'ETOS 0341',                  cat: 'healthcare',  amount: -18.40, account: 'main' },
  { id: 'j14', date: D(48), time: '14:00', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  // Feb 2026 (first half — second half already covered by t1–t39, tb1–tb2)
  { id: 'f1',  date: D(13), time: '15:00', merchant: 'Koffie ☕',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'f2',  date: D(15), time: '18:30', merchant: 'Sushi Place',       desc: 'SUSHITIME AMS',              cat: 'restaurants', amount: -27.50, account: 'main' },
  { id: 'f3',  date: D(17), time: '09:00', merchant: 'NS · OV Chip',      desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -15.20, account: 'main' },
  { id: 'f4',  date: D(18), time: '14:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -49.80, account: 'main' },
  // Google Playstore for review (must be first two in review stack)
  { id: 'gp1', date: D(9), time: '14:30', merchant: 'Google Playstore',  desc: 'GOOGLE*PLAY 493820',        cat: 'entertainment', cats:[{catId:'entertainment',amount:22.99}], amount: -22.99, account: 'main', confidence: 60, needsReview: true, aiSuggestCat: 'hobby' },
  { id: 'gp2', date: D(36), time: '11:20', merchant: 'Google Playstore',  desc: 'GOOGLE*PLAY 487231',        cat: 'entertainment', cats:[{catId:'entertainment',amount:8.99}],  amount: -8.99,  account: 'main', confidence: 62, needsReview: true, aiSuggestCat: 'hobby' },
  // Saving account transfers — ensures Savings row > €0
  { id: 'sav1', date: D(9), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -150.00, account: 'main', savingAccount: 'save' },
  { id: 'sav2', date: D(25), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -200.00, account: 'main', savingAccount: 'save' },
  { id: 'sav3', date: D(61), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -120.00, account: 'main', savingAccount: 'save' },
  { id: 'sav4', date: D(91), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -150.00, account: 'main', savingAccount: 'save' },
  { id: 'sav5', date: D(122), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -180.00, account: 'main', savingAccount: 'save' },
  { id: 'sav6', date: D(152), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -200.00, account: 'main', savingAccount: 'save' },
  { id: 'sav7', date: D(183), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -175.00, account: 'main', savingAccount: 'save' },
];

// Deterministic daily transaction generator — 0–5 txs/day, avg ~100/month, Aug 2025 – Feb 2026
function genSeedTxs() {
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = ((Math.imul(s, 1664525) + 1013904223) >>> 0); return s / 4294967296; };
  }
  const POOL = [
    { merchant:'Albert Heijn',   desc:'AH 5821 AMS',            cat:'groceries',       min:12, max:85 },
    { merchant:'Jumbo',          desc:'JUMBO 0042',              cat:'groceries',       min:10, max:65 },
    { merchant:'Lidl',           desc:'LIDL AMS CENTRUM',        cat:'groceries',       min:8,  max:50 },
    { merchant:'Koffie ☕',      desc:'TOKI ESPRESSO',           cat:'coffee',          min:3,  max:6  },
    { merchant:'Koffie ☕',      desc:'COFFEE CORNER AMS',       cat:'coffee',          min:2,  max:5  },
    { merchant:'NS · Sprinter',  desc:'NS REIZIGERS',            cat:'transportPublic', min:4,  max:30 },
    { merchant:'GVB',            desc:'GVB OV AMSTERDAM',        cat:'transportPublic', min:2,  max:8  },
    { merchant:'Vapiano',        desc:'VAPIANO 1234 AMS',        cat:'restaurants',     min:14, max:38 },
    { merchant:'Five Guys',      desc:'FIVEGUYS AMSTERDAM',      cat:'restaurants',     min:16, max:30 },
    { merchant:'Thuisbezorgd',   desc:'THUISBEZORGD NL',         cat:'restaurants',     min:18, max:48 },
    { merchant:'Deliveroo',      desc:'DELIVEROO AMS',           cat:'restaurants',     min:15, max:42 },
    { merchant:'Sushi Place',    desc:'SUSHITIME AMS',           cat:'restaurants',     min:18, max:35 },
    { merchant:'Etos',           desc:'ETOS 0341',               cat:'healthcare',      min:5,  max:35 },
    { merchant:'Kruidvat',       desc:'KRUIDVAT 0281',           cat:'healthcare',      min:4,  max:30 },
    { merchant:'Bol.com',        desc:'BOL.COM ORDER',           cat:'hobby',           min:15, max:90, confidence:62, needsReview:true },
    { merchant:'Amazon.nl',      desc:'AMZN MKTPLC',             cat:'hobby',           min:12, max:70, confidence:55, needsReview:true },
    { merchant:'HEMA',           desc:'HEMA AMSTERDAM',          cat:'hobby',           min:8,  max:45 },
    { merchant:'Action',         desc:'ACTION AMSTERDAM',        cat:'hobby',           min:4,  max:25 },
    { merchant:'H&M Nederland',  desc:'HM NETHERLANDS',          cat:'clothing',        min:18, max:80 },
    { merchant:'Zara',           desc:'ZARA AMS BIJENKORF',      cat:'clothing',        min:25, max:95 },
    { merchant:'Primark',        desc:'PRIMARK AMS',             cat:'clothing',        min:12, max:60 },
    { merchant:'Coolblue',       desc:'COOLBLUE ORDER',          cat:'electronics',     min:25, max:180, confidence:58, needsReview:true },
    { merchant:'Pathé',          desc:'PATHE ARENA AMS',         cat:'entertainment',   min:10, max:25 },
  ];
  const result = [];
  const end = new Date('2026-02-18');
  for (let d = new Date('2025-08-01'); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const seed = (d.getFullYear() - 2000) * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const r = rng(seed);
    const n = r() < 0.06 ? 0 : (Math.floor(r() * 4) + 2);
    for (let i = 0; i < n; i++) {
      const p = POOL[Math.floor(r() * POOL.length)];
      const amt = -(Math.round((p.min + r() * (p.max - p.min)) * 100) / 100);
      const hh = 8 + Math.floor(r() * 13);
      const mm = Math.floor(r() * 60);
      result.push({ id:`g${seed}_${i}`, date:iso,
        time:`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`,
        merchant:p.merchant, desc:p.desc, cat:p.cat, amount:amt, account:'main',
        ...(p.confidence ? { confidence:p.confidence } : {}),
        ...(p.needsReview ? { needsReview:true } : {}) });
    }
    if (r() < 0.05) {
      const savAmt = -(Math.round((80 + r() * 200) * 100) / 100);
      result.push({ id:`gsav${seed}`, date:iso, time:'09:00',
        merchant:'Savings transfer', desc:'SPAAROVERBOEKING ING',
        cat:'savings', amount:savAmt, account:'main', savingAccount:'save' });
    }
  }
  return result;
}
export const GEN_TXS = genSeedTxs();

// ABN AMRO transactions for the Apple user
export const ABN_TRANSACTIONS = [
  { id:'ab1',  date:D(1),  time:'08:00', merchant:'TechCorp BV',        desc:'TECHCORP BV SALARIS FEB',      cat:'salary',         amount: 3150.00, account:'abn_main' },
  { id:'ab2',  date:D(1),  time:'13:45', merchant:'Jumbo',              desc:'JUMBO SUPERMARKT AMS 0081',    cat:'groceries',      amount: -61.20,  account:'abn_main' },
  { id:'ab3',  date:D(2),  time:'07:50', merchant:'NS · Intercity',     desc:'NS REIZIGERS OV JAN',          cat:'transportPublic',amount: -22.40,  account:'abn_main' },
  { id:'ab4',  date:D(2),  time:'19:00', merchant:'Rent · Vesteda',     desc:'VESTEDA HUUR FEB',             cat:'housingRent',    amount: -980.00, account:'abn_main', recurring:true },
  { id:'ab5',  date:D(3),  time:'12:30', merchant:'Thuisbezorgd',       desc:'THUISBEZORGD.NL ORDER',        cat:'restaurants',    amount: -31.50,  account:'abn_main' },
  { id:'ab6',  date:D(4),  time:'09:10', merchant:'Shell Tankstation',  desc:'SHELL AMSTERDAM WEST',         cat:'transportFuel',  amount: -88.00,  account:'abn_main' },
  { id:'ab7',  date:D(4),  time:'17:30', merchant:'Kruidvat',           desc:'KRUIDVAT 0419 AMS',            cat:'healthcare',     amount: -14.90,  account:'abn_main' },
  { id:'ab8',  date:D(5),  time:'20:30', merchant:'De Pizzabakkers',    desc:'DE PIZZABAKKERS AMSTERDAM',    cat:'restaurants',    amount: -38.50,  account:'abn_main' },
  { id:'ab9',  date:D(6),  time:'11:00', merchant:'Albert Heijn',       desc:'AH 9921 AMS-SLOTERDIJK',       cat:'groceries',      amount: -44.30,  account:'abn_main' },
  { id:'ab10', date:D(7),  time:'08:30', merchant:'Koffie ☕',           desc:'COFFEE COMPANY AMS',           cat:'coffee',         amount: -4.20,   account:'abn_main' },
  { id:'ab11', date:D(8),  time:'21:00', merchant:'Eneco',              desc:'ENECO ENERGIE FEB',            cat:'housingUtility', amount: -72.00,  account:'abn_main', recurring:true },
  { id:'ab12', date:D(9),  time:'14:20', merchant:'Bol.com',            desc:'BOL.COM ORDER 019283',         cat:'hobby',          amount: -39.99,  account:'abn_main', confidence:68, needsReview:true },
  { id:'ab13', date:D(10), time:'10:00', merchant:'Spotify',            desc:'SPOTIFY P76321',               cat:'subs',           amount: -9.99,   account:'abn_main', recurring:true },
  { id:'ab14', date:D(11), time:'18:00', merchant:'Kinepolis',          desc:'KINEPOLIS AMS',                cat:'entertainment',  amount: -28.00,  account:'abn_main' },
  { id:'ab15', date:D(12), time:'13:00', merchant:'Jumbo',              desc:'JUMBO SUPERMARKT AMS 0081',    cat:'groceries',      amount: -52.80,  account:'abn_main' },
  { id:'ab16', date:D(14), time:'19:45', merchant:'Restaurant De Kas',  desc:'RESTAURANTDE KAS AMS',         cat:'restaurants',    amount: -74.50,  account:'abn_main' },
  { id:'ab17', date:D(15), time:'09:00', merchant:'ABN AMRO Sparen',    desc:'SPAAROVERBOEKING ABN FEB',     cat:'savings',        amount: -200.00, account:'abn_main', savingAccount:'abn_save' },
  { id:'ab18', date:D(16), time:'10:30', merchant:'Decathlon',          desc:'DECATHLON AMS WEST',           cat:'sportsEquipment',amount: -64.00,  account:'abn_main' },
  { id:'ab19', date:D(17), time:'14:00', merchant:'GVB Dagkaart',       desc:'GVB DAGKAART AMS',             cat:'transportPublic',amount: -8.00,   account:'abn_main' },
  { id:'ab20', date:D(18), time:'12:00', merchant:'Hema',               desc:'HEMA AMSTERDAM BIJLMER',       cat:'hobby',          amount: -23.50,  account:'abn_main' },
  { id:'ab21', date:D(19), time:'08:00', merchant:'Netflix',            desc:'NETFLIX SUBSCR',               cat:'subs',           amount: -13.99,  account:'abn_main', recurring:true },
  { id:'ab22', date:D(20), time:'17:00', merchant:'Sushi Moto',         desc:'SUSHIMOTO AMS',                cat:'restaurants',    amount: -29.00,  account:'abn_main' },
  { id:'ab23', date:D(21), time:'11:20', merchant:'Albert Heijn',       desc:'AH 9921 AMS',                  cat:'groceries',      amount: -38.40,  account:'abn_main' },
  { id:'ab24', date:D(22), time:'20:10', merchant:'Pathé',              desc:'PATHE AMSTERDAM ARENA',        cat:'entertainment',  amount: -24.50,  account:'abn_main' },
  { id:'ab25', date:D(24), time:'09:30', merchant:'Apotheek West',      desc:'APOTHEEK AMS WEST 0081',       cat:'healthcare',     amount: -18.60,  account:'abn_main', confidence:71, needsReview:true },
  { id:'ab26', date:D(25), time:'14:00', merchant:'Zara',               desc:'ZARA AMS BIJENKORF',           cat:'clothing',       amount: -59.99,  account:'abn_main' },
  { id:'ab27', date:D(26), time:'08:00', merchant:'TechCorp BV',        desc:'TECHCORP BV SALARIS JAN',      cat:'salary',         amount: 3150.00, account:'abn_main' },
  { id:'ab28', date:D(27), time:'19:00', merchant:'Thuisbezorgd',       desc:'THUISBEZORGD.NL ORDER',        cat:'restaurants',    amount: -26.90,  account:'abn_main', confidence:55, needsReview:true },
  { id:'ab29', date:D(28), time:'13:30', merchant:'Jumbo',              desc:'JUMBO SUPERMARKT AMS 0081',    cat:'groceries',      amount: -67.10,  account:'abn_main' },
  { id:'ab30', date:D(30), time:'10:00', merchant:'Vodafone',           desc:'VODAFONE NL ABONNEMENT',       cat:'subs',           amount: -35.00,  account:'abn_main', recurring:true },
];

// 100 demo transactions spread over 6 months on demo_main / demo_save
export const DEMO_TXS = [
  // === Month 1 (Dec 2025) ===
  { id:'dm1',  date:D(175), time:'08:00', merchant:'Demo Corp BV',     desc:'DEMO CORP BV SALARIS DEC',  cat:'salary',       amount: 2200.00, account:'demo_main' },
  { id:'dm2',  date:D(173), time:'00:00', merchant:'Demo Verhuur',     desc:'DEMO VERHUUR HUUR DEC',     cat:'housingRent',  amount: -850.00, account:'demo_main', recurring:true },
  { id:'dm3',  date:D(170), time:'07:00', merchant:'Eneco',            desc:'ENECO ENERGIE DEC',         cat:'housingUtility',amount:-72.00,  account:'demo_main', recurring:true },
  { id:'dm4',  date:D(168), time:'09:00', merchant:'Spotify',          desc:'SPOTIFY SUBSCR DEC',        cat:'subs',         amount: -9.99,   account:'demo_main', recurring:true },
  { id:'dm5',  date:D(166), time:'09:00', merchant:'Netflix',          desc:'NETFLIX SUBSCR DEC',        cat:'subs',         amount: -13.99,  account:'demo_main', recurring:true },
  { id:'dm6',  date:D(178), time:'14:30', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -52.40,  account:'demo_main' },
  { id:'dm7',  date:D(171), time:'11:20', merchant:'Jumbo',            desc:'JUMBO DEMO 0042',           cat:'groceries',    amount: -38.80,  account:'demo_main' },
  { id:'dm8',  date:D(164), time:'15:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -61.30,  account:'demo_main' },
  { id:'dm9',  date:D(176), time:'09:15', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm10', date:D(169), time:'08:30', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm11', date:D(172), time:'19:30', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -38.50,  account:'demo_main' },
  { id:'dm12', date:D(165), time:'09:00', merchant:'Savings transfer', desc:'DEMO SPAAROVERBOEKING',     cat:'savingDeposit',amount:-200.00,  account:'demo_main', savingAccount:'demo_save' },
  // === Month 2 (Jan 2026) ===
  { id:'dm13', date:D(145), time:'08:00', merchant:'Demo Corp BV',     desc:'DEMO CORP BV SALARIS JAN',  cat:'salary',       amount: 2200.00, account:'demo_main' },
  { id:'dm14', date:D(143), time:'00:00', merchant:'Demo Verhuur',     desc:'DEMO VERHUUR HUUR JAN',     cat:'housingRent',  amount: -850.00, account:'demo_main', recurring:true },
  { id:'dm15', date:D(140), time:'07:00', merchant:'Eneco',            desc:'ENECO ENERGIE JAN',         cat:'housingUtility',amount:-72.00,  account:'demo_main', recurring:true },
  { id:'dm16', date:D(138), time:'09:00', merchant:'Spotify',          desc:'SPOTIFY SUBSCR JAN',        cat:'subs',         amount: -9.99,   account:'demo_main', recurring:true },
  { id:'dm17', date:D(136), time:'09:00', merchant:'Netflix',          desc:'NETFLIX SUBSCR JAN',        cat:'subs',         amount: -13.99,  account:'demo_main', recurring:true },
  { id:'dm18', date:D(148), time:'16:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -45.20,  account:'demo_main' },
  { id:'dm19', date:D(141), time:'12:30', merchant:'Jumbo',            desc:'JUMBO DEMO 0042',           cat:'groceries',    amount: -55.60,  account:'demo_main' },
  { id:'dm20', date:D(134), time:'17:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -42.80,  account:'demo_main' },
  { id:'dm21', date:D(127), time:'10:00', merchant:'Lidl',             desc:'LIDL DEMO',                 cat:'groceries',    amount: -31.40,  account:'demo_main' },
  { id:'dm22', date:D(146), time:'09:00', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm23', date:D(139), time:'08:30', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm24', date:D(144), time:'20:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -28.00,  account:'demo_main' },
  { id:'dm25', date:D(147), time:'14:00', merchant:'NS · Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-18.40, account:'demo_main' },
  { id:'dm26', date:D(135), time:'09:00', merchant:'Savings transfer', desc:'DEMO SPAAROVERBOEKING',     cat:'savingDeposit',amount:-150.00,  account:'demo_main', savingAccount:'demo_save' },
  // === Month 3 (Feb 2026) ===
  { id:'dm27', date:D(115), time:'08:00', merchant:'Demo Corp BV',     desc:'DEMO CORP BV SALARIS FEB',  cat:'salary',       amount: 2200.00, account:'demo_main' },
  { id:'dm28', date:D(113), time:'00:00', merchant:'Demo Verhuur',     desc:'DEMO VERHUUR HUUR FEB',     cat:'housingRent',  amount: -850.00, account:'demo_main', recurring:true },
  { id:'dm29', date:D(110), time:'07:00', merchant:'Eneco',            desc:'ENECO ENERGIE FEB',         cat:'housingUtility',amount:-68.00,  account:'demo_main', recurring:true },
  { id:'dm30', date:D(108), time:'09:00', merchant:'Spotify',          desc:'SPOTIFY SUBSCR FEB',        cat:'subs',         amount: -9.99,   account:'demo_main', recurring:true },
  { id:'dm31', date:D(106), time:'09:00', merchant:'Netflix',          desc:'NETFLIX SUBSCR FEB',        cat:'subs',         amount: -13.99,  account:'demo_main', recurring:true },
  { id:'dm32', date:D(118), time:'13:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -58.90,  account:'demo_main' },
  { id:'dm33', date:D(111), time:'11:00', merchant:'Jumbo',            desc:'JUMBO DEMO 0042',           cat:'groceries',    amount: -44.50,  account:'demo_main' },
  { id:'dm34', date:D(104), time:'16:30', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -67.20,  account:'demo_main' },
  { id:'dm35', date:D(116), time:'08:45', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm36', date:D(109), time:'09:15', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm37', date:D(114), time:'21:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -45.00,  account:'demo_main' },
  { id:'dm38', date:D(117), time:'15:00', merchant:'NS · Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-22.40, account:'demo_main' },
  { id:'dm39', date:D(107), time:'14:00', merchant:'Etos',             desc:'ETOS DEMO',                 cat:'healthcare',   amount: -18.50,  account:'demo_main' },
  { id:'dm40', date:D(105), time:'09:00', merchant:'Savings transfer', desc:'DEMO SPAAROVERBOEKING',     cat:'savingDeposit',amount:-200.00,  account:'demo_main', savingAccount:'demo_save' },
  // === Month 4 (Mar 2026) ===
  { id:'dm41', date:D(85),  time:'08:00', merchant:'Demo Corp BV',     desc:'DEMO CORP BV SALARIS MAR',  cat:'salary',       amount: 2200.00, account:'demo_main' },
  { id:'dm42', date:D(83),  time:'00:00', merchant:'Demo Verhuur',     desc:'DEMO VERHUUR HUUR MAR',     cat:'housingRent',  amount: -850.00, account:'demo_main', recurring:true },
  { id:'dm43', date:D(80),  time:'07:00', merchant:'Eneco',            desc:'ENECO ENERGIE MAR',         cat:'housingUtility',amount:-65.00,  account:'demo_main', recurring:true },
  { id:'dm44', date:D(78),  time:'09:00', merchant:'Spotify',          desc:'SPOTIFY SUBSCR MAR',        cat:'subs',         amount: -9.99,   account:'demo_main', recurring:true },
  { id:'dm45', date:D(76),  time:'09:00', merchant:'Netflix',          desc:'NETFLIX SUBSCR MAR',        cat:'subs',         amount: -13.99,  account:'demo_main', recurring:true },
  { id:'dm46', date:D(88),  time:'14:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -49.30,  account:'demo_main' },
  { id:'dm47', date:D(81),  time:'12:00', merchant:'Jumbo',            desc:'JUMBO DEMO 0042',           cat:'groceries',    amount: -58.70,  account:'demo_main' },
  { id:'dm48', date:D(74),  time:'17:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -53.40,  account:'demo_main' },
  { id:'dm49', date:D(68),  time:'10:00', merchant:'Lidl',             desc:'LIDL DEMO',                 cat:'groceries',    amount: -29.80,  account:'demo_main' },
  { id:'dm50', date:D(86),  time:'09:00', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm51', date:D(79),  time:'08:30', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm52', date:D(72),  time:'09:00', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm53', date:D(84),  time:'19:30', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -32.50,  account:'demo_main' },
  { id:'dm54', date:D(70),  time:'21:00', merchant:'Demo Restaurant',  desc:'DEMO PIZZA PLACE',          cat:'restaurants',  amount: -28.50,  account:'demo_main' },
  { id:'dm55', date:D(87),  time:'15:30', merchant:'NS · Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-15.80, account:'demo_main' },
  { id:'dm56', date:D(75),  time:'13:00', merchant:'GVB',              desc:'GVB DEMO OV',               cat:'transportPublic',amount:-3.60,  account:'demo_main' },
  { id:'dm57', date:D(77),  time:'11:00', merchant:'Kruidvat',         desc:'KRUIDVAT DEMO',             cat:'healthcare',   amount: -12.80,  account:'demo_main' },
  { id:'dm58', date:D(67),  time:'09:00', merchant:'Savings transfer', desc:'DEMO SPAAROVERBOEKING',     cat:'savingDeposit',amount:-250.00,  account:'demo_main', savingAccount:'demo_save' },
  // === Month 5 (Apr 2026) ===
  { id:'dm59', date:D(55),  time:'08:00', merchant:'Demo Corp BV',     desc:'DEMO CORP BV SALARIS APR',  cat:'salary',       amount: 2200.00, account:'demo_main' },
  { id:'dm60', date:D(53),  time:'00:00', merchant:'Demo Verhuur',     desc:'DEMO VERHUUR HUUR APR',     cat:'housingRent',  amount: -850.00, account:'demo_main', recurring:true },
  { id:'dm61', date:D(50),  time:'07:00', merchant:'Eneco',            desc:'ENECO ENERGIE APR',         cat:'housingUtility',amount:-58.00,  account:'demo_main', recurring:true },
  { id:'dm62', date:D(48),  time:'09:00', merchant:'Spotify',          desc:'SPOTIFY SUBSCR APR',        cat:'subs',         amount: -9.99,   account:'demo_main', recurring:true },
  { id:'dm63', date:D(46),  time:'09:00', merchant:'Netflix',          desc:'NETFLIX SUBSCR APR',        cat:'subs',         amount: -13.99,  account:'demo_main', recurring:true },
  { id:'dm64', date:D(58),  time:'13:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -63.20,  account:'demo_main' },
  { id:'dm65', date:D(51),  time:'11:30', merchant:'Jumbo',            desc:'JUMBO DEMO 0042',           cat:'groceries',    amount: -41.80,  account:'demo_main' },
  { id:'dm66', date:D(44),  time:'17:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -55.30,  account:'demo_main' },
  { id:'dm67', date:D(37),  time:'10:00', merchant:'Lidl',             desc:'LIDL DEMO',                 cat:'groceries',    amount: -34.60,  account:'demo_main' },
  { id:'dm68', date:D(56),  time:'09:00', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm69', date:D(49),  time:'08:30', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm70', date:D(42),  time:'09:00', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm71', date:D(54),  time:'20:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -52.00,  account:'demo_main' },
  { id:'dm72', date:D(40),  time:'19:00', merchant:'Demo Restaurant',  desc:'DEMO PIZZA PLACE',          cat:'restaurants',  amount: -24.90,  account:'demo_main' },
  { id:'dm73', date:D(57),  time:'14:00', merchant:'NS · Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-24.60, account:'demo_main' },
  { id:'dm74', date:D(43),  time:'16:00', merchant:'NS · Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-18.80, account:'demo_main' },
  { id:'dm75', date:D(47),  time:'14:00', merchant:'Etos',             desc:'ETOS DEMO',                 cat:'healthcare',   amount: -22.40,  account:'demo_main' },
  { id:'dm76', date:D(38),  time:'09:00', merchant:'Savings transfer', desc:'DEMO SPAAROVERBOEKING',     cat:'savingDeposit',amount:-300.00,  account:'demo_main', savingAccount:'demo_save' },
  { id:'dm77', date:D(45),  time:'12:00', merchant:'Bol.com',          desc:'BOL.COM DEMO ORDER',        cat:'hobby',        amount: -34.99,  account:'demo_main', confidence:65, needsReview:true },
  // === Month 6 (May–Jun 2026) ===
  { id:'dm78', date:D(25),  time:'08:00', merchant:'Demo Corp BV',     desc:'DEMO CORP BV SALARIS MEI',  cat:'salary',       amount: 2200.00, account:'demo_main' },
  { id:'dm79', date:D(23),  time:'00:00', merchant:'Demo Verhuur',     desc:'DEMO VERHUUR HUUR MEI',     cat:'housingRent',  amount: -850.00, account:'demo_main', recurring:true },
  { id:'dm80', date:D(20),  time:'07:00', merchant:'Eneco',            desc:'ENECO ENERGIE MEI',         cat:'housingUtility',amount:-55.00,  account:'demo_main', recurring:true },
  { id:'dm81', date:D(18),  time:'09:00', merchant:'Spotify',          desc:'SPOTIFY SUBSCR MEI',        cat:'subs',         amount: -9.99,   account:'demo_main', recurring:true },
  { id:'dm82', date:D(16),  time:'09:00', merchant:'Netflix',          desc:'NETFLIX SUBSCR MEI',        cat:'subs',         amount: -13.99,  account:'demo_main', recurring:true },
  { id:'dm83', date:D(28),  time:'13:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -47.60,  account:'demo_main' },
  { id:'dm84', date:D(21),  time:'11:00', merchant:'Jumbo',            desc:'JUMBO DEMO 0042',           cat:'groceries',    amount: -62.30,  account:'demo_main' },
  { id:'dm85', date:D(14),  time:'16:30', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -38.90,  account:'demo_main' },
  { id:'dm86', date:D(7),   time:'10:00', merchant:'Lidl',             desc:'LIDL DEMO',                 cat:'groceries',    amount: -27.40,  account:'demo_main' },
  { id:'dm87', date:D(26),  time:'09:00', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm88', date:D(19),  time:'08:30', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm89', date:D(12),  time:'09:00', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm90', date:D(5),   time:'08:30', merchant:'Koffie ☕',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm91', date:D(24),  time:'20:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -41.50,  account:'demo_main' },
  { id:'dm92', date:D(10),  time:'19:30', merchant:'Demo Restaurant',  desc:'DEMO SUSHI PLACE',          cat:'restaurants',  amount: -29.00,  account:'demo_main' },
  { id:'dm93', date:D(3),   time:'20:30', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -34.00,  account:'demo_main' },
  { id:'dm94', date:D(27),  time:'14:30', merchant:'NS · Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-28.20, account:'demo_main' },
  { id:'dm95', date:D(13),  time:'15:00', merchant:'NS · Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-14.40, account:'demo_main' },
  { id:'dm96', date:D(22),  time:'11:00', merchant:'Kruidvat',         desc:'KRUIDVAT DEMO',             cat:'healthcare',   amount: -16.90,  account:'demo_main' },
  { id:'dm97', date:D(15),  time:'09:00', merchant:'Etos',             desc:'ETOS DEMO',                 cat:'healthcare',   amount: -24.50,  account:'demo_main' },
  { id:'dm98', date:D(8),   time:'09:00', merchant:'Savings transfer', desc:'DEMO SPAAROVERBOEKING',     cat:'savingDeposit',amount:-200.00,  account:'demo_main', savingAccount:'demo_save' },
  { id:'dm99', date:D(11),  time:'12:00', merchant:'H&M Nederland',    desc:'HM DEMO NETHERLANDS',       cat:'clothing',     amount: -49.99,  account:'demo_main', confidence:70, needsReview:true },
  { id:'dm100',date:D(2),   time:'14:00', merchant:'Amazon.nl',        desc:'AMZN DEMO MKTPLC',          cat:'hobby',        amount: -28.99,  account:'demo_main', confidence:60, needsReview:true },
];

export function getDefaultTxs(method) {
  if (method === 'google') return [...TRANSACTIONS, ...GEN_TXS];
  if (method === 'apple')  return [...ABN_TRANSACTIONS];
  if (method === 'bank')   return [...DEMO_TXS];
  return [];
}

// Schema version — bump when per-user data defaults change
export const SCHEMA_VERSION = '5';

export function computeProfileKey(method, email) {
  if (method === 'google') return 'munni_profiles_google';
  if (method === 'apple') return 'munni_profiles_apple';
  if (method === 'bank') return 'munni_profiles_bank';
  if (email && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(email))
    return `munni_profiles_${email}`;
  return 'munni_profiles';
}

// Returns the localized name for the default profile when a user signs up with email.
// The name is determined once at signup and stored in the profile — it never changes after that.
export function getDefaultProfileName(lang) {
  const names = { nl: 'Standaard', tr: 'Varsayılan', en: 'Default' };
  return names[lang] || 'Default';
}

export function getDefaultProfiles(method, lang = 'en') {
  if (method === 'google') return [{ id:'p_google', name:'Private', icon:'user', active:true, accountIds:['main','save','inv'], picture:'av3', isDemo:false }];
  if (method === 'apple')  return [{ id:'p_apple',  name:'Family',  icon:'house',active:true, accountIds:['abn_main'],           picture:'av4', isDemo:false }];
  if (method === 'bank')   return [{ id:'p_demo',   name:'Demo',    icon:'user', active:true, accountIds:['demo_main','demo_save'], picture:'av7', isDemo:true }];
  return [{ id:'p_email', name:getDefaultProfileName(lang), icon:'user', active:true, accountIds:[], picture:'av1', isDemo:false }];
}

// Returns a per-user storage key. Email users get a key scoped to their address.
export function computeUserDataKey(method, email, base) {
  if (method === 'email' && email) {
    const safe = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
    return `${base}_email_${safe}`;
  }
  return `${base}_${method || 'default'}`;
}

export function initPerUserData(method, email, lang = 'en') {
  if (!method) return;

  // Accounts + txs: once per user (schema version gate is per-user for email)
  const vKey = computeUserDataKey(method, email, 'munni_schema_v');
  if (localStorage.getItem(vKey) !== SCHEMA_VERSION) {
    const acctKey = computeUserDataKey(method, email, 'munni_bank_accounts');
    localStorage.setItem(acctKey, JSON.stringify(getDefaultAccounts(method)));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: acctKey } }));

    const txKey = computeUserDataKey(method, email, 'munni_txs');
    localStorage.setItem(txKey, JSON.stringify(getDefaultTxs(method)));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: txKey } }));

    localStorage.setItem(vKey, SCHEMA_VERSION);
  }

  // Profiles: once per user (profile key). Uses signup lang so each new
  // user gets the localised default name; never overwrites existing data.
  const profileKey = computeProfileKey(method, email || '');
  if (!localStorage.getItem(profileKey)) {
    localStorage.setItem(profileKey, JSON.stringify(getDefaultProfiles(method, lang)));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: profileKey } }));
  }
}

// Generate 30–60 realistic transactions for a newly connected bank account (past 90 days)
export function generateBankTxs(accountId, bankName) {
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = ((Math.imul(s, 1664525) + 1013904223) >>> 0); return s / 4294967296; };
  }
  const POOL = [
    { merchant:'Albert Heijn', desc:'AH SUPERMARKT', cat:'groceries', min:10, max:80 },
    { merchant:'Jumbo', desc:'JUMBO SUPERMARKT', cat:'groceries', min:8, max:65 },
    { merchant:'Koffie ☕', desc:'COFFEE CORNER', cat:'coffee', min:3, max:6 },
    { merchant:'NS · Sprinter', desc:'NS REIZIGERS', cat:'transportPublic', min:4, max:28 },
    { merchant:'Vapiano', desc:'VAPIANO', cat:'restaurants', min:14, max:38 },
    { merchant:'Thuisbezorgd', desc:'THUISBEZORGD NL', cat:'restaurants', min:18, max:45 },
    { merchant:'Etos', desc:'ETOS', cat:'healthcare', min:5, max:30 },
    { merchant:'Kruidvat', desc:'KRUIDVAT', cat:'healthcare', min:4, max:28 },
    { merchant:'Bol.com', desc:'BOL.COM ORDER', cat:'hobby', min:15, max:80, confidence:62, needsReview:true },
    { merchant:'Action', desc:'ACTION', cat:'hobby', min:4, max:25 },
    { merchant:'H&M Nederland', desc:'HM NETHERLANDS', cat:'clothing', min:18, max:75 },
    { merchant:'GVB', desc:'GVB OV', cat:'transportPublic', min:2, max:8 },
  ];
  const baseSeed = accountId.split('').reduce((s,c,i) => (s + c.charCodeAt(0) * (i+7)) | 0, 0);
  const r = rng(Math.abs(baseSeed) || 42);
  const count = 30 + Math.floor(r() * 31); // 30–60 using seeded PRNG
  const result = [];
  const today = new Date();
  for (let i = 0; i < count; i++) {
    const daysAgo = Math.floor(r() * 90); // spread pseudo-randomly across 90 days
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    const iso = d.toISOString().slice(0, 10);
    const p = POOL[Math.floor(r() * POOL.length)];
    const amt = -(Math.round((p.min + r() * (p.max - p.min)) * 100) / 100);
    const hh = 8 + Math.floor(r() * 13);
    const mm = Math.floor(r() * 60);
    result.push({
      id: `bk_${accountId}_${i}`,
      date: iso,
      time: `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`,
      merchant: p.merchant, desc: p.desc, cat: p.cat, amount: amt, account: accountId,
      ...(p.confidence ? { confidence:p.confidence } : {}),
      ...(p.needsReview ? { needsReview:true } : {}),
    });
  }
  return result;
}

const ASN_TRANSACTIONS = [
  { merchant:'Albert Heijn', amount:-42.30, cat:'groceries', desc:'AH BETAALAUTOMAAT' },
  { merchant:'NS Reizen', amount:-28.50, cat:'transportPublic', desc:'NS TREIN MAANDKAART' },
  { merchant:'Thuisbezorgd', amount:-24.95, cat:'restaurants', desc:'THUISBEZORGD.NL' },
  { merchant:'Jumbo Supermarkt', amount:-38.70, cat:'groceries', desc:'JUMBO BETAALAUTOMAAT' },
  { merchant:'Shell', amount:-65.00, cat:'transportFuel', desc:'SHELL BETAALAUTOMAAT' },
  { merchant:'Etos', amount:-14.50, cat:'healthcare', desc:'ETOS DROGIST' },
  { merchant:'Kruidvat', amount:-9.80, cat:'healthcare', desc:'KRUIDVAT' },
  { merchant:'Vapiano', amount:-22.40, cat:'restaurants', desc:'VAPIANO AMSTERDAM' },
  { merchant:'Spotify', amount:-9.99, cat:'subs', desc:'SPOTIFY NETHERLANDS' },
  { merchant:'Netflix', amount:-13.99, cat:'subs', desc:'NETFLIX.COM' },
  { merchant:'OV-chipkaart', amount:-20.00, cat:'transportPublic', desc:'NS CHIPKAART OPLADEN' },
  { merchant:'HEMA', amount:-17.60, cat:'clothing', desc:'HEMA BETAALAUTOMAAT' },
  { merchant:'Albert Heijn', amount:-55.20, cat:'groceries', desc:'AH BETAALAUTOMAAT' },
  { merchant:'Bol.com', amount:-34.99, cat:'hobby', desc:'BOL.COM ORDER' },
  { merchant:'Basic-Fit', amount:-24.99, cat:'healthcare', desc:'BASIC-FIT ABONNEMENT' },
  { merchant:'Eneco', amount:-68.50, cat:'housingUtility', desc:'ENECO ENERGIE' },
  { merchant:'Stadgenoot', amount:-740.00, cat:'housingRent', desc:'STADGENOOT HUUR' },
  { merchant:'GVB', amount:-3.60, cat:'transportPublic', desc:'GVB OV-BETALING' },
  { merchant:'Lidl', amount:-29.40, cat:'groceries', desc:'LIDL BETAALAUTOMAAT' },
  { merchant:'Action', amount:-12.75, cat:'hobby', desc:'ACTION BETAALAUTOMAAT' },
  { merchant:'Koffie Bru', amount:-4.50, cat:'coffee', desc:'KOFFIE BRU AMSTERDAM' },
  { merchant:'Pathé Cinemas', amount:-15.00, cat:'hobby', desc:'PATHE CINEMA' },
  { merchant:'H&M Nederland', amount:-49.95, cat:'clothing', desc:'HM NETHERLANDS' },
  { merchant:'Picnic', amount:-44.10, cat:'groceries', desc:'PICNIC BOODSCHAPPEN' },
  { merchant:'NS Reizen', amount:-12.80, cat:'transportPublic', desc:'NS DAGKAART' },
  { merchant:'Coolblue', amount:-89.99, cat:'hobby', desc:'COOLBLUE ORDER' },
  { merchant:'Spar', amount:-18.30, cat:'groceries', desc:'SPAR SUPERMARKT' },
  { merchant:'Zalando', amount:-64.90, cat:'clothing', desc:'ZALANDO NL' },
  { merchant:'Coffee Corner', amount:-3.80, cat:'coffee', desc:'COFFEE CORNER' },
  { merchant:'Takeaway.com', amount:-19.50, cat:'restaurants', desc:'THUISBEZORGD.NL' },
  { merchant:'Decathlon', amount:-34.50, cat:'hobby', desc:'DECATHLON AMSTERDAM' },
  { merchant:'Jumbo Supermarkt', amount:-51.20, cat:'groceries', desc:'JUMBO BETAALAUTOMAAT' },
  { merchant:'V&D Online', amount:-28.40, cat:'clothing', desc:'VD ONLINE ORDER' },
  { merchant:'Albert Heijn', amount:-36.80, cat:'groceries', desc:'AH TO GO' },
  { merchant:'Tandarts Amsterdam', amount:-45.00, cat:'healthcare', desc:'TANDARTSPRAKTIJK' },
  { merchant:'NS Reizen', amount:-31.00, cat:'transportPublic', desc:'NS TREIN RETOURTJE' },
  { merchant:'McDonald\'s', amount:-8.90, cat:'restaurants', desc:'MCDONALDS AMSTERDAM' },
  { merchant:'Gamma', amount:-22.60, cat:'hobby', desc:'GAMMA BOUWMARKT' },
  { merchant:'Kruidvat', amount:-16.40, cat:'healthcare', desc:'KRUIDVAT DROGIST' },
  { merchant:'Tikkie ontvangen', amount:50.00, cat:'salary', desc:'TIKKIE BETALING ONTVANGEN' },
];

export function generateAsnTxs(accountId) {
  const today = new Date();
  return ASN_TRANSACTIONS.map((t, i) => {
    const daysBack = Math.floor((i / ASN_TRANSACTIONS.length) * 90);
    const d = new Date(today);
    d.setDate(d.getDate() - daysBack);
    const date = d.toISOString().slice(0,10);
    return {
      id: `asn_${i}`,
      date,
      time: '10:00',
      merchant: t.merchant,
      desc: t.desc,
      cat: t.cat,
      cats: [{ catId: t.cat, amount: Math.abs(t.amount) }],
      amount: t.amount,
      account: accountId,
    };
  });
}

export const BUDGETS = [
  { id:'b1', name:'Restaurants',  icon:'fork',   spent:95.40,  total:120, period:'Weekly',   periodDays:7,  renew:'every week',    cats:['restaurants','coffee'], stack:false },
  { id:'b2', name:'Groceries',    icon:'shop',   spent:164.80, total:300, period:'Monthly',  periodDays:30, renew:'every month',   cats:['groceries'], stack:true, stackMax:600, stackCur:30 },
  { id:'b3', name:'Transport',    icon:'car',    spent:74.80,  total:80,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['transportPublic','transportCar','transportFuel'], stack:false },
  { id:'b4', name:'Hobby',        icon:'bag',    spent:204.99, total:200, period:'2 weeks',  periodDays:14, renew:'every 2 weeks', cats:['hobby','videoGame','sportsEquipment'], stack:false },
  { id:'b5', name:'Coffee runs',  icon:'flame',  spent:18.00,  total:60,  period:'3 weeks',  periodDays:21, renew:'every 3 weeks', cats:['coffee'], stack:true, stackMax:120, stackCur:42 },
  { id:'b6', name:'Health',       icon:'health', spent:36.70,  total:40,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['healthcare','doctorVisit','prescription','dental'], stack:false },
  { id:'b7', name:'Subscriptions',icon:'film',   spent:23.98,  total:32,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['subs'], stack:false },
  { id:'b8', name:'Nightlife',    icon:'star',   spent:87.50,  total:60,  period:'Monthly',  periodDays:30, renew:'every month',   cats:['restaurants'], stack:false },
];

// R(n) = day-of-month that is n days from today (capped at 28)
const R = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return Math.min(Math.max(d.getDate(), 1), 28); };

export const RECURRING = [
  { id:'r1', name:'Rent · Stadgenoot',   icon:'home-import-outline',        amount:-740.00, day:R(6),  every:'monthly',  cat:'housingRent',   type:'fixed',  luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t9']  },
  { id:'r2', name:'Eneco · Energy',        icon:'home-lightning-bolt-outline', amount:-65.00,  day:R(1),  every:'monthly',  cat:'housingUtility',type:'fixed',  luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t24'] },
  { id:'r3', name:'Spotify',               icon:'television-play',             amount:-9.99,   day:R(3),  every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-06', until:null,    active:true,  txIds:['t4']  },
  { id:'r4', name:'Netflix',               icon:'television-play',             amount:-13.99,  day:R(7),  every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-01', until:null,    active:true,  txIds:['t18'] },
  { id:'r5', name:'DEGIRO ETF',            icon:'chart-timeline-variant',      amount:-300.00, day:R(15), every:'monthly',  cat:'invest',        type:'fixed',  luxury:false, since:'2024-06', until:null,    active:true,  txIds:['t13'] },
  { id:'r6', name:'Acme Salary',           icon:'cash-plus',                   amount:2480.00, day:R(18), every:'monthly',  cat:'salary',        type:'income', luxury:false, since:'2022-01', until:null,    active:true,  txIds:['t3']  },
  { id:'r7', name:'Audible',               icon:'book-education-outline',      amount:-7.95,   day:R(22), every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-03', until:'2026-01', active:false, txIds:[] },
  { id:'r8', name:'Basic-Fit · Gym',       icon:'dumbbell',                    amount:-24.99,  day:R(10), every:'monthly',  cat:'gym',           type:'subs',   luxury:false, since:'2024-03', until:null,    active:true,  txIds:[] },
  { id:'r9', name:'Health Insurance',      icon:'shield-check-outline',        amount:-128.50, day:R(12), every:'monthly',  cat:'healthInsurance',type:'fixed', luxury:false, since:'2023-01', until:null,    active:true,  txIds:[] },
];

export const RECURRING_SUGGESTIONS = [
  { id:'rs1', name:'Amazon Prime',     icon:'shop',   amount:-6.99,   confidence:94, pattern:'Monthly · detected 6×', type:'subs'  },
  { id:'rs2', name:'Health Insurance', icon:'health', amount:-128.50, confidence:87, pattern:'Monthly · detected 3×', type:'fixed' },
  { id:'rs3', name:'Gym · Basic-Fit',  icon:'health', amount:-24.99,  confidence:72, pattern:'Monthly · detected 2×', type:'subs'  },
];

export const GOALS = [
  { id: 'g1', name: 'Emergency fund',   icon: 'piggy',  current: 2400, target: 6000, by: 'Dec 2026', monthly: 300, color: '#4A6A4F' },
  { id: 'g2', name: 'Trip to Lisbon',   icon: 'globe',  current: 720,  target: 1200, by: 'Jun 2026', monthly: 120, color: '#A8782B' },
  { id: 'g3', name: 'New laptop',       icon: 'box',    current: 380,  target: 1800, by: 'Sep 2026', monthly: 200, color: '#5E4A78' },
];

export const ALLOCATE_TOPICS = [
  { id:'at_rent',   name:'Rent',          icon:'house',  allocated:740,  actual:740.00, estimate:740,  cats:['housingRent'],                       group:'recurring' },
  { id:'at_energy', name:'Energy',         icon:'flame',  allocated:65,   actual:65.00,  estimate:65,   cats:['housingUtility'],                    group:'recurring' },
  { id:'at_subs',   name:'Subscriptions',  icon:'film',   allocated:25,   actual:23.98,  estimate:25,   cats:['subs'],                              group:'recurring' },
  { id:'at_food',   name:'Food & Dining',  icon:'fork',   allocated:280,  actual:290.30, estimate:310,  cats:['groceries','restaurants','coffee'],   group:'var' },
  { id:'at_trans',  name:'Transport',      icon:'car',    allocated:80,   actual:50.40,  estimate:75,   cats:['transportPublic','transportCar','transportFuel'], group:'var' },
  { id:'at_health', name:'Health',         icon:'health', allocated:40,   actual:22.70,  estimate:35,   cats:['healthcare','doctorVisit','prescription'], group:'var' },
  { id:'at_hobby',  name:'Hobby',          icon:'bag',    allocated:110,  actual:79.99,  estimate:150,  cats:['hobby','videoGame','sportsEquipment'], group:'var' },
];

export const EVENTS = [
  { id: 'e1', name: 'Lisbon trip 2025',     start: '2025-09-12', end: '2025-09-19', total: 1186.30, txCount: 28, status: 'closed',   icon: 'globe', photo: 'https://images.unsplash.com/photo-1555881400-74d7acaacd8b?w=600&h=260&fit=crop' },
  { id: 'e2', name: 'Anna · Birthday',      start: '2026-01-30', end: '2026-02-02', total: 312.40,  txCount: 9,  status: 'closed',   icon: 'star',  photo: 'https://images.unsplash.com/photo-1527529482837-4698179dc6ce?w=600&h=260&fit=crop' },
  { id: 'e3', name: 'Berlin weekend',       start: '2026-02-21', end: '2026-02-23', total: 0,       txCount: 0,  status: 'upcoming', icon: 'globe', photo: 'https://images.unsplash.com/photo-1560930950-5cc20e80e392?w=600&h=260&fit=crop' },
];

export const SPEND_HISTORY = {
  total:       [1182, 1290, 1190, 1345, 1308, 1220],
  restaurants: [45,   88,   138,  28,   84,   95  ],
  groceries:   [154,  250,  309,  105,  268,  165 ],
  transport:   [29,   38,   19,   22,   50,   50  ],
  hobby:       [33,   240,  124,  55,   35,   80  ],
  coffee:      [14,   30,   8,    8,    28,   18  ],
  health:      [18,   18,   11,   18,   60,   22  ],
  housing:     [805,  805,  805,  805,  805,  805 ],
};

export const PORTFOLIO = {
  total: 12480.50,
  contributed: 11200,
  pnl: 1280.50,
  pnlPct: 11.43,
  monthly: 300,
  positions: [
    { ticker: 'VWCE', name: 'FTSE All-World ETF',  alloc: 65, value: 8112.32, change: 1.24 },
    { ticker: 'IUSA', name: 'S&P 500 ETF',         alloc: 20, value: 2496.10, change: 0.86 },
    { ticker: 'IBGS', name: 'EUR Govt Bond ETF',   alloc: 10, value: 1248.05, change: -0.18 },
    { ticker: 'CASH', name: 'Cash',                alloc: 5,  value: 624.03,  change: 0.00 },
  ],
  curve: [10100, 10240, 10800, 10920, 11340, 11200, 11680, 11920, 12120, 12080, 12340, 12480],
};

export const ASSETS = [
  { id:'a1', type:'real_estate', name:'Apartment · Amsterdam', icon:'house', value:320000, mortgageLeft:218000, equity:102000, curve:[290000,295000,302000,310000,315000,320000], changeYr:3.2 },
  { id:'a2', type:'vehicle',     name:'Car · Volkswagen Golf', icon:'car',   value:14200,  loanLeft:4800,   equity:9400,  curve:[22000,20000,18500,17000,15800,14200], changeYr:-10.0 },
  { id:'a3', type:'pension',     name:'ABP Pension',           icon:'piggy', value:28400,  loanLeft:0,      equity:28400, curve:[22000,23500,24800,26000,27200,28400], changeYr:5.8 },
];

export const DEBTS = [
  { id:'d1', name:'Mortgage · Stadgenoot',   icon:'house',  balance:218000, original:240000, rate:3.2, minPayment:820,  nextDate:'01 Mar', type:'mortgage', color:'#4A6A4F' },
  { id:'d2', name:'Car loan · ABN AMRO',     icon:'car',    balance:4800,   original:12000,  rate:5.8, minPayment:250,  nextDate:'15 Mar', type:'loan',     color:'#A8782B' },
  { id:'d3', name:'Credit card · ING',       icon:'card',   balance:480,    original:480,    rate:14.5, minPayment:25,  nextDate:'25 Mar', type:'credit',   color:'#B5503A' },
  { id:'d4', name:'Study loan · DUO',        icon:'bag',    balance:12400,  original:28000,  rate:0.0,  minPayment:180, nextDate:'01 Mar', type:'student',  color:'#5E4A78' },
];
export const DEBTS_PAID_OFF = [
  { id:'dp1', name:'Personal loan · Rabobank', icon:'card',  paidAmount:3200, paidDate:'2026-01-15', type:'loan',    color:'#A8782B' },
  { id:'dp2', name:'Credit card · ABN AMRO',   icon:'card',  paidAmount:650,  paidDate:'2026-02-03', type:'credit',  color:'#B5503A' },
];
export const DEBT_HISTORY = [240000+12000+1200+28000, 240000+11000+1100+27800, 238000+9500+900+27600, 237000+8500+800+27400, 236000+7500+700+27200, 235680];

export const INTEGRATIONS = [
  { id: 'int_ah',     store: 'Albert Heijn', icon: '🛒', color: '#00A0E2', category: 'Supermarket', status: 'connected', connectedSince: '2025-08-14', txCount: 42, lastSync: '2026-02-18', email: 'demo@ahbonus.nl' },
  { id: 'int_jumbo',  store: 'Jumbo',        icon: '🛒', color: '#FFB800', category: 'Supermarket', status: 'connected', connectedSince: '2025-10-03', txCount: 18, lastSync: '2026-02-17', email: 'demo@jumbo.com' },
  { id: 'int_paypal', store: 'PayPal',       icon: '💳', color: '#003087', category: 'Payments',    status: 'connected', connectedSince: '2025-11-12', txCount: 7,  lastSync: '2026-02-15', email: 'demo@paypal.nl' },
  { id: 'int_amazon', store: 'Amazon',       icon: '📦', color: '#FF9900', category: 'Shopping',    status: 'connected', connectedSince: '2025-09-28', txCount: 12, lastSync: '2026-02-16', email: 'demo@amazon.nl' },
];

const AH_RECEIPTS = [
  { id: 'ahr1', date: D(1), store: 'AH 5821 Amsterdam Centraal', total: 42.10, items: [{ name: 'Biologische melk 1L', qty: 2, price: 2.39 }, { name: 'Halfvolle kwark 500g', qty: 1, price: 1.89 }, { name: 'Kaas 48+ jong belegen 500g', qty: 1, price: 4.79 }, { name: 'Tomaten losse 500g', qty: 1, price: 1.99 }, { name: 'Brood heel grof 800g', qty: 1, price: 2.29 }, { name: 'Kip filet 400g', qty: 1, price: 6.99 }, { name: 'Pasta farfalle 500g', qty: 2, price: 1.59 }, { name: 'Tomatensaus basilicum 350g', qty: 1, price: 1.99 }, { name: 'Douchegel men 250ml', qty: 1, price: 3.79 }, { name: 'AH Shampoo normaal 300ml', qty: 1, price: 2.99 }], matchedTxId: 't2' },
  { id: 'ahr2', date: D(7), store: 'AH 5821 Amsterdam Centraal', total: 28.40, items: [{ name: 'Sinaasappels 8 stuks', qty: 1, price: 3.49 }, { name: 'Bananen 1kg', qty: 1, price: 2.19 }, { name: 'Yoghurt naturel 500g', qty: 1, price: 1.49 }, { name: 'Eieren 10 stuks', qty: 1, price: 3.29 }, { name: 'Butter unsalted 250g', qty: 1, price: 2.79 }, { name: 'Crackers volkoren 250g', qty: 1, price: 2.19 }, { name: 'Pindakaas 350g', qty: 1, price: 3.49 }], matchedTxId: 't12' },
  { id: 'ahr3', date: D(14), store: 'AH 5821 Amsterdam Centraal', total: 38.10, items: [{ name: 'Rundgehakt 500g', qty: 1, price: 5.99 }, { name: 'Aardappelen 2kg', qty: 1, price: 3.29 }, { name: 'Broccoli 400g', qty: 1, price: 2.49 }, { name: 'Wortelen 1kg', qty: 1, price: 1.99 }, { name: 'Pasta spaghetti 500g', qty: 2, price: 1.49 }, { name: 'Tomatenpuree 70g', qty: 2, price: 0.79 }], matchedTxId: 't16' },
  { id: 'ahr4', date: D(18), store: 'AH 5821 Amsterdam Centraal', total: 49.80, items: [{ name: 'Kipfilet 600g', qty: 1, price: 8.99 }, { name: 'Rijst 2kg', qty: 1, price: 3.79 }, { name: 'Groente mix 400g', qty: 2, price: 3.49 }, { name: 'Sojasaus 150ml', qty: 1, price: 2.29 }, { name: 'Kokosnoot 400ml', qty: 1, price: 2.99 }], matchedTxId: 'f4' },
];

const JUMBO_RECEIPTS = [
  { id: 'jr1', date: D(1), store: 'Jumbo Supermarkt Amsterdam', total: 23.50, items: [{ name: 'Jumbo Halfvolle melk 1L', qty: 2, price: 1.19 }, { name: 'Jumbo Mozzarella 125g', qty: 1, price: 1.49 }, { name: 'Tomatensoep 570ml', qty: 2, price: 1.99 }, { name: 'Kaas plakken 250g', qty: 1, price: 3.29 }, { name: 'Brood wit 800g', qty: 1, price: 1.99 }, { name: 'Jumbo Cola Zero 1.5L', qty: 2, price: 1.39 }], matchedTxId: 'tb1' },
  { id: 'jr2', date: D(2), store: 'Jumbo Supermarkt Amsterdam', total: 23.50, items: [{ name: 'Salade mix 200g', qty: 1, price: 2.49 }, { name: 'Kippenfilet 400g', qty: 1, price: 5.99 }, { name: 'Pasta penne 500g', qty: 1, price: 1.29 }, { name: 'Tomatensaus 690g', qty: 1, price: 2.49 }, { name: 'Komkommer', qty: 1, price: 0.99 }], matchedTxId: 'tb2' },
  { id: 'jr3', date: D(28), store: 'Jumbo Supermarkt Amsterdam', total: 31.80, items: [{ name: 'Jumbo Biologisch brood', qty: 1, price: 2.79 }, { name: 'Verse sinaasappels 8st', qty: 1, price: 2.99 }, { name: 'Rundergehakt 500g', qty: 1, price: 6.49 }, { name: 'Uien 1kg', qty: 1, price: 1.49 }], matchedTxId: null },
];

const PAYPAL_RECEIPTS = [
  { id: 'pr1', date: D(4), store: 'PayPal — Booking.com', total: 84.00, items: [{ name: 'Hotel reservation · Berlin 21 Feb', qty: 1, price: 84.00 }], matchedTxId: null },
  { id: 'pr2', date: D(20), store: 'PayPal — G2A.com', total: 12.99, items: [{ name: 'Game key · PC Digital', qty: 1, price: 12.99 }], matchedTxId: null },
  { id: 'pr3', date: '2025-12-19', store: 'PayPal — iHerb', total: 34.50, items: [{ name: 'Omega-3 Fish Oil 90ct', qty: 1, price: 18.50 }, { name: 'Vitamin D3 200ct', qty: 1, price: 16.00 }], matchedTxId: null },
];

const AMAZON_RECEIPTS = [
  { id: 'amr1', date: D(3), store: 'Amazon.nl', total: 34.99, items: [{ name: 'Logitech MX Keys S keyboard NL', qty: 1, price: 34.99 }], matchedTxId: 't8' },
  { id: 'amr2', date: D(3), store: 'Amazon.nl', total: 22.00, items: [{ name: 'USB-C Hub 7-in-1', qty: 1, price: 22.00 }], matchedTxId: 't27' },
  { id: 'amr3', date: D(43), store: 'Amazon.nl', total: 54.99, items: [{ name: 'Anker PowerCore 20000mAh', qty: 1, price: 29.99 }, { name: 'USB-C cable 2m braided', qty: 2, price: 12.50 }], matchedTxId: 'j11' },
];

export const ALL_RECEIPTS = {
  int_ah: AH_RECEIPTS,
  int_jumbo: JUMBO_RECEIPTS,
  int_paypal: PAYPAL_RECEIPTS,
  int_amazon: AMAZON_RECEIPTS,
};

export const fmtEur = (n, opts = {}) => {
  const sign = n < 0 ? '−' : (opts.signed && n > 0 ? '+' : '');
  const abs = Math.abs(n);
  const s = abs.toLocaleString('nl-NL', { minimumFractionDigits: opts.decimals ?? 2, maximumFractionDigits: opts.decimals ?? 2 });
  return `${sign}€${s.replace('.', ',').replace(/,(\d{2})$/, ',$1')}`;
};
export const fmtEurInt = n => fmtEur(n, { decimals: 0 });
export const fmtDate = (iso, fmt = 'short') => {
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (fmt === 'short') return `${d.getDate()} ${months[d.getMonth()]}`;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
};
export const dayLabel = (iso) => {
  const d = new Date(iso);
  const today = new Date('2026-02-18');
  const diff = Math.floor((today - d) / (86400000));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `${days[d.getDay()]}, ${fmtDate(iso)}`;
};

const PERIOD = {
  start: '2026-01-20', end: '2026-02-19',
  income: 2480.00,
  expense: 1220.50,
  savings: 640.00,
  invest: 300.00,
  unallocated: 620.00,
  prevExpense: 1308.00,
  prevIncome: 2380.00,
};

export function computePeriodHistory(day) {
  const result = [];
  const today = new Date();
  // If today hasn't reached the period start day yet, the current period
  // began in the previous month — shift the window back by 1.
  const offset = today.getDate() < day ? 1 : 0;
  for (let i = 5; i >= 0; i--) {
    const startDate = new Date(today.getFullYear(), today.getMonth() - offset - i, day);
    const endDate = new Date(today.getFullYear(), today.getMonth() - offset - i + 1, day - 1);
    const fmtShort = d => d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
    result.push({
      label: `${fmtShort(startDate)} – ${fmtShort(endDate)}`,
      start: startDate.toISOString().slice(0,10),
      end: endDate.toISOString().slice(0,10),
      income: 2480, expense: 1220, invest: 300, unallocated: 620
    });
  }
  return result;
}
export const PERIOD_HISTORY = computePeriodHistory(20);
