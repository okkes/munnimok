export const DEMO_ACCOUNT_IDS = ['demo_main', 'demo_save'];
// Real accounts for google user
export const REAL_ACCOUNTS = [
  { id: 'main', name: 'Main Â· ING',        iban: 'NL47 INGB 0004 0000 4231', balance: 5240.18, type: 'checking', color: '#ff6200' },
  { id: 'save', name: 'Savings Â· ING',     iban: 'NL47 INGB 0007 7000 7782', balance: 3120.50, type: 'savings',  color: '#A8782B' },
  { id: 'inv',  name: 'Brokerage Â· DEGIRO',iban: 'NL47 DEGR 0001 0000 1015', balance: 365.00,  type: 'invest',  color: '#5E4A78' },
];
// Demo accounts â€” separate IDs, clearly labelled demo, only usable by demo profiles
export const DEMO_ACCOUNTS = [
  { id: 'demo_main', name: 'Demo Checking Â· ING', iban: 'NL00 DEMO 0000 0001 00', balance: 3420.55, type: 'checking', color: '#4A6A4F', isDemo: true },
  { id: 'demo_save', name: 'Demo Savings Â· ING',  iban: 'NL00 DEMO 0000 0002 00', balance: 8150.00, type: 'savings',  color: '#A8782B', isDemo: true },
];
export const APPLE_ACCOUNTS = [
  { id: 'abn_main', name: 'Betaalrekening Â· ABN AMRO', iban: 'NL47 ABNA 0428 7312 8940', balance: 3820.45, type: 'checking', color: '#009B77' },
  { id: 'abn_save', name: 'Spaarrekening Â· ABN AMRO',  iban: 'NL47 ABNA 0561 2849 3012', balance: 12450.00, type: 'savings',  color: '#A8782B' },
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
  { id: 't5',  date: D(2), time: '17:38', merchant: 'NS Â· Sprinter',     desc: 'NS REIZIGERS 2026',          cat: 'transportPublic', amount: -12.20, account: 'main' },
  { id: 't6',  date: D(2), time: '12:50', merchant: 'Apotheek Centraal', desc: 'APOTHEEK 7842',              cat: 'healthcare',  amount: -8.50,  account: 'main', confidence: 71, needsReview: true },
  { id: 't7',  date: D(2), time: '19:20', merchant: 'Friend Â· Tikkie',   desc: 'TIKKIE J. DE VRIES',         cat: 'reimburse',   amount: 9.20,   account: 'main', linkedTo: 't1' },
  { id: 't8',  date: D(3), time: '21:00', merchant: 'Amazon.nl',         desc: 'AMZN MKTPLC 49281',          cat: 'hobby',       amount: -34.99, account: 'main', confidence: 54, needsReview: true },
  { id: 't9',  date: D(3), time: '09:00', merchant: 'Rent Â· Stadgenoot', desc: 'STADGENOOT HUUR FEB',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 't10', date: D(3), time: '08:30', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 't11', date: D(5), time: '20:00', merchant: "L'Osteria",         desc: "L'OSTERIA AMS",              cat: 'restaurants', amount: -32.00, account: 'main' },
  { id: 't12', date: D(6), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -28.40, account: 'main' },
  { id: 't13', date: D(7), time: '10:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 't14', date: D(9), time: '16:00', merchant: 'Etos',              desc: 'ETOS 0341',                  cat: 'healthcare',  amount: -14.20, account: 'main', needsReview: true },
  { id: 't15', date: D(11), time: '20:30', merchant: 'Vapiano',           desc: 'VAPIANO 1234',               cat: 'restaurants', amount: -22.50, account: 'main' },
  { id: 't16', date: D(14), time: '12:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -38.10, account: 'main' },
  { id: 't17', date: D(16), time: '21:30', merchant: 'Five Guys',         desc: 'FIVEGUYS AMS',               cat: 'restaurants', amount: -22.50, account: 'main' },
  { id: 't18', date: D(18), time: '08:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true, needsReview: true },
  { id: 't19', date: D(20), time: '14:00', merchant: 'NS Â· OV Chip',      desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -38.20, account: 'main' },
  { id: 't20', date: D(22), time: '20:00', merchant: 'Sushi Place',       desc: 'SUSHITIME AMS',              cat: 'restaurants', amount: -22.50, account: 'main' },
  { id: 't21', date: D(24), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -56.20, account: 'main' },
  { id: 't22', date: D(26), time: '15:00', merchant: 'Bol.com',           desc: 'BOL.COM 02938',              cat: 'hobby',       amount: -45.00, account: 'main', needsReview: true },
  { id: 't23', date: D(28), time: '09:00', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
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
  // Same-merchant bulk review demo â€” Apotheek Centraal
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
  { id: 'n4',  date: D(95), time: '00:00', merchant: 'Rent Â· Stadgenoot', desc: 'STADGENOOT HUUR NOV',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 'n5',  date: D(96), time: '12:30', merchant: 'Vapiano',           desc: 'VAPIANO 1234',               cat: 'restaurants', amount: -21.50, account: 'main' },
  { id: 'n6',  date: D(97), time: '20:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true },
  { id: 'n7',  date: D(98), time: '08:30', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'n8',  date: D(99), time: '11:00', merchant: 'NS Â· Sprinter',     desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -28.60, account: 'main' },
  { id: 'n9',  date: D(99), time: '21:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 'n10', date: D(101), time: '18:00', merchant: 'Eneco',             desc: 'ENECO ENERGIE',              cat: 'housingUtility', amount: -65.00, account: 'main', recurring: true },
  { id: 'n11', date: D(102), time: '14:20', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -43.20, account: 'main' },
  { id: 'n12', date: D(103), time: '12:00', merchant: 'Five Guys',         desc: 'FIVEGUYS AMS',               cat: 'restaurants', amount: -19.50, account: 'main' },
  { id: 'n13', date: D(104), time: '10:30', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'n14', date: D(106), time: '16:00', merchant: 'Bol.com',           desc: 'BOL.COM 02100',              cat: 'hobby',       amount: -32.99, account: 'main' },
  { id: 'n15', date: D(108), time: '09:00', merchant: 'Kruidvat',          desc: 'KRUIDVAT 0281',              cat: 'healthcare',  amount: -11.50, account: 'main' },
  { id: 'n16', date: D(110), time: '14:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -58.80, account: 'main' },
  // Dec 2025
  { id: 'd1',  date: D(63), time: '08:00', merchant: 'Acme Salary',       desc: 'ACME BV PAYROLL DEC',        cat: 'salary',      amount: 2480.00, account: 'main' },
  { id: 'd2',  date: D(64), time: '19:00', merchant: 'Spotify',           desc: 'SPOTIFY P34520',             cat: 'subs',        amount: -9.99,  account: 'main', recurring: true },
  { id: 'd3',  date: D(65), time: '00:00', merchant: 'Rent Â· Stadgenoot', desc: 'STADGENOOT HUUR DEC',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 'd4',  date: D(66), time: '20:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -67.30, account: 'main' },
  { id: 'd5',  date: D(67), time: '21:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true },
  { id: 'd6',  date: D(69), time: '12:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 'd7',  date: D(69), time: '19:30', merchant: 'Vapiano',           desc: 'VAPIANO XMAS DINNER',        cat: 'restaurants', amount: -45.00, account: 'main' },
  { id: 'd8',  date: D(71), time: '10:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -89.50, account: 'main' },
  { id: 'd9',  date: D(73), time: '16:00', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'd10', date: D(74), time: '20:30', merchant: 'H&M Nederland',     desc: 'HM ONLINE ORDER WINTER',     cat: 'clothing',    amount: -78.50, account: 'main' },
  { id: 'd11', date: D(75), time: '11:30', merchant: 'Eneco',             desc: 'ENECO ENERGIE',              cat: 'housingUtility', amount: -65.00, account: 'main', recurring: true },
  { id: 'd12', date: D(76), time: '14:00', merchant: 'Bol.com',           desc: 'BOL.COM XMAS GIFTS',         cat: 'hobby',       amount: -124.00, account: 'main' },
  { id: 'd13', date: D(77), time: '09:30', merchant: 'NS Â· Sprinter',     desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -19.40, account: 'main' },
  { id: 'd14', date: D(59), time: '19:30', merchant: 'L\'Osteria',        desc: "L'OSTERIA AMS HOLIDAY",      cat: 'restaurants', amount: -58.00, account: 'main' },
  { id: 'd15', date: D(57), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821 XMAS',               cat: 'groceries',   amount: -112.40, account: 'main' },
  { id: 'd16', date: D(55), time: '15:00', merchant: 'MediaMarkt',        desc: 'MEDIAMARKT AMS BOXING DAY',  cat: 'electronics', amount: -199.00, account: 'main' },
  { id: 'd17', date: D(51), time: '21:00', merchant: 'Sushi Place',       desc: 'SUSHITIME NYE',              cat: 'restaurants', amount: -35.50, account: 'main' },
  // Jan 2026
  { id: 'j1',  date: D(32), time: '08:00', merchant: 'Acme Salary',       desc: 'ACME BV PAYROLL JAN',        cat: 'salary',      amount: 2480.00, account: 'main' },
  { id: 'j2',  date: D(33), time: '19:00', merchant: 'Spotify',           desc: 'SPOTIFY P34520',             cat: 'subs',        amount: -9.99,  account: 'main', recurring: true },
  { id: 'j3',  date: D(34), time: '00:00', merchant: 'Rent Â· Stadgenoot', desc: 'STADGENOOT HUUR JAN',        cat: 'housingRent', amount: -740.00,account: 'main', recurring: true },
  { id: 'j4',  date: D(35), time: '20:00', merchant: 'Netflix',           desc: 'NETFLIX SUBSCR',             cat: 'subs',        amount: -13.99, account: 'main', recurring: true },
  { id: 'j5',  date: D(38), time: '09:00', merchant: 'DEGIRO Buy',        desc: 'DEGIRO MTHLY ETF',           cat: 'invest',      amount: -300.00,account: 'main', recurring: true },
  { id: 'j6',  date: D(38), time: '11:30', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -61.20, account: 'main' },
  { id: 'j7',  date: D(39), time: '18:20', merchant: 'Eneco',             desc: 'ENECO ENERGIE',              cat: 'housingUtility', amount: -65.00, account: 'main', recurring: true },
  { id: 'j8',  date: D(40), time: '14:00', merchant: 'NS Â· Sprinter',     desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -22.40, account: 'main' },
  { id: 'j9',  date: D(41), time: '20:00', merchant: 'Vapiano',           desc: 'VAPIANO 1234',               cat: 'restaurants', amount: -28.50, account: 'main' },
  { id: 'j10', date: D(42), time: '09:30', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'j11', date: D(43), time: '19:00', merchant: 'Amazon.nl',         desc: 'AMZN MKTPLC',                cat: 'hobby',       amount: -54.99, account: 'main' },
  { id: 'j12', date: D(45), time: '11:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -44.30, account: 'main' },
  { id: 'j13', date: D(47), time: '16:00', merchant: 'Etos',              desc: 'ETOS 0341',                  cat: 'healthcare',  amount: -18.40, account: 'main' },
  { id: 'j14', date: D(48), time: '14:00', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  // Feb 2026 (first half â€” second half already covered by t1â€“t39, tb1â€“tb2)
  { id: 'f1',  date: D(13), time: '15:00', merchant: 'Koffie â˜•',         desc: 'TOKI ESPRESSO',              cat: 'coffee',      amount: -3.80,  account: 'main' },
  { id: 'f2',  date: D(15), time: '18:30', merchant: 'Sushi Place',       desc: 'SUSHITIME AMS',              cat: 'restaurants', amount: -27.50, account: 'main' },
  { id: 'f3',  date: D(17), time: '09:00', merchant: 'NS Â· OV Chip',      desc: 'NS REIZIGERS',               cat: 'transportPublic', amount: -15.20, account: 'main' },
  { id: 'f4',  date: D(18), time: '14:00', merchant: 'Albert Heijn',      desc: 'AH 5821',                    cat: 'groceries',   amount: -49.80, account: 'main' },
  // Google Playstore for review (must be first two in review stack)
  { id: 'gp1', date: D(9), time: '14:30', merchant: 'Google Playstore',  desc: 'GOOGLE*PLAY 493820',        cat: 'entertainment', cats:[{catId:'entertainment',amount:22.99}], amount: -22.99, account: 'main', confidence: 60, needsReview: true, aiSuggestCat: 'hobby' },
  { id: 'gp2', date: D(36), time: '11:20', merchant: 'Google Playstore',  desc: 'GOOGLE*PLAY 487231',        cat: 'entertainment', cats:[{catId:'entertainment',amount:8.99}],  amount: -8.99,  account: 'main', confidence: 62, needsReview: true, aiSuggestCat: 'hobby' },
  // Saving account transfers â€” ensures Savings row > â‚¬0
  { id: 'sav1', date: D(9), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -150.00, account: 'main', savingAccount: 'save' },
  { id: 'sav2', date: D(25), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -200.00, account: 'main', savingAccount: 'save' },
  { id: 'sav3', date: D(61), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -120.00, account: 'main', savingAccount: 'save' },
  { id: 'sav4', date: D(91), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -150.00, account: 'main', savingAccount: 'save' },
  { id: 'sav5', date: D(122), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -180.00, account: 'main', savingAccount: 'save' },
  { id: 'sav6', date: D(152), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -200.00, account: 'main', savingAccount: 'save' },
  { id: 'sav7', date: D(183), time: '09:15', merchant: 'Savings transfer', desc: 'SPAAROVERBOEKING ING SAVE',  cat: 'savingDeposit', amount: -175.00, account: 'main', savingAccount: 'save' },
];

// Deterministic daily transaction generator â€” 0â€“5 txs/day, avg ~100/month, Aug 2025 â€“ Feb 2026
function genSeedTxs() {
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = ((Math.imul(s, 1664525) + 1013904223) >>> 0); return s / 4294967296; };
  }
  const POOL = [
    { merchant:'Albert Heijn',   desc:'AH 5821 AMS',            cat:'groceries',       min:12, max:85 },
    { merchant:'Jumbo',          desc:'JUMBO 0042',              cat:'groceries',       min:10, max:65 },
    { merchant:'Lidl',           desc:'LIDL AMS CENTRUM',        cat:'groceries',       min:8,  max:50 },
    { merchant:'Koffie â˜•',      desc:'TOKI ESPRESSO',           cat:'coffee',          min:3,  max:6  },
    { merchant:'Koffie â˜•',      desc:'COFFEE CORNER AMS',       cat:'coffee',          min:2,  max:5  },
    { merchant:'NS Â· Sprinter',  desc:'NS REIZIGERS',            cat:'transportPublic', min:4,  max:30 },
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
    { merchant:'PathÃ©',          desc:'PATHE ARENA AMS',         cat:'entertainment',   min:10, max:25 },
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
  { id:'ab3',  date:D(2),  time:'07:50', merchant:'NS Â· Intercity',     desc:'NS REIZIGERS OV JAN',          cat:'transportPublic',amount: -22.40,  account:'abn_main' },
  { id:'ab4',  date:D(2),  time:'19:00', merchant:'Rent Â· Vesteda',     desc:'VESTEDA HUUR FEB',             cat:'housingRent',    amount: -980.00, account:'abn_main', recurring:true },
  { id:'ab5',  date:D(3),  time:'12:30', merchant:'Thuisbezorgd',       desc:'THUISBEZORGD.NL ORDER',        cat:'restaurants',    amount: -31.50,  account:'abn_main' },
  { id:'ab6',  date:D(4),  time:'09:10', merchant:'Shell Tankstation',  desc:'SHELL AMSTERDAM WEST',         cat:'transportFuel',  amount: -88.00,  account:'abn_main' },
  { id:'ab7',  date:D(4),  time:'17:30', merchant:'Kruidvat',           desc:'KRUIDVAT 0419 AMS',            cat:'healthcare',     amount: -14.90,  account:'abn_main' },
  { id:'ab8',  date:D(5),  time:'20:30', merchant:'De Pizzabakkers',    desc:'DE PIZZABAKKERS AMSTERDAM',    cat:'restaurants',    amount: -38.50,  account:'abn_main' },
  { id:'ab9',  date:D(6),  time:'11:00', merchant:'Albert Heijn',       desc:'AH 9921 AMS-SLOTERDIJK',       cat:'groceries',      amount: -44.30,  account:'abn_main' },
  { id:'ab10', date:D(7),  time:'08:30', merchant:'Koffie â˜•',           desc:'COFFEE COMPANY AMS',           cat:'coffee',         amount: -4.20,   account:'abn_main' },
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
  { id:'ab24', date:D(22), time:'20:10', merchant:'PathÃ©',              desc:'PATHE AMSTERDAM ARENA',        cat:'entertainment',  amount: -24.50,  account:'abn_main' },
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
  { id:'dm9',  date:D(176), time:'09:15', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm10', date:D(169), time:'08:30', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
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
  { id:'dm22', date:D(146), time:'09:00', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm23', date:D(139), time:'08:30', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm24', date:D(144), time:'20:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -28.00,  account:'demo_main' },
  { id:'dm25', date:D(147), time:'14:00', merchant:'NS Â· Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-18.40, account:'demo_main' },
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
  { id:'dm35', date:D(116), time:'08:45', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm36', date:D(109), time:'09:15', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm37', date:D(114), time:'21:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -45.00,  account:'demo_main' },
  { id:'dm38', date:D(117), time:'15:00', merchant:'NS Â· Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-22.40, account:'demo_main' },
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
  { id:'dm50', date:D(86),  time:'09:00', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm51', date:D(79),  time:'08:30', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm52', date:D(72),  time:'09:00', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm53', date:D(84),  time:'19:30', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -32.50,  account:'demo_main' },
  { id:'dm54', date:D(70),  time:'21:00', merchant:'Demo Restaurant',  desc:'DEMO PIZZA PLACE',          cat:'restaurants',  amount: -28.50,  account:'demo_main' },
  { id:'dm55', date:D(87),  time:'15:30', merchant:'NS Â· Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-15.80, account:'demo_main' },
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
  { id:'dm68', date:D(56),  time:'09:00', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm69', date:D(49),  time:'08:30', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm70', date:D(42),  time:'09:00', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm71', date:D(54),  time:'20:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -52.00,  account:'demo_main' },
  { id:'dm72', date:D(40),  time:'19:00', merchant:'Demo Restaurant',  desc:'DEMO PIZZA PLACE',          cat:'restaurants',  amount: -24.90,  account:'demo_main' },
  { id:'dm73', date:D(57),  time:'14:00', merchant:'NS Â· Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-24.60, account:'demo_main' },
  { id:'dm74', date:D(43),  time:'16:00', merchant:'NS Â· Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-18.80, account:'demo_main' },
  { id:'dm75', date:D(47),  time:'14:00', merchant:'Etos',             desc:'ETOS DEMO',                 cat:'healthcare',   amount: -22.40,  account:'demo_main' },
  { id:'dm76', date:D(38),  time:'09:00', merchant:'Savings transfer', desc:'DEMO SPAAROVERBOEKING',     cat:'savingDeposit',amount:-300.00,  account:'demo_main', savingAccount:'demo_save' },
  { id:'dm77', date:D(45),  time:'12:00', merchant:'Bol.com',          desc:'BOL.COM DEMO ORDER',        cat:'hobby',        amount: -34.99,  account:'demo_main', confidence:65, needsReview:true },
  // === Month 6 (Mayâ€“Jun 2026) ===
  { id:'dm78', date:D(25),  time:'08:00', merchant:'Demo Corp BV',     desc:'DEMO CORP BV SALARIS MEI',  cat:'salary',       amount: 2200.00, account:'demo_main' },
  { id:'dm79', date:D(23),  time:'00:00', merchant:'Demo Verhuur',     desc:'DEMO VERHUUR HUUR MEI',     cat:'housingRent',  amount: -850.00, account:'demo_main', recurring:true },
  { id:'dm80', date:D(20),  time:'07:00', merchant:'Eneco',            desc:'ENECO ENERGIE MEI',         cat:'housingUtility',amount:-55.00,  account:'demo_main', recurring:true },
  { id:'dm81', date:D(18),  time:'09:00', merchant:'Spotify',          desc:'SPOTIFY SUBSCR MEI',        cat:'subs',         amount: -9.99,   account:'demo_main', recurring:true },
  { id:'dm82', date:D(16),  time:'09:00', merchant:'Netflix',          desc:'NETFLIX SUBSCR MEI',        cat:'subs',         amount: -13.99,  account:'demo_main', recurring:true },
  { id:'dm83', date:D(28),  time:'13:00', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -47.60,  account:'demo_main' },
  { id:'dm84', date:D(21),  time:'11:00', merchant:'Jumbo',            desc:'JUMBO DEMO 0042',           cat:'groceries',    amount: -62.30,  account:'demo_main' },
  { id:'dm85', date:D(14),  time:'16:30', merchant:'Albert Heijn',     desc:'AH DEMO 0001',              cat:'groceries',    amount: -38.90,  account:'demo_main' },
  { id:'dm86', date:D(7),   time:'10:00', merchant:'Lidl',             desc:'LIDL DEMO',                 cat:'groceries',    amount: -27.40,  account:'demo_main' },
  { id:'dm87', date:D(26),  time:'09:00', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm88', date:D(19),  time:'08:30', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm89', date:D(12),  time:'09:00', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -4.50,   account:'demo_main' },
  { id:'dm90', date:D(5),   time:'08:30', merchant:'Koffie â˜•',        desc:'DEMO COFFEE BAR',           cat:'coffee',       amount: -3.80,   account:'demo_main' },
  { id:'dm91', date:D(24),  time:'20:00', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -41.50,  account:'demo_main' },
  { id:'dm92', date:D(10),  time:'19:30', merchant:'Demo Restaurant',  desc:'DEMO SUSHI PLACE',          cat:'restaurants',  amount: -29.00,  account:'demo_main' },
  { id:'dm93', date:D(3),   time:'20:30', merchant:'Demo Restaurant',  desc:'DEMO RESTAURANT AMS',       cat:'restaurants',  amount: -34.00,  account:'demo_main' },
  { id:'dm94', date:D(27),  time:'14:30', merchant:'NS Â· Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-28.20, account:'demo_main' },
  { id:'dm95', date:D(13),  time:'15:00', merchant:'NS Â· Sprinter',    desc:'NS DEMO REIZIGERS',         cat:'transportPublic',amount:-14.40, account:'demo_main' },
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

export function generateBankTxs(accountId, bankName) {
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = ((Math.imul(s, 1664525) + 1013904223) >>> 0); return s / 4294967296; };
  }
  const POOL = [
    { merchant:'Albert Heijn', desc:'AH SUPERMARKT', cat:'groceries', min:10, max:80 },
    { merchant:'Jumbo', desc:'JUMBO SUPERMARKT', cat:'groceries', min:8, max:65 },
    { merchant:'Koffie â˜•', desc:'COFFEE CORNER', cat:'coffee', min:3, max:6 },
    { merchant:'NS Â· Sprinter', desc:'NS REIZIGERS', cat:'transportPublic', min:4, max:28 },
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
  const count = 30 + Math.floor(r() * 31); // 30â€“60 using seeded PRNG
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
  { merchant:'PathÃ© Cinemas', amount:-15.00, cat:'hobby', desc:'PATHE CINEMA' },
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

export const INTEGRATIONS = [
  { id: 'int_ah',     store: 'Albert Heijn', icon: 'ðŸ›’', color: '#00A0E2', category: 'Supermarket', status: 'connected', connectedSince: '2025-08-14', txCount: 42, lastSync: '2026-02-18', email: 'demo@ahbonus.nl' },
  { id: 'int_jumbo',  store: 'Jumbo',        icon: 'ðŸ›’', color: '#FFB800', category: 'Supermarket', status: 'connected', connectedSince: '2025-10-03', txCount: 18, lastSync: '2026-02-17', email: 'demo@jumbo.com' },
  { id: 'int_paypal', store: 'PayPal',       icon: 'ðŸ’³', color: '#003087', category: 'Payments',    status: 'connected', connectedSince: '2025-11-12', txCount: 7,  lastSync: '2026-02-15', email: 'demo@paypal.nl' },
  { id: 'int_amazon', store: 'Amazon',       icon: 'ðŸ“¦', color: '#FF9900', category: 'Shopping',    status: 'connected', connectedSince: '2025-09-28', txCount: 12, lastSync: '2026-02-16', email: 'demo@amazon.nl' },
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
  { id: 'pr1', date: D(4), store: 'PayPal â€” Booking.com', total: 84.00, items: [{ name: 'Hotel reservation Â· Berlin 21 Feb', qty: 1, price: 84.00 }], matchedTxId: null },
  { id: 'pr2', date: D(20), store: 'PayPal â€” G2A.com', total: 12.99, items: [{ name: 'Game key Â· PC Digital', qty: 1, price: 12.99 }], matchedTxId: null },
  { id: 'pr3', date: '2025-12-19', store: 'PayPal â€” iHerb', total: 34.50, items: [{ name: 'Omega-3 Fish Oil 90ct', qty: 1, price: 18.50 }, { name: 'Vitamin D3 200ct', qty: 1, price: 16.00 }], matchedTxId: null },
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
