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
  { id:'a1', type:'real_estate', name:'Apartment Â· Amsterdam', icon:'house', value:320000, mortgageLeft:218000, equity:102000, curve:[290000,295000,302000,310000,315000,320000], changeYr:3.2 },
  { id:'a2', type:'vehicle',     name:'Car Â· Volkswagen Golf', icon:'car',   value:14200,  loanLeft:4800,   equity:9400,  curve:[22000,20000,18500,17000,15800,14200], changeYr:-10.0 },
  { id:'a3', type:'pension',     name:'ABP Pension',           icon:'piggy', value:28400,  loanLeft:0,      equity:28400, curve:[22000,23500,24800,26000,27200,28400], changeYr:5.8 },
];

export const DEBTS = [
  { id:'d1', name:'Mortgage Â· Stadgenoot',   icon:'house',  balance:218000, original:240000, rate:3.2, minPayment:820,  nextDate:'01 Mar', type:'mortgage', color:'#4A6A4F' },
  { id:'d2', name:'Car loan Â· ABN AMRO',     icon:'car',    balance:4800,   original:12000,  rate:5.8, minPayment:250,  nextDate:'15 Mar', type:'loan',     color:'#A8782B' },
  { id:'d3', name:'Credit card Â· ING',       icon:'card',   balance:480,    original:480,    rate:14.5, minPayment:25,  nextDate:'25 Mar', type:'credit',   color:'#B5503A' },
  { id:'d4', name:'Study loan Â· DUO',        icon:'bag',    balance:12400,  original:28000,  rate:0.0,  minPayment:180, nextDate:'01 Mar', type:'student',  color:'#5E4A78' },
];
export const DEBTS_PAID_OFF = [
  { id:'dp1', name:'Personal loan Â· Rabobank', icon:'card',  paidAmount:3200, paidDate:'2026-01-15', type:'loan',    color:'#A8782B' },
  { id:'dp2', name:'Credit card Â· ABN AMRO',   icon:'card',  paidAmount:650,  paidDate:'2026-02-03', type:'credit',  color:'#B5503A' },
];
export const DEBT_HISTORY = [240000+12000+1200+28000, 240000+11000+1100+27800, 238000+9500+900+27600, 237000+8500+800+27400, 236000+7500+700+27200, 235680];
