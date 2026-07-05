export const ALL_TX_TYPES = ['Expense','Income','Saving','Transfer','Investment','Debt Payment','Adjustment'];

export const CATEGORIES = {
  // ── General (hidden — universal fallback) ───────────────────
  general:                { id:'general',                name:'General',            icon:'help-circle-outline',        group:'General',      isParent:true, hidden:true, types:ALL_TX_TYPES, direction:'both' },
  uncategorized:          { id:'uncategorized',          name:'Uncategorized',      icon:'help-circle-outline',        group:'General',      parent:'general', hidden:true, types:ALL_TX_TYPES, direction:'both' },
  // ── Income ──────────────────────────────────────────────────
  income:                 { id:'income',                 name:'Income',             icon:'cash-plus',                  group:'Income',       isParent:true, positive:true, color:'#27AE60', type:'Income' },
  incomeUncategorized:    { id:'incomeUncategorized',    name:'Uncategorized',      icon:'help-circle-outline',        group:'Income',       parent:'income', positive:true, type:'Income',  direction:'credit', hidden:true },
  reimburse:              { id:'reimburse',              name:'Reimbursement',      icon:'cash-refund',                group:'Income',       parent:'income', positive:true, type:'Income',  direction:'credit' },
  salary:                 { id:'salary',                 name:'Salary',             icon:'office-building-outline',    group:'Income',       parent:'income', positive:true, type:'Income',  direction:'credit' },
  freelance:              { id:'freelance',              name:'Freelance Work',     icon:'home-city-outline',          group:'Income',       parent:'income', positive:true, type:'Income',  direction:'credit' },
  rental:                 { id:'rental',                 name:'Rental Income',      icon:'store-clock-outline',        group:'Income',       parent:'income', positive:true, type:'Income',  direction:'credit' },
  investIncome:           { id:'investIncome',           name:'Investment Income',  icon:'chart-timeline-variant',     group:'Income',       parent:'income', positive:true, type:'Income',  direction:'credit' },
  incomeOther:            { id:'incomeOther',            name:'Other Income',       icon:'cash-plus',                  group:'Income',       parent:'income', positive:true, type:'Income',  direction:'credit' },
  // ── Saving ──────────────────────────────────────────────────
  saving:                 { id:'saving',                 name:'Saving',             icon:'piggy-bank-outline',         group:'Saving',       isParent:true, color:'#A8782B', type:'Saving' },
  savingWithdraw:         { id:'savingWithdraw',         name:'Withdrawal',         icon:'bank-remove',                group:'Saving',       parent:'saving', type:'Saving',  direction:'credit' },
  savingDeposit:          { id:'savingDeposit',          name:'Deposit',            icon:'bank-plus',                  group:'Saving',       parent:'saving', type:'Saving',  direction:'debit' },
  // ── Expense (default) ───────────────────────────────────────
  expense:                { id:'expense',                name:'Expense',            icon:'cash-remove',                group:'Expense',      isParent:true, type:'Expense' },
  expenseReimburse:       { id:'expenseReimburse',       name:'Reimbursement',      icon:'cash-refund',                group:'Expense',      parent:'expense', type:'Expense', direction:'debit' },
  expenseUncategorized:   { id:'expenseUncategorized',   name:'Uncategorized',      icon:'help-circle-outline',        group:'Expense',      parent:'expense', type:'Expense', direction:'debit', hidden:true },
  // ── Housing ─────────────────────────────────────────────────
  housing:                { id:'housing',                name:'Housing',            icon:'home-outline',               group:'Housing',      isParent:true, color:'#E67E22', type:'Expense' },
  housingRent:            { id:'housingRent',            name:'Rent & Mortgage',    icon:'home-import-outline',        group:'Housing',      parent:'housing', type:'Expense' },
  housingUtility:         { id:'housingUtility',         name:'Utility',            icon:'home-lightning-bolt-outline',group:'Housing',      parent:'housing', type:'Expense' },
  housingMaintenance:     { id:'housingMaintenance',     name:'Maintenance',        icon:'wrench-outline',             group:'Housing',      parent:'housing', type:'Expense' },
  housingStorage:         { id:'housingStorage',         name:'Storage Area',       icon:'warehouse',                  group:'Housing',      parent:'housing', type:'Expense' },
  housingOther:           { id:'housingOther',           name:'Other',              icon:'home-outline',               group:'Housing',      parent:'housing', type:'Expense' },
  // ── Transportation ──────────────────────────────────────────
  transport:              { id:'transport',              name:'Transportation',     icon:'bus-side',                   group:'Transportation',isParent:true, color:'#3498DB', type:'Expense' },
  transportCar:           { id:'transportCar',           name:'Car Payment',        icon:'car-outline',                group:'Transportation',parent:'transport', type:'Expense' },
  transportFuel:          { id:'transportFuel',          name:'Gas & Fuel',         icon:'gas-station-outline',        group:'Transportation',parent:'transport', type:'Expense' },
  transportPublic:        { id:'transportPublic',        name:'Public Transport',   icon:'train-car',                  group:'Transportation',parent:'transport', type:'Expense' },
  transportOther:         { id:'transportOther',         name:'Other',              icon:'bus-side',                   group:'Transportation',parent:'transport', type:'Expense' },
  // ── Consumption ─────────────────────────────────────────────
  consumption:            { id:'consumption',            name:'Consumption',        icon:'food-outline',               group:'Consumption',  isParent:true, color:'#27AE60', type:'Expense' },
  groceries:              { id:'groceries',              name:'Grocery',            icon:'cart-variant',               group:'Consumption',  parent:'consumption', type:'Expense' },
  breakfast:              { id:'breakfast',              name:'Breakfast & Brunch', icon:'bread-slice-outline',        group:'Consumption',  parent:'consumption', type:'Expense' },
  restaurants:            { id:'restaurants',            name:'Dining Out',         icon:'room-service-outline',       group:'Consumption',  parent:'consumption', type:'Expense' },
  takeout:                { id:'takeout',                name:'Takeout & Delivery', icon:'food-takeout-box-outline',   group:'Consumption',  parent:'consumption', type:'Expense' },
  sweets:                 { id:'sweets',                 name:'Sweets & Treats',    icon:'candy-outline',              group:'Consumption',  parent:'consumption', type:'Expense' },
  alcohol:                { id:'alcohol',                name:'Alcohol & Tobacco',  icon:'smoking',                    group:'Consumption',  parent:'consumption', type:'Expense' },
  coffee:                 { id:'coffee',                 name:'Coffee',             icon:'coffee-outline',             group:'Consumption',  parent:'consumption', type:'Expense' },
  consumptionOther:       { id:'consumptionOther',       name:'Other',              icon:'food-outline',               group:'Consumption',  parent:'consumption', type:'Expense' },
  // ── Personal Care ───────────────────────────────────────────
  personalCare:           { id:'personalCare',           name:'Personal Care',      icon:'mirror',                     group:'Personal Care',isParent:true, color:'#9B59B6', type:'Expense' },
  haircut:                { id:'haircut',                name:'Haircut',            icon:'content-cut',                group:'Personal Care',parent:'personalCare', type:'Expense' },
  toiletry:               { id:'toiletry',               name:'Toiletry',           icon:'toothbrush',                 group:'Personal Care',parent:'personalCare', type:'Expense' },
  beautyProduct:          { id:'beautyProduct',          name:'Health & Beauty',    icon:'hair-dryer-outline',         group:'Personal Care',parent:'personalCare', type:'Expense' },
  personalCareOther:      { id:'personalCareOther',      name:'Other',              icon:'mirror',                     group:'Personal Care',parent:'personalCare', type:'Expense' },
  // ── Entertainment ───────────────────────────────────────────
  entertainment:          { id:'entertainment',          name:'Entertainment',      icon:'drama-masks',                group:'Entertainment',isParent:true, color:'#E74C3C', type:'Expense' },
  movie:                  { id:'movie',                  name:'Movie',              icon:'popcorn',                    group:'Entertainment',parent:'entertainment', type:'Expense' },
  concerts:               { id:'concerts',               name:'Concerts & Shows',   icon:'curtains',                   group:'Entertainment',parent:'entertainment', type:'Expense' },
  sportingEvent:          { id:'sportingEvent',          name:'Sporting Event',     icon:'soccer-field',               group:'Entertainment',parent:'entertainment', type:'Expense' },
  gambling:               { id:'gambling',               name:'Gambling',           icon:'slot-machine-outline',       group:'Entertainment',parent:'entertainment', type:'Expense' },
  hobby:                  { id:'hobby',                  name:'Hobby',              icon:'checkerboard',               group:'Entertainment',parent:'entertainment', type:'Expense' },
  videoGame:              { id:'videoGame',              name:'Video Game',         icon:'gamepad-square-outline',     group:'Entertainment',parent:'entertainment', type:'Expense' },
  dating:                 { id:'dating',                 name:'Dating',             icon:'heart-multiple-outline',     group:'Entertainment',parent:'entertainment', type:'Expense' },
  subs:                   { id:'subs',                   name:'Streaming Service',  icon:'television-play',            group:'Entertainment',parent:'entertainment', type:'Expense' },
  entertainmentOther:     { id:'entertainmentOther',     name:'Other',              icon:'drama-masks',                group:'Entertainment',parent:'entertainment', type:'Expense' },
  // ── Sport ───────────────────────────────────────────────────
  sport:                  { id:'sport',                  name:'Sport',              icon:'tennis',                     group:'Sport',        isParent:true, color:'#1ABC9C', type:'Expense' },
  gym:                    { id:'gym',                    name:'Gym Membership',     icon:'dumbbell',                   group:'Sport',        parent:'sport', type:'Expense' },
  sportsEquipment:        { id:'sportsEquipment',        name:'Sports Equipment',   icon:'biathlon',                   group:'Sport',        parent:'sport', type:'Expense' },
  sportOther:             { id:'sportOther',             name:'Other',              icon:'tennis',                     group:'Sport',        parent:'sport', type:'Expense' },
  // ── Shopping ────────────────────────────────────────────────
  shopping:               { id:'shopping',               name:'Shopping',           icon:'shopping-outline',           group:'Shopping',     isParent:true, color:'#F39C12', type:'Expense' },
  clothing:               { id:'clothing',               name:'Clothing',           icon:'tshirt-crew-outline',        group:'Shopping',     parent:'shopping', type:'Expense' },
  electronics:            { id:'electronics',            name:'Electronic',         icon:'cellphone-link',             group:'Shopping',     parent:'shopping', type:'Expense' },
  homeGoods:              { id:'homeGoods',              name:'Home Goods',         icon:'sofa-single-outline',        group:'Shopping',     parent:'shopping', type:'Expense' },
  gift:                   { id:'gift',                   name:'Gift',               icon:'gift-outline',               group:'Shopping',     parent:'shopping', type:'Expense' },
  intimateUtility:        { id:'intimateUtility',        name:'Intimate Utility',   icon:'account-heart-outline',      group:'Shopping',     parent:'shopping', type:'Expense' },
  festivity:              { id:'festivity',              name:'Festivity',          icon:'party-popper',               group:'Shopping',     parent:'shopping', type:'Expense' },
  houseGarden:            { id:'houseGarden',            name:'House & Garden',     icon:'watering-can-outline',       group:'Shopping',     parent:'shopping', type:'Expense' },
  homeAutomation:         { id:'homeAutomation',         name:'Home Automation',    icon:'robot-outline',              group:'Shopping',     parent:'shopping', type:'Expense' },
  childCare:              { id:'childCare',              name:'Child Care',         icon:'baby-face-outline',          group:'Shopping',     parent:'shopping', type:'Expense' },
  shoppingOther:          { id:'shoppingOther',          name:'Other',              icon:'shopping-outline',           group:'Shopping',     parent:'shopping', type:'Expense' },
  // ── Holiday ─────────────────────────────────────────────────
  holiday:                { id:'holiday',                name:'Holiday',            icon:'island',                     group:'Holiday',      isParent:true, color:'#16A085', type:'Expense' },
  flight:                 { id:'flight',                 name:'Flight',             icon:'airplane-takeoff',           group:'Holiday',      parent:'holiday', type:'Expense' },
  hotel:                  { id:'hotel',                  name:'Hotel & Airbnb',     icon:'bed-outline',                group:'Holiday',      parent:'holiday', type:'Expense' },
  carRental:              { id:'carRental',              name:'Car Rental',         icon:'car-key',                    group:'Holiday',      parent:'holiday', type:'Expense' },
  activity:               { id:'activity',               name:'Activity',           icon:'map-marker-outline',         group:'Holiday',      parent:'holiday', type:'Expense' },
  holidayOther:           { id:'holidayOther',           name:'Other',              icon:'island',                     group:'Holiday',      parent:'holiday', type:'Expense' },
  // ── Education ───────────────────────────────────────────────
  education:              { id:'education',              name:'Education',          icon:'school-outline',             group:'Education',    isParent:true, color:'#2980B9', type:'Expense' },
  tuition:                { id:'tuition',                name:'Tuition',            icon:'account-cash-outline',       group:'Education',    parent:'education', type:'Expense' },
  course:                 { id:'course',                 name:'Course',             icon:'human-male-board',           group:'Education',    parent:'education', type:'Expense' },
  book:                   { id:'book',                   name:'Book',               icon:'book-education-outline',     group:'Education',    parent:'education', type:'Expense' },
  schoolSupply:           { id:'schoolSupply',           name:'School Supply',      icon:'notebook-edit-outline',      group:'Education',    parent:'education', type:'Expense' },
  certificate:            { id:'certificate',            name:'Certificate',        icon:'certificate-outline',        group:'Education',    parent:'education', type:'Expense' },
  newspaper:              { id:'newspaper',              name:'Newspaper',          icon:'newspaper-variant-outline',  group:'Education',    parent:'education', type:'Expense' },
  educationOther:         { id:'educationOther',         name:'Other',              icon:'school-outline',             group:'Education',    parent:'education', type:'Expense' },
  // ── Healthcare ──────────────────────────────────────────────
  healthcare:             { id:'healthcare',             name:'Healthcare',         icon:'hospital-box-outline',       group:'Healthcare',   isParent:true, color:'#E91E63', type:'Expense' },
  doctorVisit:            { id:'doctorVisit',            name:'Doctor Visit',       icon:'stethoscope',                group:'Healthcare',   parent:'healthcare', type:'Expense' },
  dental:                 { id:'dental',                 name:'Dental Work',        icon:'tooth-outline',              group:'Healthcare',   parent:'healthcare', type:'Expense' },
  prescription:           { id:'prescription',           name:'Prescription',       icon:'pill',                       group:'Healthcare',   parent:'healthcare', type:'Expense' },
  healthInsurance:        { id:'healthInsurance',        name:'Health Insurance',   icon:'shield-check-outline',       group:'Healthcare',   parent:'healthcare', type:'Expense' },
  healthUtility:          { id:'healthUtility',          name:'Health Utility',     icon:'face-mask-outline',          group:'Healthcare',   parent:'healthcare', type:'Expense' },
  mentalCare:             { id:'mentalCare',             name:'Mental Care',        icon:'meditation',                 group:'Healthcare',   parent:'healthcare', type:'Expense' },
  healthcareOther:        { id:'healthcareOther',        name:'Other',              icon:'hospital-box-outline',       group:'Healthcare',   parent:'healthcare', type:'Expense' },
  // ── Pet ─────────────────────────────────────────────────────
  pet:                    { id:'pet',                    name:'Pet',                icon:'fishbowl-outline',           group:'Pet',          isParent:true, color:'#795548', type:'Expense' },
  petFood:                { id:'petFood',                name:'Pet Food',           icon:'food-drumstick-outline',     group:'Pet',          parent:'pet', type:'Expense' },
  petSupply:              { id:'petSupply',              name:'Pet Supply',         icon:'paw-outline',                group:'Pet',          parent:'pet', type:'Expense' },
  petInsurance:           { id:'petInsurance',           name:'Pet Insurance',      icon:'shield-bug-outline',         group:'Pet',          parent:'pet', type:'Expense' },
  petOther:               { id:'petOther',               name:'Other',              icon:'fishbowl-outline',           group:'Pet',          parent:'pet', type:'Expense' },
  // ── Extra ───────────────────────────────────────────────────
  extra:                  { id:'extra',                  name:'Extra',              icon:'archive-plus-outline',       group:'Extra',        isParent:true, color:'#607D8B', type:'Expense' },
  birthday:               { id:'birthday',               name:'Birthday',           icon:'cake-variant-outline',       group:'Extra',        parent:'extra', type:'Expense' },
  funeralInsurance:       { id:'funeralInsurance',       name:'Funeral Insurance',  icon:'shield-cross-outline',       group:'Extra',        parent:'extra', type:'Expense' },
  charity:                { id:'charity',                name:'Charity',            icon:'handshake-outline',          group:'Extra',        parent:'extra', type:'Expense' },
  taxes:                  { id:'taxes',                  name:'Taxes',              icon:'bank-transfer-in',           group:'Extra',        parent:'extra', type:'Expense' },
  fee:                    { id:'fee',                    name:'Fee',                icon:'credit-card-check-outline',  group:'Extra',        parent:'extra', type:'Expense' },
  workExpense:            { id:'workExpense',            name:'Work Expense',       icon:'briefcase-outline',          group:'Extra',        parent:'extra', type:'Expense' },
  familyCare:             { id:'familyCare',             name:'Family Care',        icon:'account-child-outline',      group:'Extra',        parent:'extra', type:'Expense' },
  fines:                  { id:'fines',                  name:'Fines',              icon:'account-tie-hat-outline',    group:'Extra',        parent:'extra', type:'Expense' },
  secret:                 { id:'secret',                 name:'Secret',             icon:'incognito',                  group:'Extra',        parent:'extra', type:'Expense' },
  extraOther:             { id:'extraOther',             name:'Other',              icon:'archive-plus-outline',       group:'Extra',        parent:'extra', type:'Expense' },
  // ── Transfer ────────────────────────────────────────────────
  transfer:               { id:'transfer',               name:'Transfer',           icon:'bank-transfer',              group:'Transfer',     isParent:true, color:'#FF9800', type:'Transfer' },
  transferOut:            { id:'transferOut',            name:'Transfer Out',       icon:'bank-transfer-out',          group:'Transfer',     parent:'transfer', type:'Transfer',     direction:'debit' },
  transferIn:             { id:'transferIn',             name:'Transfer In',        icon:'bank-transfer-in',           group:'Transfer',     parent:'transfer', type:'Transfer',     direction:'credit' },
  cashWithdraw:           { id:'cashWithdraw',           name:'Cash Withdraw',      icon:'atm',                        group:'Transfer',     parent:'transfer', type:'Transfer',     direction:'debit' },
  cashDeposit:            { id:'cashDeposit',            name:'Cash Deposit',       icon:'cash-plus',                  group:'Transfer',     parent:'transfer', type:'Transfer',     direction:'credit' },
  // ── Debt Payment ────────────────────────────────────────────
  debt:                   { id:'debt',                   name:'Debt Payment',       icon:'credit-card-outline',        group:'Debt Payment', isParent:true, color:'#9C27B0', type:'Debt Payment' },
  debtUncategorized:      { id:'debtUncategorized',      name:'Uncategorized',      icon:'help-circle-outline',        group:'Debt Payment', parent:'debt', type:'Debt Payment',   direction:'both', hidden:true },
  lendMoney:              { id:'lendMoney',              name:'Lend Money',         icon:'hand-coin-outline',          group:'Debt Payment', parent:'debt', type:'Debt Payment',   direction:'debit' },
  loanRepayment:          { id:'loanRepayment',          name:'Loan Repayment',     icon:'bank-outline',               group:'Debt Payment', parent:'debt', type:'Debt Payment',   direction:'debit' },
  creditCardPayment:      { id:'creditCardPayment',      name:'Credit Card',        icon:'credit-card-clock-outline',  group:'Debt Payment', parent:'debt', type:'Debt Payment',   direction:'debit' },
  // ── Investment ──────────────────────────────────────────────
  investment:             { id:'investment',             name:'Investment',         icon:'chart-timeline-variant',     group:'Investment',   isParent:true, color:'#673AB7', type:'Investment' },
  invest:                 { id:'invest',                 name:'General',            icon:'chart-areaspline',           group:'Investment',   parent:'investment', type:'Investment', direction:'both' },
  investBuy:              { id:'investBuy',              name:'Buy',                icon:'trending-up',                group:'Investment',   parent:'investment', type:'Investment', direction:'debit' },
  investSell:             { id:'investSell',             name:'Sell',               icon:'trending-down',              group:'Investment',   parent:'investment', type:'Investment', direction:'credit' },
  investContribution:     { id:'investContribution',     name:'Contribution',       icon:'bank-plus',                  group:'Investment',   parent:'investment', type:'Investment', direction:'debit' },
  // ── Adjustment ──────────────────────────────────────────────
  adjustment:             { id:'adjustment',             name:'Adjustment',         icon:'tune-variant',               group:'Adjustment',   isParent:true, color:'#607D8B', type:'Adjustment' },
  balanceAdjustment:      { id:'balanceAdjustment',      name:'Balance Adjustment', icon:'scale-balance',              group:'Adjustment',   parent:'adjustment', type:'Adjustment', direction:'both' },
};

// Returns types array: multi-type for uncategorized, single-item for everything else
export function getCatTypes(cat) {
  if (!cat) return [];
  if (cat.types) return cat.types;
  if (cat.type) return [cat.type];
  return [];
}

// True if catId is any of the legacy or current uncategorized IDs
export function isUncatId(id) {
  return id === 'uncategorized' || id === 'expenseUncategorized' || id === 'incomeUncategorized' || id === 'debtUncategorized';
}

// Derive direction if not explicitly set: Income→credit, Expense→debit, others→both
export function getCatDirection(cat) {
  if (!cat) return 'both';
  if (cat.direction) return cat.direction;
  if (cat.types && cat.types.length > 1) return 'both';
  const t = cat.type || cat.types?.[0];
  if (t === 'Income') return 'credit';
  if (t === 'Expense') return 'debit';
  return 'both';
}

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
  'Transfer':'cat.transfer','Debt Payment':'cat.debt','Investment':'cat.investment','Adjustment':'cat.adjustment',
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

// Transaction types
export const TX_TYPES = ['Income', 'Expense', 'Saving', 'Transfer', 'Debt Payment', 'Investment', 'Adjustment'];

export const TX_TYPE_META = {
  'Income':       { icon:'cash-plus',              color:'#08372B' },
  'Expense':      { icon:'cash-remove',            color:'#C0392B' },
  'Saving':       { icon:'piggy-bank-outline',     color:'#2980B9' },
  'Transfer':     { icon:'bank-transfer',          color:'#FF9800' },
  'Debt Payment': { icon:'credit-card-outline',    color:'#9C27B0' },
  'Investment':   { icon:'chart-timeline-variant', color:'#673AB7' },
  'Adjustment':   { icon:'tune-variant',           color:'#607D8B' },
};

// Derive transaction type from source + destination account pair
export function deriveTxType(srcAcct, dstAcct, amount) {
  if (!dstAcct) return amount > 0 ? 'Income' : 'Expense';
  const src = srcAcct?.type;
  const dst = dstAcct?.type;
  // Investment accounts (brokerage or invest type)
  if (dst === 'invest' || dst === 'brokerage' || src === 'invest' || src === 'brokerage') return 'Investment';
  // Savings accounts
  if (dst === 'savings' || dst === 'saving' || src === 'savings' || src === 'saving') return 'Saving';
  // Cash wallet with saving purpose
  if ((dst === 'cash' && dstAcct?.purpose === 'saving') || (src === 'cash' && srcAcct?.purpose === 'saving')) return 'Saving';
  // Credit card
  if (dst === 'credit' || src === 'credit') return 'Debt Payment';
  return 'Transfer';
}

// Default category for a given type + sign
export function getTypeFallbackCat(txType, isNegative) {
  switch (txType) {
    case 'Income':       return 'uncategorized';
    case 'Expense':      return 'uncategorized';
    case 'Saving':       return isNegative ? 'savingDeposit'   : 'savingWithdraw';
    case 'Transfer':     return isNegative ? 'transferOut'     : 'transferIn';
    case 'Debt Payment': return 'uncategorized';
    case 'Investment':   return isNegative ? 'investBuy'       : 'investSell';
    case 'Adjustment':   return 'balanceAdjustment';
    default:             return 'uncategorized';
  }
}
