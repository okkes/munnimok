// patch_mega.js — comprehensive patch for all requested features
// Run: node patch_mega.js
const fs = require('fs');

let c = fs.readFileSync('munni.html', 'utf8').replace(/\r\n/g, '\n');
const orig = c;

function rep(from, to, label) {
  if (c.indexOf(from) === -1) { console.warn('⚠ NOT FOUND:', label || from.slice(0,60).replace(/\n/g,'↵')); return; }
  c = c.replace(from, to);
  console.log('✓', label || from.slice(0,60).replace(/\n/g,'↵'));
}

// ═══════════════════════════════════════════════════════════════════
// 1. HEAD — add MDI font CDN
// ═══════════════════════════════════════════════════════════════════
rep(
  `  <script src="https://unpkg.com/react@18.3.1`,
  `  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css" crossorigin="anonymous"/>
  <script src="https://unpkg.com/react@18.3.1`,
  'MDI font CDN'
);

// ═══════════════════════════════════════════════════════════════════
// 2. CSS — iOS zoom fix (inputs must be ≥16px to prevent auto-zoom)
// ═══════════════════════════════════════════════════════════════════
rep(
  `  html, body { margin: 0; padding: 0; height: 100%; background: #2A2823;`,
  `  input, textarea, select { font-size: 16px !important; }
  .m-tap { touch-action: manipulation; }
  html, body { margin: 0; padding: 0; height: 100%; background: #2A2823;`,
  'iOS zoom fix CSS'
);

// ═══════════════════════════════════════════════════════════════════
// 3. After I() component — add IcoMDI and CatIcon
// ═══════════════════════════════════════════════════════════════════
rep(
  `function Divider({ inset = 0, style = {} }) {`,
  `function IcoMDI({ name, size = 20, color }) {
  return <i className={'mdi mdi-' + name} style={{ fontSize: size, color: color || 'currentColor', lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: size, height: size }}/>;
}
function CatIcon({ cat, size = 20, color }) {
  if (!cat) return <IcoMDI name="help-circle-outline" size={size} color={color}/>;
  return <IcoMDI name={cat.icon || 'help-circle-outline'} size={size} color={color}/>;
}

function Divider({ inset = 0, style = {} }) {`,
  'IcoMDI + CatIcon components'
);

// ═══════════════════════════════════════════════════════════════════
// 4. CATEGORIES — update icons to MDI names
// ═══════════════════════════════════════════════════════════════════
const CAT_ICONS = {
  "icon:'arrow-dn-right', group:'Income',      isParent": "icon:'cash-plus', group:'Income',      isParent",
  "icon:'box',            group:'Income',      parent:'income'": "icon:'help-circle-outline', group:'Income',      parent:'income'",
  "icon:'link',           group:'Income',      parent:'income'": "icon:'cash-refund', group:'Income',      parent:'income'",
  "icon:'wallet',         group:'Income',      parent:'income', positive:true }": "icon:'office-building-outline', group:'Income',      parent:'income', positive:true }",
  "icon:'bag',            group:'Income',      parent:'income'": "icon:'home-city-outline', group:'Income',      parent:'income'",
  "icon:'house',          group:'Income',      parent:'income'": "icon:'store-clock-outline', group:'Income',      parent:'income'",
  "icon:'rocket',         group:'Income',      parent:'income'": "icon:'chart-timeline-variant', group:'Income',      parent:'income'",
  "icon:'arrow-dn-right', group:'Income',      parent:'income'": "icon:'cash-plus', group:'Income',      parent:'income'",
  "icon:'piggy',          group:'Saving',      isParent": "icon:'piggy-bank-outline', group:'Saving',      isParent",
  "icon:'card',           group:'Saving',      parent:'saving'": "icon:'bank-remove', group:'Saving',      parent:'saving'",
  "icon:'piggy',          group:'Saving',      parent:'saving'": "icon:'bank-plus', group:'Saving',      parent:'saving'",
  "icon:'arrow-up-right', group:'Expense',     isParent": "icon:'cash-remove', group:'Expense',     isParent",
  "icon:'link',           group:'Expense',     parent:'expense'": "icon:'cash-refund', group:'Expense',     parent:'expense'",
  "icon:'box',            group:'Expense',     parent:'expense'": "icon:'help-circle-outline', group:'Expense',     parent:'expense'",
  "icon:'house',          group:'Housing',     isParent": "icon:'home-outline', group:'Housing',     isParent",
  "icon:'house',          group:'Housing',     parent:'housing'": "icon:'home-import-outline', group:'Housing',     parent:'housing'",
  "icon:'flame',          group:'Housing',     parent:'housing'": "icon:'home-lightning-bolt-outline', group:'Housing',     parent:'housing'",
  "icon:'box',            group:'Housing',     parent:'housing', id:'housingMaintenance'": null, // handled below via regex
  "icon:'car',            group:'Transportation', isParent": "icon:'bus-side', group:'Transportation', isParent",
  "icon:'car',            group:'Transportation', parent:'transport'}": "icon:'car-outline', group:'Transportation', parent:'transport'}",
  "icon:'flame',          group:'Transportation', parent:'transport'": "icon:'gas-station-outline', group:'Transportation', parent:'transport'",
  "icon:'fork',           group:'Consumption', isParent": "icon:'food-outline', group:'Consumption', isParent",
  "icon:'shop',           group:'Consumption', parent:'consumption'": "icon:'cart-variant', group:'Consumption', parent:'consumption'",
  "icon:'user',           group:'Personal Care', isParent": "icon:'mirror', group:'Personal Care', isParent",
  "icon:'edit',           group:'Personal Care', parent:'personalCare'": "icon:'content-cut', group:'Personal Care', parent:'personalCare'",
  "icon:'star',           group:'Entertainment', isParent": "icon:'drama-masks', group:'Entertainment', isParent",
  "icon:'film',           group:'Entertainment', parent:'entertainment'}": "icon:'popcorn', group:'Entertainment', parent:'entertainment'}",
  "icon:'bag',            group:'Sport',       isParent": "icon:'tennis', group:'Sport',       isParent",
  "icon:'shop',           group:'Shopping',    isParent": "icon:'shopping-outline', group:'Shopping',    isParent",
  "icon:'globe',          group:'Holiday',     isParent": "icon:'island', group:'Holiday',     isParent",
  "icon:'globe',          group:'Holiday',     parent:'holiday'": "icon:'airplane-takeoff', group:'Holiday',     parent:'holiday'",
  "icon:'box',            group:'Education',   isParent": "icon:'school-outline', group:'Education',   isParent",
  "icon:'health',         group:'Healthcare',  isParent": "icon:'hospital-box-outline', group:'Healthcare',  isParent",
  "icon:'box',            group:'Pet',         isParent": "icon:'fishbowl-outline', group:'Pet',         isParent",
  "icon:'box',            group:'Extra',       isParent": "icon:'archive-plus-outline', group:'Extra',       isParent",
};

// Apply targeted category icon replacements using the categories block
// Use a comprehensive regex replacement on the CATEGORIES block
c = c.replace(
  /const CATEGORIES = \{[\s\S]*?\};(\n\nlet _catExt)/,
  (match, after) => {
    let m = match;
    // Income
    m = m.replace("income:                 { id:'income',                 name:'Income',             icon:'arrow-dn-right'", "income:                 { id:'income',                 name:'Income',             icon:'cash-plus'");
    m = m.replace("incomeUncategorized:    { id:'incomeUncategorized',    name:'Uncategorized',      icon:'box'", "incomeUncategorized:    { id:'incomeUncategorized',    name:'Uncategorized',      icon:'help-circle-outline'");
    m = m.replace("reimburse:              { id:'reimburse',              name:'Reimbursement',      icon:'link'", "reimburse:              { id:'reimburse',              name:'Reimbursement',      icon:'cash-refund'");
    m = m.replace("salary:                 { id:'salary',                 name:'Salary',             icon:'wallet'", "salary:                 { id:'salary',                 name:'Salary',             icon:'office-building-outline'");
    m = m.replace("freelance:              { id:'freelance',              name:'Freelance Work',     icon:'bag'", "freelance:              { id:'freelance',              name:'Freelance Work',     icon:'home-city-outline'");
    m = m.replace("rental:                 { id:'rental',                 name:'Rental Income',      icon:'house'", "rental:                 { id:'rental',                 name:'Rental Income',      icon:'store-clock-outline'");
    m = m.replace("investIncome:           { id:'investIncome',           name:'Investment Income',  icon:'rocket'", "investIncome:           { id:'investIncome',           name:'Investment Income',  icon:'chart-timeline-variant'");
    m = m.replace("incomeOther:            { id:'incomeOther',            name:'Other Income',       icon:'arrow-dn-right'", "incomeOther:            { id:'incomeOther',            name:'Other Income',       icon:'cash-plus'");
    // Saving
    m = m.replace("saving:                 { id:'saving',                 name:'Saving',             icon:'piggy'", "saving:                 { id:'saving',                 name:'Saving',             icon:'piggy-bank-outline'");
    m = m.replace("savingWithdraw:         { id:'savingWithdraw',         name:'Withdrawal',         icon:'card'", "savingWithdraw:         { id:'savingWithdraw',         name:'Withdrawal',         icon:'bank-remove'");
    m = m.replace("savingDeposit:          { id:'savingDeposit',          name:'Deposit',            icon:'piggy'", "savingDeposit:          { id:'savingDeposit',          name:'Deposit',            icon:'bank-plus'");
    // Expense
    m = m.replace("expense:                { id:'expense',                name:'Expense',            icon:'arrow-up-right'", "expense:                { id:'expense',                name:'Expense',            icon:'cash-remove'");
    m = m.replace("expenseReimburse:       { id:'expenseReimburse',       name:'Reimbursement',      icon:'link'", "expenseReimburse:       { id:'expenseReimburse',       name:'Reimbursement',      icon:'cash-refund'");
    m = m.replace("expenseUncategorized:   { id:'expenseUncategorized',   name:'Uncategorized',      icon:'box'", "expenseUncategorized:   { id:'expenseUncategorized',   name:'Uncategorized',      icon:'help-circle-outline'");
    // Housing
    m = m.replace("housing:                { id:'housing',                name:'Housing',            icon:'house'", "housing:                { id:'housing',                name:'Housing',            icon:'home-outline'");
    m = m.replace("housingRent:            { id:'housingRent',            name:'Rent & Mortgage',    icon:'house'", "housingRent:            { id:'housingRent',            name:'Rent & Mortgage',    icon:'home-import-outline'");
    m = m.replace("housingUtility:         { id:'housingUtility',         name:'Utility',            icon:'flame'", "housingUtility:         { id:'housingUtility',         name:'Utility',            icon:'home-lightning-bolt-outline'");
    m = m.replace("housingMaintenance:     { id:'housingMaintenance',     name:'Maintenance',        icon:'box'", "housingMaintenance:     { id:'housingMaintenance',     name:'Maintenance',        icon:'wrench-outline'");
    m = m.replace("housingStorage:         { id:'housingStorage',         name:'Storage Area',       icon:'box'", "housingStorage:         { id:'housingStorage',         name:'Storage Area',       icon:'warehouse'");
    m = m.replace("housingOther:           { id:'housingOther',           name:'Other',              icon:'house'", "housingOther:           { id:'housingOther',           name:'Other',              icon:'home-outline'");
    // Transport
    m = m.replace("transport:              { id:'transport',              name:'Transportation',     icon:'car'", "transport:              { id:'transport',              name:'Transportation',     icon:'bus-side'");
    m = m.replace("transportCar:           { id:'transportCar',           name:'Car Payment',        icon:'car'", "transportCar:           { id:'transportCar',           name:'Car Payment',        icon:'car-outline'");
    m = m.replace("transportFuel:          { id:'transportFuel',          name:'Gas & Fuel',         icon:'flame'", "transportFuel:          { id:'transportFuel',          name:'Gas & Fuel',         icon:'gas-station-outline'");
    m = m.replace("transportPublic:        { id:'transportPublic',        name:'Public Transport',   icon:'car'", "transportPublic:        { id:'transportPublic',        name:'Public Transport',   icon:'train-car'");
    m = m.replace("transportOther:         { id:'transportOther',         name:'Other',              icon:'car'", "transportOther:         { id:'transportOther',         name:'Other',              icon:'bus-side'");
    // Consumption
    m = m.replace("consumption:            { id:'consumption',            name:'Consumption',        icon:'fork'", "consumption:            { id:'consumption',            name:'Consumption',        icon:'food-outline'");
    m = m.replace("groceries:              { id:'groceries',              name:'Grocery',            icon:'shop'", "groceries:              { id:'groceries',              name:'Grocery',            icon:'cart-variant'");
    m = m.replace("breakfast:              { id:'breakfast',              name:'Breakfast & Brunch', icon:'fork'", "breakfast:              { id:'breakfast',              name:'Breakfast & Brunch', icon:'bread-slice-outline'");
    m = m.replace("restaurants:            { id:'restaurants',            name:'Dining Out',         icon:'fork'", "restaurants:            { id:'restaurants',            name:'Dining Out',         icon:'room-service-outline'");
    m = m.replace("takeout:                { id:'takeout',                name:'Takeout & Delivery', icon:'fork'", "takeout:                { id:'takeout',                name:'Takeout & Delivery', icon:'food-takeout-box-outline'");
    m = m.replace("sweets:                 { id:'sweets',                 name:'Sweets & Treats',    icon:'star'", "sweets:                 { id:'sweets',                 name:'Sweets & Treats',    icon:'candy-outline'");
    m = m.replace("alcohol:                { id:'alcohol',                name:'Alcohol & Tobacco',  icon:'box'", "alcohol:                { id:'alcohol',                name:'Alcohol & Tobacco',  icon:'smoking'");
    m = m.replace("coffee:                 { id:'coffee',                 name:'Coffee',             icon:'flame'", "coffee:                 { id:'coffee',                 name:'Coffee',             icon:'coffee-outline'");
    m = m.replace("consumptionOther:       { id:'consumptionOther',       name:'Other',              icon:'fork'", "consumptionOther:       { id:'consumptionOther',       name:'Other',              icon:'food-outline'");
    // Personal Care
    m = m.replace("personalCare:           { id:'personalCare',           name:'Personal Care',      icon:'user'", "personalCare:           { id:'personalCare',           name:'Personal Care',      icon:'mirror'");
    m = m.replace("haircut:                { id:'haircut',                name:'Haircut',            icon:'edit'", "haircut:                { id:'haircut',                name:'Haircut',            icon:'content-cut'");
    m = m.replace("toiletry:               { id:'toiletry',               name:'Toiletry',           icon:'health'", "toiletry:               { id:'toiletry',               name:'Toiletry',           icon:'toothbrush'");
    m = m.replace("beautyProduct:          { id:'beautyProduct',          name:'Health & Beauty',    icon:'health'", "beautyProduct:          { id:'beautyProduct',          name:'Health & Beauty',    icon:'hair-dryer-outline'");
    m = m.replace("personalCareOther:      { id:'personalCareOther',      name:'Other',              icon:'user'", "personalCareOther:      { id:'personalCareOther',      name:'Other',              icon:'mirror'");
    // Entertainment
    m = m.replace("entertainment:          { id:'entertainment',          name:'Entertainment',      icon:'star'", "entertainment:          { id:'entertainment',          name:'Entertainment',      icon:'drama-masks'");
    m = m.replace("movie:                  { id:'movie',                  name:'Movie',              icon:'film'", "movie:                  { id:'movie',                  name:'Movie',              icon:'popcorn'");
    m = m.replace("concerts:               { id:'concerts',               name:'Concerts & Shows',   icon:'star'", "concerts:               { id:'concerts',               name:'Concerts & Shows',   icon:'curtains'");
    m = m.replace("sportingEvent:          { id:'sportingEvent',          name:'Sporting Event',     icon:'star'", "sportingEvent:          { id:'sportingEvent',          name:'Sporting Event',     icon:'soccer-field'");
    m = m.replace("gambling:               { id:'gambling',               name:'Gambling',           icon:'star'", "gambling:               { id:'gambling',               name:'Gambling',           icon:'slot-machine-outline'");
    m = m.replace("hobby:                  { id:'hobby',                  name:'Hobby',              icon:'bag'", "hobby:                  { id:'hobby',                  name:'Hobby',              icon:'checkerboard'");
    m = m.replace("videoGame:              { id:'videoGame',              name:'Video Game',         icon:'bag'", "videoGame:              { id:'videoGame',              name:'Video Game',         icon:'gamepad-square-outline'");
    m = m.replace("dating:                 { id:'dating',                 name:'Dating',             icon:'star'", "dating:                 { id:'dating',                 name:'Dating',             icon:'heart-multiple-outline'");
    m = m.replace("subs:                   { id:'subs',                   name:'Streaming Service',  icon:'film'", "subs:                   { id:'subs',                   name:'Streaming Service',  icon:'television-play'");
    m = m.replace("entertainmentOther:     { id:'entertainmentOther',     name:'Other',              icon:'star'", "entertainmentOther:     { id:'entertainmentOther',     name:'Other',              icon:'drama-masks'");
    // Sport
    m = m.replace("sport:                  { id:'sport',                  name:'Sport',              icon:'bag'", "sport:                  { id:'sport',                  name:'Sport',              icon:'tennis'");
    m = m.replace("gym:                    { id:'gym',                    name:'Gym Membership',     icon:'bag'", "gym:                    { id:'gym',                    name:'Gym Membership',     icon:'dumbbell'");
    m = m.replace("sportsEquipment:        { id:'sportsEquipment',        name:'Sports Equipment',   icon:'bag'", "sportsEquipment:        { id:'sportsEquipment',        name:'Sports Equipment',   icon:'biathlon'");
    m = m.replace("sportOther:             { id:'sportOther',             name:'Other',              icon:'bag'", "sportOther:             { id:'sportOther',             name:'Other',              icon:'tennis'");
    // Shopping
    m = m.replace("shopping:               { id:'shopping',               name:'Shopping',           icon:'shop'", "shopping:               { id:'shopping',               name:'Shopping',           icon:'shopping-outline'");
    m = m.replace("clothing:               { id:'clothing',               name:'Clothing',           icon:'shop'", "clothing:               { id:'clothing',               name:'Clothing',           icon:'tshirt-crew-outline'");
    m = m.replace("electronics:            { id:'electronics',            name:'Electronic',         icon:'box'", "electronics:            { id:'electronics',            name:'Electronic',         icon:'cellphone-link'");
    m = m.replace("homeGoods:              { id:'homeGoods',              name:'Home Goods',         icon:'house'", "homeGoods:              { id:'homeGoods',              name:'Home Goods',         icon:'sofa-single-outline'");
    m = m.replace("gift:                   { id:'gift',                   name:'Gift',               icon:'star'", "gift:                   { id:'gift',                   name:'Gift',               icon:'gift-outline'");
    m = m.replace("intimateUtility:        { id:'intimateUtility',        name:'Intimate Utility',   icon:'user'", "intimateUtility:        { id:'intimateUtility',        name:'Intimate Utility',   icon:'account-heart-outline'");
    m = m.replace("festivity:              { id:'festivity',              name:'Festivity',          icon:'star'", "festivity:              { id:'festivity',              name:'Festivity',          icon:'party-popper'");
    m = m.replace("houseGarden:            { id:'houseGarden',            name:'House & Garden',     icon:'house'", "houseGarden:            { id:'houseGarden',            name:'House & Garden',     icon:'watering-can-outline'");
    m = m.replace("homeAutomation:         { id:'homeAutomation',         name:'Home Automation',    icon:'box'", "homeAutomation:         { id:'homeAutomation',         name:'Home Automation',    icon:'robot-outline'");
    m = m.replace("childCare:              { id:'childCare',              name:'Child Care',         icon:'user'", "childCare:              { id:'childCare',              name:'Child Care',         icon:'baby-face-outline'");
    m = m.replace("shoppingOther:          { id:'shoppingOther',          name:'Other',              icon:'shop'", "shoppingOther:          { id:'shoppingOther',          name:'Other',              icon:'shopping-outline'");
    // Holiday
    m = m.replace("holiday:                { id:'holiday',                name:'Holiday',            icon:'globe'", "holiday:                { id:'holiday',                name:'Holiday',            icon:'island'");
    m = m.replace("flight:                 { id:'flight',                 name:'Flight',             icon:'globe'", "flight:                 { id:'flight',                 name:'Flight',             icon:'airplane-takeoff'");
    m = m.replace("hotel:                  { id:'hotel',                  name:'Hotel & Airbnb',     icon:'house'", "hotel:                  { id:'hotel',                  name:'Hotel & Airbnb',     icon:'bed-outline'");
    m = m.replace("carRental:              { id:'carRental',              name:'Car Rental',         icon:'car'", "carRental:              { id:'carRental',              name:'Car Rental',         icon:'car-key'");
    m = m.replace("activity:               { id:'activity',               name:'Activity',           icon:'star'", "activity:               { id:'activity',               name:'Activity',           icon:'map-marker-outline'");
    m = m.replace("holidayOther:           { id:'holidayOther',           name:'Other',              icon:'globe'", "holidayOther:           { id:'holidayOther',           name:'Other',              icon:'island'");
    // Education
    m = m.replace("education:              { id:'education',              name:'Education',          icon:'box'", "education:              { id:'education',              name:'Education',          icon:'school-outline'");
    m = m.replace("tuition:                { id:'tuition',                name:'Tuition',            icon:'wallet'", "tuition:                { id:'tuition',                name:'Tuition',            icon:'account-cash-outline'");
    m = m.replace("course:                 { id:'course',                 name:'Course',             icon:'user'", "course:                 { id:'course',                 name:'Course',             icon:'human-male-board'");
    m = m.replace("book:                   { id:'book',                   name:'Book',               icon:'box'", "book:                   { id:'book',                   name:'Book',               icon:'book-education-outline'");
    m = m.replace("schoolSupply:           { id:'schoolSupply',           name:'School Supply',      icon:'edit'", "schoolSupply:           { id:'schoolSupply',           name:'School Supply',      icon:'notebook-edit-outline'");
    m = m.replace("certificate:            { id:'certificate',            name:'Certificate',        icon:'box'", "certificate:            { id:'certificate',            name:'Certificate',        icon:'certificate-outline'");
    m = m.replace("newspaper:              { id:'newspaper',              name:'Newspaper',          icon:'box'", "newspaper:              { id:'newspaper',              name:'Newspaper',          icon:'newspaper-variant-outline'");
    m = m.replace("educationOther:         { id:'educationOther',         name:'Other',              icon:'box'", "educationOther:         { id:'educationOther',         name:'Other',              icon:'school-outline'");
    // Healthcare
    m = m.replace("healthcare:             { id:'healthcare',             name:'Healthcare',         icon:'health'", "healthcare:             { id:'healthcare',             name:'Healthcare',         icon:'hospital-box-outline'");
    m = m.replace("doctorVisit:            { id:'doctorVisit',            name:'Doctor Visit',       icon:'health'", "doctorVisit:            { id:'doctorVisit',            name:'Doctor Visit',       icon:'stethoscope'");
    m = m.replace("dental:                 { id:'dental',                 name:'Dental Work',        icon:'health'", "dental:                 { id:'dental',                 name:'Dental Work',        icon:'tooth-outline'");
    m = m.replace("prescription:           { id:'prescription',           name:'Prescription',       icon:'health'", "prescription:           { id:'prescription',           name:'Prescription',       icon:'pill'");
    m = m.replace("healthInsurance:        { id:'healthInsurance',        name:'Health Insurance',   icon:'lock'", "healthInsurance:        { id:'healthInsurance',        name:'Health Insurance',   icon:'shield-check-outline'");
    m = m.replace("healthUtility:          { id:'healthUtility',          name:'Health Utility',     icon:'health'", "healthUtility:          { id:'healthUtility',          name:'Health Utility',     icon:'face-mask-outline'");
    m = m.replace("mentalCare:             { id:'mentalCare',             name:'Mental Care',        icon:'health'", "mentalCare:             { id:'mentalCare',             name:'Mental Care',        icon:'meditation'");
    m = m.replace("healthcareOther:        { id:'healthcareOther',        name:'Other',              icon:'health'", "healthcareOther:        { id:'healthcareOther',        name:'Other',              icon:'hospital-box-outline'");
    // Pet
    m = m.replace("pet:                    { id:'pet',                    name:'Pet',                icon:'box'", "pet:                    { id:'pet',                    name:'Pet',                icon:'fishbowl-outline'");
    m = m.replace("petFood:                { id:'petFood',                name:'Pet Food',           icon:'fork'", "petFood:                { id:'petFood',                name:'Pet Food',           icon:'food-drumstick-outline'");
    m = m.replace("petSupply:              { id:'petSupply',              name:'Pet Supply',         icon:'box'", "petSupply:              { id:'petSupply',              name:'Pet Supply',         icon:'paw-outline'");
    m = m.replace("petInsurance:           { id:'petInsurance',           name:'Pet Insurance',      icon:'lock'", "petInsurance:           { id:'petInsurance',           name:'Pet Insurance',      icon:'shield-bug-outline'");
    m = m.replace("petOther:               { id:'petOther',               name:'Other',              icon:'box'", "petOther:               { id:'petOther',               name:'Other',              icon:'fishbowl-outline'");
    // Extra
    m = m.replace("extra:                  { id:'extra',                  name:'Extra',              icon:'box'", "extra:                  { id:'extra',                  name:'Extra',              icon:'archive-plus-outline'");
    m = m.replace("birthday:               { id:'birthday',               name:'Birthday',           icon:'star'", "birthday:               { id:'birthday',               name:'Birthday',           icon:'cake-variant-outline'");
    m = m.replace("funeralInsurance:       { id:'funeralInsurance',       name:'Funeral Insurance',  icon:'lock'", "funeralInsurance:       { id:'funeralInsurance',       name:'Funeral Insurance',  icon:'shield-cross-outline'");
    m = m.replace("charity:                { id:'charity',                name:'Charity',            icon:'link'", "charity:                { id:'charity',                name:'Charity',            icon:'handshake-outline'");
    m = m.replace("taxes:                  { id:'taxes',                  name:'Taxes',              icon:'card'", "taxes:                  { id:'taxes',                  name:'Taxes',              icon:'bank-transfer-in'");
    m = m.replace("fee:                    { id:'fee',                    name:'Fee',                icon:'card'", "fee:                    { id:'fee',                    name:'Fee',                icon:'credit-card-check-outline'");
    m = m.replace("workExpense:            { id:'workExpense',            name:'Work Expense',       icon:'bag'", "workExpense:            { id:'workExpense',            name:'Work Expense',       icon:'briefcase-outline'");
    m = m.replace("familyCare:             { id:'familyCare',             name:'Family Care',        icon:'user'", "familyCare:             { id:'familyCare',             name:'Family Care',        icon:'account-child-outline'");
    m = m.replace("lendMoney:              { id:'lendMoney',              name:'Lend Money',         icon:'link'", "lendMoney:              { id:'lendMoney',              name:'Lend Money',         icon:'hand-coin-outline'");
    m = m.replace("cashWithdraw:           { id:'cashWithdraw',           name:'Cash Withdraw',      icon:'card'", "cashWithdraw:           { id:'cashWithdraw',           name:'Cash Withdraw',      icon:'atm'");
    m = m.replace("fines:                  { id:'fines',                  name:'Fines',              icon:'alert'", "fines:                  { id:'fines',                  name:'Fines',              icon:'account-tie-hat-outline'");
    m = m.replace("secret:                 { id:'secret',                 name:'Secret',             icon:'lock'", "secret:                 { id:'secret',                 name:'Secret',             icon:'incognito'");
    m = m.replace("invest:                 { id:'invest',                 name:'Investment',         icon:'rocket'", "invest:                 { id:'invest',                 name:'Investment',         icon:'chart-timeline-variant'");
    m = m.replace("extraOther:             { id:'extraOther',             name:'Other',              icon:'box'", "extraOther:             { id:'extraOther',             name:'Other',              icon:'archive-plus-outline'");
    return m + after;
  }
);
console.log('✓ CATEGORIES icons updated to MDI');

// ═══════════════════════════════════════════════════════════════════
// 5. Update category icon rendering to use IcoMDI
// ═══════════════════════════════════════════════════════════════════
// In ScreenExpenses category list
rep(
  `                    <I name={c.icon || 'box'} size={18} color={M.ink2}/>`,
  `                    <IcoMDI name={c.icon || 'help-circle-outline'} size={18} color={M.ink2}/>`,
  'ScreenExpenses parent icon'
);
rep(
  `                              <I name={subCat.icon || 'box'} size={14} color={M.ink2}/>`,
  `                              <IcoMDI name={subCat.icon || 'help-circle-outline'} size={14} color={M.ink2}/>`,
  'ScreenExpenses sub icon'
);
rep(
  `                        <I name={c.icon || 'box'} size={14} color={M.ink3}/>`,
  `                        <IcoMDI name={c.icon || 'help-circle-outline'} size={14} color={M.ink3}/>`,
  'ScreenExpenses all-sub icon'
);
// CategoryPicker
rep(
  `                        <I name={c.icon} size={16} color={selected === c.id ? M.sage : M.ink2}/>`,
  `                        <IcoMDI name={c.icon || 'help-circle-outline'} size={16} color={selected === c.id ? M.sage : M.ink2}/>`,
  'CategoryPicker icon'
);
// ScreenManageCategories parent icon
rep(
  `            <I name={parentCat.icon||'box'} size={18} color={isCustom?'#fff':M.ink2}/>`,
  `            <IcoMDI name={parentCat.icon||'help-circle-outline'} size={18} color={isCustom?'#fff':M.ink2}/>`,
  'ManageCategories parent icon'
);

// ═══════════════════════════════════════════════════════════════════
// 6. DEFAULT_PROFILES — add demo profile
// ═══════════════════════════════════════════════════════════════════
rep(
  `const DEFAULT_PROFILES = [
  { id:'p1', name:'Personal',  icon:'user',  active:true,  accountIds:['main','save','inv'], picture: null },
  { id:'p2', name:'Family',    icon:'house', active:false, accountIds:['main'],              picture: null },
  { id:'p3', name:'Freelance', icon:'bag',   active:false, accountIds:['main'],              picture: null },
];`,
  `const DEFAULT_PROFILES = [
  { id:'p1', name:'Personal',  icon:'user',  active:true,  accountIds:['main','save','inv'], picture: null },
  { id:'p2', name:'Family',    icon:'house', active:false, accountIds:['main'],              picture: null },
  { id:'p3', name:'Freelance', icon:'bag',   active:false, accountIds:['main'],              picture: null },
  { id:'p_demo', name:'Demo',  icon:'user',  active:false, accountIds:['main','save'],       picture: 'av7' },
];`,
  'Add demo profile'
);

// ═══════════════════════════════════════════════════════════════════
// 7. R() helper before RECURRING + update RECURRING days
// ═══════════════════════════════════════════════════════════════════
rep(
  `const RECURRING = [`,
  `// R(n) = day-of-month that is n days from today (capped at 28)
const R = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return Math.min(Math.max(d.getDate(), 1), 28); };

const RECURRING = [`,
  'R() helper before RECURRING'
);

rep(
  `  { id:'r1', name:'Rent · Stadgenoot', icon:'house',  amount:-740.00, day:1,  every:'monthly · 1st',  next:'01 Mar', cat:'housingRent', type:'fixed', luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t9']  },
  { id:'r2', name:'Eneco · Energy',    icon:'flame',  amount:-65.00,  day:20, every:'monthly · 20th', next:'20 Feb', cat:'housingUtility', type:'fixed', luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t24'] },
  { id:'r3', name:'Spotify',           icon:'film',   amount:-9.99,   day:17, every:'monthly · 17th', next:'17 Mar', cat:'subs',   type:'subs',  luxury:true,  since:'2023-06', until:null,    active:true,  txIds:['t4']  },
  { id:'r4', name:'Netflix',           icon:'film',   amount:-13.99,  day:1,  every:'monthly · 1st',  next:'01 Mar', cat:'subs',   type:'subs',  luxury:true,  since:'2023-01', until:null,    active:true,  txIds:['t18'] },
  { id:'r5', name:'DEGIRO ETF',        icon:'rocket', amount:-300.00, day:12, every:'monthly · 12th', next:'12 Mar', cat:'invest', type:'fixed', luxury:false, since:'2024-06', until:null,    active:true,  txIds:['t13'] },
  { id:'r6', name:'Acme Salary',       icon:'arrow-dn-right', amount:2480.00, day:18, every:'monthly · 18th', next:'18 Mar', cat:'salary', type:'income', luxury:false, since:'2022-01', until:null, active:true, txIds:['t3'] },
  { id:'r7', name:'Audible',           icon:'film',   amount:-7.95,   day:22, every:'monthly · 22nd', next:'22 Feb', cat:'subs',   type:'subs',  luxury:true,  since:'2023-03', until:'2026-01', active:false, txIds:[] },
];`,
  `  { id:'r1', name:'Rent · Stadgenoot',   icon:'home-import-outline',        amount:-740.00, day:R(6),  every:'monthly',  cat:'housingRent',   type:'fixed',  luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t9']  },
  { id:'r2', name:'Eneco · Energy',        icon:'home-lightning-bolt-outline', amount:-65.00,  day:R(1),  every:'monthly',  cat:'housingUtility',type:'fixed',  luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t24'] },
  { id:'r3', name:'Spotify',               icon:'television-play',             amount:-9.99,   day:R(3),  every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-06', until:null,    active:true,  txIds:['t4']  },
  { id:'r4', name:'Netflix',               icon:'television-play',             amount:-13.99,  day:R(7),  every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-01', until:null,    active:true,  txIds:['t18'] },
  { id:'r5', name:'DEGIRO ETF',            icon:'chart-timeline-variant',      amount:-300.00, day:R(15), every:'monthly',  cat:'invest',        type:'fixed',  luxury:false, since:'2024-06', until:null,    active:true,  txIds:['t13'] },
  { id:'r6', name:'Acme Salary',           icon:'cash-plus',                   amount:2480.00, day:R(18), every:'monthly',  cat:'salary',        type:'income', luxury:false, since:'2022-01', until:null,    active:true,  txIds:['t3']  },
  { id:'r7', name:'Audible',               icon:'book-education-outline',      amount:-7.95,   day:R(22), every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-03', until:'2026-01', active:false, txIds:[] },
  { id:'r8', name:'Basic-Fit · Gym',       icon:'dumbbell',                    amount:-24.99,  day:R(10), every:'monthly',  cat:'gym',           type:'subs',   luxury:false, since:'2024-03', until:null,    active:true,  txIds:[] },
  { id:'r9', name:'Health Insurance',      icon:'shield-check-outline',        amount:-128.50, day:R(12), every:'monthly',  cat:'healthInsurance',type:'fixed', luxury:false, since:'2023-01', until:null,    active:true,  txIds:[] },
];`,
  'RECURRING with R() days'
);

// ═══════════════════════════════════════════════════════════════════
// 8. Fix savings transfer transactions cat field
// ═══════════════════════════════════════════════════════════════════
rep(
  `  { id: 'sav1', date: D(9), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savings',`,
  `  { id: 'sav1', date: D(9), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit',`,
  'Fix sav1 cat'
);
rep(
  `  { id: 'sav2', date: D(25), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savings',`,
  `  { id: 'sav2', date: D(25), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit',`,
  'Fix sav2 cat'
);
// Fix remaining sav3-sav7
c = c.replace(/{ id: 'sav(\d)', date: D\((\d+)\), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savings',/g,
  (m, n, days) => m.replace("cat: 'savings',", "cat: 'savingDeposit',"));
console.log('✓ Fix sav* cat fields');

// ═══════════════════════════════════════════════════════════════════
// 9. ScreenExpenses — exclude saving transfers from periodTxs
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const periodTxs = txs.filter(t => t.amount < 0 && t.date >= activeStart && t.date <= activeEnd);`,
  `  const periodTxs = txs.filter(t => t.amount < 0 && !t.savingAccount && t.date >= activeStart && t.date <= activeEnd);`,
  'ScreenExpenses filter saving transfers'
);

// ═══════════════════════════════════════════════════════════════════
// 10. ScreenExpenses — fix bar labels to show period range
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const barLabels = periodHistory.map(p => new Date(p.start).toLocaleString('en-GB',{month:'short'}));`,
  `  const barLabels = periodHistory.map(p => {
    const s = new Date(p.start); const e = new Date(p.end);
    const sm = s.toLocaleString('en-GB',{month:'short'}); const em = e.toLocaleString('en-GB',{month:'short'});
    return sm === em ? sm : sm+'–'+em;
  });`,
  'ScreenExpenses bar labels show period range'
);

// ═══════════════════════════════════════════════════════════════════
// 11. ScreenExpenses — show values on top of bars
// ═══════════════════════════════════════════════════════════════════
rep(
  `          <BarChart
            data={barValues}
            labels={barLabels}
            height={90}
            accent={M.clay}
            color={M.ink3}
            selected={pidx}
            onSelect={(idx) => setPidx(idx)}
          />`,
  `          <BarChart
            data={barValues}
            labels={barLabels}
            height={90}
            accent={M.clay}
            color={M.ink3}
            showValues
            selected={pidx}
            onSelect={(idx) => setPidx(idx)}
          />`,
  'ScreenExpenses showValues on bars'
);

// ═══════════════════════════════════════════════════════════════════
// 12. HOME_CARDS_DEFAULT — rename Period → Overview
// ═══════════════════════════════════════════════════════════════════
rep(
  `  { id:'period',     label:'Period',             sub:'Income, spent, savings, invest',                   visible:true,  pinned:true  },`,
  `  { id:'period',     label:'Overview',           sub:'Income, spent, savings, invest',                   visible:true,  pinned:true  },`,
  'HOME_CARDS_DEFAULT Period→Overview'
);

// ═══════════════════════════════════════════════════════════════════
// 13. Translations — rename Period → Overview
// ═══════════════════════════════════════════════════════════════════
rep(`'home.period':'Period',`, `'home.period':'Overview',`, 'EN Period→Overview');
rep(`'home.period':'Periode',`, `'home.period':'Overzicht',`, 'NL Period→Overview');
rep(`'home.period':'Dönem',`, `'home.period':'Özet',`, 'TR Period→Overview');

// ═══════════════════════════════════════════════════════════════════
// 14. ScreenCustomizeHome description text update
// ═══════════════════════════════════════════════════════════════════
rep(
  `Transaction Review and Period are always shown at the top.`,
  `Transaction Review and Overview are always shown at the top.`,
  'ScreenCustomizeHome description'
);

// ═══════════════════════════════════════════════════════════════════
// 15. ScreenCustomizeHome — improve upcoming days UX
// ═══════════════════════════════════════════════════════════════════
rep(
  `              {s.id === 'upcoming' && s.visible && !s.pinned && (
                <div style={{ padding:'6px 16px 12px', borderTop:\`1px solid \${M.line2}\`, display:'flex', alignItems:'center', gap:8, background:M.paper2 }}>
                  <span style={{ fontSize:12, color:M.ink3, flex:1 }}>Show upcoming payments for next</span>
                  <button className="m-tap" onClick={() => setUpcomingDays(d => Math.max(1,d-1))} style={{ width:24, height:24, borderRadius:6, border:\`1px solid \${M.line}\`, background:M.card, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', color:M.sage, fontWeight:700, fontSize:14, fontFamily:M.fontUI }}>−</button>
                  <span style={{ fontSize:13, fontWeight:700, minWidth:16, textAlign:'center', fontFamily:M.fontMono }}>{upcomingDays}</span>
                  <button className="m-tap" onClick={() => setUpcomingDays(d => Math.min(7,d+1))} style={{ width:24, height:24, borderRadius:6, border:\`1px solid \${M.line}\`, background:M.card, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', color:M.sage, fontWeight:700, fontSize:14, fontFamily:M.fontUI }}>+</button>
                  <span style={{ fontSize:12, color:M.ink3 }}>days</span>
                </div>
              )}`,
  `              {s.id === 'upcoming' && s.visible && !s.pinned && (
                <div style={{ padding:'10px 16px 14px', borderTop:\`1px solid \${M.line2}\`, background:M.paper2 }}>
                  <div style={{ fontSize:12, color:M.ink3, marginBottom:8, fontWeight:500 }}>Lookahead window</div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    {[3,7,14,30].map(n => (
                      <button key={n} className="m-tap" onClick={() => setUpcomingDays(n)} style={{
                        flex:1, height:36, borderRadius:10, fontSize:13, fontWeight:600,
                        border:\`1.5px solid \${upcomingDays===n?M.sage:M.line}\`,
                        background:upcomingDays===n?M.sage:'transparent',
                        color:upcomingDays===n?'#fff':M.ink2, cursor:'pointer', fontFamily:M.fontUI,
                      }}>{n}d</button>
                    ))}
                  </div>
                </div>
              )}`,
  'ScreenCustomizeHome upcoming days UX'
);

// ═══════════════════════════════════════════════════════════════════
// 16. Accounts AppBar — remove + button
// ═══════════════════════════════════════════════════════════════════
rep(
  `        trailing={<button className="m-iconbtn m-tap" onClick={() => setShowAddChoice(true)}><I name="plus" size={20}/></button>}`,
  `        trailing={null}`,
  'Remove accounts + button'
);

// ═══════════════════════════════════════════════════════════════════
// 17. ScreenProfiles — remove "transaction history" from explanation
// ═══════════════════════════════════════════════════════════════════
rep(
  `Profiles let you track separate finances in one app — perfect for personal vs. business, or managing finances for different household members. Each profile has its own accounts, budgets, goals, and transaction history.`,
  `Profiles let you track separate finances in one app — perfect for personal vs. business, or managing finances for different household members. Each profile has its own accounts, budgets, goals, and financial data.`,
  'Remove transaction history from profiles text'
);

// ═══════════════════════════════════════════════════════════════════
// 18. CategoryPicker — fix custom categories showing "Undefined" group
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const groups = {};
  const allCatValues = [...Object.values(CATEGORIES), ...Object.values(_catExt)];
  allCatValues.forEach(c => {
    if (c.isParent) return;
    if (positiveOnly && !c.positive) return;
    if (!positiveOnly && c.positive) return;
    if (!positiveOnly && c.group === 'Saving') return;
    if (searchQ) {
      const q = searchQ.toLowerCase();
      const parentName = c.parent ? ((CATEGORIES[c.parent] || _catExt[c.parent])?.name || '').toLowerCase() : '';
      if (!c.name.toLowerCase().includes(q) && !parentName.includes(q) && !c.group.toLowerCase().includes(q)) return;
    }
    if (!groups[c.group]) groups[c.group] = [];
    groups[c.group].push(c);
  });`,
  `  const groups = {};
  const allCatValues = [...Object.values(CATEGORIES), ...Object.values(_catExt)];
  allCatValues.forEach(c => {
    if (c.isParent) return;
    if (positiveOnly && !c.positive) return;
    if (!positiveOnly && c.positive) return;
    if (!positiveOnly && c.group === 'Saving') return;
    // For custom cats without group, derive group from parent name
    const groupKey = c.group || (c.parent && (CATEGORIES[c.parent] || _catExt[c.parent])?.name) || 'Custom';
    if (searchQ) {
      const q = searchQ.toLowerCase();
      const parentName = c.parent ? ((CATEGORIES[c.parent] || _catExt[c.parent])?.name || '').toLowerCase() : '';
      if (!c.name.toLowerCase().includes(q) && !parentName.includes(q) && !(groupKey||'').toLowerCase().includes(q)) return;
    }
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(c);
  });`,
  'CategoryPicker fix custom category group'
);

// ═══════════════════════════════════════════════════════════════════
// 19. NewCatForm — accept isParent prop and hide color when sub
// ═══════════════════════════════════════════════════════════════════
rep(
  `function NewCatForm({ onSave }) {
  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState('box');
  const [color, setColor] = React.useState(M.slate);
  const icons = ['box','home','car','heart','star','fork','shop','flame','film','health','bag','globe','rocket','wallet','lock','user','edit','tag','link','receipt','piggy','cal','eye'];
  const colors = [M.sage, M.clay, M.ochre, M.violet, M.slate, '#e07b39', '#6b8e6b', '#8e6b8e'];
  return (
    <div style={{ paddingBottom:8 }}>
      <input
        value={name} onChange={e => setName(e.target.value)}
        placeholder="Category name"
        style={{ width:'100%', boxSizing:'border-box', border:\`1px solid \${M.line}\`, borderRadius:10, padding:'11px 14px', fontSize:14, fontFamily:M.fontUI, marginBottom:14, outline:'none', background:M.paper2, color:M.ink }}
      />
      <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Icon</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14 }}>
        {icons.map(ic => (
          <button key={ic} className="m-tap" onClick={() => setIcon(ic)}
            style={{ width:36, height:36, borderRadius:8, background: icon===ic?M.sageSoft:M.paper2, border:\`1.5px solid \${icon===ic?M.sage:M.line}\`, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
            <I name={ic} size={15} color={icon===ic?M.sage:M.ink3}/>
          </button>
        ))}
      </div>
      <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Color</div>
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
        {colors.map(c => (
          <button key={c} className="m-tap" onClick={() => setColor(c)}
            style={{ width:28, height:28, borderRadius:'50%', background:c, border:\`2.5px solid \${color===c?M.ink:'transparent'}\`, cursor:'pointer' }}/>
        ))}
      </div>
      <button className="m-tap" onClick={() => name.trim() && onSave(name.trim(), icon, color)}
        disabled={!name.trim()}
        style={{ width:'100%', background:M.sage, border:'none', borderRadius:12, padding:'13px', color:'#fff', fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, opacity: name.trim()?1:0.5 }}>
        Add category
      </button>
    </div>
  );
}`,
  `function NewCatForm({ onSave, isSub = false }) {
  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState('help-circle-outline');
  const [color, setColor] = React.useState(M.slate);
  const mdiIcons = [
    'help-circle-outline','home-outline','car-outline','heart-outline','star-outline',
    'food-outline','cart-variant','coffee-outline','television-play','hospital-box-outline',
    'shopping-outline','island','school-outline','dumbbell','baby-face-outline',
    'cash-plus','piggy-bank-outline','cellphone-link','gift-outline','book-education-outline',
    'briefcase-outline','bus-side','airplane-takeoff','medication-outline','paw-outline',
  ];
  const colors = [M.sage, M.clay, M.ochre, M.violet, M.slate, '#e07b39', '#6b8e6b', '#8e6b8e'];
  return (
    <div style={{ paddingBottom:8 }}>
      <input
        value={name} onChange={e => setName(e.target.value)}
        placeholder="Category name"
        style={{ width:'100%', boxSizing:'border-box', border:\`1px solid \${M.line}\`, borderRadius:10, padding:'11px 14px', fontSize:14, fontFamily:M.fontUI, marginBottom:14, outline:'none', background:M.paper2, color:M.ink }}
      />
      <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Icon</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14 }}>
        {mdiIcons.map(ic => (
          <button key={ic} className="m-tap" onClick={() => setIcon(ic)}
            style={{ width:36, height:36, borderRadius:8, background: icon===ic?M.sageSoft:M.paper2, border:\`1.5px solid \${icon===ic?M.sage:M.line}\`, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
            <IcoMDI name={ic} size={15} color={icon===ic?M.sage:M.ink3}/>
          </button>
        ))}
      </div>
      {!isSub && (
        <>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>Color</div>
          <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
            {colors.map(clr => (
              <button key={clr} className="m-tap" onClick={() => setColor(clr)}
                style={{ width:28, height:28, borderRadius:'50%', background:clr, border:\`2.5px solid \${color===clr?M.ink:'transparent'}\`, cursor:'pointer' }}/>
            ))}
          </div>
        </>
      )}
      <button className="m-tap" onClick={() => name.trim() && onSave(name.trim(), icon, color)}
        disabled={!name.trim()}
        style={{ width:'100%', background:M.sage, border:'none', borderRadius:12, padding:'13px', color:'#fff', fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, opacity: name.trim()?1:0.5 }}>
        {isSub ? 'Add sub-category' : 'Add category'}
      </button>
    </div>
  );
}`,
  'NewCatForm isSub prop'
);

// Pass isSub prop to sub sheet
rep(
  `      <Sheet open={!!newSubSheet} onClose={() => setNewSubSheet(null)} title="New sub-category">
        <NewCatForm
          onSave={(name, icon, color) => {`,
  `      <Sheet open={!!newSubSheet} onClose={() => setNewSubSheet(null)} title="New sub-category">
        <NewCatForm
          isSub={true}
          onSave={(name, icon, color) => {`,
  'Pass isSub to sub sheet'
);

// ═══════════════════════════════════════════════════════════════════
// 20. ScreenManageCategories — fix collapse button + +sub stopPropagation
// ═══════════════════════════════════════════════════════════════════
rep(
  `            <button
              className="m-tap"
              onClick={() => setNewSubSheet(parentKey)}
              style={{
                background:M.sageSoft, border:'none', borderRadius:8, padding:'4px 10px', color:M.sage, fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, display:'flex', alignItems:'center', gap:4 }}>
              <I name="plus" size={11} color={M.sage}/> Sub
            </button>
            <div style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition:'transform 0.2s ease', display:'flex' }}
              onClick={(e) => { e.stopPropagation(); setCollapsedParents(prev => ({ ...prev, [parentKey]: !prev[parentKey] })); }}>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>`,
  `            <button
              className="m-tap"
              onClick={(e) => { e.stopPropagation(); setNewSubSheet(parentKey); }}
              style={{
                background:M.sageSoft, border:'none', borderRadius:8, padding:'4px 10px', color:M.sage, fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, display:'flex', alignItems:'center', gap:4 }}>
              <I name="plus" size={11} color={M.sage}/> Sub
            </button>
            <button className="m-tap"
              onClick={(e) => { e.stopPropagation(); setCollapsedParents(prev => ({ ...prev, [parentKey]: !prev[parentKey] })); }}
              style={{ background:'none', border:'none', cursor:'pointer', padding:'4px', display:'flex', alignItems:'center', borderRadius:6 }}>
              <div style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(90deg)', transition:'transform 0.2s ease', display:'flex' }}>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </button>`,
  'Fix collapse button + +sub stopPropagation'
);

// ═══════════════════════════════════════════════════════════════════
// 21. ScreenManageCategories — prevent renaming pre-made categories
// ═══════════════════════════════════════════════════════════════════
// The edit sheet is opened from header onClick. For premade (non-custom), don't allow name editing.
// We need to pass an `isPrebuilt` prop to EditCatSheet.
// The parent header onClick passes isCustom, so we just need to not show name edit for !isCustom.
rep(
  `function EditCatSheet({ entry, txCount, onSave, onDelete }) {
  const [nameDraft, setNameDraft] = React.useState(entry.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const canDelete = onDelete !== null;
  const isParent = entry.isParent;`,
  `function EditCatSheet({ entry, txCount, onSave, onDelete, isPrebuilt = false }) {
  const [nameDraft, setNameDraft] = React.useState(entry.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const canDelete = onDelete !== null;
  const isParent = entry.isParent;`,
  'EditCatSheet isPrebuilt prop'
);
rep(
  `      <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Name</div>
      <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
        style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:\`1px solid \${M.line}\`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box', marginBottom:20 }}/>`,
  `      <div style={{ fontSize:12, color:M.ink3, marginBottom:6 }}>Name</div>
      {isPrebuilt ? (
        <div style={{ padding:'12px 14px', borderRadius:10, border:\`1px solid \${M.line}\`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, marginBottom:8, color:M.ink }}>{nameDraft}</div>
      ) : (
        <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
          style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:\`1px solid \${M.line}\`, fontSize:14, fontFamily:M.fontUI, background:M.paper2, outline:'none', boxSizing:'border-box' }}/>
      )}
      {isPrebuilt && <div style={{ fontSize:11, color:M.ink3, marginBottom:16, paddingLeft:2 }}>Built-in category names cannot be changed.</div>}
      {!isPrebuilt && <div style={{ marginBottom:20 }}/>}`,
  'EditCatSheet prevent renaming prebuilt'
);

// Pass isPrebuilt to edit sheet for premade categories (isCustom=false)
rep(
  `      {editSheet && (() => {
        const isCust = editSheet.isCustom;`,
  `      {editSheet && (() => {
        const isCust = editSheet.isCustom;
        const isPrebuilt = !isCust;`,
  'isPrebuilt flag in edit sheet handler'
);

// ═══════════════════════════════════════════════════════════════════
// 22. useProfileBudgets/Goals/Debts — empty for new profiles
// ═══════════════════════════════════════════════════════════════════
rep(
  `function useProfileBudgets() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(\`munni_budgets_\${activeProfileId}\`, BUDGETS);
}
function useProfileGoals() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(\`munni_goals_\${activeProfileId}\`, GOALS);
}
function useProfileDebts() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(\`munni_debts_\${activeProfileId}\`, DEBTS);
}`,
  `const DEFAULT_PROFILE_IDS = ['p1','p2','p3','p_demo'];
function useProfileBudgets() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(\`munni_budgets_\${activeProfileId}\`, DEFAULT_PROFILE_IDS.includes(activeProfileId) ? BUDGETS : []);
}
function useProfileGoals() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(\`munni_goals_\${activeProfileId}\`, DEFAULT_PROFILE_IDS.includes(activeProfileId) ? GOALS : []);
}
function useProfileDebts() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(\`munni_debts_\${activeProfileId}\`, DEFAULT_PROFILE_IDS.includes(activeProfileId) ? DEBTS : []);
}`,
  'Profile data empty for new profiles'
);

// ═══════════════════════════════════════════════════════════════════
// 23. ScreenProfile — no email edit + add picture picker
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const [editing, setEditing] = React.useState(false);
  const [name, setName] = useLocalStorage('munni_profile_name', 'Demo van der Berg');
  const [email, setEmail] = useLocalStorage('munni_profile_email', 'demo@munni.app');
  const { profiles } = useProfiles();
  const [connectedAccounts] = useLocalStorage('munni_bank_accounts', () => ACCOUNTS.slice());
  const [draft, setDraft] = React.useState({ name, email });
  const [showReset, setShowReset] = React.useState(false);

  const startEdit = () => { setDraft({ name, email }); setEditing(true); };
  const save = () => { setName(draft.name); setEmail(draft.email); setEditing(false); };
  const cancel = () => setEditing(false);
  const initial = name.charAt(0).toUpperCase();`,
  `  const [editing, setEditing] = React.useState(false);
  const [name, setName] = useLocalStorage('munni_profile_name', 'Demo van der Berg');
  const [email] = useLocalStorage('munni_profile_email', 'demo@munni.app');
  const [userPicture, setUserPicture] = useLocalStorage('munni_user_picture', null);
  const { profiles } = useProfiles();
  const [connectedAccounts] = useLocalStorage('munni_bank_accounts', () => ACCOUNTS.slice());
  const [draft, setDraft] = React.useState({ name });
  const [showReset, setShowReset] = React.useState(false);
  const [showPicturePicker, setShowPicturePicker] = React.useState(false);

  const startEdit = () => { setDraft({ name }); setEditing(true); };
  const save = () => { setName(draft.name); setEditing(false); };
  const cancel = () => setEditing(false);
  const initial = name.charAt(0).toUpperCase();`,
  'ScreenProfile no email edit, add userPicture state'
);

// Update identity card to use userPicture and remove email edit
rep(
  `        <div className="m-card" style={{ padding: 18, marginBottom: 16, border: \`1px solid \${M.line}\`, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 999,
            background: \`linear-gradient(135deg, \${M.sage} 0%, #3D5A42 100%)\`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 600, fontSize: 22, fontFamily: M.fontDisp, flexShrink: 0,
          }}>{initial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <>
                <input value={draft.name} onChange={e => setDraft(d => ({...d, name: e.target.value}))}
                  style={{ width:'100%', fontSize:16, fontWeight:600, border:\`1px solid \${M.sage}\`, borderRadius:8, padding:'6px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:6 }}/>
                <input value={draft.email} onChange={e => setDraft(d => ({...d, email: e.target.value}))}
                  style={{ width:'100%', fontSize:13, border:\`1px solid \${M.line}\`, borderRadius:8, padding:'5px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', color:M.ink3 }}/>
              </>
            ) : (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2 }}>
                  <div style={{ fontSize: 17, fontWeight: 600 }}>{name}</div>
                </div>
                <div style={{ fontSize: 12, color: M.ink3 }}>{email}</div>
              </>
            )}
          </div>`,
  `        <div className="m-card" style={{ padding: 18, marginBottom: 16, border: \`1px solid \${M.line}\`, display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="m-tap" onClick={() => setShowPicturePicker(true)} style={{ position:'relative', background:'none', border:'none', cursor:'pointer', padding:0, flexShrink:0 }}>
            {userPicture ? (
              userPicture.startsWith('av') ? (
                (() => { const av = STOCK_AVATARS.find(a => a.id === userPicture); return av ? <div style={{ width:56, height:56, borderRadius:999, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:26 }}>{av.emoji}</div> : null; })()
              ) : (
                <img src={userPicture} style={{ width:56, height:56, borderRadius:999, objectFit:'cover' }}/>
              )
            ) : (
              <div style={{ width:56, height:56, borderRadius:999, background:\`linear-gradient(135deg, \${M.sage} 0%, #3D5A42 100%)\`, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:22, fontFamily:M.fontDisp }}>{initial}</div>
            )}
            <div style={{ position:'absolute', bottom:0, right:0, width:20, height:20, borderRadius:'50%', background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', border:'2px solid #fff' }}>
              <I name="cam" size={10} color="#fff"/>
            </div>
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <input value={draft.name} onChange={e => setDraft(d => ({...d, name: e.target.value}))}
                style={{ width:'100%', fontSize:16, fontWeight:600, border:\`1px solid \${M.sage}\`, borderRadius:8, padding:'6px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:6 }}/>
            ) : (
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2 }}>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{name}</div>
              </div>
            )}
            <div style={{ fontSize: 12, color: M.ink3 }}>{email}</div>
          </div>`,
  'ScreenProfile identity card with picture picker'
);

// Add picture picker sheet before the return closing div (find the reset section)
rep(
  `        {showReset && (`,
  `        {/* User picture picker */}
        {showPicturePicker && (
          <Sheet onClose={() => setShowPicturePicker(false)} title="Profile picture">
            <div style={{ paddingBottom:8 }}>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
                {STOCK_AVATARS.map(av => (
                  <button key={av.id} className="m-tap" onClick={() => { setUserPicture(av.id); setShowPicturePicker(false); }}
                    style={{ padding:4, border:\`2px solid \${userPicture===av.id?M.sage:'transparent'}\`, borderRadius:16, background:'none', cursor:'pointer' }}>
                    <div style={{ width:'100%', aspectRatio:'1', borderRadius:12, background:av.bg, display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>{av.emoji}</div>
                  </button>
                ))}
              </div>
              <label className="m-tap" style={{ display:'block', width:'100%', padding:'13px 0', textAlign:'center', background:M.paper2, border:\`1px solid \${M.line}\`, borderRadius:12, fontSize:14, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI }}>
                <input type="file" accept="image/*" style={{ display:'none' }} onChange={e => { const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>{setUserPicture(ev.target.result); setShowPicturePicker(false);}; r.readAsDataURL(f); }}/>
                Upload photo
              </label>
              {userPicture && <button className="m-tap" onClick={() => { setUserPicture(null); setShowPicturePicker(false); }} style={{ width:'100%', marginTop:10, padding:'13px 0', background:'none', border:\`1px solid \${M.clay}\`, borderRadius:12, fontSize:14, color:M.clay, cursor:'pointer', fontFamily:M.fontUI }}>Remove picture</button>}
            </div>
          </Sheet>
        )}

        {showReset && (`,
  'ScreenProfile picture picker sheet'
);

// ═══════════════════════════════════════════════════════════════════
// 24. Settings overview — dynamic period sub text
// ═══════════════════════════════════════════════════════════════════
rep(
  `          <ProfileLink icon="cal"     label={t('settings.periods')}        sub="Monthly · 20th"                     onClick={() => nav.push('periods')}/>`,
  `          <ProfileLink icon="cal"     label={t('settings.periods')}        sub={(() => { const [pd] = useLocalStorage ? [null] : [null]; const pday = parseInt(localStorage.getItem('munni_period_day')||'20'); const ptype = localStorage.getItem('munni_period_type')||'monthly'; if(ptype==='weekly') return 'Weekly · '+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][pday]||'Mon'; if(ptype==='biweekly') return 'Bi-weekly · '+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][pday]||'Mon'; return 'Monthly · '+pday+(pday===1||pday===21?'st':pday===2||pday===22?'nd':pday===3||pday===23?'rd':'th'); })()} onClick={() => nav.push('periods')}/>`,
  'Dynamic period sub text in settings'
);

// ═══════════════════════════════════════════════════════════════════
// 25. ScreenPeriods — add weekly/biweekly/monthly selector
// ═══════════════════════════════════════════════════════════════════
rep(
  `function ScreenPeriods() {
  const nav = useNav();
  const { t } = useLang();
  const [selectedDay, setSelectedDay] = useLocalStorage('munni_period_day', 20);
  // Days 1-28 (disallow 29-31 as some months don't have them)
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  const ordinalStr = (d) => {
    if (d === 1 || d === 21) return \`\${d}st\`;
    if (d === 2 || d === 22) return \`\${d}nd\`;
    if (d === 3 || d === 23) return \`\${d}rd\`;
    return \`\${d}th\`;
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.periods')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ padding:'12px 16px', borderRadius:12, background:M.sageSoft, marginBottom:18, fontSize:13, color:M.sage, lineHeight:1.6 }}>
          <strong>What is a period?</strong> munni organises your finances in periods rather than calendar months. A period starts on your chosen day — ideally the day your salary arrives — so income and expenses always line up.
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Period start day</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:8, marginBottom:20 }}>
          {days.map(d => (
            <button key={d} className="m-tap" onClick={() => setSelectedDay(d)} style={{
              height:44, borderRadius:12, border:\`1.5px solid \${selectedDay === d ? M.sage : M.line}\`,
              background: selectedDay === d ? M.sage : M.card,
              color: selectedDay === d ? '#fff' : M.ink,
              fontSize:14, fontWeight: selectedDay === d ? 700 : 400,
              cursor:'pointer', fontFamily:M.fontUI,
              display:'flex', alignItems:'center', justifyContent:'center',
            }}>{d}</button>
          ))}
        </div>

        <div className="m-card" style={{ padding:14, marginBottom:16, border:\`1px solid \${M.line}\` }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Current period</div>
          <div style={{ fontSize:13, color:M.ink3 }}>
            {ordinalStr(selectedDay)} of each month — period runs from the <strong>{ordinalStr(selectedDay)}</strong> to the <strong>{ordinalStr(selectedDay === 1 ? 28 : selectedDay - 1)}</strong> of the following month.
          </div>
          <div style={{ fontSize:12, color:M.sage, marginTop:6, fontWeight:500 }}>
            {(() => { const ph = computePeriodHistory(selectedDay); const cur = ph[ph.length-1]; return cur ? cur.label : ''; })()}
          </div>
        </div>

        <div style={{ padding:'10px 14px', borderRadius:10, background:M.ochreSoft, marginBottom:20, fontSize:12, color:M.ochre, lineHeight:1.5 }}>
          <strong>Tip:</strong> We recommend choosing the day your salary is deposited. If there is sometimes a 1–2 day delay, pick the earliest expected day to avoid your salary landing in the wrong period.
        </div>

        <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={() => nav.pop()}>
          {t('action.save')} — periods start on the {ordinalStr(selectedDay)}
        </button>
      </div>
    </div>
  );
}`,
  `function ScreenPeriods() {
  const nav = useNav();
  const { t } = useLang();
  const [selectedDay, setSelectedDay] = useLocalStorage('munni_period_day', 20);
  const [periodType, setPeriodType] = useLocalStorage('munni_period_type', 'monthly');
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  const ordinalStr = (d) => {
    if (d === 1 || d === 21) return \`\${d}st\`;
    if (d === 2 || d === 22) return \`\${d}nd\`;
    if (d === 3 || d === 23) return \`\${d}rd\`;
    return \`\${d}th\`;
  };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.periods')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ padding:'12px 16px', borderRadius:12, background:M.sageSoft, marginBottom:18, fontSize:13, color:M.sage, lineHeight:1.6 }}>
          <strong>What is a period?</strong> munni organises your finances in periods. A period starts on your chosen day — ideally when your salary arrives — so income and expenses always line up.
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Period type</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:20 }}>
          {[['monthly','Monthly'],['biweekly','Bi-weekly'],['weekly','Weekly']].map(([type,label]) => (
            <button key={type} className="m-tap" onClick={() => setPeriodType(type)} style={{
              height:48, borderRadius:12, border:\`1.5px solid \${periodType===type?M.sage:M.line}\`,
              background:periodType===type?M.sage:M.card, color:periodType===type?'#fff':M.ink,
              fontSize:13, fontWeight:periodType===type?700:400, cursor:'pointer', fontFamily:M.fontUI,
            }}>{label}</button>
          ))}
        </div>

        {periodType === 'monthly' ? (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Start day of month</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:8, marginBottom:20 }}>
              {days.map(d => (
                <button key={d} className="m-tap" onClick={() => setSelectedDay(d)} style={{
                  height:44, borderRadius:12, border:\`1.5px solid \${selectedDay === d ? M.sage : M.line}\`,
                  background: selectedDay === d ? M.sage : M.card,
                  color: selectedDay === d ? '#fff' : M.ink,
                  fontSize:14, fontWeight: selectedDay === d ? 700 : 400,
                  cursor:'pointer', fontFamily:M.fontUI,
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>{d}</button>
              ))}
            </div>
            <div className="m-card" style={{ padding:14, marginBottom:16, border:\`1px solid \${M.line}\` }}>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Current period</div>
              <div style={{ fontSize:13, color:M.ink3 }}>
                Starts on the <strong>{ordinalStr(selectedDay)}</strong> of each month.
              </div>
              <div style={{ fontSize:12, color:M.sage, marginTop:6, fontWeight:500 }}>
                {(() => { const ph = computePeriodHistory(selectedDay); const cur = ph[ph.length-1]; return cur ? cur.label : ''; })()}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Start day of week</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:6, marginBottom:20 }}>
              {DAY_NAMES.map((day, idx) => (
                <button key={idx} className="m-tap" onClick={() => setSelectedDay(idx)} style={{
                  height:44, borderRadius:12, border:\`1.5px solid \${selectedDay===idx?M.sage:M.line}\`,
                  background:selectedDay===idx?M.sage:M.card, color:selectedDay===idx?'#fff':M.ink,
                  fontSize:11, fontWeight:selectedDay===idx?700:400, cursor:'pointer', fontFamily:M.fontUI,
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>{day.slice(0,3)}</button>
              ))}
            </div>
            <div className="m-card" style={{ padding:14, marginBottom:16, border:\`1px solid \${M.line}\` }}>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Current period</div>
              <div style={{ fontSize:13, color:M.ink3 }}>
                {periodType === 'weekly' ? 'Weekly' : 'Every 2 weeks'}, starting on <strong>{DAY_NAMES[selectedDay] || 'Monday'}</strong>.
              </div>
            </div>
          </>
        )}

        <div style={{ padding:'10px 14px', borderRadius:10, background:M.ochreSoft, marginBottom:20, fontSize:12, color:M.ochre, lineHeight:1.5 }}>
          <strong>Tip:</strong> Monthly periods work best when your salary arrives on a fixed day.
        </div>

        <button className="m-btn sage m-tap" style={{ width:'100%' }} onClick={() => nav.pop()}>
          {t('action.save')}
        </button>
      </div>
    </div>
  );
}`,
  'ScreenPeriods weekly/biweekly/monthly redesign'
);

// ═══════════════════════════════════════════════════════════════════
// 26. ScreenNotifications — redesign error log
// ═══════════════════════════════════════════════════════════════════
// Find the error log section in ScreenNotifications and replace it
const LOG_ENTRIES = `[
            { level:'error', msg:'localStorage key munni_topics_p_demo parse error: Unexpected token', ts:'Today 09:18', src:'useLocalStorage:14' },
            { level:'warn', msg:'CategoryPicker: unknown catId "custom_xyz" in profile p_demo', ts:'Today 11:42', src:'CategoryPicker:87' },
            { level:'warn', msg:'TxCtx: transaction t_sync_1747 has no matching account — skipped', ts:'Yesterday 18:30', src:'TxCtx:52' },
            { level:'info', msg:'PeriodCtx: period_day changed 1→18, rebuilding period history', ts:'Yesterday 15:02', src:'PeriodCtx:34' },
            { level:'info', msg:'AllocProvider: loaded 3 topics for profile p1', ts:'Yesterday 14:55', src:'AllocProvider:21' },
          ]`;

// Find and replace the entire error log section
c = c.replace(
  /(\s*\/\* Error log section \*\/[\s\S]*?<\/div>\s*\n\s*\);\s*\n\s*\})\s*\n\s*return/,
  (m) => m
);

// Let's search more carefully for the log section
const LOG_START = `        {/* Error log */}`;
const LOG_END_MARKER = `      </div>\n    </div>\n  );\n}`;

// Find the error log section by searching for specific text
const notifErrStart = c.indexOf(`        {/* Error log */}`);
if (notifErrStart === -1) {
  console.warn('⚠ Error log section NOT FOUND — will try alternate search');
  // Try to find by log content
  const altStart = c.indexOf(`level:'warn', msg:'CategoryPicker`);
  if (altStart !== -1) {
    console.log('Found log content at', altStart);
  }
} else {
  console.log('✓ Found error log at', notifErrStart);
}

// Find the closing of the error log card using a known trailing pattern
// Instead, let's replace the whole notifications return content
// We need to find the div that contains all the log entries

// Simple approach: replace the error log card
c = c.replace(
  /\s*\{\/\* Error log \*\/\}\s*<div className="m-card"[\s\S]*?<\/div>\s*\n\s*\}\s*\n\s*<\/div>\s*\n\s*<\/div>\s*\n\s*\);\s*\n\}\s*\n\nfunction SettingToggle/,
  (match) => {
    // Replace with new log design
    return `\n\n        {/* Error log — Show Logs button */}
        <LogPanel/>
      </div>
    </div>
  );
}

function LogPanel() {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState('all');
  const [readIds, setReadIds] = useLocalStorage('munni_log_read', []);

  const LOGS = [
    { id:'l1', level:'error', msg:'localStorage key munni_topics_p_demo parse error: Unexpected token', ts:'Today 09:18', src:'useLocalStorage:14' },
    { id:'l2', level:'warn',  msg:'CategoryPicker: unknown catId "custom_xyz" in profile p_demo',         ts:'Today 11:42', src:'CategoryPicker:87' },
    { id:'l3', level:'warn',  msg:'TxCtx: transaction t_sync_1747 has no matching account — skipped',    ts:'Yesterday 18:30', src:'TxCtx:52' },
    { id:'l4', level:'info',  msg:'PeriodCtx: period_day changed 1→18, rebuilding period history',        ts:'Yesterday 15:02', src:'PeriodCtx:34' },
    { id:'l5', level:'info',  msg:'AllocProvider: loaded 3 topics for profile p1',                        ts:'Yesterday 14:55', src:'AllocProvider:21' },
  ];

  const errCount = LOGS.filter(l => l.level==='error' && !readIds.includes(l.id)).length;
  const warnCount = LOGS.filter(l => l.level==='warn' && !readIds.includes(l.id)).length;

  const handleOpen = () => {
    setOpen(true);
    setReadIds(LOGS.map(l => l.id));
  };

  const filtered = filter === 'all' ? LOGS : LOGS.filter(l => l.level === filter);
  const levelColor = { error: M.clay, warn: M.ochre, info: M.ink3 };
  const levelBg = { error: M.claySoft, warn: M.ochreSoft, info: M.paper2 };

  return (
    <div>
      <button className="m-tap" onClick={handleOpen} style={{
        width:'100%', padding:'12px 16px', borderRadius:14, border:\`1px solid \${M.line}\`,
        background:M.card, display:'flex', alignItems:'center', gap:10, cursor:'pointer',
        fontFamily:M.fontUI, textAlign:'left',
      }}>
        <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <I name="alert" size={16} color={errCount>0?M.clay:M.ink3}/>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:600, color:M.ink }}>Developer logs</div>
          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{LOGS.length} entries</div>
        </div>
        {(errCount > 0 || warnCount > 0) && (
          <div style={{ display:'flex', gap:4 }}>
            {errCount > 0 && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.claySoft, color:M.clay }}>{errCount} error{errCount>1?'s':''}</span>}
            {warnCount > 0 && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.ochreSoft, color:M.ochre }}>{warnCount} warn</span>}
          </div>
        )}
        <I name="caretR" size={14} color={M.ink4}/>
      </button>

      {open && (
        <Sheet onClose={() => setOpen(false)} title="Developer logs">
          <div style={{ marginBottom:12 }}>
            <div style={{ display:'flex', gap:6 }}>
              {[['all','All'],['error','Errors'],['warn','Warnings'],['info','Info']].map(([key,lbl]) => (
                <button key={key} className="m-tap" onClick={() => setFilter(key)} style={{
                  flex:1, padding:'6px 0', borderRadius:8, fontSize:11, fontWeight:600,
                  border:\`1px solid \${filter===key?M.sage:M.line}\`,
                  background:filter===key?M.sageSoft:'transparent', color:filter===key?M.sage:M.ink3,
                  cursor:'pointer', fontFamily:M.fontUI,
                }}>{lbl}</button>
              ))}
            </div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {filtered.map(log => (
              <div key={log.id} style={{ padding:'10px 12px', borderRadius:10, background:levelBg[log.level], border:\`1px solid \${levelColor[log.level]}22\` }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                  <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:levelColor[log.level], color:'#fff', textTransform:'uppercase' }}>{log.level}</span>
                  <span style={{ fontSize:10, color:M.ink4, flex:1 }}>{log.src}</span>
                  <span style={{ fontSize:10, color:M.ink4 }}>{log.ts}</span>
                </div>
                <div style={{ fontSize:12, color:M.ink2, fontFamily:M.fontMono, lineHeight:1.45, wordBreak:'break-word' }}>{log.msg}</div>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function SettingToggle`;
  }
);
console.log('✓ Notifications log redesign');

// ═══════════════════════════════════════════════════════════════════
// 27. ScreenLoginGate — complete redesign
// ═══════════════════════════════════════════════════════════════════
// Replace the entire ScreenLoginGate function
const OLD_LOGIN_GATE_START = `function ScreenLoginGate({ onLogin }) {
  const [mode, setMode] = React.useState('login'); // 'login' | 'signup' | 'signup-bank' | 'signup-demo' | 'language'`;
const OLD_LOGIN_GATE_END = `  return (
    <div className="m-screen">
      <StatusBar/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '28px 24px 32px' }}>
        <div style={{ marginBottom: 36 }}>
          <div className="m-logo" style={{ fontSize: 28, marginBottom: 14 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom: 6 }}>{t('login.welcome')}</div>
          <div style={{ fontSize: 14, color: M.ink3 }}>{t('login.subtitle')}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={onLogin}>
            <I name="g" size={20}/> {t('login.google')}
          </button>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }} onClick={onLogin}>
            <I name="apple" size={20}/> {t('login.apple')}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0' }}>
            <div style={{ flex: 1, height: 1, background: M.line2 }}/><div style={{ fontSize: 12, color: M.ink4 }}>{t('login.or')}</div><div style={{ flex: 1, height: 1, background: M.line2 }}/>
          </div>
          <div className="m-input empty" style={{ fontSize: 15 }}>{t('login.email')}</div>
          <button className="m-btn m-tap" style={{ height: 52 }} onClick={onLogin}>{t('login.continue')}</button>
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: M.ink4, marginBottom: 10 }}>{t('login.noAccount')}</div>
          <button className="m-tap" onClick={() => setMode('signup')} style={{ background: 'transparent', border: 'none', fontSize: 13, fontWeight: 600, color: M.sage, cursor: 'pointer', fontFamily: M.fontUI }}>
            {t('login.createAccount')}
          </button>
        </div>
        <button className="m-tap" onClick={onLogin} style={{ background: 'transparent', border: 'none', fontSize: 12, color: M.ink4, cursor: 'pointer', marginTop: 20, fontFamily: M.fontUI, textAlign: 'center' }}>
          {t('login.demoUser')}
        </button>
        <div style={{ fontSize: 11, color: M.ink4, textAlign: 'center', marginTop: 14, lineHeight: 1.5 }}>
          {t('login.terms')}
        </div>
        <div style={{ textAlign:'center', marginTop:20 }}>
          <button className="m-tap" onClick={() => setMode('language')}
            style={{ background:'transparent', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, textDecoration:'underline' }}>
            🌐 {t('login.changeLanguage')}
          </button>
        </div>
      </div>
    </div>
  );
}`;

// We'll replace the full ScreenLoginGate with a new comprehensive version
// First find the exact boundaries
const gateIdx = c.indexOf('function ScreenLoginGate({ onLogin }) {');
const appIdx = c.indexOf('\nfunction App() {');
if (gateIdx === -1 || appIdx === -1) {
  console.warn('⚠ Could not find ScreenLoginGate or App function boundaries');
} else {
  const beforeGate = c.slice(0, gateIdx);
  const afterApp = c.slice(appIdx);

  const NEW_GATE = `function ScreenTerms({ onBack, showPrivacy = false }) {
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
}

function ScreenLoginGate({ onLogin }) {
  // mode: 'login'|'email-input'|'email-verify'|'google-loading'|'apple-loading'
  //       'signup'|'signup-google'|'signup-apple'|'signup-email'|'signup-email-verify'
  //       'signup-bank'|'terms'|'privacy'|'language'
  const [mode, setMode] = React.useState('login');
  const { t } = useLang();
  const [emailInput, setEmailInput] = React.useState('custom@munni.app');
  const [signupEmailInput, setSignupEmailInput] = React.useState('');
  const [signupName, setSignupName] = React.useState('');
  const [verifyDigits, setVerifyDigits] = React.useState(['','','','','','']);
  const [autoFilling, setAutoFilling] = React.useState(false);
  const [loadingMethod, setLoadingMethod] = React.useState(null);
  const [loginError, setLoginError] = React.useState(null);
  const [signupError, setSignupError] = React.useState(null);

  const hasOpenedBefore = localStorage.getItem('munni_opened_before') === 'true';
  const getSignupMethods = () => { try { return JSON.parse(localStorage.getItem('munni_signup_methods') || '[]'); } catch { return []; } };
  const getSignupEmails = () => { try { return JSON.parse(localStorage.getItem('munni_signup_emails') || '[]'); } catch { return []; } };

  const doLogin = (method, email, displayName, activateDemo = false) => {
    const methods = [...new Set([...getSignupMethods(), method])];
    localStorage.setItem('munni_signup_methods', JSON.stringify(methods));
    localStorage.setItem('munni_opened_before', 'true');
    if (email) localStorage.setItem('munni_profile_email', email);
    if (displayName) localStorage.setItem('munni_profile_name', displayName);
    if (activateDemo) {
      const profiles = JSON.parse(localStorage.getItem('munni_profiles') || JSON.stringify(DEFAULT_PROFILES));
      const updated = profiles.map(p => ({ ...p, active: p.id === 'p_demo' }));
      localStorage.setItem('munni_profiles', JSON.stringify(updated));
    }
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
        if (methods.includes('google')) { setSignupError('A Google account is already registered. Sign in instead.'); return; }
        doLogin('google', 'google@munni.app', 'Google User');
      } else {
        if (!methods.includes('google')) { setLoginError('No account found for this Google account. Continue to sign up?'); return; }
        doLogin('google', 'google@munni.app', 'Google User');
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
        if (methods.includes('apple')) { setSignupError('An Apple account is already registered. Sign in instead.'); return; }
        doLogin('apple', 'apple@munni.app', 'Apple User');
      } else {
        if (!methods.includes('apple')) { setLoginError('No account found for this Apple ID. Continue to sign up?'); return; }
        doLogin('apple', 'apple@munni.app', 'Apple User');
      }
    }, 1400);
  };

  // Email continue → go to verify
  const handleEmailContinue = () => {
    setLoginError(null);
    const methods = getSignupMethods();
    const emails = getSignupEmails();
    if (!methods.includes('email') || !emails.includes(emailInput.toLowerCase().trim())) {
      setLoginError('No account found for this email. Did you mean to create an account?');
      return;
    }
    setMode('email-verify');
    setVerifyDigits(['','','','','','']);
    setAutoFilling(false);
    setTimeout(() => {
      setAutoFilling(true);
      const code = '4', digits = ['4','2','7','1','8','3'];
      let i = 0;
      const fill = () => {
        if (i >= 6) {
          setVerifyDigits([...digits]);
          setTimeout(() => doLogin('email', emailInput.trim().toLowerCase(), null), 800);
          return;
        }
        setVerifyDigits(prev => { const n=[...prev]; n[i]=digits[i]; return n; });
        i++; setTimeout(fill, 250);
      };
      setTimeout(fill, 1200);
    }, 200);
  };

  // Signup email
  const handleSignupEmail = () => {
    setSignupError(null);
    const email = signupEmailInput.trim().toLowerCase();
    if (!email.includes('@')) { setSignupError('Please enter a valid email address.'); return; }
    const emails = getSignupEmails();
    if (emails.includes(email)) { setSignupError('This email is already registered. Sign in instead.'); return; }
    setMode('signup-email-verify');
    setVerifyDigits(['','','','','','']);
    setAutoFilling(false);
    setTimeout(() => {
      setAutoFilling(true);
      const digits = ['7','3','9','2','5','1'];
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
        i++; setTimeout(fill, 250);
      };
      setTimeout(fill, 1200);
    }, 200);
  };

  if (mode === 'language') return <ScreenLanguagePicker fromOnboarding={true} onBack={() => setMode('login')}/>;
  if (mode === 'terms') return <ScreenTerms onBack={() => setMode('login')} showPrivacy={false}/>;
  if (mode === 'privacy') return <ScreenTerms onBack={() => setMode('login')} showPrivacy={true}/>;

  const Divr = () => (
    <div style={{ display:'flex', alignItems:'center', gap:12, margin:'4px 0' }}>
      <div style={{ flex:1, height:1, background:M.line2 }}/><div style={{ fontSize:12, color:M.ink4 }}>or</div><div style={{ flex:1, height:1, background:M.line2 }}/>
    </div>
  );

  // Loading overlay
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
  }

  // Email verification
  if (mode === 'email-verify' || mode === 'signup-email-verify') {
    const emailForDisplay = mode === 'email-verify' ? emailInput : signupEmailInput;
    return (
      <div className="m-screen">
        <StatusBar/>
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <button className="m-tap" onClick={() => setMode(mode === 'email-verify' ? 'email-input' : 'signup-email')} style={{ background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:M.ink3, fontFamily:M.fontUI, fontSize:13 }}>
            <I name="arrowL" size={16} color={M.ink3}/> Back
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>Check your email</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:28, lineHeight:1.5 }}>
            We sent a 6-digit code to <strong>{emailForDisplay}</strong>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'center', marginBottom:24 }}>
            {verifyDigits.map((d, i) => (
              <div key={i} style={{ width:44, height:52, borderRadius:12, border:\`2px solid \${d ? M.sage : M.line}\`, background:d ? M.sageSoft : M.paper2, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, fontWeight:700, fontFamily:M.fontMono, color:M.ink, transition:'all 0.15s ease' }}>
                {d || ''}
              </div>
            ))}
          </div>
          {autoFilling && <div style={{ textAlign:'center', fontSize:12, color:M.sage }}>Auto-filling code…</div>}
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
            <I name="arrowL" size={16} color={M.ink3}/> Back
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:22, marginBottom:20 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:6 }}>Sign in</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>Enter your email address</div>
          <input
            value={emailInput} onChange={e => { setEmailInput(e.target.value); setLoginError(null); }}
            type="email" placeholder="your@email.com"
            style={{ width:'100%', boxSizing:'border-box', padding:'14px 16px', borderRadius:12, border:\`1.5px solid \${loginError?M.clay:M.line}\`, fontSize:15, fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:loginError?8:16, color:M.ink }}
          />
          {loginError && <div style={{ fontSize:12, color:M.clay, marginBottom:12, lineHeight:1.4 }}>{loginError} <button onClick={() => { setLoginError(null); setMode('signup-email'); }} style={{ background:'none', border:'none', color:M.sage, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, fontSize:12 }}>Create account →</button></div>}
          <button className="m-btn sage m-tap" style={{ height:52, width:'100%' }} onClick={handleEmailContinue}>Continue</button>
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
            <I name="arrowL" size={16} color={M.ink3}/> Sign in
          </button>
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', padding:'24px 24px 32px', overflowY:'auto' }}>
          <div className="m-logo" style={{ fontSize:24, marginBottom:16 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom:4 }}>Create account</div>
          <div style={{ fontSize:13, color:M.ink3, marginBottom:24 }}>Choose how to sign up</div>
          {signupError && <div style={{ padding:'10px 14px', borderRadius:10, background:M.claySoft, marginBottom:14, fontSize:13, color:M.clay, lineHeight:1.4 }}>{signupError}</div>}
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleGoogle(true)}>
              <I name="g" size={20}/> Continue with Google
            </button>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:12 }} onClick={() => handleApple(true)}>
              <I name="apple" size={20}/> Continue with Apple
            </button>
            <Divr/>
            <button className="m-btn outline m-tap" style={{ height:52, justifyContent:'flex-start', paddingLeft:20, gap:10 }} onClick={() => { setSignupEmailInput(''); setSignupError(null); setMode('signup-email'); }}>
              <I name="edit" size={18}/> Sign up with email
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
            <div key={bank} className="m-tap" onClick={() => doLogin('bank', 'bank@munni.app', 'Bank User')} style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 0', borderBottom:\`1px solid \${M.line2}\` }}>
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
            {hasOpenedBefore ? 'Welcome back' : t('login.welcome')}
          </div>
          <div style={{ fontSize: 14, color: M.ink3 }}>{t('login.subtitle')}</div>
        </div>

        {loginError && (
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
        </div>

        <div style={{ flex: 1, minHeight: 20 }}/>

        <div style={{ textAlign: 'center', marginBottom:10 }}>
          <div style={{ fontSize: 12, color: M.ink4, marginBottom: 8 }}>{t('login.noAccount')}</div>
          <button className="m-tap" onClick={() => { setLoginError(null); setMode('signup'); }}
            style={{ background: 'transparent', border: 'none', fontSize: 13, fontWeight: 600, color: M.sage, cursor: 'pointer', fontFamily: M.fontUI }}>
            {t('login.createAccount')}
          </button>
        </div>

        <button className="m-tap" onClick={() => {
          localStorage.setItem('munni_opened_before', 'true');
          const profiles = JSON.parse(localStorage.getItem('munni_profiles') || JSON.stringify(DEFAULT_PROFILES));
          const updated = profiles.map(p => ({ ...p, active: p.id === 'p_demo' }));
          localStorage.setItem('munni_profiles', JSON.stringify(updated));
          localStorage.setItem('munni_profile_email', 'demo@munni.app');
          localStorage.setItem('munni_profile_name', 'Demo van der Berg');
          onLogin();
        }}
          style={{ background: 'transparent', border: 'none', fontSize: 12, color: M.ink4, cursor: 'pointer', marginTop: 8, fontFamily: M.fontUI, textAlign: 'center' }}>
          {t('login.demoUser')}
        </button>

        <div style={{ fontSize: 11, color: M.ink4, textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
          By continuing you agree to our{' '}
          <button onClick={() => setMode('terms')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>Terms of Service</button>
          {' '}and{' '}
          <button onClick={() => setMode('privacy')} style={{ background:'none', border:'none', color:M.sage, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, fontSize:11, textDecoration:'underline' }}>Privacy Policy</button>
        </div>
        <div style={{ textAlign:'center', marginTop:14 }}>
          <button className="m-tap" onClick={() => setMode('language')}
            style={{ background:'transparent', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, textDecoration:'underline' }}>
            🌐 {t('login.changeLanguage')}
          </button>
        </div>
      </div>
    </div>
  );
}`;

  c = beforeGate + NEW_GATE + afterApp;
  console.log('✓ ScreenLoginGate complete redesign');
}

// ═══════════════════════════════════════════════════════════════════
// 28. App — add logout context + fix ScreenLogin sign out
// ═══════════════════════════════════════════════════════════════════
rep(
  `function App() {
  const [dark, setDark] = useLocalStorage('munni_dark', false);
  const [loggedIn, setLoggedIn] = React.useState(false);`,
  `const AppCtx = React.createContext({ logout: () => {} });
const useAppCtx = () => React.useContext(AppCtx);

function App() {
  const [dark, setDark] = useLocalStorage('munni_dark', false);
  const [loggedIn, setLoggedIn] = React.useState(false);`,
  'App logout context'
);

// Wrap app content with AppCtx
rep(
  `    <div className="m m-app" style={{ width:'100%', height:'100%', background: M.paper, filter: dark ? 'invert(0.93) hue-rotate(180deg)' : 'none', transition:'filter 0.3s' }}>`,
  `    <AppCtx.Provider value={{ logout: () => setLoggedIn(false) }}>
    <div className="m m-app" style={{ width:'100%', height:'100%', background: M.paper, filter: dark ? 'invert(0.93) hue-rotate(180deg)' : 'none', transition:'filter 0.3s' }}>`,
  'Wrap app with AppCtx'
);

// Close AppCtx
rep(
  `      </div>
  );
}

const rootEl`,
  `      </div>
    </AppCtx.Provider>
  );
}

const rootEl`,
  'Close AppCtx'
);

// ═══════════════════════════════════════════════════════════════════
// 29. ScreenProfile sign out — use AppCtx
// ═══════════════════════════════════════════════════════════════════
rep(
  `          <ProfileLink icon="logout"  label={t('settings.signOut')}        danger onClick={() => nav.push('login')}/>`,
  `          <ProfileLink icon="logout"  label={t('settings.signOut')}        danger onClick={() => { const { logout } = useAppCtx(); logout(); }}/>`,
  'Sign out via AppCtx'
);

// Actually that won't work (can't call hook in callback). Let us use a proper pattern
// Find and fix it differently
rep(
  `          <ProfileLink icon="logout"  label={t('settings.signOut')}        danger onClick={() => { const { logout } = useAppCtx(); logout(); }}/>`,
  `          <ProfileLink icon="logout"  label={t('settings.signOut')}        danger onClick={logoutFn}/>`,
  'Sign out via logoutFn'
);

// Add logoutFn to ScreenProfile
rep(
  `  const startEdit = () => { setDraft({ name }); setEditing(true); };`,
  `  const { logout: logoutFn } = useAppCtx();
  const startEdit = () => { setDraft({ name }); setEditing(true); };`,
  'Add logoutFn to ScreenProfile'
);

// ═══════════════════════════════════════════════════════════════════
// 30. ScreenLogin (in-app version) — make consistent with gate
// ═══════════════════════════════════════════════════════════════════
rep(
  `function ScreenLogin() {
  const nav = useNav();
  const { t } = useLang();
  return (
    <div className="m-screen">
      <StatusBar/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '28px 24px 32px' }}>
        <div style={{ marginBottom: 36 }}>
          <div className="m-logo" style={{ fontSize: 28, marginBottom: 14 }}>munni<span className="dot">.</span></div>
          <div className="m-h2" style={{ marginBottom: 6 }}>{t('login.welcome')}</div>
          <div style={{ fontSize: 14, color: M.ink3 }}>{t('login.subtitle')}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }}>
            <I name="g" size={20}/> {t('login.google')}
          </button>
          <button className="m-btn outline m-tap" style={{ height: 52, justifyContent: 'flex-start', paddingLeft: 20, gap: 12 }}>
            <I name="apple" size={20}/> {t('login.apple')}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0' }}>
            <div style={{ flex: 1, height: 1, background: M.line2 }}/>
            <div style={{ fontSize: 12, color: M.ink4 }}>{t('login.or')}</div>
            <div style={{ flex: 1, height: 1, background: M.line2 }}/>
          </div>
          <div className="m-input empty" style={{ fontSize: 15 }}>{t('login.email')}</div>
          <button className="m-btn m-tap" style={{ height: 52 }}>{t('login.continue')}</button>
        </div>

        <div style={{ flex: 1 }}/>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: M.ink4, marginBottom: 10 }}>{t('login.noAccount')}</div>
          <button className="m-tap" onClick={() => nav.push('signupGate')}
            style={{ background: 'transparent', border: 'none', fontSize: 13, fontWeight: 600, color: M.sage, cursor: 'pointer', fontFamily: M.fontUI }}>
            {t('login.createAccount')}
          </button>
        </div>

        <button className="m-tap" onClick={() => nav.pop()}
          style={{ background: 'transparent', border: 'none', fontSize: 12, color: M.ink4, cursor: 'pointer', marginTop: 20, fontFamily: M.fontUI, textAlign: 'center' }}>
          {t('login.demoUser')}
        </button>

        <div style={{ fontSize: 11, color: M.ink4, textAlign: 'center', marginTop: 14, lineHeight: 1.5 }}>
          {t('login.terms')}
        </div>
        <div style={{ textAlign:'center', marginTop:16 }}>
          <button className="m-tap" onClick={() => nav.push('language')}
            style={{ background:'transparent', border:'none', fontSize:13, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, textDecoration:'underline' }}>
            🌐 {t('login.changeLanguage')}
          </button>
        </div>
      </div>
    </div>
  );
}`,
  `function ScreenLogin() {
  const { logout: logoutFn } = useAppCtx();
  React.useEffect(() => { logoutFn(); }, []);
  return null;
}`,
  'ScreenLogin → trigger real logout'
);

// ═══════════════════════════════════════════════════════════════════
// Write result
// ═══════════════════════════════════════════════════════════════════
const changed = c !== orig;
if (!changed) {
  console.error('\n❌ No changes were made! The file is identical to the original.');
  process.exit(1);
}

fs.writeFileSync('munni.html', c.replace(/\n/g, '\r\n'), 'utf8');
const lines = c.split('\n').length;
console.log(`\n✅ Done — ${lines} lines, ${c.length} chars`);
