import React from 'react';
import { fmtEur, fmtDate, TRANSACTIONS, EVENTS } from '../data.jsx';
import { M, I, Divider, StatusBar, AppBar } from '../theme.jsx';
import { useNav, TabBar } from '../i18n.jsx';
import { StackedBar, TxRow } from '../components.jsx';


export function ScreenEvents() {
  const nav = useNav();
  const [filter, setFilter] = React.useState('all');
  const evs = filter === 'all' ? EVENTS : EVENTS.filter(e => e.status === filter);

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="Events" large
        trailing={<button className="m-iconbtn m-tap" onClick={() => nav.push('eventCreate')}><I name="plus" size={22}/></button>}
      />
      <div style={{ padding: '0 20px 14px', display: 'flex', gap: 6, flexShrink: 0 }}>
        {[{id:'all',label:'All'},{id:'active',label:'Active'},{id:'closed',label:'Closed'},{id:'planning',label:'Planning'}].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} className="m-chip m-tap"
            style={{
              background: filter === f.id ? M.ink : M.card,
              color: filter === f.id ? M.paper : M.ink2,
              borderColor: filter === f.id ? M.ink : M.line,
              fontWeight: filter === f.id ? 600 : 500,
            }}>{f.label}</button>
        ))}
      </div>

      <div className="m-body-scroll">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {evs.map(e => <EventCard key={e.id} ev={e} onClick={() => nav.push('eventDetail', { id: e.id })}/>)}
        </div>
      </div>

      <TabBar active="events" onChange={(t) => nav.switchTab(t)}/>
    </div>
  );
}

function EventCard({ ev, onClick }) {
  const status = ({
    active:   { label: 'Active',   bg: 'rgba(44,90,51,0.85)',  color: '#fff' },
    closed:   { label: 'Closed',   bg: 'rgba(0,0,0,0.50)',     color: '#fff' },
    planning: { label: 'Planning', bg: 'rgba(122,92,32,0.85)', color: '#fff' },
    upcoming: { label: 'Upcoming', bg: 'rgba(63,78,99,0.85)',  color: '#fff' },
  }[ev.status]) || { label: ev.status || 'Draft', bg: 'rgba(0,0,0,0.5)', color: '#fff' };

  return (
    <div className="m-card m-tap" onClick={onClick} style={{ overflow: 'hidden', border: `1px solid ${M.line}` }}>
      <div style={{
        height: 150, position: 'relative',
        background: ev.photo ? `url(${ev.photo}) center/cover no-repeat` : '#3F4E63',
      }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.38) 100%)' }}/>
        <div style={{ position: 'absolute', bottom: 14, left: 16, right: 16 }}>
          <div style={{ color: '#fff', fontSize: 18, fontWeight: 700, fontFamily: M.fontDisp, textShadow: '0 1px 6px rgba(0,0,0,0.5)' }}>{ev.name}</div>
          <div style={{ color: 'rgba(255,255,255,0.82)', fontSize: 12, marginTop: 3, textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}>
            {fmtDate(ev.start)} – {fmtDate(ev.end)}
          </div>
        </div>
        <div style={{ position: 'absolute', top: 12, right: 12, padding: '4px 10px', borderRadius: 999, background: status.bg, color: status.color, fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', backdropFilter: 'blur(4px)' }}>{status.label}</div>
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 12, color: M.ink3 }}>{ev.txCount} transactions</div>
        <div className="m-num" style={{ fontSize: 20, fontWeight: 600 }}>{fmtEur(ev.total)}</div>
      </div>
    </div>
  );
}

export function ScreenEventDetail({ params }) {
  const nav = useNav();
  const ev = EVENTS.find(e => e.id === params?.id) || EVENTS[0];
  const breakdown = [
    { id: 'flights',     label: 'Flights',     icon: 'rocket', amount: 412.30, color: M.slate },
    { id: 'lodging',     label: 'Lodging',     icon: 'house',  amount: 380.00, color: M.sage },
    { id: 'food',        label: 'Food',        icon: 'fork',   amount: 248.50, color: M.clay },
    { id: 'transport',   label: 'Transport',   icon: 'car',    amount: 86.40,  color: M.ochre },
    { id: 'activities',  label: 'Activities',  icon: 'film',   amount: 59.10,  color: M.violet },
  ];
  const evTx = TRANSACTIONS.slice(0, 6);

  return (
    <div className="m-screen">
      <div style={{ position: 'relative', height: 220, flexShrink: 0,
        background: ev.photo ? `url(${ev.photo}) center/cover no-repeat` : `linear-gradient(135deg, #3F4E63 0%, #2C3848 100%)`,
        overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.55) 100%)' }}/>
        <StatusBar dark/>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
          <button className="m-iconbtn m-tap" onClick={() => nav.pop()} style={{ color: '#fff' }}><I name="arrowL" size={20} color="#fff"/></button>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="m-iconbtn m-tap" style={{ color: '#fff' }}><I name="edit" size={18} color="#fff"/></button>
            <button className="m-iconbtn m-tap" style={{ color: '#fff' }}><I name="more" size={18} color="#fff"/></button>
          </div>
        </div>
        <div style={{ position: 'absolute', left: 20, right: 20, bottom: 18 }}>
          <div style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', color: '#fff', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 }}>Closed · 7 days</div>
          <div style={{ fontFamily: M.fontDisp, fontSize: 26, fontWeight: 600, color: '#fff', letterSpacing: '-0.02em' }}>{ev.name}</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>{fmtDate(ev.start)} – {fmtDate(ev.end)}</div>
        </div>
      </div>

      <div className="m-body-scroll" style={{ paddingTop: 16 }}>
        <div className="m-card" style={{ padding: 18, marginBottom: 14, border: `1px solid ${M.line}` }}>
          <div className="m-cap">Total spent</div>
          <div className="m-num" style={{ fontSize: 32, fontWeight: 600, fontFamily: M.fontDisp, marginTop: 4 }}>{fmtEur(ev.total)}</div>
          <div style={{ fontSize: 12, color: M.ink3, marginTop: 2 }}>{ev.txCount} transactions · €{(ev.total/7).toFixed(0)}/day avg</div>
          <div style={{ marginTop: 14 }}>
            <StackedBar segments={breakdown.map(b => ({ value: b.amount, color: b.color }))} height={8}/>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Breakdown</div>
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 14, border: `1px solid ${M.line}` }}>
          {breakdown.map((b, i) => (
            <React.Fragment key={b.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: M.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <I name={b.icon} size={16} color={b.color}/>
                </div>
                <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{b.label}</div>
                <div className="m-num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtEur(b.amount)}</div>
                <div style={{ fontSize: 11, color: M.ink3, minWidth: 36, textAlign: 'right' }}>{((b.amount/ev.total)*100).toFixed(0)}%</div>
              </div>
              {i < breakdown.length - 1 && <Divider/>}
            </React.Fragment>
          ))}
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Transactions · {ev.txCount}</div>
        <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}`, marginBottom:14 }}>
          {evTx.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <TxRow tx={t} showDate onClick={() => nav.push('txDetail', { id:t.id })}/>
              {i < a.length-1 && <Divider inset={50}/>}
            </React.Fragment>
          ))}
        </div>
        <LinkTransactionsCard txs={TRANSACTIONS.slice(6, 14)} label="from this date range — select to add"/>
      </div>
    </div>
  );
}

function LinkTransactionsCard({ txs = [], label = 'in this period' }) {
  const [sel, setSel] = React.useState(new Set());
  const [expanded, setExpanded] = React.useState(true);
  const toggle = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="m-card" style={{ marginBottom:14, border:`1px solid ${M.line}`, overflow:'hidden' }}>
      <div className="m-tap" onClick={() => setExpanded(e => !e)} style={{ padding:'14px 16px', display:'flex', alignItems:'center', gap:10 }}>
        <div style={{ width:32, height:32, borderRadius:9, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <I name="list" size={16} color={M.sage}/>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:600 }}>Link transactions</div>
          <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>
            {sel.size > 0 ? `${sel.size} selected` : `${txs.length} transactions ${label}`}
          </div>
        </div>
        <I name={expanded ? 'arrowDn' : 'caretR'} size={14} color={M.ink4}/>
      </div>
      {expanded && (
        <div style={{ borderTop:`1px solid ${M.line2}`, maxHeight:240, overflowY:'auto' }}>
          {txs.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <div className="m-tap" onClick={() => toggle(t.id)} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px' }}>
                <div style={{ width:22, height:22, borderRadius:6, border:`1.5px solid ${sel.has(t.id)?M.sage:M.line}`, background:sel.has(t.id)?M.sage:'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  {sel.has(t.id) && <I name="check" size={11} color="#fff" stroke={2.5}/>}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:500 }}>{t.merchant}</div>
                  <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{fmtDate(t.date)}</div>
                </div>
                <div className="m-num" style={{ fontSize:13, fontWeight:600, color:t.amount<0?M.ink:M.sage }}>{fmtEur(t.amount)}</div>
              </div>
              {i < a.length-1 && <Divider inset={50}/>}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export function ScreenEventCreate() {
  const nav = useNav();
  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title="New event"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="x" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{
          height: 140, borderRadius: 14, background: M.paper2, border: `1px dashed ${M.line}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 6, marginBottom: 18, color: M.ink3,
        }}>
          <I name="cam" size={28} color={M.ink3}/>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Add cover image</div>
          <div style={{ fontSize: 11 }}>or pick a placeholder</div>
        </div>

        <div className="m-cap" style={{ marginBottom: 8 }}>Details</div>
        <div className="m-card" style={{ padding: 4, marginBottom: 14, border: `1px solid ${M.line}` }}>
          <FormRow label="Name" value="Lisbon trip 2026" placeholder="e.g. Anna's birthday"/>
          <Divider inset={16}/>
          <FormRow label="Type" value="Travel" caretR/>
          <Divider inset={16}/>
          <FormRow label="Start" value="12 Sep 2026" icon="cal"/>
          <Divider inset={16}/>
          <FormRow label="End" value="19 Sep 2026" icon="cal"/>
        </div>

        <LinkTransactionsCard txs={TRANSACTIONS.slice(0, 8)} label="from selected date range"/>

        <button className="m-btn sage m-tap" style={{ width: '100%' }} onClick={() => nav.pop()}>Create event</button>
      </div>
    </div>
  );
}

export function FormRow({ label, value, icon, caretR, placeholder }) {
  const empty = !value;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 14px' }}>
      <div style={{ fontSize: 12, color: M.ink3, width: 60 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 14, color: empty ? M.ink4 : M.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
        {icon && <I name={icon} size={14} color={M.ink3}/>}
        {value || placeholder}
      </div>
      {caretR && <I name="caretR" size={14} color={M.ink4}/>}
    </div>
  );
}

export function Toggle({ on }) {
  return (
    <div style={{
      width: 40, height: 24, borderRadius: 999, background: on ? M.sage : M.line,
      padding: 2, transition: 'background 0.2s',
    }}>
      <div style={{
        width: 20, height: 20, borderRadius: 999, background: '#fff',
        transform: on ? 'translateX(16px)' : 'none', transition: 'transform 0.2s',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      }}/>
    </div>
  );
}
