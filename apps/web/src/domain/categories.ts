// GENERATED from apps/legacy/src/shared/data/categories.js by scripts/port-demo-data.mjs.
// Built-ins are a static catalog, not synced rows; only custom categories live in the database.
import type { TxType } from '@/db/types';

export type CatDirection = 'credit' | 'debit' | 'both';

export interface BuiltinCategory {
  id: string;
  parentId?: string;
  nameKey: string;
  icon: string;
  color?: string;
  isParent?: boolean;
  hidden?: boolean;
  positive?: boolean;
  /** the main's catch-all where its id does not say so (`<main>Other`): it closes the list */
  isOther?: boolean;
  txTypes: TxType[];
  direction: CatDirection;
}

export const BUILTIN_CATEGORIES: BuiltinCategory[] = [
  // gray by design (#353): without a color here each call site invented its own fallback for uncategorized
  {"id":"general","nameKey":"cat.general","icon":"help-circle-outline","color":"#8A94A6","isParent":true,"hidden":true,"txTypes":["expense","income","saving","transfer","investment","debtPayment","adjustment"],"direction":"both"},
  {"id":"uncategorized","parentId":"general","nameKey":"cat.uncategorized","icon":"help-circle-outline","color":"#8A94A6","hidden":true,"txTypes":["expense","income","saving","transfer","investment","debtPayment","adjustment"],"direction":"both"},
  // locked system main: no user subs, no edits. `reimburse` keeps its historical id (old rows resolve) but reads as received;
  // `expenseReimburse` is the expected side; `reimbursed` holds the settled value on both sides of a link
  {"id":"reimbursement","nameKey":"cat.reimbursement","icon":"cash-refund","color":"#16A085","isParent":true,"txTypes":["expense","income"],"direction":"both"},
  {"id":"reimbursed","parentId":"reimbursement","nameKey":"cat.reimbursed","icon":"check-decagram-outline","txTypes":["expense","income"],"direction":"both"},
  {"id":"reimburse","parentId":"reimbursement","nameKey":"cat.reimburse","icon":"cash-refund","positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"income","nameKey":"cat.income","icon":"cash-plus","color":"#27AE60","isParent":true,"positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"salary","parentId":"income","nameKey":"cat.salary","icon":"office-building-outline","positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"freelance","parentId":"income","nameKey":"cat.freelance","icon":"home-city-outline","positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"rental","parentId":"income","nameKey":"cat.rental","icon":"store-clock-outline","positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"investIncome","parentId":"income","nameKey":"cat.investIncome","icon":"chart-timeline-variant","positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"giftReceived","parentId":"income","nameKey":"cat.giftReceived","icon":"gift-open-outline","positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"incomeOther","parentId":"income","nameKey":"cat.incomeOther","icon":"cash-plus","positive":true,"txTypes":["income"],"direction":"credit"},
  {"id":"saving","nameKey":"cat.saving","icon":"piggy-bank-outline","color":"#A8782B","isParent":true,"txTypes":["saving"],"direction":"both"},
  // movement subs live on both legs (stamps put them on the special account's own rows, where signs invert)
  {"id":"savingWithdraw","parentId":"saving","nameKey":"cat.savingWithdraw","icon":"bank-remove","txTypes":["saving"],"direction":"both"},
  {"id":"savingDeposit","parentId":"saving","nameKey":"cat.savingDeposit","icon":"bank-plus","txTypes":["saving"],"direction":"both"},
  // saving-account rows no transfer caused: interest grows the pot (+), fees shrink it (−)
  {"id":"savingInterest","parentId":"saving","nameKey":"cat.savingInterest","icon":"percent-outline","positive":true,"txTypes":["saving"],"direction":"credit"},
  {"id":"savingFees","parentId":"saving","nameKey":"cat.savingFees","icon":"cash-minus","txTypes":["saving"],"direction":"debit"},
  {"id":"expense","nameKey":"cat.expense","icon":"cash-remove","isParent":true,"hidden":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"housing","nameKey":"cat.housing","icon":"home-outline","color":"#E67E22","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"housingRent","parentId":"housing","nameKey":"cat.housingRent","icon":"home-import-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"housingUtility","parentId":"housing","nameKey":"cat.housingUtility","icon":"home-lightning-bolt-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"housingMaintenance","parentId":"housing","nameKey":"cat.housingMaintenance","icon":"wrench-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"housingStorage","parentId":"housing","nameKey":"cat.housingStorage","icon":"warehouse","txTypes":["expense"],"direction":"debit"},
  {"id":"telecom","parentId":"housing","nameKey":"cat.telecom","icon":"router-wireless","txTypes":["expense"],"direction":"debit"},
  {"id":"housingOther","parentId":"housing","nameKey":"cat.housingOther","icon":"home-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"transport","nameKey":"cat.transport","icon":"bus-side","color":"#3498DB","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"transportCar","parentId":"transport","nameKey":"cat.transportCar","icon":"car-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"transportFuel","parentId":"transport","nameKey":"cat.transportFuel","icon":"gas-station-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"transportPublic","parentId":"transport","nameKey":"cat.transportPublic","icon":"train-car","txTypes":["expense"],"direction":"debit"},
  {"id":"parking","parentId":"transport","nameKey":"cat.parking","icon":"parking","txTypes":["expense"],"direction":"debit"},
  {"id":"bikes","parentId":"transport","nameKey":"cat.bikes","icon":"bike","txTypes":["expense"],"direction":"debit"},
  {"id":"transportOther","parentId":"transport","nameKey":"cat.transportOther","icon":"bus-side","txTypes":["expense"],"direction":"debit"},
  // #653: what is bought to take home. `groceries` and `tobacco` keep the ids they had under `consumption`, so every row
  // filed under them still resolves: `groceries` is this main's Other
  {"id":"grocery","nameKey":"cat.grocery","icon":"cart-outline","color":"#7CB342","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"groceryAlcohol","parentId":"grocery","nameKey":"cat.groceryAlcohol","icon":"bottle-wine-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryBread","parentId":"grocery","nameKey":"cat.groceryBread","icon":"baguette","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryBreakfast","parentId":"grocery","nameKey":"cat.groceryBreakfast","icon":"egg-fried","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryCooking","parentId":"grocery","nameKey":"cat.groceryCooking","icon":"shaker-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryCoffee","parentId":"grocery","nameKey":"cat.groceryCoffee","icon":"coffee-maker-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryDairy","parentId":"grocery","nameKey":"cat.groceryDairy","icon":"cheese","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryDrinks","parentId":"grocery","nameKey":"cat.groceryDrinks","icon":"bottle-soda-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryFish","parentId":"grocery","nameKey":"cat.groceryFish","icon":"fish","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryFruit","parentId":"grocery","nameKey":"cat.groceryFruit","icon":"food-apple-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryHousehold","parentId":"grocery","nameKey":"cat.groceryHousehold","icon":"spray-bottle","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryMealKits","parentId":"grocery","nameKey":"cat.groceryMealKits","icon":"package-variant-closed","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryMeat","parentId":"grocery","nameKey":"cat.groceryMeat","icon":"food-steak","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryReadyMeals","parentId":"grocery","nameKey":"cat.groceryReadyMeals","icon":"microwave","txTypes":["expense"],"direction":"debit"},
  {"id":"grocerySnacks","parentId":"grocery","nameKey":"cat.grocerySnacks","icon":"cookie-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryToiletries","parentId":"grocery","nameKey":"cat.groceryToiletries","icon":"lotion-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"tobacco","parentId":"grocery","nameKey":"cat.tobacco","icon":"smoking","txTypes":["expense"],"direction":"debit"},
  {"id":"groceryVegetables","parentId":"grocery","nameKey":"cat.groceryVegetables","icon":"carrot","txTypes":["expense"],"direction":"debit"},
  {"id":"groceries","parentId":"grocery","nameKey":"cat.groceries","icon":"cart-variant","isOther":true,"txTypes":["expense"],"direction":"debit"},
  // #653: eating and drinking out; the id predates the name. `coffee` and `alcohol` are its cafés and bars
  {"id":"consumption","nameKey":"cat.consumption","icon":"food-outline","color":"#27AE60","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"breakfast","parentId":"consumption","nameKey":"cat.breakfast","icon":"bread-slice-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"sweets","parentId":"consumption","nameKey":"cat.sweets","icon":"candy-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"restaurants","parentId":"consumption","nameKey":"cat.restaurants","icon":"room-service-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"takeout","parentId":"consumption","nameKey":"cat.takeout","icon":"food-takeout-box-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"lunchWork","parentId":"consumption","nameKey":"cat.lunchWork","icon":"silverware-fork-knife","txTypes":["expense"],"direction":"debit"},
  {"id":"coffee","parentId":"consumption","nameKey":"cat.coffee","icon":"coffee-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"alcohol","parentId":"consumption","nameKey":"cat.alcohol","icon":"glass-cocktail","txTypes":["expense"],"direction":"debit"},
  {"id":"consumptionOther","parentId":"consumption","nameKey":"cat.consumptionOther","icon":"food-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"personalCare","nameKey":"cat.personalCare","icon":"mirror","color":"#9B59B6","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"haircut","parentId":"personalCare","nameKey":"cat.haircut","icon":"content-cut","txTypes":["expense"],"direction":"debit"},
  {"id":"toiletry","parentId":"personalCare","nameKey":"cat.toiletry","icon":"toothbrush","txTypes":["expense"],"direction":"debit"},
  {"id":"beautyProduct","parentId":"personalCare","nameKey":"cat.beautyProduct","icon":"hair-dryer-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"personalCareOther","parentId":"personalCare","nameKey":"cat.personalCareOther","icon":"mirror","txTypes":["expense"],"direction":"debit"},
  {"id":"entertainment","nameKey":"cat.entertainment","icon":"drama-masks","color":"#E74C3C","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"movie","parentId":"entertainment","nameKey":"cat.movie","icon":"popcorn","txTypes":["expense"],"direction":"debit"},
  {"id":"concerts","parentId":"entertainment","nameKey":"cat.concerts","icon":"curtains","txTypes":["expense"],"direction":"debit"},
  {"id":"sportingEvent","parentId":"entertainment","nameKey":"cat.sportingEvent","icon":"soccer-field","txTypes":["expense"],"direction":"debit"},
  {"id":"gambling","parentId":"entertainment","nameKey":"cat.gambling","icon":"dice-multiple-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"hobby","parentId":"entertainment","nameKey":"cat.hobby","icon":"checkerboard","txTypes":["expense"],"direction":"debit"},
  {"id":"videoGame","parentId":"entertainment","nameKey":"cat.videoGame","icon":"gamepad-square-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"dating","parentId":"entertainment","nameKey":"cat.dating","icon":"heart-multiple-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"subs","parentId":"entertainment","nameKey":"cat.subs","icon":"television-play","txTypes":["expense"],"direction":"debit"},
  {"id":"outdoor","parentId":"entertainment","nameKey":"cat.outdoor","icon":"hiking","txTypes":["expense"],"direction":"debit"},
  {"id":"activities","parentId":"entertainment","nameKey":"cat.activities","icon":"ferris-wheel","txTypes":["expense"],"direction":"debit"},
  {"id":"entertainmentOther","parentId":"entertainment","nameKey":"cat.entertainmentOther","icon":"drama-masks","txTypes":["expense"],"direction":"debit"},
  {"id":"sport","nameKey":"cat.sport","icon":"tennis","color":"#1ABC9C","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"gym","parentId":"sport","nameKey":"cat.gym","icon":"dumbbell","txTypes":["expense"],"direction":"debit"},
  {"id":"sportsEquipment","parentId":"sport","nameKey":"cat.sportsEquipment","icon":"biathlon","txTypes":["expense"],"direction":"debit"},
  {"id":"sportOther","parentId":"sport","nameKey":"cat.sportOther","icon":"tennis","txTypes":["expense"],"direction":"debit"},
  {"id":"shopping","nameKey":"cat.shopping","icon":"shopping-outline","color":"#F39C12","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"clothing","parentId":"shopping","nameKey":"cat.clothing","icon":"tshirt-crew-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"electronics","parentId":"shopping","nameKey":"cat.electronics","icon":"cellphone-link","txTypes":["expense"],"direction":"debit"},
  {"id":"homeGoods","parentId":"shopping","nameKey":"cat.homeGoods","icon":"sofa-single-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"gift","parentId":"shopping","nameKey":"cat.gift","icon":"gift-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"intimateUtility","parentId":"shopping","nameKey":"cat.intimateUtility","icon":"account-heart-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"festivity","parentId":"shopping","nameKey":"cat.festivity","icon":"party-popper","txTypes":["expense"],"direction":"debit"},
  {"id":"houseGarden","parentId":"shopping","nameKey":"cat.houseGarden","icon":"watering-can-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"homeAutomation","parentId":"shopping","nameKey":"cat.homeAutomation","icon":"robot-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"shoppingOther","parentId":"shopping","nameKey":"cat.shoppingOther","icon":"shopping-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"holiday","nameKey":"cat.holiday","icon":"island","color":"#16A085","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"flight","parentId":"holiday","nameKey":"cat.flight","icon":"airplane-takeoff","txTypes":["expense"],"direction":"debit"},
  {"id":"hotel","parentId":"holiday","nameKey":"cat.hotel","icon":"bed-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"carRental","parentId":"holiday","nameKey":"cat.carRental","icon":"car-key","txTypes":["expense"],"direction":"debit"},
  {"id":"activity","parentId":"holiday","nameKey":"cat.activity","icon":"map-marker-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"holidayOther","parentId":"holiday","nameKey":"cat.holidayOther","icon":"island","txTypes":["expense"],"direction":"debit"},
  {"id":"education","nameKey":"cat.education","icon":"school-outline","color":"#2980B9","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"tuition","parentId":"education","nameKey":"cat.tuition","icon":"account-cash-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"course","parentId":"education","nameKey":"cat.course","icon":"human-male-board","txTypes":["expense"],"direction":"debit"},
  {"id":"book","parentId":"education","nameKey":"cat.book","icon":"book-education-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"schoolSupply","parentId":"education","nameKey":"cat.schoolSupply","icon":"notebook-edit-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"certificate","parentId":"education","nameKey":"cat.certificate","icon":"certificate-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"newspaper","parentId":"education","nameKey":"cat.newspaper","icon":"newspaper-variant-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"software","parentId":"education","nameKey":"cat.software","icon":"application-brackets-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"educationOther","parentId":"education","nameKey":"cat.educationOther","icon":"school-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"healthcare","nameKey":"cat.healthcare","icon":"hospital-box-outline","color":"#E91E63","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"doctorVisit","parentId":"healthcare","nameKey":"cat.doctorVisit","icon":"stethoscope","txTypes":["expense"],"direction":"debit"},
  {"id":"dental","parentId":"healthcare","nameKey":"cat.dental","icon":"tooth-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"prescription","parentId":"healthcare","nameKey":"cat.prescription","icon":"pill","txTypes":["expense"],"direction":"debit"},
  {"id":"healthInsurance","parentId":"healthcare","nameKey":"cat.healthInsurance","icon":"shield-check-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"healthUtility","parentId":"healthcare","nameKey":"cat.healthUtility","icon":"face-mask-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"mentalCare","parentId":"healthcare","nameKey":"cat.mentalCare","icon":"meditation","txTypes":["expense"],"direction":"debit"},
  {"id":"healthcareOther","parentId":"healthcare","nameKey":"cat.healthcareOther","icon":"hospital-box-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"pet","nameKey":"cat.pet","icon":"fishbowl-outline","color":"#795548","isParent":true,"txTypes":["expense"],"direction":"debit"},
  {"id":"petFood","parentId":"pet","nameKey":"cat.petFood","icon":"food-drumstick-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"petSupply","parentId":"pet","nameKey":"cat.petSupply","icon":"paw-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"petInsurance","parentId":"pet","nameKey":"cat.petInsurance","icon":"shield-bug-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"petOther","parentId":"pet","nameKey":"cat.petOther","icon":"fishbowl-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"extra","nameKey":"cat.extra","icon":"archive-plus-outline","color":"#607D8B","isParent":true,"txTypes":["expense"],"direction":"debit"},
  // under the locked `reimbursement` main; id unchanged so old rows keep resolving
  {"id":"expenseReimburse","parentId":"reimbursement","nameKey":"cat.expenseReimburse","icon":"cash-refund","txTypes":["expense"],"direction":"debit"},
  {"id":"birthday","parentId":"extra","nameKey":"cat.birthday","icon":"cake-variant-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"funeralInsurance","parentId":"extra","nameKey":"cat.funeralInsurance","icon":"shield-cross-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"charity","parentId":"extra","nameKey":"cat.charity","icon":"handshake-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"taxes","parentId":"extra","nameKey":"cat.taxes","icon":"bank-transfer-in","txTypes":["expense"],"direction":"debit"},
  {"id":"fee","parentId":"extra","nameKey":"cat.fee","icon":"credit-card-check-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"interest","parentId":"extra","nameKey":"cat.interest","icon":"percent-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"workExpense","parentId":"extra","nameKey":"cat.workExpense","icon":"briefcase-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"familyCare","parentId":"extra","nameKey":"cat.familyCare","icon":"account-child-outline","txTypes":["expense"],"direction":"debit"},
  // moved from shopping: child care is rarely a shopping decision
  {"id":"childCare","parentId":"extra","nameKey":"cat.childCare","icon":"baby-face-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"kidsActivities","parentId":"extra","nameKey":"cat.kidsActivities","icon":"human-male-child","txTypes":["expense"],"direction":"debit"},
  {"id":"insurance","parentId":"extra","nameKey":"cat.insurance","icon":"shield-account-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"fines","parentId":"extra","nameKey":"cat.fines","icon":"account-tie-hat-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"secret","parentId":"extra","nameKey":"cat.secret","icon":"incognito","txTypes":["expense"],"direction":"debit"},
  {"id":"extraOther","parentId":"extra","nameKey":"cat.extraOther","icon":"archive-plus-outline","txTypes":["expense"],"direction":"debit"},
  {"id":"transfer","nameKey":"cat.transfer","icon":"bank-transfer","color":"#FF9800","isParent":true,"txTypes":["transfer"],"direction":"both"},
  {"id":"transferOut","parentId":"transfer","nameKey":"cat.transferOut","icon":"bank-transfer-out","txTypes":["transfer"],"direction":"debit"},
  {"id":"transferIn","parentId":"transfer","nameKey":"cat.transferIn","icon":"bank-transfer-in","txTypes":["transfer"],"direction":"credit"},
  {"id":"cashWithdraw","parentId":"transfer","nameKey":"cat.cashWithdraw","icon":"atm","txTypes":["transfer"],"direction":"debit"},
  {"id":"cashDeposit","parentId":"transfer","nameKey":"cat.cashDeposit","icon":"cash-plus","txTypes":["transfer"],"direction":"credit"},
  {"id":"debt","nameKey":"cat.debt","icon":"credit-card-outline","color":"#9C27B0","isParent":true,"txTypes":["debtPayment"],"direction":"both"},
  {"id":"loanRepayment","parentId":"debt","nameKey":"cat.loanRepayment","icon":"bank-outline","txTypes":["debtPayment"],"direction":"both"},
  {"id":"debtBorrowed","parentId":"debt","nameKey":"cat.debtBorrowed","icon":"bank-transfer-in","txTypes":["debtPayment"],"direction":"both"},
  // debt-account rows no transfer caused: the lender's interest and fees both grow the debt (−)
  {"id":"debtInterest","parentId":"debt","nameKey":"cat.debtInterest","icon":"percent-outline","txTypes":["debtPayment"],"direction":"debit"},
  {"id":"debtFees","parentId":"debt","nameKey":"cat.debtFees","icon":"cash-minus","txTypes":["debtPayment"],"direction":"debit"},
  // #252: the movement pair is Invested/Withdrawn (both legs); Bought/Sold/Fees are the brokerage's own ledger
  {"id":"investment","nameKey":"cat.investment","icon":"chart-timeline-variant","color":"#673AB7","isParent":true,"txTypes":["investment"],"direction":"both"},
  {"id":"invest","parentId":"investment","nameKey":"cat.invest","icon":"chart-areaspline","txTypes":["investment"],"direction":"both"},
  {"id":"investBuy","parentId":"investment","nameKey":"cat.investBuy","icon":"trending-up","txTypes":["investment"],"direction":"debit"},
  {"id":"investSell","parentId":"investment","nameKey":"cat.investSell","icon":"trending-down","txTypes":["investment"],"direction":"credit"},
  {"id":"investContribution","parentId":"investment","nameKey":"cat.investContribution","icon":"bank-plus","txTypes":["investment"],"direction":"both"},
  {"id":"investWithdraw","parentId":"investment","nameKey":"cat.investWithdraw","icon":"bank-remove","txTypes":["investment"],"direction":"both"},
  {"id":"investDividend","parentId":"investment","nameKey":"cat.investDividend","icon":"cash-plus","positive":true,"txTypes":["investment"],"direction":"credit"},
  {"id":"investFees","parentId":"investment","nameKey":"cat.investFees","icon":"cash-minus","txTypes":["investment"],"direction":"debit"},
  {"id":"adjustment","nameKey":"cat.adjustment","icon":"tune-variant","color":"#607D8B","isParent":true,"txTypes":["adjustment"],"direction":"both"},
  {"id":"balanceAdjustment","parentId":"adjustment","nameKey":"cat.balanceAdjustment","icon":"scale-balance","txTypes":["adjustment"],"direction":"both"},
  // funding is a marked special category on standard rows; 'funding' stays in txTypes because a row whose counterparty is
  // a funding pot derives that family (#152) and its category must not read as a conflict
  {"id":"funding","nameKey":"cat.funding","icon":"hand-coin","color":"#16A085","isParent":true,"txTypes":["expense","income","funding"],"direction":"both"},
  {"id":"fundingOut","parentId":"funding","nameKey":"cat.fundingOut","icon":"bank-transfer-out","txTypes":["expense","funding"],"direction":"debit"},
  {"id":"fundingIn","parentId":"funding","nameKey":"cat.fundingIn","icon":"bank-transfer-in","txTypes":["income","funding"],"direction":"credit"},
];

export const CATEGORY_BY_ID: ReadonlyMap<string, BuiltinCategory> = new Map(
  BUILTIN_CATEGORIES.map((c) => [c.id, c]),
);

export const childrenOf = (parentId: string): BuiltinCategory[] =>
  BUILTIN_CATEGORIES.filter((c) => c.parentId === parentId);

export const UNCATEGORIZED_ID = 'uncategorized';

// the locked reimbursement tree: pickable, never editable, no sibling additions
export const REIMBURSEMENT_MAIN_ID = 'reimbursement';

/** locked system mains: pickable, never editable, no user subs, absent from budget/trends pickers */
export const LOCKED_MAIN_IDS: ReadonlySet<string> = new Set([
  REIMBURSEMENT_MAIN_ID,
  'saving',
  'transfer',
  'debt',
  'investment',
  'funding',
  // Adjustment is munni's own bookkeeping: balance edits mint its rows (#261)
  'adjustment',
]);

/** the machine-picked sub per transfer-family type: debit = money out */
const FAMILY_AUTO_SUB: Partial<Record<TxType, { debit: string; credit: string }>> = {
  saving: { debit: 'savingDeposit', credit: 'savingWithdraw' },
  transfer: { debit: 'transferOut', credit: 'transferIn' },
  debtPayment: { debit: 'loanRepayment', credit: 'debtBorrowed' },
  // #252: unstamped legs file the movement pair; Bought/Sold are brokerage-internal, never auto-filed
  investment: { debit: 'investContribution', credit: 'investWithdraw' },
  funding: { debit: 'fundingOut', credit: 'fundingIn' },
};

/** the sign-picked locked sub for a transfer-family row; undefined for
 *  standard/adjustment types (they categorize freely) */
export function autoSubFor(txType: TxType, amountCents: number): string | undefined {
  const pair = FAMILY_AUTO_SUB[txType];
  if (!pair) return undefined;
  return amountCents < 0 ? pair.debit : pair.credit;
}

/** a stamped row naming a counterparty is a movement: category forced to the pair, signed from the special account's side */
const STAMP_MOVEMENT_SUB: Partial<Record<TxType, { in: string; out: string }>> = {
  saving: { in: 'savingDeposit', out: 'savingWithdraw' },
  debtPayment: { in: 'loanRepayment', out: 'debtBorrowed' },
  investment: { in: 'investContribution', out: 'investWithdraw' },
};

export function stampMovementSub(stamp: TxType, amountCents: number): string | undefined {
  const pair = STAMP_MOVEMENT_SUB[stamp];
  if (!pair) return undefined;
  return amountCents >= 0 ? pair.in : pair.out;
}

/** movement categories (#133): money physically moved between accounts; only these link in the bare-row fold */
const MOVEMENT_CAT_IDS = new Set([
  'savingDeposit', 'savingWithdraw',
  'loanRepayment', 'debtBorrowed',
  // #252: Bought/Sold are out: stocks bought with money already in the brokerage move nothing between accounts
  'investContribution', 'investWithdraw',
  'transferOut', 'transferIn',
  'cashWithdraw', 'cashDeposit',
  'fundingOut', 'fundingIn',
]);
export const isMovementCat = (catId: string | undefined): boolean => !!catId && MOVEMENT_CAT_IDS.has(catId);
/** special = locked family trees: buckets count them, movements force them, pickers mark them; custom ones never join */
export const isSpecialCategory = (cat: { id: string; parentId?: string }): boolean =>
  LOCKED_MAIN_IDS.has(cat.parentId ?? cat.id);

/** the BUILTIN main a category belongs to (itself when parentless);
 *  undefined for custom categories — they can never be special */
export const mainCatOf = (catId: string | undefined): string | undefined => {
  if (!catId) return undefined;
  const cat = CATEGORY_BY_ID.get(catId);
  return cat ? (cat.parentId ?? cat.id) : undefined;
};

export const INCOME_MAIN_ID = 'income';
/** the Income family, a person's own subs under it included; the placeholder and reimbursements are typed income too and stay out */
export const isIncomeFamily = (cat: { id: string; parentId?: string }): boolean => (cat.parentId ?? cat.id) === INCOME_MAIN_ID;
export const isIncomeBuiltin = (catId: string | undefined): boolean => mainCatOf(catId) === INCOME_MAIN_ID;

// the type a special-category pick pulls onto a standard row; a transfer sub is the manual road into a transfer (#133)
// funding asks WHICH funding account; walking away keeps the bare funding story (#152)
export const specialCatType = (catId: string | undefined): TxType | undefined => {
  switch (mainCatOf(catId)) {
    case 'saving':
      return 'saving';
    case 'debt':
      return 'debtPayment';
    case 'investment':
      return 'investment';
    case 'transfer':
      return 'transfer';
    case 'funding':
      return 'funding';
    default:
      return undefined;
  }
};

/** settled value, both sides of a link */
export const REIMBURSED_ID = 'reimbursed';
/** money you expect back (negative side, pre-settlement) */
export const EXPECTED_REIMBURSE_ID = 'expenseReimburse';
/** money that arrived to settle something (positive side, pre-settlement) */
export const RECEIVED_REIMBURSE_ID = 'reimburse';
