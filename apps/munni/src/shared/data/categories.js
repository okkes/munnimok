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