import React from 'react';
import { fmtEur } from '../../shared/utils/format.js';
import { GOALS } from './data.js';
import { M, I, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav } from '../../app/nav.jsx';
import { StackedBar } from '../../shared/components/Charts.jsx';
import { useProfileGoals } from '../../app/providers.jsx';
import { FormRow } from '../events/Events.jsx';


export function ScreenGoals() {
  const nav = useNav();
  const { t } = useLang();
  const [goals] = useProfileGoals();
  const total = goals.reduce((s, g) => s + g.current, 0);
  const active = goals.filter(g => g.current < g.target);
  const achieved = goals.filter(g => g.current >= g.target);

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.goals')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap"><I name="plus" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-card" style={{ padding: 18, marginBottom: 16, border: `1px solid ${M.line}` }}>
          <div className="m-cap">{t('goals.totalSaved')}</div>
          <div className="m-num" style={{ fontSize: 28, fontWeight: 600, fontFamily: M.fontDisp, marginTop: 4 }}>{fmtEur(total)}</div>
          <div style={{ fontSize: 12, color: M.ink3, marginTop: 2 }}>across {goals.length} goals Â· linked to ING Savings</div>
          <div style={{ marginTop: 14 }}>
            <StackedBar segments={goals.map(g => ({ value: g.current, color: g.color }))} height={8}/>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {goals.map(g => (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: g.color }}/>
                <span style={{ color: M.ink2 }}>{g.name}</span>
              </div>
            ))}
          </div>
        </div>

        {active.length > 0 && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingLeft: 4 }}>
              <div className="m-cap">{t('goals.active')} Â· {active.length}</div>
              <button className="m-tap" style={{ background: 'transparent', border: 'none', fontSize: 12, color: M.sage, fontWeight: 600, cursor: 'pointer', fontFamily: M.fontUI }}>Auto-allocate</button>
            </div>
            <div className="m-card" style={{ padding: '4px 16px', marginBottom: 16, border: `1px solid ${M.line}` }}>
              {active.map((g, i, a) => (
                <React.Fragment key={g.id}>
                  <GoalListRow g={g} onClick={() => nav.push('goalDetail', { id: g.id })}/>
                  {i < a.length - 1 && <Divider inset={52}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}

        {achieved.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>{t('goals.achieved')} Â· {achieved.length}</div>
            <div className="m-card" style={{ padding: '4px 16px', marginBottom: 16, border: `1px solid ${M.line}` }}>
              {achieved.map((g, i, a) => (
                <React.Fragment key={g.id}>
                  <div className="m-tap" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', opacity: 0.7 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: M.sageSoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <I name="check" size={16} color={M.sage} stroke={2.5}/>
                    </div>
                    <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{g.name}</div>
                    <div className="m-num" style={{ fontSize: 13, fontWeight: 600 }}>{fmtEur(g.target)}</div>
                  </div>
                  {i < a.length - 1 && <Divider inset={48}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function GoalListRow({ g, onClick }) {
  const pct = (g.current / g.target) * 100;
  const remaining = g.target - g.current;
  const monthsLeft = Math.ceil(remaining / g.monthly);
  return (
    <div className="m-tap" onClick={onClick} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 0' }}>
      <div style={{ width: 40, height: 40, borderRadius: 11, background: g.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
        <I name={g.icon} size={18} color={g.color}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{g.name}</div>
          <div className="m-num" style={{ fontSize: 13, fontWeight: 600 }}>{fmtEur(g.current)}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: M.ink3 }}>of {fmtEur(g.target)} Â· by {g.by}</div>
          <div style={{ fontSize: 11, color: M.ink3 }}>{fmtEur(g.monthly)}/mo Â· {monthsLeft}mo left</div>
        </div>
        <div style={{ height: 5, borderRadius: 999, background: M.line2, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: g.color }}/>
        </div>
        <div style={{ marginTop: 3, fontSize: 10, color: M.ink4 }}>{pct.toFixed(0)}% Â· {fmtEur(remaining)} to go</div>
      </div>
      <I name="caretR" size={14} color={M.ink4} style={{ marginTop: 6 }}/>
    </div>
  );
}

function GoalCardLarge({ g, onClick }) {
  const { t } = useLang();
  const pct = (g.current / g.target) * 100;
  return (
    <div className="m-card m-tap" onClick={onClick} style={{ padding: 16, border: `1px solid ${M.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: g.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <I name={g.icon} size={20} color={g.color}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{g.name}</div>
            <div className="m-num" style={{ fontSize: 12, color: M.ink3, fontWeight: 600 }}>{pct.toFixed(0)}%</div>
          </div>
          <div style={{ fontSize: 11, color: M.ink3, marginTop: 2 }}>by {g.by} Â· {fmtEur(g.monthly)}/mo</div>
        </div>
      </div>
      <div style={{ marginTop: 12, height: 6, borderRadius: 999, background: M.line2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: g.color }}/>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: M.ink3 }}>
        <span><span className="m-num" style={{ color: M.ink2, fontWeight: 600 }}>{fmtEur(g.current)}</span> {t('goals.saved')}</span>
        <span>{t('budgets.of')} {fmtEur(g.target)}</span>
      </div>
    </div>
  );
}

export function ScreenGoalDetail({ params }) {
  const nav = useNav();
  const [goals] = useProfileGoals();
  const g = goals.find(x => x.id === params?.id) || goals[0];
  const pct = (g.current / g.target) * 100;
  const monthsLeft = Math.ceil((g.target - g.current) / g.monthly);

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title=""
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap"><I name="edit" size={18}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
          <div style={{ width: 70, height: 70, borderRadius: 20, background: g.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <I name={g.icon} size={32} color={g.color}/>
          </div>
          <div className="m-h2">{g.name}</div>
          <div style={{ fontSize: 13, color: M.ink3, marginTop: 6 }}>by {g.by}</div>
        </div>

        <div className="m-card" style={{ padding: 20, marginBottom: 14, border: `1px solid ${M.line}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div className="m-num" style={{ fontSize: 32, fontWeight: 600, fontFamily: M.fontDisp, letterSpacing: '-0.02em' }}>{fmtEur(g.current)}</div>
            <div style={{ fontSize: 13, color: M.ink3 }}>of {fmtEur(g.target)}</div>
          </div>
          <div style={{ marginTop: 14, height: 10, borderRadius: 999, background: M.line2, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: g.color }}/>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: M.ink3 }}>
            <span>{pct.toFixed(0)}% complete</span>
            <span>{monthsLeft} months left</span>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Plan</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 14, border: `1px solid ${M.line}` }}>
          <FormRow label="Monthly" value={fmtEur(g.monthly)} icon="cal"/>
          <Divider inset={0}/>
          <FormRow label="Required" value={fmtEur(g.monthly)} caretR/>
          <Divider inset={0}/>
          <FormRow label="Source" value="ING Savings"/>
        </div>

        <button className="m-btn sage m-tap" style={{ width: '100%', marginBottom: 8 }}>
          <I name="plus" size={16}/> Add funds
        </button>
      </div>
    </div>
  );
}

