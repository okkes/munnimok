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

// Currency-aware money formatter. currencyCode defaults to EUR.
export const fmtMoney = (n, currencyCode = 'EUR', opts = {}) => {
  // Inline symbol map so format.js stays free of circular imports
  const SYMS = {
    EUR:'€', USD:'$', GBP:'£', CHF:'Fr', SEK:'kr', NOK:'kr', DKK:'kr',
    PLN:'zł', CZK:'Kč', HUF:'Ft', RON:'lei', TRY:'₺', AUD:'A$', NZD:'NZ$',
    CAD:'C$', BRL:'R$', MXN:'MX$', ARS:'AR$', JPY:'¥', KRW:'₩', CNY:'¥',
    INR:'₹', SGD:'S$', AED:'AED', SAR:'SAR', ILS:'₪', QAR:'QR',
    ZAR:'R', NGN:'₦', PKR:'Rs', IDR:'Rp', MYR:'RM', THB:'฿', VND:'₫', PHP:'₱',
  };
  const NO_DEC = new Set(['JPY','KRW','IDR','VND']);
  const sign = n < 0 ? '−' : (opts.signed && n > 0 ? '+' : '');
  const abs = Math.abs(n);
  const decimals = opts.decimals ?? (NO_DEC.has(currencyCode) ? 0 : 2);
  const s = abs.toLocaleString('nl-NL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const sym = SYMS[currencyCode] || currencyCode;
  return `${sign}${sym}${s}`;
};
export const fmtMoneyInt = (n, currencyCode = 'EUR') => fmtMoney(n, currencyCode, { decimals: 0 });

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