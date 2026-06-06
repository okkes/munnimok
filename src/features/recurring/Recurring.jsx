import React from 'react';
import { fmtEur } from '../../shared/utils/format.js';
import { RECURRING, RECURRING_SUGGESTIONS } from './data.js';
import { M, I, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav, TabBar } from '../../app/nav.jsx';
import { BarChart, StackedBar } from '../../shared/components/Charts.jsx';
import { Stat } from '../../app/providers.jsx';
import { DetailRow } from '../transactions/Tx.jsx';
import { Toggle, FormRow } from '../events/Events.jsx';

export const ordinal = (n) => {
  const v = n % 100;
  return n + (['th','st','nd','rd'][(v-20)%10] || ['th','st','nd','rd'][v] || 'th');
};

function RecurringRow({ r, onClick }) {
  const isPaid = r.txIds?.length > 0;
  return (
    <div className="m-tap" onClick={onClick} style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
      <div style={{ width:36, height:36, borderRadius:10, background:isPaid?M.sageSoft:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', position:'relative', flexShrink:0 }}>
        <I name={r.icon} size={18} color={isPaid?M.sage:M.ink2}/>
        {isPaid && (
          <div style={{ position:'absolute', bottom:-2, right:-2, width:14, height:14, borderRadius:999, background:M.sage, border:`2px solid ${M.paper}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <I name="check" size={7} color="#fff" stroke={3}/>
          </div>
        )}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
          <div style={{ fontSize:14, fontWeight:500 }}>{r.name}</div>
          {r.luxury && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.violetSoft, color:M.violet, textTransform:'uppercase', letterSpacing:'0.05em' }}>luxury</span>}
        </div>
        <div style={{ fontSize:11, color:M.ink3 }}>
          {isPaid ? 'Paid this period' : `Due ${ordinal(r.day)} Â· next ${r.next}`}
          {r.until ? ` Â· ends ${r.until}` : ''}
        </div>
      </div>
      <div className="m-num" style={{ fontSize:14, fontWeight:600 }}>{fmtEur(r.amount)}</div>
      <I name="caretR" size={12} color={M.ink4}/>
    </div>
  );
}

function RecurringContent({ showTabBar = false }) {
  const nav   = useNav();
  const { t } = useLang();
  const [view, setView] = React.useState('period');

  const costs     = RECURRING.filter(r => r.amount < 0 && r.active);
  const fixed     = costs.filter(r => r.type === 'fixed');
  const subs      = costs.filter(r => r.type === 'subs');
  const total     = costs.reduce((s, r) => s + Math.abs(r.amount), 0);
  const paid      = costs.filter(r => r.txIds?.length).reduce((s, r) => s + Math.abs(r.amount), 0);
  const remaining = total - paid;
  const luxTotal  = subs.reduce((s, r) => s + Math.abs(r.amount), 0);
  const yearTotal = total * 12;
  const yearPaid  = total * 2;
  const yearLeft  = yearTotal - yearPaid;

  const dispTotal = view === 'period' ? total : yearTotal;
  const dispPaid  = view === 'period' ? paid  : yearPaid;
  const dispLeft  = view === 'period' ? remaining : yearLeft;

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('screen.recurring')}
        leading={showTabBar ? null : <button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap" onClick={() => nav.push('recurringCreate')}><I name="plus" size={20}/></button>}
      />

      <div style={{ padding:'0 20px 14px', flexShrink:0 }}>
        <div style={{ display:'flex', background:M.paper2, borderRadius:12, padding:3, gap:3 }}>
          {[{id:'period',label:'This period'},{id:'year',label:'This year'}].map(v => (
            <button key={v.id} onClick={() => setView(v.id)} className="m-tap" style={{
              flex:1, height:34, borderRadius:10, border:'none', fontFamily:M.fontUI, cursor:'pointer',
              background: view===v.id ? M.card : 'transparent',
              boxShadow: view===v.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              color: view===v.id ? M.ink : M.ink3,
              fontSize:13, fontWeight: view===v.id ? 600 : 500,
            }}>{v.label}</button>
          ))}
        </div>
      </div>

      <div className="m-body-scroll">
        <div className="m-card" style={{ padding:18, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:14 }}>
            <Stat label={view==='period'?'Period total':'Year total'} value={fmtEur(dispTotal)} color={M.ink}/>
            <Stat label="Paid" value={fmtEur(dispPaid)} color={M.sage}/>
            <Stat label="Remaining" value={fmtEur(dispLeft)} color={dispLeft>0?M.ochre:M.sage}/>
          </div>
          <StackedBar segments={[
            { value:dispPaid, color:M.sage },
            { value:dispLeft, color:M.line2 },
          ]} height={6}/>
          {luxTotal > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:12 }}>
              <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.violetSoft, color:M.violet, textTransform:'uppercase', letterSpacing:'0.05em' }}>luxury</span>
              <div style={{ fontSize:11, color:M.ink3 }}>{fmtEur(luxTotal)}/period Â· {fmtEur(luxTotal*12)}/year</div>
            </div>
          )}
        </div>

        {RECURRING_SUGGESTIONS.length > 0 && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, paddingLeft:4 }}>
              <div className="m-cap">Detected by AI Â· {RECURRING_SUGGESTIONS.length}</div>
              <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:999, background:M.sageSoft, color:M.sage, textTransform:'uppercase', letterSpacing:'0.05em' }}>new</span>
            </div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, background:M.sageSoft, border:`1px solid ${M.sage}` }}>
              {RECURRING_SUGGESTIONS.map((s, i, a) => (
                <React.Fragment key={s.id}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background:'rgba(255,255,255,0.7)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name={s.icon} size={18} color={M.sage}/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:500, marginBottom:2 }}>{s.name}</div>
                      <div style={{ fontSize:11, color:M.ink3 }}>{s.pattern} Â· {s.confidence}% confidence</div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:6 }}>
                      <div className="m-num" style={{ fontSize:14, fontWeight:600 }}>{fmtEur(s.amount)}</div>
                      <div style={{ display:'flex', gap:6 }}>
                        <button className="m-tap" style={{ width:28, height:28, borderRadius:8, border:'none', background:M.sage, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                          <I name="check" size={12} color="#fff" stroke={2.5}/>
                        </button>
                        <button className="m-tap" style={{ width:28, height:28, borderRadius:8, border:`1px solid rgba(0,0,0,0.1)`, background:'rgba(255,255,255,0.6)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
                          <I name="x" size={12} color={M.ink3}/>
                        </button>
                      </div>
                    </div>
                  </div>
                  {i < a.length-1 && <Divider inset={48}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}

        {fixed.length > 0 && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Fixed costs Â· {fixed.length}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
            {fixed.map((r, i, a) => (
              <React.Fragment key={r.id}>
                <RecurringRow r={r} onClick={() => nav.push('recurringDetail', { id:r.id })}/>
                {i < a.length-1 && <Divider inset={48}/>}
              </React.Fragment>
            ))}
          </div>
        </>}

        {subs.length > 0 && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Subscriptions Â· {subs.length}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
            {subs.map((r, i, a) => (
              <React.Fragment key={r.id}>
                <RecurringRow r={r} onClick={() => nav.push('recurringDetail', { id:r.id })}/>
                {i < a.length-1 && <Divider inset={48}/>}
              </React.Fragment>
            ))}
          </div>
        </>}

        {RECURRING.filter(r => r.amount < 0 && !r.active).length > 0 && <>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4, color:M.ink4 }}>Inactive</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:20, border:`1px solid ${M.line2}`, opacity:0.55 }}>
            {RECURRING.filter(r => r.amount < 0 && !r.active).map((r, i, a) => (
              <React.Fragment key={r.id}>
                <RecurringRow r={r} onClick={() => nav.push('recurringDetail', { id:r.id })}/>
                {i < a.length-1 && <Divider inset={48}/>}
              </React.Fragment>
            ))}
          </div>
        </>}
      </div>
      {showTabBar && <TabBar active="recurring" onChange={(t) => nav.switchTab(t)}/>}
    </div>
  );
}

export function ScreenRecurring()    { return <RecurringContent showTabBar={false}/>; }
export function ScreenRecurringTab() { return <RecurringContent showTabBar={true}/>; }

export function ScreenRecurringDetail({ params }) {
  const nav = useNav();
  const { txs: allTxs } = useTxCtx();
  const [showAddTx, setShowAddTx] = React.useState(false);
  const r = RECURRING.find(x => x.id === params?.id) || RECURRING[0];
  const txs = allTxs.filter(t => r.txIds?.includes(t.id));
  const seed = Math.abs(r.amount);
  const history = [seed*0.97, seed, seed*1.02, seed*0.99, seed*1.01, Math.abs(r.amount)];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title=""
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<>
          <button className="m-iconbtn m-tap"><I name="edit" size={18}/></button>
          <button className="m-iconbtn m-tap"><I name="more" size={18}/></button>
        </>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign:'center', padding:'8px 0 20px' }}>
          <div style={{ width:64, height:64, borderRadius:18, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
            <I name={r.icon} size={28} color={M.ink2}/>
          </div>
          <div className="m-h2">{r.name}</div>
          <div style={{ display:'flex', justifyContent:'center', gap:6, marginTop:10, flexWrap:'wrap' }}>
            <span style={{ fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:999, background:M.paper2, color:M.ink2, border:`1px solid ${M.line}` }}>
              {r.type === 'fixed' ? 'Fixed cost' : 'Subscription'}
            </span>
            {r.luxury && (
              <span style={{ fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:999, background:M.violetSoft, color:M.violet }}>Luxury</span>
            )}
            {!r.active && (
              <span style={{ fontSize:11, fontWeight:600, padding:'4px 10px', borderRadius:999, background:M.claySoft, color:M.clay }}>Inactive</span>
            )}
          </div>
        </div>

        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          <DetailRow label="Amount" value={fmtEur(r.amount)} mono/>
          <Divider inset={0}/>
          <DetailRow label="Billing day" value={`${ordinal(r.day)} of each month`}/>
          <Divider inset={0}/>
          <DetailRow label="Active since" value={r.since || 'â€”'}/>
          <Divider inset={0}/>
          <DetailRow label="Duration" value={r.until ? `Until ${r.until}` : 'Ongoing â€” no end date'}/>
          <Divider inset={0}/>
          <DetailRow label="Next payment" value={r.next || 'â€”'}/>
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
          <div className="m-cap" style={{ marginBottom:10 }}>History Â· 6 periods</div>
          <BarChart data={history} labels={['Sepâ€“Oct','Octâ€“Nov','Novâ€“Dec','Decâ€“Jan','Janâ€“Feb','Febâ€“Mar']} showValues height={84} accent={M.sage}/>
        </div>

        {(r.type === 'subs' || r.type === 'fixed') && (
          <div className="m-card m-tap" onClick={() => nav.push('recurringDeals', { id:r.id })} style={{ padding:14, marginBottom:14, background:M.ochreSoft, border:`1px solid ${M.ochre}33`, display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:38, height:38, borderRadius:10, background:'rgba(255,255,255,0.65)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="tag" size={18} color={M.ochre}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:600 }}>Find better deals</div>
              <div style={{ fontSize:11, color:M.ink2, marginTop:2 }}>Compare alternatives and save money</div>
            </div>
            <I name="caretR" size={12} color={M.ochre}/>
          </div>
        )}

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, paddingLeft:4 }}>
          <div className="m-cap">Linked transactions Â· {txs.length}</div>
          <button className="m-tap" onClick={() => setShowAddTx(true)}
            style={{ display:'flex', alignItems:'center', gap:4, background:'transparent', border:'none', color:M.ink3, fontSize:12, fontWeight:600, fontFamily:M.fontUI, cursor:'pointer', padding:'4px 0' }}>
            <I name="plus" size={12} color={M.ink3}/> Add
          </button>
        </div>
        <div className="m-card" style={{ padding:'0 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {txs.length === 0 ? (
            <div className="m-tap" onClick={() => setShowAddTx(true)} style={{ padding:'20px 0', display:'flex', alignItems:'center', gap:10 }}>
              <I name="plus" size={16} color={M.ink4}/>
              <div style={{ fontSize:13, color:M.ink4 }}>Link a transaction to this recurring cost</div>
            </div>
          ) : txs.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <TxRow tx={t} showDate onClick={() => nav.push('txDetail', { id:t.id })}/>
              {i < a.length-1 && <Divider inset={50}/>}
            </React.Fragment>
          ))}
        </div>

        <button className="m-btn outline m-tap" style={{ width:'100%', marginBottom:10 }} onClick={() => setShowAddTx(true)}>
          <I name="plus" size={16}/> Add transaction
        </button>
        <button className="m-btn m-tap" style={{ width:'100%', marginBottom:20, background:'transparent', color:M.clay, borderColor:M.claySoft }}>
          Delete recurring cost
        </button>
      </div>
      {showAddTx && <RecurringAddTxSheet rid={r.id} cat={r.cat} onClose={() => setShowAddTx(false)}/>}
    </div>
  );
}

function RecurringAddTxSheet({ rid, cat, onClose }) {
  const nav = useNav();
  const { txs } = useTxCtx();
  const already = RECURRING.find(r => r.id === rid)?.txIds || [];
  const candidates = txs.filter(t => t.cat === cat && t.amount < 0 && !already.includes(t.id));
  return (
    <Sheet onClose={onClose}>
      <div style={{ padding:'4px 20px 32px', maxHeight:'72vh', overflowY:'auto' }}>
        <div className="m-h2" style={{ marginBottom:4 }}>Link a transaction</div>
        <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>Attach an existing transaction to this recurring cost.</div>
        {candidates.length === 0 ? (
          <div style={{ padding:'24px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>No unlinked transactions in this category</div>
        ) : (
          <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}`, marginBottom:16 }}>
            {candidates.slice(0, 8).map((t, i, a) => (
              <React.Fragment key={t.id}>
                <TxRow tx={t} showDate onClick={onClose}/>
                {i < a.length-1 && <Divider inset={50}/>}
              </React.Fragment>
            ))}
          </div>
        )}
        <button className="m-btn outline m-tap" style={{ width:'100%' }} onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  );
}

export function ScreenRecurringCreate() {
  const nav = useNav();
  const { t } = useLang();
  const [type,    setType]    = React.useState('subs');
  const [luxury,  setLuxury]  = React.useState(false);
  const [endless, setEndless] = React.useState(true);
  const [icon,    setIcon]    = React.useState('film');
  const icons = ['film','house','flame','health','car','shop','rocket','heart','globe','star','bag','wave'];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Add recurring"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="x" size={20}/></button>}
        trailing={<button className="m-tap" style={{ background:'transparent', border:'none', fontSize:14, fontWeight:600, color:M.sage, fontFamily:M.fontUI }} onClick={() => nav.pop()}>{t('action.save')}</button>}
      />
      <div className="m-body-scroll">
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Type</div>
        <div style={{ display:'flex', background:M.paper2, borderRadius:12, padding:3, gap:3, marginBottom:6 }}>
          {[{id:'fixed',label:'Fixed cost'},{id:'subs',label:'Subscription'}].map(t => (
            <button key={t.id} onClick={() => setType(t.id)} className="m-tap" style={{
              flex:1, height:34, borderRadius:10, border:'none', fontFamily:M.fontUI, cursor:'pointer',
              background: type===t.id ? M.card : 'transparent',
              boxShadow: type===t.id ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              color: type===t.id ? M.ink : M.ink3,
              fontSize:13, fontWeight: type===t.id ? 600 : 500,
            }}>{t.label}</button>
          ))}
        </div>
        <div style={{ fontSize:11, color:M.ink3, marginBottom:18, paddingLeft:4 }}>
          {type === 'fixed' ? 'Rent, utilities, insurance â€” predictable monthly outflows.' : 'Streaming, apps, memberships â€” cancellable anytime.'}
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Icon</div>
        <div style={{ display:'flex', gap:8, overflowX:'auto', paddingBottom:4, marginBottom:16 }}>
          {icons.map(ic => (
            <button key={ic} onClick={() => setIcon(ic)} className="m-tap" style={{
              flexShrink:0, width:48, height:48, borderRadius:12,
              background:icon===ic?M.ink:M.card, border:`1px solid ${icon===ic?M.ink:M.line}`,
              display:'flex', alignItems:'center', justifyContent:'center',
            }}>
              <I name={ic} size={20} color={icon===ic?'#fff':M.ink2}/>
            </button>
          ))}
        </div>

        <div className="m-card" style={{ padding:4, marginBottom:14, border:`1px solid ${M.line}` }}>
          <FormRow label="Name" value="" placeholder={type==='fixed'?'e.g. Rent':'e.g. Netflix'}/>
          <Divider inset={16}/>
          <FormRow label="Amount" value="â‚¬0,00" icon="wallet"/>
          <Divider inset={16}/>
          <FormRow label="Billing day" value="1st of the month" caretR/>
          <Divider inset={16}/>
          <FormRow label="Starting from" value="Feb 2026" caretR/>
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
          <div className="m-tap" onClick={() => setEndless(!endless)} style={{ display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>Ongoing â€” no end date</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>Runs indefinitely until you cancel it</div>
            </div>
            <Toggle on={endless}/>
          </div>
          {!endless && (
            <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${M.line2}` }}>
              <FormRow label="End date" value="â€”" caretR/>
            </div>
          )}
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:20, border:`1px solid ${M.line}` }}>
          <div className="m-tap" onClick={() => setLuxury(!luxury)} style={{ display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}>
            <div style={{ width:36, height:36, borderRadius:10, background:luxury?M.violetSoft:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="star" size={16} color={luxury?M.violet:M.ink3}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>Mark as luxury</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>Optional / non-essential spending</div>
            </div>
            <Toggle on={luxury}/>
          </div>
        </div>

        <button className="m-btn sage m-tap" style={{ width:'100%', marginBottom:18 }} onClick={() => nav.pop()}>
          Add recurring cost
        </button>
      </div>
    </div>
  );
}

export function ScreenRecurringDeals({ params }) {
  const nav = useNav();
  const r = RECURRING.find(x => x.id === params?.id) || RECURRING[0];

  const DEALS_MAP = {
    r3: [
      { id:'d1', name:'Spotify Family', price:-15.99, saving:null, desc:'Up to 6 accounts â€” â‚¬2.67/person', badge:'Best for groups', badgeColor:M.sage },
      { id:'d2', name:'YouTube Music', price:-9.99, saving:0, desc:'Similar library + YouTube integration', badge:'Same price', badgeColor:M.ink3 },
      { id:'d3', name:'Deezer Premium', price:-10.99, saving:-1.00, desc:'High-fidelity FLAC audio', badge:'â‚¬1 more/mo', badgeColor:M.clay },
      { id:'d4', name:'Deezer Free', price:0, saving:9.99, desc:'Ad-supported, 64 Mbit quality', badge:'Free option', badgeColor:M.sage },
    ],
    r4: [
      { id:'d1', name:'Netflix Standard with Ads', price:-7.99, saving:6.00, desc:'Full library, short ad breaks per hour', badge:'Save â‚¬6/mo', badgeColor:M.sage },
      { id:'d2', name:'Disney+', price:-8.99, saving:5.00, desc:'Disney, Marvel, Star Wars, Pixar', badge:'Save â‚¬5/mo', badgeColor:M.sage },
      { id:'d3', name:'Prime Video', price:-8.99, saving:5.00, desc:'Included with Amazon Prime', badge:'Save â‚¬5/mo', badgeColor:M.sage },
      { id:'d4', name:'Apple TV+', price:-9.99, saving:4.00, desc:'Award-winning originals only', badge:'Save â‚¬4/mo', badgeColor:M.sage },
    ],
  };

  const fallbackDeals = [
    { id:'d1', name:'Comparable plan A', price: r.amount * 0.82, saving: Math.abs(r.amount) * 0.18, desc:'Same core features at a lower tier', badge:'Save ~18%', badgeColor:M.sage },
    { id:'d2', name:'Comparable plan B', price: r.amount * 0.92, saving: Math.abs(r.amount) * 0.08, desc:'Basic tier, fewer extras', badge:'Save ~8%', badgeColor:M.sage },
    { id:'d3', name:'Annual plan', price: r.amount * 0.83, saving: Math.abs(r.amount) * 0.17, desc:'Pay once a year, 2 months free', badge:'Save 2 months', badgeColor:M.ochre },
  ];

  const deals = DEALS_MAP[r.id] || fallbackDeals;
  const annualSavings = deals.filter(d => d.saving > 0).sort((a,b) => b.saving - a.saving);
  const best = annualSavings[0];

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Better deals"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-card" style={{ padding:16, marginBottom:16, border:`1px solid ${M.line}` }}>
          <div className="m-cap" style={{ marginBottom:10 }}>Your current plan</div>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:42, height:42, borderRadius:12, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name={r.icon} size={20} color={M.ink2}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:15, fontWeight:600 }}>{r.name}</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{r.type === 'subs' ? 'Subscription' : 'Fixed cost'} Â· billed monthly</div>
            </div>
            <div className="m-num" style={{ fontSize:17, fontWeight:700 }}>{fmtEur(r.amount)}</div>
          </div>
          {best && (
            <div style={{ marginTop:12, padding:'10px 12px', borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', gap:10 }}>
              <I name="tag" size={14} color={M.sage}/>
              <div style={{ fontSize:12, color:M.ink2, lineHeight:1.4 }}>
                Best alternative: <span style={{ fontWeight:700, color:M.sage }}>{fmtEur(best.saving)}/month</span> saved Â· {fmtEur(best.saving * 12)}/year
              </div>
            </div>
          )}
        </div>

        <div className="m-cap" style={{ marginBottom:10, paddingLeft:4 }}>Alternatives Â· {deals.length}</div>
        <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
          {deals.map(d => {
            const bColor = d.badgeColor === M.ink3 ? M.ink3 : d.badgeColor;
            const bBg    = d.badgeColor === M.ink3 ? M.paper2 : d.badgeColor + '22';
            return (
              <div key={d.id} className="m-card" style={{ padding:16, border:`1px solid ${M.line}`, display:'flex', gap:12, alignItems:'flex-start' }}>
                <div style={{ width:42, height:42, borderRadius:12, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:16, fontWeight:700, color:M.ink2 }}>
                  {d.name[0]}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4, gap:8 }}>
                    <div style={{ fontSize:14, fontWeight:600 }}>{d.name}</div>
                    <div className="m-num" style={{ fontSize:14, fontWeight:700, flexShrink:0 }}>
                      {d.price === 0 ? 'Free' : fmtEur(d.price)}
                    </div>
                  </div>
                  <div style={{ fontSize:11, color:M.ink3, marginBottom:10, lineHeight:1.4 }}>{d.desc}</div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:999, background:bBg, color:bColor, textTransform:'uppercase', letterSpacing:'0.04em' }}>
                      {d.badge}
                    </span>
                    <button className="m-tap" style={{ fontSize:12, fontWeight:600, color:M.sage, background:'transparent', border:'none', fontFamily:M.fontUI, cursor:'pointer', padding:0 }}>
                      Explore â†’
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding:14, borderRadius:12, background:M.paper2, border:`1px solid ${M.line2}`, display:'flex', gap:10, marginBottom:20 }}>
          <I name="help" size={15} color={M.ink4}/>
          <div style={{ fontSize:11, color:M.ink3, lineHeight:1.5 }}>
            Prices are approximate and may vary by region or active promotions. Check the provider before switching.
          </div>
        </div>
      </div>
    </div>
  );
}
