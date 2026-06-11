import React from 'react';
import { CATEGORIES, _catExt } from '../../shared/data/categories.js';
import { fmtEur, fmtEurInt, fmtDate, computePeriodHistory, fmtSyncTime } from '../../shared/utils/format.js';
import { getUserId, getUserSyncKey } from '../../shared/utils/user.js';
import { PORTFOLIO } from '../investments/data.js';
import { M, I, IcoMDI, Divider, StatusBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav, Sheet, TabBar } from '../../app/nav.jsx';
import { useLocalStorage } from '../../shared/hooks.jsx';
import { Sparkline, StackedBar } from '../../shared/components/Charts.jsx';
import { useProfiles, useTxCtx, useRecurCtx, useAlloc, useConnectedAccounts, useProfileBudgets, useProfileGoals, useProfileDebts } from '../../app/providers.jsx';
import { ProfileAvatar } from '../profile/Profile.jsx';
import { HOME_CARDS_DEFAULT } from '../accounts/Accounts.jsx';
import { budgetColor, budgetSoft } from '../budgets/Budgets.jsx';


function CustomGraphCard({ card, txs }) {
  const nav = useNav();
  const [periodDay] = useLocalStorage('munni_period_day', 20);
  const periodHistory = computePeriodHistory(periodDay);
  const currentPeriod = periodHistory[periodHistory.length - 1];
  const excluded = card.excludeCategories || [];

  const filteredTxs = txs.filter(t => {
    if (t.amount >= 0 || t.savingAccount) return false;
    if (t.date < currentPeriod.start || t.date > currentPeriod.end) return false;
    const cat = CATEGORIES[t.cat] || _catExt[t.cat] || {};
    const parentId = cat.parent || cat.id;
    if (excluded.includes(parentId) || excluded.includes(t.cat)) return false;
    return true;
  });

  const total = filteredTxs.reduce((s,t) => s + Math.abs(t.amount), 0);

  // Group by parent category
  const byCat = {};
  filteredTxs.forEach(t => {
    const cat = CATEGORIES[t.cat] || _catExt[t.cat] || {};
    const parentId = cat.parent || cat.id;
    const parentCat = CATEGORIES[parentId] || _catExt[parentId] || cat;
    if (!byCat[parentId]) byCat[parentId] = { name: parentCat.name, color: parentCat.color || M.slate, total: 0 };
    byCat[parentId].total += Math.abs(t.amount);
  });
  const segments = Object.values(byCat).sort((a,b) => b.total - a.total);

  return (
    <div className="m-card m-fade" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
        <div className="m-h3">{card.name}</div>
        <div style={{ fontSize:11, color:M.ink3, fontWeight:500 }}>This period</div>
      </div>
      <div className="m-num" style={{ fontSize:24, fontWeight:600, marginBottom:10 }}>{fmtEur(total)}</div>
      {segments.length > 0 && (
        <>
          <StackedBar height={8} segments={segments.map(s => ({ value:s.total, color:s.color }))}/>
          <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:8 }}>
            {segments.slice(0,4).map(s => (
              <div key={s.name} style={{ display:'flex', alignItems:'center', gap:4, fontSize:10, color:M.ink3 }}>
                <div style={{ width:6, height:6, borderRadius:2, background:s.color }}/>
                {s.name}
              </div>
            ))}
          </div>
        </>
      )}
      {segments.length === 0 && <div style={{ fontSize:13, color:M.ink4 }}>No transactions this period</div>}
    </div>
  );
}

export function ScreenHome() {
  const nav = useNav();
  const { t } = useLang();
  const alloc = useAlloc();
  const { txs, allTxs } = useTxCtx();
  const { profiles, setProfiles } = useProfiles();
  const { recurList } = useRecurCtx();
  const [homeCards] = useLocalStorage('munni_home_cards', HOME_CARDS_DEFAULT);
  const [upcomingDays] = useLocalStorage('munni_upcoming_days', 3);
  const [customGraphCards] = useLocalStorage('munni_custom_graphs', []);
  const [showProfileSwitcher, setShowProfileSwitcher] = React.useState(false);

  const [budgets] = useProfileBudgets();
  const [goals] = useProfileGoals();
  const [debts] = useProfileDebts();

  const [periodDay] = useLocalStorage('munni_period_day', 20);
  const periodHistory = React.useMemo(() => computePeriodHistory(periodDay), [periodDay]);

  const reviewCount = txs.filter(t => t.needsReview).length;
  const budgetTop = [...budgets].sort((a, b) => (b.spent/b.total) - (a.spent/a.total)).slice(0, 3);
  const [pidx, setPidx] = React.useState(periodHistory.length - 1);
  React.useEffect(() => { setPidx(periodHistory.length - 1); }, [periodDay]);
  const pd = periodHistory[pidx] || periodHistory[periodHistory.length - 1];
  const isCurrent = pidx === periodHistory.length - 1;
  const currentUnallocated = alloc ? alloc.unallocated : pd.unallocated;

  const activeProfile = profiles.find(p => p.active) || profiles[0];
  const [connectedAccounts] = useConnectedAccounts();
  const syncKey = React.useMemo(() => getUserSyncKey(), []);
  const [lastSyncedStr] = useLocalStorage(syncKey, null);
  const [notifUnread] = useLocalStorage('munni_notif_unread', 0);
  const [invitations] = useLocalStorage('munni_global_invitations', []);
  const myId = React.useMemo(() => getUserId(), []);
  const pendingInvites = invitations.filter(inv => inv.toId === myId && inv.status === 'pending').length;
  const totalBadge = notifUnread + pendingInvites;
  const isSharedActive = !!(activeProfile?.isShared || (activeProfile?.members||[]).length > 0);
  const activeSharedDataKey = isSharedActive ? `munni_shared_data_${activeProfile?.id}` : 'munni_shared_data_none';
  const [activeSharedData] = useLocalStorage(activeSharedDataKey, { accounts: [], txs: [] });
  const activeAccountIds = (isSharedActive && (activeSharedData?.accounts?.length ?? 0) > 0)
    ? (activeSharedData.accounts || []).map(a => a.id)
    : (activeProfile?.accountIds || []);
  const allAccountsForBalance = [...connectedAccounts, ...(activeSharedData?.accounts || []).filter(sa => !connectedAccounts.some(ca => ca.id === sa.id))];
  const totalBalance = allAccountsForBalance
    .filter(a => a.type === 'checking' && activeAccountIds.includes(a.id))
    .reduce((s, a) => s + (a.balance || 0), 0);

  // Compute period values from txs
  const periodTxs = React.useMemo(() => {
    if (!txs) return [];
    const { start, end } = pd;
    if (!start || !end) return txs;
    return txs.filter(t => t.date >= start && t.date <= end);
  }, [txs, pd]);
  const periodIncome  = React.useMemo(() => periodTxs.filter(t => t.amount > 0).reduce((s,t) => s + t.amount, 0), [periodTxs]);
  const periodExpense = React.useMemo(() => periodTxs.filter(t => t.amount < 0 && !t.savingAccount).reduce((s,t) => s + Math.abs(t.amount), 0), [periodTxs]);
  const periodInvest  = React.useMemo(() => periodTxs.filter(t => t.cat === 'invest').reduce((s,t) => s + Math.abs(t.amount), 0), [periodTxs]);
  const periodSavings = React.useMemo(() => periodTxs.filter(t => t.savingAccount).reduce((s,t) => s + Math.abs(t.amount), 0), [periodTxs]);

  const activateProfile = (id) => {
    setProfiles(ps => ps.map(p => ({ ...p, active: p.id === id })));
    setShowProfileSwitcher(false);
  };

  const isVisible = (id) => {
    const card = homeCards.find(c => c.id === id);
    return card ? card.visible : true;
  };

  // Order home cards as per homeCards config (pinned first, then in user order)
  const orderedCardIds = homeCards.map(c => c.id);

  const renderCard = (id) => {
    switch(id) {
      case 'review':
        if (reviewCount === 0) return null;
        return (
          <div key="review" className="m-tap m-card m-fade" onClick={() => nav.push('reviewSwipe')} style={{
            padding:14, marginBottom:14, border:`1px solid ${M.ochreSoft}`, background:'#FBF6E9',
            display:'flex', alignItems:'center', gap:12,
          }}>
            <div style={{ width:40, height:40, borderRadius:10, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="sliders" size={18} color={M.ochre}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:600 }}>Review {reviewCount} transactions</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('review.title')}</div>
            </div>
            <I name="arrowR" size={16} color={M.ink3}/>
          </div>
        );
      case 'period':
        if (!isVisible('period')) return null;
        return (
          <div key="period" className="m-card m-fade" style={{ padding:'16px 16px 14px', marginBottom:14, border:`1px solid ${M.line}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
              <div className="m-h3">{t('home.period')}</div>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <button className="m-iconbtn m-tap" onClick={() => setPidx(i => Math.max(0, i-1))}
                  style={{ width:28, height:28, opacity:pidx===0?0.3:1 }}><I name="arrowL" size={14}/></button>
                <div style={{ fontSize:12, fontWeight:600, color:M.ink2, width:130, textAlign:'center' }}>{pd.label}</div>
                <button className="m-iconbtn m-tap" onClick={() => setPidx(i => Math.min(periodHistory.length-1, i+1))}
                  style={{ width:28, height:28, opacity:isCurrent?0.3:1 }}><I name="arrowR" size={14}/></button>
              </div>
            </div>
            <PeriodStatRow icon="arrow-dn-right" iconBg={M.sageSoft} iconColor={M.sage}
              label={t('home.income')} value={periodIncome} valueColor={M.sage}
              onClick={() => nav.push('income')}/>
            <div style={{ height:1, background:M.line2 }}/>
            <PeriodStatRow icon="arrow-up-right" iconBg={M.claySoft} iconColor={M.clay}
              label={t('home.spent')} value={periodExpense} valueColor={M.clay}
              onClick={() => nav.push('expenses')}/>
            <div style={{ height:1, background:M.line2 }}/>
            <PeriodStatRow icon="rocket" iconBg={M.violetSoft} iconColor={M.violet}
              label={t('home.invested')} value={periodInvest} valueColor={M.violet}
              onClick={() => nav.push('invested')}/>
            <div style={{ height:1, background:M.line2 }}/>
            <PeriodStatRow icon="piggy" iconBg={M.ochreSoft} iconColor={M.ochre}
              label={t('home.savings')} value={periodSavings} valueColor={M.ochre}
              onClick={() => nav.push('savings')}/>
            <div style={{ height:1, background:M.line2 }}/>
            <PeriodStatRow icon="goal"
              iconBg={isCurrent?(currentUnallocated===0?M.sageSoft:M.ochreSoft):(pd.unallocated===0?M.sageSoft:M.ochreSoft)}
              iconColor={isCurrent?(currentUnallocated===0?M.sage:M.ochre):(pd.unallocated===0?M.sage:M.ochre)}
              label={t('home.allocate')} value={isCurrent?currentUnallocated:pd.unallocated}
              valueColor={isCurrent?(currentUnallocated===0?M.sage:M.ochre):(pd.unallocated===0?M.sage:M.ochre)}
              sub={isCurrent?(currentUnallocated===0?t('home.everyEuroPlanned'):t('home.unallocated')):(pd.unallocated===0?t('home.everyEuroPlanned'):t('home.unallocated'))}
              badge={isCurrent?currentUnallocated>0:pd.unallocated>0}
              onClick={() => nav.push('allocate')}/>
          </div>
        );
      case 'budgets':
        if (!isVisible('budgets')) return null;
        return (
          <div key="budgets" className="m-card m-fade" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div className="m-h3">{t('budgets.title')}</div>
                <div style={{ display:'flex', alignItems:'center', gap:3 }}>
                  {budgets.map(b => (
                    <div key={b.id} style={{ width:7, height:7, borderRadius:999, background: b.spent > b.total ? M.clay : M.sage }}/>
                  ))}
                </div>
              </div>
              <div className="m-tap" onClick={() => nav.push('budgets')} style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:M.ink3, fontWeight:500 }}>
                {t('action.seeAll')} {budgets.length} <I name="caretR" size={12}/>
              </div>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              {budgetTop.map(b => <BudgetMini key={b.id} b={b} onClick={() => nav.push('budgetDetail', { id:b.id })}/>)}
            </div>
          </div>
        );
      case 'goals':
        if (!isVisible('goals')) return null;
        return (
          <div key="goals" className="m-card m-fade" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div className="m-h3">{t('goals.title')}</div>
              <div className="m-tap" onClick={() => nav.push('goals')} style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:M.ink3, fontWeight:500 }}>
                {t('action.seeAll')} <I name="caretR" size={12}/>
              </div>
            </div>
            {(() => {
              const totalTarget = goals.reduce((s,g) => s + g.target, 0);
              const totalCurrent = goals.reduce((s,g) => s + g.current, 0);
              const pct = totalTarget > 0 ? Math.round(totalCurrent/totalTarget*100) : 0;
              return (
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12, paddingBottom:12, borderBottom:`1px solid ${M.line2}` }}>
                  <svg width="44" height="44" viewBox="0 0 44 44">
                    <circle cx="22" cy="22" r="18" fill="none" stroke={M.line2} strokeWidth="4"/>
                    <circle cx="22" cy="22" r="18" fill="none" stroke={M.violet} strokeWidth="4"
                      strokeDasharray={`${pct * 1.131} 113.1`}
                      strokeLinecap="round"
                      transform="rotate(-90 22 22)"
                      style={{ transition:'stroke-dasharray 0.5s ease' }}/>
                    <text x="22" y="26" textAnchor="middle" fontSize="10" fontWeight="700" fill={M.ink} fontFamily="'SF Pro Display',system-ui">{pct}%</text>
                  </svg>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600 }}>{fmtEur(totalCurrent)} {t('goals.saved')}</div>
                    <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{t('budgets.of')} {fmtEur(totalTarget)} {t('goals.totalSaved').toLowerCase()}</div>
                  </div>
                </div>
              );
            })()}
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {goals.map(g => <GoalMiniRow key={g.id} g={g} onClick={() => nav.push('goalDetail', { id:g.id })}/>)}
            </div>
          </div>
        );
      case 'debts':
        if (!isVisible('debts')) return null;
        return (() => {
          const totalDebt = debts.reduce((s, d) => s + d.balance, 0);
          const paidOff = debts.reduce((s, d) => s + (d.original - d.balance), 0);
          const total = debts.reduce((s, d) => s + d.original, 0);
          return (
            <div key="debts" className="m-tap m-card m-fade" onClick={() => nav.push('debts')} style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <div className="m-h3">{t('debts.title')}</div>
                <div className="m-tap" style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:M.ink3, fontWeight:500 }}>
                  {debts.length} {t('debts.activeDebts').toLowerCase()} <I name="caretR" size={12}/>
                </div>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10 }}>
                <div className="m-num" style={{ fontSize:22, fontWeight:600, color:M.clay }}>{fmtEurInt(totalDebt)}</div>
                <div style={{ fontSize:11, color:M.sage, fontWeight:600 }}>{Math.round(paidOff/total*100)}% paid off overall</div>
              </div>
              <div style={{ height:6, borderRadius:999, background:M.line2, overflow:'hidden' }}>
                <div style={{ width:`${Math.round(paidOff/total*100)}%`, height:'100%', background:M.sage }}/>
              </div>
              <div style={{ marginTop:6, fontSize:11, color:M.ink3 }}>
                {debts.length} active debt{debts.length!==1?'s':''} · started at {fmtEur(total)}
              </div>
            </div>
          );
        })();
      case 'upcoming':
        if (!isVisible('upcoming')) return null;
        return (() => {
          const today = new Date();
          today.setHours(0,0,0,0);
          const cutoff = new Date(today);
          cutoff.setDate(cutoff.getDate() + upcomingDays);
          const todayYear = today.getFullYear();
          const todayMonth = today.getMonth();
          // Build upcoming items from recurList using their day field
          const upcomingItems = (recurList || []).filter(r => r.active !== false && r.amount < 0).map(r => {
            // Compute next occurrence date using r.day (day of month)
            const d = r.day;
            let candidate = new Date(todayYear, todayMonth, d);
            if (candidate < today) candidate = new Date(todayYear, todayMonth + 1, d);
            candidate.setHours(0,0,0,0);
            return { ...r, _nextDate: candidate };
          }).filter(r => r._nextDate >= today && r._nextDate <= cutoff)
            .sort((a, b) => a._nextDate - b._nextDate);
          const fmtDate = (d) => d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
          return (
            <div key="upcoming" className="m-card m-fade" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div className="m-h3">{t('upcoming.title')}</div>
                <div className="m-tap" onClick={() => nav.switchTab('recurring')} style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:M.ink3, fontWeight:500 }}>
                  {t('action.seeAll')} <I name="caretR" size={12}/>
                </div>
              </div>
              {upcomingItems.length === 0 ? (
                <div style={{ fontSize:13, color:M.ink3, padding:'8px 0' }}>No upcoming payments in the next {upcomingDays} days.</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                  {upcomingItems.map((r, i) => (
                    <React.Fragment key={r.id}>
                      {i > 0 && <Divider inset={36}/>}
                      <div className="m-tap" onClick={() => nav.push('recurringDetail', { id: r.id })} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 0', cursor:'pointer' }}>
                        <div style={{ width:28, height:28, borderRadius:8, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                          <IcoMDI name={r.icon} size={14} color={M.ink2}/>
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{r.name}</div>
                          {(() => {
                            const daysAway = Math.ceil((r._nextDate - today) / 86400000);
                            const chipColor = daysAway === 0 ? M.clay : daysAway <= 2 ? M.ochre : M.sage;
                            const chipBg = daysAway === 0 ? M.claySoft : daysAway <= 2 ? M.ochreSoft : M.sageSoft;
                            const chipLabel = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`;
                            return (
                              <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:1 }}>
                                <span style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:999, background:chipBg, color:chipColor, textTransform:'uppercase', letterSpacing:'0.04em' }}>{chipLabel}</span>
                              </div>
                            );
                          })()}
                        </div>
                        <div className="m-num" style={{ fontSize:13, fontWeight:600, color:M.clay }}>{fmtEur(r.amount)}</div>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          );
        })();
      case 'investment':
        if (!isVisible('investment')) return null;
        return (
          <div key="investment" className="m-tap m-card m-fade" onClick={() => nav.push('investment')} style={{
            padding:16, marginBottom:14, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', gap:14,
          }}>
            <div style={{ width:40, height:40, borderRadius:10, background:M.violetSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <I name="rocket" size={18} color={M.violet}/>
            </div>
            <div style={{ flex:1 }}>
              <div className="m-h3">{t('invest.cardTitle')}</div>
              <div className="m-num" style={{ fontSize:15, fontWeight:600, marginTop:2 }}>
                {fmtEurInt(PORTFOLIO.total)}
                <span style={{ fontSize:13, color:M.sage, marginLeft:8, fontFamily:M.fontUI, fontWeight:700, background:M.sageSoft, padding:'1px 7px', borderRadius:999 }}>+{PORTFOLIO.pnlPct.toFixed(1)}%</span>
              </div>
            </div>
            <Sparkline data={PORTFOLIO.curve} width={60} height={26} color={M.violet} fill="rgba(94,74,120,0.12)" strokeWidth={1.6}/>
            <I name="caretR" size={14} color={M.ink4}/>
          </div>
        );
      case 'insights':
        if (!isVisible('insights')) return null;
        return (
          <div key="insights" className="m-tap m-card m-fade" onClick={() => nav.switchTab('insights')} style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', gap:14 }}>
            <div style={{ width:40, height:40, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <I name="trending-up" size={18} color={M.sage}/>
            </div>
            <div style={{ flex:1 }}>
              <div className="m-h3">{t('tab.insights')}</div>
              <div style={{ fontSize:12, color:M.ink3, marginTop:2 }}>AI spending analysis</div>
            </div>
            <I name="caretR" size={14} color={M.ink4}/>
          </div>
        );
      case 'quickActions':
        if (!isVisible('quickActions')) return null;
        return (
          <div key="quickActions" className="m-card m-fade" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
            <div className="m-h3" style={{ marginBottom:12 }}>Quick Actions</div>
            <div style={{ display:'flex', gap:10 }}>
              {[
                { label:'Add saving', icon:'piggy', action: () => nav.push('savingAccounts') },
                { label:'Review tx', icon:'sliders', action: () => nav.push('reviewSwipe') },
                { label:'New budget', icon:'goal', action: () => nav.push('budgetCreate') },
              ].map(a => (
                <button key={a.label} className="m-tap" onClick={a.action} style={{ flex:1, padding:'12px 8px', background:M.paper2, border:`1px solid ${M.line}`, borderRadius:12, textAlign:'center', cursor:'pointer', fontFamily:M.fontUI }}>
                  <I name={a.icon} size={20} color={M.ink2}/>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:6 }}>{a.label}</div>
                </button>
              ))}
            </div>
          </div>
        );
      case 'customGraph':
        // Custom graph cards are rendered separately below — skip here
        return null;
      default: return null;
    }
  };

  return (
    <div className="m-screen">
      <StatusBar/>

      {/* Header */}
      <div style={{ padding:'16px 20px 14px', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
        <div className="m-tap" onClick={() => setShowProfileSwitcher(true)} style={{ flexShrink:0 }}>
          <div style={{ position:'relative' }}>
            <ProfileAvatar profile={activeProfile} size={42}/>
            {activeProfile?.isDemo && (
              <div style={{ position:'absolute', bottom:-4, right:-2, fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.ochre, color:'#fff', textTransform:'uppercase', letterSpacing:'0.04em' }}>Demo</div>
            )}
          </div>
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div className="m-num" style={{ fontSize:22, fontWeight:600, letterSpacing:'-0.02em', lineHeight:1 }}>
            {fmtEur(totalBalance)}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:3 }}>
            <div style={{ width:5, height:5, borderRadius:999, background:M.sage, flexShrink:0 }}/>
            <div style={{ fontSize:11, color:M.ink3 }}>{lastSyncedStr ? `${t('home.lastSync')} · ${fmtSyncTime(lastSyncedStr)}` : t('home.notSynced')}</div>
          </div>
        </div>
        <div style={{ position:'relative' }}>
          <button className="m-iconbtn filled m-tap" onClick={() => nav.push('notifications')}><I name="bell" size={18}/></button>
          {totalBadge > 0 && (
            <div style={{ position:'absolute', top:-3, right:-3, minWidth:16, height:16, borderRadius:999, background:M.clay, display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'none' }}>
              <span style={{ fontSize:9, fontWeight:700, color:'#fff', lineHeight:1, padding:'0 3px' }}>{totalBadge > 9 ? '9+' : totalBadge}</span>
            </div>
          )}
        </div>
      </div>

      {sessionStorage.getItem('munni_last_login_method') === 'offline' && (
        <div style={{ margin:'0 16px 12px', padding:'10px 14px', borderRadius:12, background:'#E8F4FD', border:'1.5px solid #B3D9F5', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          <div style={{ width:30, height:30, borderRadius:8, background:'#C6E6FA', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <I name="lock" size={15} color="#2B8FCA"/>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, fontWeight:700, color:'#1B6FA0', letterSpacing:'0.02em' }}>{t('offline.badge')}</div>
            <div style={{ fontSize:11, color:'#4A8CB8', marginTop:1, lineHeight:1.4 }}>{t('offline.homeSub')}</div>
          </div>
        </div>
      )}

      <div className="m-body-scroll">
        {orderedCardIds.map(id => renderCard(id))}
        {customGraphCards.map(cg => (
          <CustomGraphCard key={cg.id} card={cg} txs={txs}/>
        ))}
        <div style={{ height:12 }}/>
      </div>

      <TabBar active="home" onChange={(t) => nav.switchTab(t)}/>

      {/* Profile switcher sheet */}
      {showProfileSwitcher && (
        <Sheet onClose={() => setShowProfileSwitcher(false)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:16 }}>{t('home.switchSpace')}</div>
            <div className="m-card" style={{ border:`1px solid ${M.line}`, padding:'4px 16px', marginBottom:16, maxHeight:280, overflowY:'auto' }}>
              {profiles.map((p, i) => {
                const sharedRaw = p.isShared ? (() => { try { return JSON.parse(localStorage.getItem(`munni_shared_data_${p.id}`) || '{}'); } catch { return {}; } })() : null;
                const sharedAccts = sharedRaw ? (sharedRaw.accounts || []) : null;
                const acctIds = p.isShared ? (sharedAccts || []).map(a => a.id) : (p.accountIds || []);
                const acctCount = acctIds.length;
                const acctLabel = acctCount === 0 ? t('word.noAccounts') : `${acctCount} ${acctCount === 1 ? t('word.account') : t('word.accounts')}`;
                const reviewN = p.isShared
                  ? (sharedRaw?.txs || []).filter(tx => tx.needsReview && acctIds.includes(tx.account)).length
                  : allTxs.filter(tx => tx.needsReview && acctIds.includes(tx.account)).length;
                const hasAction = reviewN > 0;
                const isOwnerShared = !p.isShared && (p.members||[]).length > 0;
                return (
                  <React.Fragment key={p.id}>
                    {i > 0 && <Divider inset={48}/>}
                    <div className="m-tap" onClick={() => activateProfile(p.id)}
                      style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                      <div style={{ position:'relative', flexShrink:0 }}>
                        <ProfileAvatar profile={p} size={36}/>
                        {hasAction && (
                          <div style={{ position:'absolute', top:-2, right:-2, width:10, height:10, borderRadius:999, background:M.ochre, border:`2px solid ${M.paper}` }}/>
                        )}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:14, fontWeight:600, display:'flex', alignItems:'center', gap:5 }}>
                          {p.localName || p.name}
                          {p.isShared && (p.members||[]).some(m => m.userId !== myId) && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.violetSoft||'#EEE8FF', color:M.violet||'#7B61FF', textTransform:'uppercase' }}>Shared</span>}
                          {isOwnerShared && <span style={{ fontSize:8, fontWeight:700, padding:'1px 5px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase' }}>Shared</span>}
                        </div>
                        <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>
                          {p.isShared ? `${t('space.by')} ${(p.ownerDisplay || '').split(' ')[0]}` : acctLabel}
                          {hasAction && <span style={{ marginLeft:6, color:M.ochre, fontWeight:600 }}>· {reviewN} {t('review.title')}</span>}
                        </div>
                      </div>
                      {p.active ? (
                        <div style={{ width:20, height:20, borderRadius:999, background:M.sage, display:'flex', alignItems:'center', justifyContent:'center' }}>
                          <I name="check" size={11} color="#fff" stroke={2.5}/>
                        </div>
                      ) : (
                        <div style={{ width:20, height:20, borderRadius:999, border:`2px solid ${M.line2}` }}/>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            <div className="m-tap" onClick={() => { setShowProfileSwitcher(false); nav.push('spaces'); }}
              style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'12px 0', color:M.sage, fontSize:14, fontWeight:600 }}>
              {t('home.manageSpaces')} <I name="caretR" size={14} color={M.sage}/>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function PeriodLegendRow({ color, label, value, dim }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: color }}/>
      <div style={{ fontSize: 12, color: dim ? M.ink4 : M.ink2, flex: 1 }}>{label}</div>
      <div className="m-num" style={{ fontSize: 13, fontWeight: 600, color: dim ? M.ink3 : M.ink }}>{fmtEurInt(value)}</div>
    </div>
  );
}

function PeriodStatRow({ icon, iconBg, iconColor, label, value, valueColor, sub, onClick, badge }) {
  return (
    <div className="m-tap" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
      <div style={{ position: 'relative', width: 36, height: 36, borderRadius: 10, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <I name={icon} size={16} color={iconColor}/>
        {badge && (
          <div style={{ position: 'absolute', top: -3, right: -3, width: 14, height: 14, borderRadius: 999, background: M.ochre, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 9, color: '#fff', fontWeight: 700, lineHeight: 1 }}>!</span>
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: M.ink4, marginTop: 1 }}>{sub}</div>}
      </div>
      <div className="m-num" style={{ fontSize: 15, fontWeight: 600, color: valueColor || M.ink }}>{fmtEurInt(value)}</div>
      <I name="caretR" size={14} color={M.ink4}/>
    </div>
  );
}

function GoalMiniRow({ g, onClick }) {
  const pct = (g.current / g.target) * 100;
  return (
    <div className="m-tap" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: g.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <I name={g.icon} size={14} color={g.color}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{g.name}</div>
          <div className="m-num" style={{ fontSize: 12, fontWeight: 600, color: M.ink2 }}>{fmtEurInt(g.current)}</div>
        </div>
        <div style={{ height: 4, borderRadius: 999, background: M.line2, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: g.color }}/>
        </div>
      </div>
      <I name="caretR" size={14} color={M.ink4}/>
    </div>
  );
}

function budgetDaysLeft(b) {
  const TODAY = new Date('2026-02-18');
  const periodStart = new Date('2026-01-20');
  const elapsed = Math.floor((TODAY - periodStart) / 86400000) % b.periodDays;
  return b.periodDays - elapsed;
}

function BudgetMini({ b, onClick }) {
  const ratio = b.spent / b.total;
  const over = ratio > 1;
  const color = budgetColor(ratio);
  const left = b.total - b.spent;
  return (
    <div className="m-tap" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: budgetSoft(ratio), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <I name={b.icon} size={16} color={color}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{b.name}</div>
          <div className="m-num" style={{ fontSize: 12, fontWeight: 600, color: over ? M.clay : M.ink2 }}>
            {over ? `−${fmtEurInt(Math.abs(left))}` : `${fmtEurInt(left)} left`}
          </div>
        </div>
        <div style={{ height: 5, marginTop: 6, borderRadius: 999, background: M.line2, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: `${Math.min(100, ratio * 100)}%`, height: '100%', background: color }}/>
          {over && <div style={{ flex: 1, background: `repeating-linear-gradient(45deg, ${M.clay} 0 3px, ${M.claySoft} 3px 6px)` }}/>}
        </div>
        <div style={{ fontSize:10, color:M.ink4, marginTop:4 }}>{budgetDaysLeft(b)}d left</div>
      </div>
    </div>
  );
}

function GoalCard({ g, onClick }) {
  const pct = (g.current / g.target) * 100;
  return (
    <div className="m-tap" onClick={onClick} style={{
      flexShrink: 0, width: 168, padding: 14, borderRadius: 14, background: M.paper2,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: M.card, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <I name={g.icon} size={14} color={g.color}/>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{g.name}</div>
      </div>
      <div className="m-num" style={{ fontSize: 18, fontWeight: 600 }}>{fmtEurInt(g.current)}</div>
      <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>of {fmtEurInt(g.target)} · by {g.by}</div>
      <div style={{ height: 4, marginTop: 10, borderRadius: 999, background: M.line, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: g.color }}/>
      </div>
      <div style={{ fontSize: 10, color: M.ink3, marginTop: 6, fontWeight: 500 }}>{pct.toFixed(0)}% · +{fmtEurInt(g.monthly)}/mo</div>
    </div>
  );
}
