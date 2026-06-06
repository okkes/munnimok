const R = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return Math.min(Math.max(d.getDate(), 1), 28); };

export const RECURRING = [
  { id:'r1', name:'Rent Â· Stadgenoot',   icon:'home-import-outline',        amount:-740.00, day:R(6),  every:'monthly',  cat:'housingRent',   type:'fixed',  luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t9']  },
  { id:'r2', name:'Eneco Â· Energy',        icon:'home-lightning-bolt-outline', amount:-65.00,  day:R(1),  every:'monthly',  cat:'housingUtility',type:'fixed',  luxury:false, since:'2024-01', until:null,    active:true,  txIds:['t24'] },
  { id:'r3', name:'Spotify',               icon:'television-play',             amount:-9.99,   day:R(3),  every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-06', until:null,    active:true,  txIds:['t4']  },
  { id:'r4', name:'Netflix',               icon:'television-play',             amount:-13.99,  day:R(7),  every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-01', until:null,    active:true,  txIds:['t18'] },
  { id:'r5', name:'DEGIRO ETF',            icon:'chart-timeline-variant',      amount:-300.00, day:R(15), every:'monthly',  cat:'invest',        type:'fixed',  luxury:false, since:'2024-06', until:null,    active:true,  txIds:['t13'] },
  { id:'r6', name:'Acme Salary',           icon:'cash-plus',                   amount:2480.00, day:R(18), every:'monthly',  cat:'salary',        type:'income', luxury:false, since:'2022-01', until:null,    active:true,  txIds:['t3']  },
  { id:'r7', name:'Audible',               icon:'book-education-outline',      amount:-7.95,   day:R(22), every:'monthly',  cat:'subs',          type:'subs',   luxury:true,  since:'2023-03', until:'2026-01', active:false, txIds:[] },
  { id:'r8', name:'Basic-Fit Â· Gym',       icon:'dumbbell',                    amount:-24.99,  day:R(10), every:'monthly',  cat:'gym',           type:'subs',   luxury:false, since:'2024-03', until:null,    active:true,  txIds:[] },
  { id:'r9', name:'Health Insurance',      icon:'shield-check-outline',        amount:-128.50, day:R(12), every:'monthly',  cat:'healthInsurance',type:'fixed', luxury:false, since:'2023-01', until:null,    active:true,  txIds:[] },
];

export const RECURRING_SUGGESTIONS = [
  { id:'rs1', name:'Amazon Prime',     icon:'shop',   amount:-6.99,   confidence:94, pattern:'Monthly Â· detected 6Ã—', type:'subs'  },
  { id:'rs2', name:'Health Insurance', icon:'health', amount:-128.50, confidence:87, pattern:'Monthly Â· detected 3Ã—', type:'fixed' },
  { id:'rs3', name:'Gym Â· Basic-Fit',  icon:'health', amount:-24.99,  confidence:72, pattern:'Monthly Â· detected 2Ã—', type:'subs'  },
];
