import React from 'react';
import { CATEGORIES } from '../../shared/data/categories.js';
import { fmtEur, fmtEurInt, fmtDate, computePeriodHistory, dayLabel, PERIOD_HISTORY } from '../../shared/utils/format.js';
import { RECURRING } from '../recurring/data.js';
import { PORTFOLIO, DEBTS_PAID_OFF, SPEND_HISTORY, DEBT_HISTORY } from '../investments/data.js';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav, Sheet, TabBar } from '../../app/nav.jsx';
import { useLocalStorage } from '../../shared/hooks.jsx';
import { BarChart, BarChartScrollable } from '../../shared/components/Charts.jsx';
import { useTxCtx, useProfileDebts, Stat } from '../../app/providers.jsx';
import { useAppCtx } from '../../app/providers.jsx';


export function ScreenIncome() {
  const nav = useNav();
  const { t } = useLang();
  const { txs: allTxs } = useTxCtx();
  const [periodDay] = useLocalStorage('munni_period_day', 20);
  const periodHistory = computePeriodHistory(periodDay);
  const [selBar, setSelBar] = React.useState(periodHistory.length - 1);
  const selPeriod = periodHistory[selBar] || periodHistory[periodHistory.length - 1];
  const periodStart = selPeriod.start;
  const periodEnd = selPeriod.end;

  // All income txs for the selected period
  const periodIncomeTxs = allTxs.filter(t =>
    t.amount > 0 && t.date >= periodStart && t.date <= periodEnd
  ).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));

  const total = periodIncomeTxs.reduce((s, t) => s + t.amount, 0);

  // Bar chart data: income per period
  const barData = periodHistory.map(p =>
    allTxs.filter(t => t.amount > 0 && t.date >= p.start && t.date <= p.end).reduce((s, t) => s + t.amount, 0)
  );

  // Group by date
  const byDate = React.useMemo(() => {
    const map = {};
    periodIncomeTxs.forEach(t => {
      if (!map[t.date]) map[t.date] = [];
      map[t.date].push(t);
    });
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [allTxs, periodStart, periodEnd]);

  // Prev period income for comparison
  const prevPeriod = periodHistory[selBar - 1];
  const prevTotal = prevPeriod
    ? allTxs.filter(t => t.amount > 0 && t.date >= prevPeriod.start && t.date <= prevPeriod.end).reduce((s, t) => s + t.amount, 0)
    : null;
  const vsLabel = prevTotal != null && prevTotal > 0
    ? (() => { const diff = ((total - prevTotal) / prevTotal) * 100; return (diff >= 0 ? '+' : '') + diff.toFixed(0) + '% vs previous'; })()
    : null;

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('period.income')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
          <div className="m-num" style={{ fontSize: 38, fontWeight: 600, letterSpacing: '-0.025em', color: M.sage }}>{fmtEur(total)}</div>
          <div style={{ fontSize: 12, color: M.ink3, marginTop: 4, fontWeight: 500 }}>{selPeriod.label}</div>
          {vsLabel && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8, padding: '4px 10px', borderRadius: 999, background: M.sageSoft }}>
              <I name="trending-up" size={12} color={M.sage}/>
              <span style={{ fontSize: 11, color: M.sage, fontWeight: 600 }}>{vsLabel}</span>
            </div>
          )}
        </div>

        <div className="m-card" style={{ padding:'12px 16px 8px', marginBottom:14, border:`1px solid ${M.line}` }}>
          <div className="m-cap" style={{ marginBottom:8 }}>Period history Â· tap to navigate</div>
          <BarChartScrollable
            data={barData}
            labels={periodHistory.map(p => new Date(p.start).toLocaleString('en-GB',{month:'short'}))}
            height={80}
            accent={M.sage}
            color={M.ink3}
            selected={selBar}
            onSelect={setSelBar}
          />
        </div>

        {byDate.length === 0 ? (
          <div style={{ textAlign:'center', padding:'48px 24px', color:M.ink3 }}>
            <I name="inbox" size={32} color={M.ink4}/>
            <div style={{ marginTop:12, fontSize:14, fontWeight:500 }}>No income this period</div>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {byDate.map(([date, dayTxs]) => (
              <div key={date}>
                <div style={{ fontSize:11, fontWeight:600, color:M.ink3, paddingLeft:4, marginBottom:4 }}>{dayLabel(date)}</div>
                <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}` }}>
                  {dayTxs.map((t, i, a) => (
                    <React.Fragment key={t.id}>
                      <div className="m-tap" onClick={() => nav.push('txDetail', { id: t.id })}
                        style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                        <div style={{ width:36, height:36, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                          <I name={CATEGORIES[t.cat]?.icon || 'arrow-dn-right'} size={16} color={M.sage}/>
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:500 }}>{t.merchant}</div>
                          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{CATEGORIES[t.cat]?.name || 'Income'}</div>
                        </div>
                        <div className="m-num" style={{ fontSize:14, fontWeight:600, color:M.sage }}>+{fmtEur(t.amount)}</div>
                      </div>
                      {i < a.length - 1 && <Divider inset={48}/>}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


export function ScreenInvested() {
  const nav = useNav();
  const { t } = useLang();
  const { txs } = useTxCtx();
  const investTx = txs.filter(t => t.cat === 'invest');
  const total = Math.abs(investTx.reduce((s, t) => s + t.amount, 0));
  const monthlyHistory = [250, 300, 300, 280, 300, 300];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('period.invested')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign: 'center', padding: '8px 0 18px' }}>
          <div className="m-num" style={{ fontSize: 38, fontWeight: 600, letterSpacing: '-0.025em', color: M.violet }}>{fmtEur(total)}</div>
          <div style={{ fontSize: 12, color: M.ink3, marginTop: 4, fontWeight: 500 }}>20 Jan â€“ 19 Feb</div>
        </div>

        <div className="m-tap m-card m-fade" onClick={() => nav.push('investment')} style={{
          padding: 14, marginBottom: 14, border: `1px solid ${M.line}`,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: M.violetSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I name="rocket" size={18} color={M.violet}/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>View full portfolio</div>
            <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{fmtEur(PORTFOLIO.total)} total Â· +{PORTFOLIO.pnlPct.toFixed(1)}%</div>
          </div>
          <I name="caretR" size={14} color={M.ink4}/>
        </div>

        <div className="m-card" style={{ padding: 16, marginBottom: 16, border: `1px solid ${M.line}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <div className="m-cap">Monthly history</div>
            <div style={{ fontSize: 11, color: M.ink3 }}>last 6 periods</div>
          </div>
          <div style={{ overflowX: 'auto', marginLeft: -16, paddingLeft: 16, paddingRight: 16, marginRight: -16 }}>
            <div style={{ minWidth: 280 }}>
              <BarChart data={monthlyHistory} labels={['Sepâ€“Oct','Octâ€“Nov','Novâ€“Dec','Decâ€“Jan','Janâ€“Feb','Febâ€“Mar']} showValues height={80} accent={M.violet}/>
            </div>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Transactions Â· {investTx.length}</div>
        <div className="m-card" style={{ padding: '4px 16px', border: `1px solid ${M.line}` }}>
          {investTx.length > 0 ? investTx.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <div className="m-tap" onClick={() => nav.push('txDetail', { id: t.id })}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: M.violetSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <I name="rocket" size={16} color={M.violet}/>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{t.merchant}</div>
                  <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{fmtDate(t.date)}</div>
                </div>
                <div className="m-num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtEur(t.amount)}</div>
              </div>
              {i < a.length - 1 && <Divider inset={48}/>}
            </React.Fragment>
          )) : (
            <div style={{ padding: '24px 0', textAlign: 'center', color: M.ink3, fontSize: 13 }}>No investments this period</div>
          )}
        </div>
      </div>
    </div>
  );
}


export function ScreenInsights() {
  const nav = useNav();
  const { t } = useLang();
  const [selInsight, setSelInsight] = React.useState(null);
  const totalSpend = SPEND_HISTORY.total.reduce((s, v) => s + v, 0) / SPEND_HISTORY.total.length;
  const coffeeMonthly = SPEND_HISTORY.coffee.reduce((s, v) => s + v, 0) / SPEND_HISTORY.coffee.length;
  const luxurySubs = RECURRING.filter(r => r.type === 'subs' && r.luxury && r.active).reduce((s, r) => s + Math.abs(r.amount), 0);
  const savingsRate = ((2480 - totalSpend) / 2480 * 100).toFixed(0);

  const insights = [
    {
      id:'projection',
      icon:'trending-up', iconBg:M.sageSoft, iconColor:M.sage,
      title:'5-year projection',
      sub:'Keep this up and you\'ll save â‚¬38k',
      detail:`At your current savings rate of ${savingsRate}%, investing â‚¬300/month with 7% average returns would grow your portfolio from ${fmtEurInt(PORTFOLIO.total)} to approx. â‚¬38 000 by 2031. That's assuming no income change.`,
      chart: [12480, 14200, 16100, 18200, 20500, 23100, 26000, 29200, 32800, 36800, 41500],
      chartColor: M.sage,
    },
    {
      id:'coffee',
      icon:'flame', iconBg:M.ochreSoft, iconColor:M.ochre,
      title:'Coffee habit',
      sub:`${fmtEurInt(coffeeMonthly)}/month on coffee runs`,
      detail:`You spend an average of ${fmtEurInt(coffeeMonthly)}/month on coffee â€” ${fmtEurInt(coffeeMonthly * 12)}/year. Cutting to 3Ã—/week instead of daily would save you ${fmtEurInt(coffeeMonthly * 0.57 * 12)}/year, which invested at 7% over 5 years = ${fmtEurInt(coffeeMonthly * 0.57 * 12 * 6.15)}.`,
      chart: SPEND_HISTORY.coffee,
      chartColor: M.ochre,
    },
    {
      id:'weekend',
      icon:'star', iconBg:M.violetSoft, iconColor:M.violet,
      title:'Weekend spending',
      sub:'You spend 2.4Ã— more on weekends',
      detail:'Your weekend transactions (Friâ€“Sun) average â‚¬127 vs â‚¬53 on weekdays. Most of it is restaurants and bars. This is totally normal â€” but if you want to cut back, restaurants on Sunday evening are your single biggest weekend category.',
      chart:[53,53,53,53,127,127,127,53,53,53,53,127,127,127],
      chartColor: M.violet,
    },
    {
      id:'luxury',
      icon:'film', iconBg:M.slateSoft, iconColor:M.slate,
      title:'Luxury subscriptions',
      sub:`â‚¬${luxurySubs.toFixed(2)}/month on luxury subs`,
      detail:`You have ${RECURRING.filter(r => r.type === 'subs' && r.luxury && r.active).length} luxury subscriptions totalling ${fmtEurInt(luxurySubs)}/month (${fmtEurInt(luxurySubs * 12)}/year). Netflix + Spotify alone = ${fmtEurInt(13.99 + 9.99)}/month. Have you used all of them this month?`,
      chart: [18, 20, 24, 24, 24, luxurySubs],
      chartColor: M.slate,
    },
    {
      id:'progress',
      icon:'goal', iconBg:M.sageSoft, iconColor:M.sage,
      title:'You\'re on track',
      sub:'Savings rate improved 4 months in a row',
      detail:`Your savings rate has improved from 14% to ${savingsRate}% over the past 6 periods. Your emergency fund is 40% funded, and your Lisbon trip goal is on pace to hit by June. Keep going â€” consistency matters more than perfection.`,
      chart:[14,16,18,21,24,parseInt(savingsRate)],
      chartColor: M.sage,
    },
  ];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.insights')} large leading={null}/>
      <div className="m-body-scroll">
        <div style={{ fontSize:13, color:M.ink3, marginBottom:16, lineHeight:1.5 }}>
          Based on your last 6 periods Â· updated daily
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {insights.map(ins => (
            <div key={ins.id} className="m-card m-tap" onClick={() => setSelInsight(selInsight === ins.id ? null : ins.id)}
              style={{ border:`1px solid ${M.line}`, overflow:'hidden' }}>
              <div style={{ padding:'16px 16px 14px', display:'flex', gap:14, alignItems:'flex-start' }}>
                <div style={{ width:42, height:42, borderRadius:12, background:ins.iconBg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name={ins.icon} size={20} color={ins.iconColor}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:15, fontWeight:600, marginBottom:3 }}>{ins.title}</div>
                  <div style={{ fontSize:12, color:M.ink3, lineHeight:1.4 }}>{ins.sub}</div>
                </div>
                <I name={selInsight===ins.id ? 'arrowDn' : 'caretR'} size={14} color={M.ink4}/>
              </div>
              {selInsight === ins.id && (
                <div style={{ borderTop:`1px solid ${M.line2}`, padding:'14px 16px 16px', background:M.paper2 }}>
                  <BarChart data={ins.chart} height={64} accent={ins.chartColor} color={ins.chartColor} highlightLast showValues/>
                  <div style={{ fontSize:13, color:M.ink2, lineHeight:1.55, marginTop:12 }}>{ins.detail}</div>
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{ height:12 }}/>
      </div>
      <TabBar active="insights" onChange={(t) => nav.switchTab(t)}/>
    </div>
  );
}


export function ScreenDebts() {
  const nav = useNav();
  const { t } = useLang();
  const [strategy, setStrategy] = React.useState('avalanche');
  const [showAdd, setShowAdd] = React.useState(false);
  const [manageDebt, setManageDebt] = React.useState(null);
  const [debts, setDebts] = useProfileDebts();
  const totalDebt = debts.reduce((s, d) => s + d.balance, 0);
  const monthlyMin = debts.reduce((s, d) => s + d.minPayment, 0);

  const sorted = strategy === 'avalanche'
    ? [...debts].sort((a, b) => b.rate - a.rate)
    : [...debts].sort((a, b) => a.balance - b.balance);

  const strategies = [
    { id:'avalanche', label:'Avalanche', sub:'Highest interest first â€” saves most money' },
    { id:'snowball',  label:'Snowball',  sub:'Smallest balance first â€” builds momentum' },
  ];
  const debtTypeIcon = { mortgage:'house', loan:'car', credit:'card', student:'bag' };

  const histMax = Math.max(...DEBT_HISTORY);

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.debts')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap" onClick={() => setShowAdd(true)}><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {/* Summary + history */}
        <div className="m-card" style={{ padding:18, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div className="m-cap" style={{ marginBottom:6 }}>{t('debts.totalOutstanding')}</div>
          <div className="m-num" style={{ fontSize:36, fontWeight:600, letterSpacing:'-0.025em', color:M.clay }}>{fmtEurInt(totalDebt)}</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:14, marginBottom:16 }}>
            <Stat label="Min./month" value={fmtEurInt(monthlyMin)} color={M.ink}/>
            <Stat label="Active debts" value={debts.length} color={M.ink}/>
          </div>
          <div className="m-cap" style={{ marginBottom:8 }}>6-month trend</div>
          <div style={{ display:'flex', alignItems:'flex-end', gap:4, height:52 }}>
            {DEBT_HISTORY.map((v, i) => {
              const h = Math.round((v / histMax) * 52);
              const isLast = i === DEBT_HISTORY.length - 1;
              return (
                <div key={i} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <div style={{ width:'100%', height:h, borderRadius:4, background: isLast ? M.clay : M.claySoft||'#EDD6D0', transition:'height 0.3s' }}/>
                </div>
              );
            })}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:4, fontSize:9, color:M.ink4 }}>
            <span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span><span>Jan</span><span>Feb</span>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:8 }}>
            <div style={{ fontSize:11, color:M.sage, fontWeight:600 }}>â†“ {fmtEurInt(DEBT_HISTORY[0] - DEBT_HISTORY[DEBT_HISTORY.length-1])} paid down in 6 months</div>
            <div className="m-num" style={{ fontSize:12, fontWeight:700, color:M.clay }}>{fmtEurInt(DEBT_HISTORY[DEBT_HISTORY.length-1])}</div>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('debts.payoffStrategy')}</div>
        <div style={{ display:'flex', background:M.paper2, borderRadius:12, padding:3, gap:3, marginBottom:16 }}>
          {strategies.map(s => (
            <button key={s.id} onClick={() => setStrategy(s.id)} className="m-tap" style={{
              flex:1, height:34, borderRadius:10, border:'none', fontFamily:M.fontUI, cursor:'pointer',
              background:strategy===s.id?M.card:'transparent',
              boxShadow:strategy===s.id?'0 1px 3px rgba(0,0,0,0.08)':'none',
              color:strategy===s.id?M.ink:M.ink3, fontSize:13, fontWeight:strategy===s.id?600:500,
            }}>{s.label}</button>
          ))}
        </div>
        <div style={{ padding:'10px 14px', borderRadius:12, background:M.paper2, border:`1px solid ${M.line2}`, marginBottom:14, fontSize:12, color:M.ink2 }}>
          {strategies.find(s => s.id === strategy)?.sub}
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('debts.activeDebts')} Â· {debts.length}</div>
        <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
          {sorted.map((d, rank) => {
            const progress = 1 - d.balance / d.original;
            const isPriority = rank === 0;
            return (
              <div key={d.id} className="m-card" style={{ padding:16, border:`1px solid ${isPriority?d.color+'66':M.line}`, background: isPriority ? d.color + '08' : M.card }}>
                <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
                  <div style={{ width:42, height:42, borderRadius:12, background:d.color+'18', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <I name={debtTypeIcon[d.type] || 'card'} size={20} color={d.color}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                      <div style={{ fontSize:14, fontWeight:600 }}>{d.name}</div>
                      {isPriority && <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:d.color+'22', color:d.color, textTransform:'uppercase', letterSpacing:'0.05em' }}>Pay first</span>}
                    </div>
                    <div style={{ fontSize:11, color:M.ink3 }}>
                      {d.rate > 0 ? `${d.rate}% interest Â· ` : 'Interest-free Â· '}{fmtEurInt(d.minPayment)}/month min
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div className="m-num" style={{ fontSize:16, fontWeight:700, color:M.clay }}>{fmtEurInt(d.balance)}</div>
                    <div style={{ fontSize:10, color:M.ink3, marginTop:2 }}>of {fmtEurInt(d.original)}</div>
                  </div>
                </div>
                <div style={{ height:8, borderRadius:999, background:M.line2, overflow:'hidden', marginBottom:6 }}>
                  <div style={{ width:`${Math.round(progress * 100)}%`, height:'100%', background:d.color, borderRadius:999, transition:'width 0.4s' }}/>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:11 }}>
                  <span style={{ color:M.sage, fontWeight:600 }}>{Math.round(progress * 100)}% paid off</span>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ color:M.ink3 }}>Next: {d.nextDate}</span>
                    <button className="m-tap" onClick={() => setManageDebt(d)} style={{ padding:'3px 10px', borderRadius:8, border:`1px solid ${M.line}`, background:M.paper2, fontSize:11, fontWeight:600, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI }}>
                      {t('debts.manage')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Paid off this year */}
        {DEBTS_PAID_OFF.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Paid off this year ðŸŽ‰</div>
            <div style={{ padding:'14px 16px', borderRadius:16, background:M.sageSoft, border:`1px solid ${M.sage}22`, marginBottom:16 }}>
              <div style={{ fontSize:13, fontWeight:600, color:M.sage, marginBottom:12 }}>
                You cleared {DEBTS_PAID_OFF.length} debt{DEBTS_PAID_OFF.length > 1 ? 's' : ''} this year. That's real progress.
              </div>
              {DEBTS_PAID_OFF.map((d, i) => (
                <React.Fragment key={d.id}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'8px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background:M.sage+'18', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name="check" size={16} color={M.sage} stroke={2.5}/>
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:M.ink }}>{d.name}</div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>Paid off {fmtDate(d.paidDate, 'long')} Â· {fmtEurInt(d.paidAmount)}</div>
                    </div>
                  </div>
                  {i < DEBTS_PAID_OFF.length - 1 && <div style={{ height:1, background:M.sage+'22', margin:'0 0 0 48px' }}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}

        <div style={{ padding:14, borderRadius:12, background:M.sageSoft, display:'flex', gap:10, marginBottom:20 }}>
          <I name="help" size={15} color={M.sage}/>
          <div style={{ fontSize:12, color:M.ink2, lineHeight:1.5 }}>
            Avalanche saves more interest overall. Snowball helps you feel quick wins. Either beats paying minimums only.
          </div>
        </div>
      </div>

      {/* Add debt sheet */}
      {showAdd && (
        <Sheet onClose={() => setShowAdd(false)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div className="m-h2" style={{ marginBottom:4 }}>{t('debts.addDebt')}</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:20 }}>Track a new loan, credit card or other debt</div>
            {['Mortgage','Car loan','Student loan','Credit card','Personal loan','Other'].map(type => (
              <div key={type} className="m-tap" onClick={() => setShowAdd(false)}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0', borderBottom:`1px solid ${M.line2}` }}>
                <div style={{ width:34, height:34, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <I name={type==='Mortgage'?'house':type==='Car loan'?'car':type==='Credit card'?'card':'bag'} size={16} color={M.ink2}/>
                </div>
                <div style={{ flex:1, fontSize:14, fontWeight:500 }}>{type}</div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            ))}
          </div>
        </Sheet>
      )}

      {/* Manage debt sheet */}
      {manageDebt && (
        <Sheet onClose={() => setManageDebt(null)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
              <div style={{ width:40, height:40, borderRadius:12, background:manageDebt.color+'18', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name={debtTypeIcon[manageDebt.type]||'card'} size={18} color={manageDebt.color}/>
              </div>
              <div>
                <div className="m-h2" style={{ marginBottom:0 }}>{manageDebt.name.split('Â·')[0].trim()}</div>
                <div style={{ fontSize:12, color:M.ink3 }}>{fmtEurInt(manageDebt.balance)} remaining</div>
              </div>
            </div>
            {[
              { icon:'swap', label:'Log a payment', sub:`Min. ${fmtEurInt(manageDebt.minPayment)}/month` },
              { icon:'edit', label:'Edit details', sub:'Name, rate, balance' },
              { icon:'cal', label:'Change due date', sub:`Currently ${manageDebt.nextDate}` },
              { icon:'alert', label:'Mark as paid off', sub:'Remove from active debts' },
            ].map((item, i, a) => (
              <React.Fragment key={item.label}>
                <div className="m-tap" onClick={() => setManageDebt(null)}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                  <div style={{ width:34, height:34, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <I name={item.icon} size={16} color={item.label.includes('paid')?M.sage:M.ink2}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:500, color:item.label.includes('paid')?M.sage:M.ink }}>{item.label}</div>
                    <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{item.sub}</div>
                  </div>
                  <I name="caretR" size={14} color={M.ink4}/>
                </div>
                {i < a.length-1 && <div style={{ height:1, background:M.line2, marginLeft:46 }}/>}
              </React.Fragment>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}


export function ScreenCustomGraphCreate() {
  const nav = useNav();
  const [customGraphs, setCustomGraphs] = useLocalStorage('munni_custom_graphs', []);
  const [step, setStep] = React.useState(0); // 0: name, 1: metric, 2: categories
  const [name, setName] = React.useState('');
  const [metric, setMetric] = React.useState('expenses');
  const [excludedCats, setExcludedCats] = React.useState([]);

  const allExpenseParents = Object.entries(CATEGORIES)
    .filter(([k,v]) => v.isParent && !v.positive && k !== 'saving' && k !== 'expense')
    .map(([k,v]) => ({ id: k, name: v.name, icon: v.icon, color: v.color }));

  const toggleCat = (id) => {
    setExcludedCats(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const save = () => {
    const newCard = {
      id: `cg_${Date.now()}`,
      name: name.trim() || 'Custom graph',
      metric,
      excludeCategories: excludedCats,
    };
    setCustomGraphs(prev => [...prev, newCard]);
    nav.pop();
  };

  const steps = [
    { label: 'Name', icon: 'edit' },
    { label: 'Metric', icon: 'trending-up' },
    { label: 'Filter', icon: 'sliders' },
  ];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Create custom card"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {/* Step indicator */}
        <div style={{ display:'flex', gap:8, marginBottom:24 }}>
          {steps.map((s, i) => (
            <div key={s.label} className="m-tap" onClick={() => i < step && setStep(i)}
              style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
              <div style={{ width:36, height:36, borderRadius:10, background: i <= step ? M.sage : M.paper2, border:`1px solid ${i <= step ? M.sage : M.line}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name={s.icon} size={16} color={i <= step ? '#fff' : M.ink3}/>
              </div>
              <div style={{ fontSize:10, color: i === step ? M.sage : M.ink3, fontWeight: i === step ? 600 : 400 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {step === 0 && (
          <>
            <div style={{ fontSize:16, fontWeight:600, marginBottom:6 }}>What should this card be called?</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>Give your custom card a descriptive name.</div>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && name.trim() && setStep(1)}
              placeholder="e.g. Variable spending, Subscriptionsâ€¦"
              style={{ width:'100%', padding:'14px 16px', borderRadius:12, border:`1.5px solid ${M.sage}`, fontSize:16, fontFamily:M.fontUI, background:M.paper, outline:'none', boxSizing:'border-box', marginBottom:20 }}
            />
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:20 }}>
              {['Variable costs','Fixed costs excluded','Food & fun','Work expenses','Subscriptions only'].map(s => (
                <button key={s} className="m-tap" onClick={() => setName(s)}
                  style={{ padding:'7px 14px', borderRadius:999, border:`1px solid ${M.line}`, background: name===s ? M.sageSoft : M.paper2, color: name===s ? M.sage : M.ink3, fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI }}>
                  {s}
                </button>
              ))}
            </div>
            <button onClick={() => name.trim() && setStep(1)} style={{ width:'100%', padding:'14px 0', background: name.trim() ? M.sage : M.line, color: name.trim() ? '#fff' : M.ink4, border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor: name.trim() ? 'pointer' : 'default', fontFamily:M.fontUI }}>
              Continue
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <div style={{ fontSize:16, fontWeight:600, marginBottom:6 }}>What do you want to track?</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>Choose the data you&apos;d like this card to visualize.</div>
            {[
              { v:'expenses', icon:'arrow-up-right', label:'Expenses', sub:'Track your spending by category', color:M.clay },
              { v:'income', icon:'arrow-dn-right', label:'Income', sub:'Track your income sources', color:M.sage },
            ].map(opt => (
              <div key={opt.v} className="m-tap" onClick={() => setMetric(opt.v)}
                style={{ display:'flex', alignItems:'center', gap:14, padding:'16px', borderRadius:14, border:`2px solid ${metric===opt.v ? opt.color : M.line}`, background: metric===opt.v ? opt.color+'11' : M.paper2, marginBottom:10, cursor:'pointer' }}>
                <div style={{ width:44, height:44, borderRadius:12, background: opt.color+'22', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <I name={opt.icon} size={22} color={opt.color}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:15, fontWeight:600 }}>{opt.label}</div>
                  <div style={{ fontSize:12, color:M.ink3, marginTop:2 }}>{opt.sub}</div>
                </div>
                {metric === opt.v && <div style={{ width:22, height:22, borderRadius:999, background:opt.color, display:'flex', alignItems:'center', justifyContent:'center' }}><I name="check" size={12} color="#fff" stroke={2.5}/></div>}
              </div>
            ))}
            <button onClick={() => setStep(2)} style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginTop:10 }}>
              Continue
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div style={{ fontSize:16, fontWeight:600, marginBottom:4 }}>Exclude categories</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:16, lineHeight:1.5 }}>
              Select categories to exclude from this card. For example, exclude Housing to see only variable costs.
            </div>
            {excludedCats.length > 0 && (
              <div style={{ padding:'8px 12px', borderRadius:8, background:M.ochreSoft, marginBottom:14, fontSize:12, color:M.ochre }}>
                {excludedCats.length} categor{excludedCats.length!==1?'ies':'y'} excluded
              </div>
            )}
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
              {allExpenseParents.map((cat, i) => {
                const isExcluded = excludedCats.includes(cat.id);
                return (
                  <React.Fragment key={cat.id}>
                    {i > 0 && <Divider inset={48}/>}
                    <div className="m-tap" onClick={() => toggleCat(cat.id)}
                      style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0', opacity: isExcluded ? 0.5 : 1 }}>
                      <div style={{ width:36, height:36, borderRadius:10, background: (cat.color||M.ink3)+'22', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                        <IcoMDI name={cat.icon||'help-circle-outline'} size={16} color={cat.color||M.ink2}/>
                      </div>
                      <div style={{ flex:1, fontSize:14, fontWeight:500 }}>{cat.name}</div>
                      {isExcluded
                        ? <div style={{ width:20, height:20, borderRadius:4, background:M.clay+'22', display:'flex', alignItems:'center', justifyContent:'center' }}><I name="x" size={11} color={M.clay}/></div>
                        : <div style={{ width:20, height:20, borderRadius:4, border:`1.5px solid ${M.line2}` }}/>}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            <button onClick={save} style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
              Create card
            </button>
          </>
        )}

        <div style={{ height:16 }}/>
      </div>
    </div>
  );
}

