import React from 'react';
import { CATEGORIES, _catExt, catPath } from '../../shared/data/categories.js';
import { fmtEur, fmtDate, computePeriodHistory, dayLabel } from '../../shared/utils/format.js';
import { getUserId } from '../../shared/utils/user.js';
import { ACCOUNTS, TRANSACTIONS } from '../accounts/data.js';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav, Sheet, TabBar } from '../../app/nav.jsx';
import { useLocalStorage } from '../../shared/hooks.jsx';
import { BarChart, StackedBar } from '../../shared/components/Charts.jsx';
import { TxRow, HighlightText } from '../../shared/components/TxRow.jsx';
import { useTxCtx, useRecurCtx, useConnectedAccounts, useProfiles } from '../../app/providers.jsx';
import { CategoryPicker } from '../review/Review.jsx';
import { ordinal } from '../recurring/Recurring.jsx';



export function ScreenTransactions() {
  const nav = useNav();
  const { t } = useLang();
  const { txs } = useTxCtx();
  const [filter, setFilter] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchRef = React.useRef(null);

  React.useEffect(() => { if (searchOpen && searchRef.current) searchRef.current.focus(); }, [searchOpen]);

  let filtered = txs;
  if (filter === 'income') filtered = filtered.filter(t => t.amount > 0);
  if (filter === 'expense') filtered = filtered.filter(t => t.amount < 0);
  if (filter === 'review') filtered = filtered.filter(t => t.needsReview);
  if (filter === 'recurring') filtered = filtered.filter(t => t.recurring);
  if (query) filtered = filtered.filter(t =>
    t.merchant.toLowerCase().includes(query.toLowerCase()) ||
    t.desc.toLowerCase().includes(query.toLowerCase())
  );

  const groups = {};
  filtered.forEach(t => {
    const k = t.date;
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  });
  const days = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  const filters = [
    { id: 'all', label: 'All' },
    { id: 'income', label: 'Income' },
    { id: 'expense', label: 'Expense' },
    { id: 'review', label: 'Review' },
    { id: 'recurring', label: 'Recurring' },
  ];

  return (
    <div className="m-screen">
      <StatusBar/>
      {searchOpen ? (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 16px', flexShrink:0, borderBottom:`1px solid ${M.line2}` }}>
          <I name="search" size={16} color={M.ink3}/>
          <input
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search transactions…"
            style={{ flex:1, border:'none', outline:'none', fontSize:15, fontFamily:M.fontUI, background:'transparent', color:M.ink }}
          />
          <button className="m-tap" onClick={() => { setSearchOpen(false); setQuery(''); }}
            style={{ background:'transparent', border:'none', fontSize:13, fontWeight:600, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('action.cancel')}
          </button>
        </div>
      ) : (
        <AppBar title={t('tab.transactions')} large
          leading={null}
          trailing={
            <button className="m-iconbtn m-tap" onClick={() => setSearchOpen(true)}>
              <I name="search" size={20}/>
            </button>
          }
        />
      )}

      {!searchOpen && (
        <div style={{ padding: '0 20px 12px', display: 'flex', gap: 6, overflowX: 'auto', flexShrink: 0 }}>
          {filters.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className="m-chip m-tap"
              style={{
                background: filter === f.id ? M.ink : M.card,
                color: filter === f.id ? M.paper : M.ink2,
                borderColor: filter === f.id ? M.ink : M.line,
                fontWeight: filter === f.id ? 600 : 500,
                flexShrink: 0,
              }}>{f.label}</button>
          ))}
        </div>
      )}

      <div className="m-body-scroll">
        {days.map(d => (
          <div key={d} style={{ marginBottom: 18 }}>
            <div style={{ marginBottom: 8, padding: '0 4px' }}>
              <div className="m-cap">{dayLabel(d)}</div>
            </div>
            <div className="m-card" style={{ padding: '0 16px', border: `1px solid ${M.line}` }}>
              {groups[d].map((t, i, a) => (
                <React.Fragment key={t.id}>
                  <TxRow tx={t} onClick={() => nav.push('txDetail', { id: t.id })} highlight={query}/>
                  {i < a.length - 1 && <Divider inset={50}/>}
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
        {days.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: M.ink3 }}>
            <I name="search" size={32} color={M.ink4}/>
            <div style={{ marginTop: 8, fontSize: 14 }}>{query ? `No results for "${query}"` : 'No transactions'}</div>
          </div>
        )}
      </div>

      <TabBar active="tx" onChange={(t) => nav.switchTab(t)}/>
    </div>
  );
}

export function ScreenTxDetail({ params }) {
  const nav = useNav();
  const { txs, updateTx } = useTxCtx();
  const { recurList, addRecur } = useRecurCtx();
  const [connectedAccounts] = useConnectedAccounts();
  const { profiles } = useProfiles();
  const _activeProfile = profiles.find(p => p.active) || profiles[0];
  const _sharedKey = (_activeProfile?.isShared || (_activeProfile?.members||[]).length > 0) ? `munni_shared_data_${_activeProfile?.id}` : 'munni_shared_data_none';
  const [_sharedData] = useLocalStorage(_sharedKey, { accounts: [] });
  const [_userRegistry] = useLocalStorage('munni_global_users', {});
  const _myId = React.useMemo(() => getUserId(), []);

  const [showLinkRecurring, setShowLinkRecurring] = React.useState(false);
  const [showCatPicker, setShowCatPicker] = React.useState(false);
  const [showReceiptEdit, setShowReceiptEdit] = React.useState(false);
  const [showSavingPicker, setShowSavingPicker] = React.useState(false);

  const tx = txs.find(t => t.id === params.id) || txs[0] || TRANSACTIONS[0];
  const positive = tx.amount > 0;

  const initCats = () => tx.cats ? tx.cats.slice() : [{ catId: tx.cat, amount: Math.abs(tx.amount) }];
  const [txCats, setTxCats] = React.useState(initCats);
  const [noteText, setNoteText] = React.useState(tx.note || '');
  // Derive from live tx so store/photo receipt additions are reflected immediately
  const hasReceiptState = tx.hasReceipt || false;
  const setHasReceiptState = (v) => updateTx(tx.id, { hasReceipt: v, ...(v ? {} : { receiptPhoto: undefined, receiptStore: undefined, receiptItems: undefined, receiptTotal: undefined, receiptId: undefined }) });

  const NOTE_MAX = 200;

  const linkedTx = txs.find(t => t.linkedTo === tx.id);
  const originalTx = tx.linkedTo ? txs.find(t => t.id === tx.linkedTo) : null;
  const reimburseAmt = linkedTx ? linkedTx.amount : 0;
  const net = tx.amount + reimburseAmt;
  const netOriginalTx = originalTx ? originalTx.amount + tx.amount : 0;

  const account = connectedAccounts.find(a => a.id === tx.account) || (_sharedData?.accounts || []).find(a => a.id === tx.account) || ACCOUNTS.find(a => a.id === tx.account);

  // Editing lock: first opener wins; subsequent openers are read-only
  React.useEffect(() => {
    if (_sharedKey === 'munni_shared_data_none') return;
    try {
      const sd = JSON.parse(localStorage.getItem(_sharedKey) || '{}');
      const existing = sd.editing;
      const alreadyLockedByOther = existing?.txId === tx.id && existing.userId !== _myId
        && (Date.now() - (existing.since || 0)) < 300000;
      if (!alreadyLockedByOther) {
        localStorage.setItem(_sharedKey, JSON.stringify({ ...sd, editing: { txId: tx.id, userId: _myId, since: Date.now() } }));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: _sharedKey } }));
      }
    } catch {}
    return () => {
      try {
        const sd = JSON.parse(localStorage.getItem(_sharedKey) || '{}');
        if (sd.editing?.userId === _myId && sd.editing?.txId === tx.id) {
          const { editing: _e, ...rest } = sd;
          localStorage.setItem(_sharedKey, JSON.stringify(rest));
          window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: _sharedKey } }));
        }
      } catch {}
    };
  }, [tx.id, _sharedKey]);

  const _editingLock = _sharedData?.editing;
  const isLockedByOther = !!_editingLock && _editingLock.txId === tx.id && _editingLock.userId !== _myId
    && (Date.now() - (_editingLock.since || 0)) < 300000;
  const _lockedByName = _userRegistry[_editingLock?.userId]?.displayName || _editingLock?.userId || 'Someone';

  const linkedRecurId = tx.recurId || null;
  const linkedRecurring = recurList.find(r => r.id === linkedRecurId || r.txIds?.includes(tx.id));

  const primaryCat = CATEGORIES[txCats[0]?.catId] || {};
  const allocTotal = txCats.reduce((s, c) => s + c.amount, 0);
  const remaining = Math.round((Math.abs(tx.amount) - allocTotal) * 100) / 100;
  const isOnlyUncategorized = txCats.length === 1 && (txCats[0].catId === 'expenseUncategorized' || txCats[0].catId === 'incomeUncategorized');
  const effectiveRemaining = isOnlyUncategorized ? Math.abs(tx.amount) : remaining;
  const [showAllocInfo, setShowAllocInfo] = React.useState(false);

  React.useEffect(() => {
    const primaryCatId = txCats.find(c => c.catId !== 'expenseUncategorized' && c.catId !== 'incomeUncategorized')?.catId || txCats[0]?.catId;
    updateTx(tx.id, { cats: txCats, cat: primaryCatId || tx.cat });
  }, [txCats]);

  const heroAmount = reimburseAmt !== 0 ? net : tx.amount;
  const showOriginal = reimburseAmt !== 0;

  const saveNote = (text) => { updateTx(tx.id, { note: text }); };

  const removeCategory = (i) => {
    setTxCats(s => {
      if (s.length === 1) {
        const fallback = positive ? 'incomeUncategorized' : 'expenseUncategorized';
        return [{ catId: fallback, amount: Math.abs(tx.amount) }];
      }
      return s.filter((_, j) => j !== i);
    });
  };

  return (
    <div className="m-screen" style={{ position: 'relative' }}>
      <StatusBar/>
      <AppBar title=""
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={null}
      />
      <div className="m-body-scroll">
        {isLockedByOther && (
          <div style={{ margin:'0 0 10px', padding:'10px 14px', borderRadius:12, background:M.ochreSoft, border:`1px solid ${M.ochre}`, display:'flex', alignItems:'center', gap:8 }}>
            <I name="lock" size={14} color={M.ochre}/>
            <span style={{ fontSize:13, color:M.ochre, fontWeight:500 }}>{_lockedByName} is editing this transaction — view only</span>
          </div>
        )}
        <div style={{ pointerEvents: isLockedByOther ? 'none' : 'auto', opacity: isLockedByOther ? 0.65 : 1 }}>
        {/* Hero — compact horizontal layout */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0 16px' }}>
          <div style={{ width:44, height:44, borderRadius:13, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={primaryCat.icon || 'help-circle-outline'} size={22} color={M.ink2}/>
          </div>
          <div style={{ flex:1 }}>
            <div className="m-num" style={{ fontSize:26, fontWeight:700, color: heroAmount > 0 ? M.sage : (heroAmount === 0 ? M.ink3 : M.ink), lineHeight:1.1, letterSpacing:'-0.02em' }}>
              {heroAmount > 0 ? '+' : heroAmount < 0 ? '−' : ''}{fmtEur(Math.abs(heroAmount))}
            </div>
            <div style={{ fontSize:15, fontWeight:600, marginTop:2, color:M.ink }}>{tx.merchant}</div>
            <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{fmtDate(tx.date, 'long')} · {tx.time}</div>
          </div>
        </div>

        {/* Categories — own card */}
        <div className="m-card" style={{ padding: '12px 16px', marginBottom: 14, border: `1px solid ${M.line}`, position:'relative' }}>
          <div className="m-cap" style={{ marginBottom: 8 }}>Categories</div>
          {txCats.map((c, i) => {
            const cat = CATEGORIES[c.catId] || _catExt[c.catId] || {};
            const isUncategorized = c.catId === 'expenseUncategorized' || c.catId === 'incomeUncategorized';
            const parent = cat.parent ? (CATEGORIES[cat.parent] || _catExt[cat.parent]) : null;
            const parentName = parent?.name || cat.group || '';
            const subName = cat.name || c.catId;
            return (
              <React.Fragment key={c.catId + i}>
                <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 0', opacity: isUncategorized ? 0.6 : 1 }}>
                  <div style={{ width:28, height:28, borderRadius:8, background: isUncategorized ? M.line2 : M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <IcoMDI name={cat.icon||'help-circle-outline'} size={14} color={isUncategorized ? M.ink4 : M.ink2}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:500, fontStyle: isUncategorized ? 'italic' : 'normal', color: isUncategorized ? M.ink3 : M.ink }}>{subName}</div>
                    {!isUncategorized && parentName && <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{parentName}</div>}
                    {isUncategorized && <div style={{ fontSize:10, color:M.ink4, marginTop:1 }}>Auto-set · add a category above to replace</div>}
                  </div>
                  <div className="m-num" style={{ fontSize:13, color: isUncategorized ? M.ink4 : M.ink2 }}>{fmtEur(c.amount)}</div>
                  {!isUncategorized && (
                    <button onClick={() => removeCategory(i)} style={{ background:'none', border:'none', color:M.clay, padding:'0 4px', fontSize:18, lineHeight:1, cursor:'pointer', fontFamily:M.fontUI }}>×</button>
                  )}
                </div>
                {i < txCats.length - 1 && <Divider/>}
              </React.Fragment>
            );
          })}
          {remaining > 0.005 && !isOnlyUncategorized && (
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 0', borderTop:`1px dashed ${M.line2}`, marginTop:4 }}>
              <div style={{ width:28, height:28 }}/>
              <span style={{ flex:1, fontSize:12, color:M.ink4 }}>Unallocated</span>
              <span className="m-num" style={{ fontSize:12, color:M.ink4 }}>{fmtEur(remaining)}</span>
            </div>
          )}
          {effectiveRemaining > 0.005 ? (
            <div className="m-tap" onClick={() => setShowCatPicker(true)} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 0', borderTop:`1px solid ${M.line2}`, marginTop:4 }}>
              <div style={{ width:28, height:28, borderRadius:8, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="plus" size={14} color={M.sage}/>
              </div>
              <span style={{ fontSize:13, color:M.sage, fontWeight:500 }}>Add category split</span>
            </div>
          ) : (
            <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 0', borderTop:`1px solid ${M.line2}`, marginTop:4 }}>
              <div style={{ width:28, height:28, borderRadius:8, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="plus" size={14} color={M.ink4}/>
              </div>
              <span style={{ fontSize:13, color:M.ink3, fontWeight:500, flex:1 }}>Add category split</span>
              <button onClick={() => setShowAllocInfo(s => !s)} style={{ width:20, height:20, borderRadius:999, border:`1.5px solid ${M.ink4}`, background:'none', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, cursor:'pointer', padding:0 }}>
                <span style={{ fontSize:11, fontWeight:700, color:M.ink4, lineHeight:1 }}>i</span>
              </button>
              {showAllocInfo && (
                <div style={{ position:'absolute', right:16, bottom:52, background:M.ink, color:'#fff', fontSize:11, padding:'6px 10px', borderRadius:8, maxWidth:200, zIndex:20, lineHeight:1.5 }}>
                  Full amount already allocated across categories.
                </div>
              )}
            </div>
          )}
        </div>

        {/* General info card */}
        <div className="m-card" style={{ padding: '4px 16px', marginBottom: 14, border: `1px solid ${M.line}` }}>
          <div className={account ? 'm-tap' : ''} onClick={account ? () => {
            sessionStorage.setItem('munni_highlight_acct', JSON.stringify({ id: account.id, at: Date.now() }));
            window.dispatchEvent(new CustomEvent('munni-ss', { detail: { key: 'munni_highlight_acct' } }));
            nav.push('accounts');
          } : undefined} style={{ display:'flex', alignItems:'center', gap:10, padding:'13px 0' }}>
            <div style={{ fontSize:12, color:M.ink3, width:96 }}>Account</div>
            <div style={{ flex:1, fontSize:13, color:account ? M.ink : M.ink4 }}>{account?.name || '—'}</div>
            {account && <I name="caretR" size={14} color={M.ink4}/>}
          </div>
          <Divider inset={0}/>
          {(() => {
            const savAcct = tx.savingAccount ? ACCOUNTS.find(a => a.id === tx.savingAccount) : null;
            return (
              <div className="m-tap" onClick={() => setShowSavingPicker(true)} style={{ display:'flex', alignItems:'center', gap:10, padding:'13px 0' }}>
                <div style={{ fontSize:12, color:M.ink3, width:96 }}>Saving account</div>
                <div style={{ flex:1, fontSize:13, color:savAcct ? M.ink : M.ink4 }}>
                  {savAcct ? savAcct.name : 'None — tap to attach'}
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            );
          })()}
          {showOriginal && (
            <>
              <Divider inset={0}/>
              <DetailRow label="Original" value={`${tx.amount > 0 ? '+' : '−'}${fmtEur(Math.abs(tx.amount))}`}/>
            </>
          )}
          <Divider inset={0}/>
          {!positive && (
            <>
              <div className="m-tap" onClick={() => setShowLinkRecurring(true)} style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 0' }}>
                <div style={{ fontSize:12, color:M.ink3, width:96 }}>Recurring</div>
                <div style={{ flex:1, fontSize:13, color:linkedRecurring?M.ink:M.ink4, display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                  {linkedRecurring ? (
                    <>
                      <I name={linkedRecurring.icon} size={14} color={M.ink3}/>
                      <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{linkedRecurring.name}</span>
                    </>
                  ) : 'Link to recurring…'}
                </div>
                {linkedRecurring ? (
                  <button className="m-tap" onClick={e => { e.stopPropagation(); updateTx(tx.id, { recurId: null }); }}
                    style={{ background:'none', border:'none', color:M.clay, fontSize:16, lineHeight:1, cursor:'pointer', fontFamily:M.fontUI, padding:'0 4px' }}>×</button>
                ) : (
                  <I name="caretR" size={14} color={M.ink4}/>
                )}
              </div>
              <Divider inset={0}/>
            </>
          )}
          <DetailRow label="Description" value={tx.desc} mono/>
          <Divider inset={0}/>
          {noteText !== undefined && (
            <div className="m-tap" onClick={() => {}} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'12px 0' }}>
              <div style={{ fontSize:12, color:M.ink3, width:96, paddingTop:1 }}>Note</div>
              <textarea
                value={noteText}
                onChange={e => setNoteText(e.target.value.slice(0, NOTE_MAX))}
                onBlur={() => saveNote(noteText)}
                rows={noteText ? Math.min(5, Math.ceil(noteText.length / 40) + 1) : 2}
                placeholder="Add a note…"
                style={{ flex:1, border:`1px solid ${M.line}`, borderRadius:8, padding:'6px 8px', fontSize:13, fontFamily:M.fontUI, resize:'none', outline:'none', background:M.paper2, color:M.ink, lineHeight:1.5 }}
              />
              <div style={{ fontSize:10, color:M.ink4, alignSelf:'flex-end', paddingBottom:2, minWidth:30, textAlign:'right' }}>{noteText.length}/{NOTE_MAX}</div>
            </div>
          )}
        </div>

        {showLinkRecurring && (
          <Sheet onClose={() => setShowLinkRecurring(false)}>
            <div style={{ padding:'4px 20px 32px', maxHeight:'70vh', overflowY:'auto' }}>
              <div className="m-h2" style={{ marginBottom:4 }}>Link to recurring</div>
              <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>Attach this transaction to a recurring cost.</div>
              <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}`, marginBottom:16 }}>
                {recurList.filter(r => r.amount < 0).map((r, i, a) => (
                  <React.Fragment key={r.id}>
                    <div className="m-tap" onClick={() => { updateTx(tx.id, { recurId: r.id }); setShowLinkRecurring(false); }} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                      <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <I name={r.icon} size={16} color={M.ink2}/>
                      </div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:14, fontWeight:500 }}>{r.name}</div>
                        <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{fmtEur(r.amount)}/mo · {ordinal(r.day)} of month</div>
                      </div>
                      {linkedRecurring?.id === r.id && <I name="check" size={16} color={M.sage}/>}
                    </div>
                    {i < a.length-1 && <Divider inset={48}/>}
                  </React.Fragment>
                ))}
                <div className="m-tap" onClick={() => { setShowLinkRecurring(false); nav.push('recurringCreate'); }}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0', borderTop:`1px solid ${M.line2}` }}>
                  <div style={{ width:36, height:36, borderRadius:10, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <I name="plus" size={16} color={M.sage}/>
                  </div>
                  <div style={{ flex:1, fontSize:14, fontWeight:600, color:M.sage }}>Create new recurring</div>
                  <I name="caretR" size={14} color={M.ink4}/>
                </div>
              </div>
              <button className="m-btn outline m-tap" style={{ width:'100%' }} onClick={() => setShowLinkRecurring(false)}>Cancel</button>
            </div>
          </Sheet>
        )}

        {showSavingPicker && (
          <Sheet onClose={() => setShowSavingPicker(false)}>
            <div style={{ padding:'4px 20px 32px' }}>
              <div className="m-h2" style={{ marginBottom:4 }}>Attach saving account</div>
              <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>Mark this transaction as a deposit or withdrawal to a saving account.</div>
              <div className="m-card" style={{ padding:'4px 16px', border:`1px solid ${M.line}`, marginBottom:16 }}>
                {ACCOUNTS.filter(a => a.type !== 'checking').map((a, i, arr) => (
                  <React.Fragment key={a.id}>
                    <div className="m-tap" onClick={() => {
                      const newCat = tx.amount < 0 ? 'savingDeposit' : 'savingWithdraw';
                      const newCats = [{ catId: newCat, amount: Math.abs(tx.amount) }];
                      updateTx(tx.id, { savingAccount: a.id, cat: newCat, cats: newCats });
                      setTxCats(newCats);
                      setShowSavingPicker(false);
                    }} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                      <div style={{ width:36, height:36, borderRadius:10, background:a.color, display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <I name={a.type==='invest'?'rocket':'piggy'} size={16} color="#fff"/>
                      </div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:14, fontWeight:500 }}>{a.name}</div>
                        <div style={{ fontSize:11, color:M.ink3, marginTop:1, fontFamily:M.fontMono }}>{a.iban}</div>
                      </div>
                      {tx.savingAccount === a.id && <I name="check" size={16} color={M.sage}/>}
                    </div>
                    {i < arr.length - 1 && <Divider inset={48}/>}
                  </React.Fragment>
                ))}
                {tx.savingAccount && (
                  <>
                    <Divider inset={0}/>
                    <div className="m-tap" onClick={() => { updateTx(tx.id, { savingAccount: undefined }); setShowSavingPicker(false); }}
                      style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                      <div style={{ width:36, height:36, borderRadius:10, background:M.claySoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <I name="x" size={16} color={M.clay}/>
                      </div>
                      <div style={{ flex:1, fontSize:14, fontWeight:500, color:M.clay }}>Remove attachment</div>
                    </div>
                  </>
                )}
              </div>
              <button className="m-btn outline m-tap" style={{ width:'100%' }} onClick={() => setShowSavingPicker(false)}>Cancel</button>
            </div>
          </Sheet>
        )}

        {/* Receipt */}
        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Receipt</div>
        <div className="m-card" style={{ padding: 14, marginBottom: 14, border: `1px solid ${M.line}` }}>
          {hasReceiptState ? (
            <div style={{ display:'flex', gap:12, alignItems:'center' }}>
              <div style={{ width: 40, height: 52, borderRadius: 6, background: M.paper2, border: `1px solid ${M.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow:'hidden' }}>
                {tx.receiptPhoto ? (
                  <div style={{ width:'100%', height:'100%', background:'linear-gradient(135deg,#f5f5f5 0%,#eee 100%)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>🧾</div>
                ) : (
                  <I name="receipt" size={20} color={M.ink2}/>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{tx.receiptStore ? `${tx.receiptStore} · receipt` : `${tx.merchant} · receipt`}</div>
                <div style={{ fontSize: 11, color: M.ink3, marginTop: 2 }}>{tx.receiptStore ? `${tx.receiptItems?.length || 0} items` : 'Photo captured'} · {fmtEur(tx.receiptTotal || Math.abs(tx.amount))}</div>
                <div style={{ display:'flex', gap:6, marginTop:6 }}>
                  <button className="m-tap" style={{ fontSize:11, fontWeight:600, color:M.ink3, background:M.paper2, border:`1px solid ${M.line}`, borderRadius:6, padding:'4px 8px', cursor:'pointer', fontFamily:M.fontUI }}>
                    Edit
                  </button>
                  <button className="m-tap" onClick={() => setHasReceiptState(false)} style={{ fontSize:11, fontWeight:600, color:M.clay, background:M.claySoft, border:'none', borderRadius:6, padding:'4px 8px', cursor:'pointer', fontFamily:M.fontUI }}>
                    Remove
                  </button>
                </div>
              </div>
              <I name="caretR" size={16} color={M.ink4}/>
            </div>
          ) : (
            <div style={{ display:'flex', gap:12, alignItems:'center' }}>
              <div style={{ width: 40, height: 52, borderRadius: 6, border: `1px dashed ${M.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink:0 }}>
                <I name="cam" size={18} color={M.ink4}/>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: M.ink3, marginBottom: 6 }}>No receipt yet</div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                  <button className="m-tap" onClick={() => updateTx(tx.id, { hasReceipt: true, receiptPhoto: true, receiptItems: [{ name: 'Captured item', qty: 1, price: Math.abs(tx.amount) }], receiptTotal: Math.abs(tx.amount) })} style={{ fontSize:11, fontWeight:600, color:M.sage, background:M.sageSoft, border:'none', borderRadius:6, padding:'4px 8px', cursor:'pointer', fontFamily:M.fontUI }}>
                    📷 Take photo
                  </button>
                  <button className="m-tap" onClick={() => nav.push('integrations', { sourceTxId: tx.id })} style={{ fontSize:11, fontWeight:600, color:M.ink2, background:M.paper2, border:`1px solid ${M.line}`, borderRadius:6, padding:'4px 8px', cursor:'pointer', fontFamily:M.fontUI }}>
                    Get from connected store
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Reimbursement of (this tx is a reimbursement) */}
        {originalTx && (
          <>
            <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Reimbursement of</div>
            <div className="m-card" style={{ padding: '4px 16px', marginBottom: 14, border: `1px solid ${M.line}` }}>
              <div className="m-tap" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}
                onClick={() => nav.push('txDetail', { id: originalTx.id })}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: M.claySoft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <IcoMDI name={CATEGORIES[originalTx.cat]?.icon || 'help-circle-outline'} size={16} color={M.clay}/>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{originalTx.merchant}</div>
                  <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{fmtDate(originalTx.date)} · original {fmtEur(Math.abs(originalTx.amount))}</div>
                </div>
                <div className="m-num" style={{ fontWeight: 600, color: M.clay }}>
                  {netOriginalTx < 0 ? '−' : ''}{fmtEur(Math.abs(netOriginalTx))}
                </div>
                <I name="caretR" size={14} color={M.ink4}/>
              </div>
            </div>
          </>
        )}

        {/* Reimbursed by (this expense has a reimbursement) */}
        {linkedTx && (
          <>
            <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>Reimbursed by · 1</div>
            <div className="m-card" style={{ padding: '4px 16px', marginBottom: 14, border: `1px solid ${M.line}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
                <div className="m-tap" style={{ display:'flex', alignItems:'center', gap:12, flex:1, minWidth:0 }}
                  onClick={() => nav.push('txDetail', { id: linkedTx.id })}>
                  <div style={{ width: 32, height: 32, borderRadius: 9, background: M.sageSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink:0 }}>
                    <I name="link" size={16} color={M.sage}/>
                  </div>
                  <div style={{ flex: 1, minWidth:0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{linkedTx.merchant}</div>
                    <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{fmtDate(linkedTx.date)} · reimbursed</div>
                  </div>
                  <div className="m-num" style={{ fontWeight: 600, color: M.sage }}>+{fmtEur(linkedTx.amount)}</div>
                  <I name="caretR" size={14} color={M.ink4}/>
                </div>
                <button className="m-tap" onClick={() => updateTx(linkedTx.id, { linkedTo: undefined })}
                  style={{ background:'none', border:'none', color:M.clay, fontSize:18, lineHeight:1, cursor:'pointer', fontFamily:M.fontUI, padding:'0 0 0 8px', flexShrink:0 }}>×</button>
              </div>
            </div>
          </>
        )}

        {net !== 0 && (
          <button className="m-btn outline m-tap" style={{ width: '100%', marginBottom: 18 }}
            onClick={() => nav.push('linkReimburse', { txId: tx.id, positive })}>
            <I name="link" size={16}/>
            {positive ? 'Link reimbursed expense' : 'Link a reimbursement'}
          </button>
        )}
      </div>{/* end lock wrapper */}
    </div>{/* end m-body-scroll */}

      {showCatPicker && (
        <CategoryPicker
          selected={txCats.length === 1 && !isOnlyUncategorized ? txCats[0].catId : null}
          positiveOnly={positive}
          defaultAmount={effectiveRemaining > 0.005 ? effectiveRemaining : 0}
          maxAmount={Math.abs(tx.amount)}
          onClose={() => setShowCatPicker(false)}
          onPick={(catId, val) => {
            setTxCats(s => {
              if (isOnlyUncategorized) {
                const uncatId = positive ? 'incomeUncategorized' : 'expenseUncategorized';
                const leftover = Math.round((Math.abs(tx.amount) - val) * 100) / 100;
                if (leftover < 0.005) return [{ catId, amount: val }];
                return [{ catId, amount: val }, { catId: uncatId, amount: leftover }];
              }
              const idx = s.findIndex(x => x.catId === catId);
              if (idx >= 0) return s.map((x, i) => i === idx ? { ...x, amount: val } : x);
              return [...s, { catId, amount: val }];
            });
            setShowCatPicker(false);
          }}
        />
      )}
    </div>
  );
}

export function DetailRow({ label, value, icon, mono, placeholder, caretR }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 0' }}>
      <div style={{ fontSize: 12, color: M.ink3, width: 96 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 13, color: placeholder ? M.ink4 : M.ink, fontFamily: mono ? M.fontMono : M.fontUI, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {icon && <I name={icon} size={14} color={M.ink3}/>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      </div>
      {caretR && <I name="caretR" size={14} color={M.ink4}/>}
    </div>
  );
}

export function ScreenExpenses() {
  const nav = useNav();
  const { t } = useLang();
  const { txs } = useTxCtx();
  const [periodDay] = useLocalStorage('munni_period_day', 20);
  const periodHistory = computePeriodHistory(periodDay);
  const [pidx, setPidx] = React.useState(periodHistory.length - 1);

  const barValues = periodHistory.map(p =>
    txs.filter(t => t.amount < 0 && !t.savingAccount && t.date >= p.start && t.date <= p.end)
       .reduce((s,t) => s + Math.abs(t.amount), 0)
  );
  const barLabels = periodHistory.map(p => {
    const s = new Date(p.start); const e = new Date(p.end);
    const sm = s.toLocaleString('en-GB',{month:'short'}); const em = e.toLocaleString('en-GB',{month:'short'});
    return sm === em ? sm : sm+'–'+em;
  });

  const selPeriod = periodHistory[pidx] || periodHistory[periodHistory.length - 1];
  const periodStart = selPeriod.start;
  const periodEnd = selPeriod.end;
  const periodLabel = selPeriod.label;

  // Filter transactions by selected period
  const activeStart = periodStart;
  const activeEnd   = periodEnd;
  const periodTxs = txs.filter(t => t.amount < 0 && !t.savingAccount && t.date >= activeStart && t.date <= activeEnd);

  const totals = {};
  periodTxs.forEach(t => {
    const c = CATEGORIES[t.cat] || _catExt[t.cat];
    const grp = c?.parent || c?.id;
    const grpCat = CATEGORIES[grp] || _catExt[grp];
    if (!totals[grp]) totals[grp] = { id: grp, name: grpCat?.name || c?.group || c?.name, icon: grpCat?.icon || c?.icon, total: 0, subs: {} };
    totals[grp].total += Math.abs(t.amount);
    if (c?.parent) {
      if (!totals[grp].subs[c.id]) totals[grp].subs[c.id] = { id: c.id, name: c.name, total: 0, count: 0 };
      totals[grp].subs[c.id].total += Math.abs(t.amount);
      totals[grp].subs[c.id].count += 1;
    }
  });

  const cats = Object.values(totals).sort((a, b) => b.total - a.total);
  const grandTotal = cats.reduce((s, c) => s + c.total, 0);
  const [expanded, setExpanded] = React.useState({ consumptions: true, essentials: true });

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('home.spent')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap"><I name="filter" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
          <div className="m-num" style={{ fontSize: 38, fontWeight: 600, letterSpacing: '-0.025em' }}>{fmtEur(grandTotal)}</div>
          <div style={{ fontSize: 12, color: M.ink3, marginTop: 4, fontWeight: 500 }}>
            {periodHistory[pidx]?.label}
          </div>
        </div>

        <div className="m-card" style={{ padding:'12px 16px 8px', marginBottom:14, border:`1px solid ${M.line}` }}>
          <BarChart
            data={barValues}
            labels={barLabels}
            height={90}
            accent={M.clay}
            color={M.ink3}
            showValues
            selected={pidx}
            onSelect={(idx) => setPidx(idx)}
          />
        </div>

        <StackedBar height={10} segments={cats.map((c, i) => ({
          value: c.total, color: CATEGORIES[c.id]?.color || _catExt[c.id]?.color || [M.sage, M.clay, M.ochre, M.violet, M.slate, M.ink3][i % 6],
        }))}/>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14, marginBottom: 18 }}>
          {cats.map((c, i) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: M.ink2 }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: CATEGORIES[c.id]?.color || _catExt[c.id]?.color || [M.sage, M.clay, M.ochre, M.violet, M.slate, M.ink3][i % 6] }}/>
              {c.name}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cats.map(c => {
            const subs = Object.values(c.subs);
            const isOpen = expanded[c.id];
            const pct = (c.total / grandTotal) * 100;
            return (
              <div key={c.id} className="m-card" style={{ border: `1px solid ${M.line}`, overflow: 'hidden' }}>
                <div className="m-tap" onClick={() => subs.length > 0 && setExpanded({ ...expanded, [c.id]: !isOpen })}
                  style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: M.paper2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <IcoMDI name={c.icon || 'help-circle-outline'} size={18} color={M.ink2}/>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</div>
                      <div className="m-num" style={{ fontSize: 14, fontWeight: 600 }}>{fmtEur(c.total)}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <div style={{ flex: 1, height: 4, borderRadius: 999, background: M.line2, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: M.ink2 }}/>
                      </div>
                      <div style={{ fontSize: 11, color: M.ink3, fontWeight: 500, minWidth: 28, textAlign: 'right' }}>{pct.toFixed(0)}%</div>
                    </div>
                  </div>
                  {subs.length > 0 && <div style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s ease', display:'flex' }}><I name="caretR" size={14} color={M.ink4}/></div>}
                </div>
                <div style={{ overflow:'hidden', maxHeight: isOpen && subs.length > 0 ? 1000 : 0, transition:'max-height 0.3s ease', background: M.paper2 }}>
                  {subs.length > 0 && (
                    <div>
                      {/* All — shows every transaction under this parent */}
                      <Divider inset={0}/>
                      <div className="m-tap" onClick={() => nav.push('categoryDrill', { id: c.id, periodStart: activeStart, periodEnd: activeEnd, periodLabel: periodLabel })}
                        style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 30, height: 30, borderRadius: 8, background: '#fff', border: `1px solid ${M.line2}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <IcoMDI name={c.icon || 'help-circle-outline'} size={14} color={M.ink3}/>
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>All {c.name}</div>
                          <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{subs.reduce((s, x) => s + x.count, 0)} transactions</div>
                        </div>
                        <div className="m-num" style={{ fontSize: 13, fontWeight: 600 }}>{fmtEur(c.total)}</div>
                        <I name="caretR" size={12} color={M.ink4}/>
                      </div>
                      {/* Individual subcategories */}
                      {subs.map((s) => {
                        const subCat = CATEGORIES[s.id] || {};
                        return (
                          <React.Fragment key={s.id}>
                            <Divider inset={58}/>
                            <div className="m-tap" onClick={() => nav.push('categoryDrill', { id: s.id, periodStart: activeStart, periodEnd: activeEnd, periodLabel: periodLabel })}
                              style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                              <div style={{ width: 30, height: 30, borderRadius: 8, background: '#fff', border: `1px solid ${M.line2}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                <IcoMDI name={subCat.icon || 'help-circle-outline'} size={14} color={M.ink2}/>
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                                <div style={{ fontSize: 11, color: M.ink3, marginTop: 1 }}>{s.count} transactions</div>
                              </div>
                              <div className="m-num" style={{ fontSize: 13, fontWeight: 600 }}>{fmtEur(s.total)}</div>
                              <I name="caretR" size={12} color={M.ink4}/>
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ScreenCategoryDrill({ params }) {
  const nav = useNav();
  const { txs: allTxs } = useTxCtx();
  const [periodDay] = useLocalStorage('munni_period_day', 20);
  const periodHistory = computePeriodHistory(periodDay);
  const cat = CATEGORIES[params?.id] || _catExt[params?.id] || CATEGORIES.restaurants;
  const isParent = !!cat.isParent;

  const childIds = isParent
    ? [...Object.values(CATEGORIES), ...Object.values(_catExt)].filter(c => c.parent === cat.id).map(c => c.id)
    : [cat.id];

  const periodBars = periodHistory.map(p => ({
    label: new Date(p.start).toLocaleString('en-GB',{month:'short'}),
    start: p.start,
    end: p.end,
    amount: allTxs.filter(t => t.amount < 0 && childIds.includes(t.cat) && t.date >= p.start && t.date <= p.end).reduce((s,t) => s + Math.abs(t.amount), 0),
  }));

  const [selectedBar, setSelectedBar] = React.useState(() => {
    const idx = periodHistory.findIndex(p => p.start === params?.periodStart);
    return idx >= 0 ? idx : periodHistory.length - 1;
  });

  // All txs for this category
  const txs = allTxs.filter(t => t.amount < 0 && childIds.includes(t.cat));
  const total = periodBars[selectedBar]?.amount || 0;

  const barData = periodBars.map(b => b.amount);
  const barLabels = periodBars.map(b => b.label);
  const barMax = Math.max(...barData, 1);

  const title = isParent ? `All ${cat.name}` : cat.name;
  const sub   = isParent ? null : cat.group;

  // Filter txs for selected period bar
  const visibleTxs = periodBars[selectedBar]
    ? txs.filter(t => t.date >= periodBars[selectedBar].start && t.date <= periodBars[selectedBar].end)
    : txs;

  // Group by day
  const byDay = {};
  visibleTxs.forEach(t => {
    if (!byDay[t.date]) byDay[t.date] = [];
    byDay[t.date].push(t);
  });
  const dayKeys = Object.keys(byDay).sort((a,b) => b.localeCompare(a));

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={title} sub={sub}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
        trailing={<button className="m-iconbtn m-tap"><I name="filter" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div className="m-card" style={{ padding: 18, marginBottom: 14, border: `1px solid ${M.line}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div className="m-cap">Spent · {periodBars[selectedBar]?.label || 'this period'}</div>
          </div>
          <div className="m-num" style={{ fontSize: 30, fontWeight: 600, marginTop: 4 }}>{fmtEur(total)}</div>
          {/* Interactive bar chart */}
          <div style={{ marginTop: 16, display:'flex', alignItems:'flex-end', gap:4, height:84 }}>
            {barData.map((v, i) => (
              <div key={i} onClick={() => setSelectedBar(i)}
                style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-end', height:'100%', cursor:'pointer' }}>
                <div style={{
                  width:'100%', borderRadius:4,
                  height: `${Math.max((v / barMax) * 74, v > 0 ? 4 : 0)}px`,
                  background: M.ink,
                  opacity: selectedBar === i ? 1 : 0.25,
                  transition: 'opacity 0.2s ease, height 0.2s ease',
                }}/>
                <div style={{ fontSize:9, color: selectedBar === i ? M.ink : M.ink3, marginTop:3, textAlign:'center', fontWeight: selectedBar === i ? 700 : 400 }}>{barLabels[i]}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom: 8, paddingLeft: 4 }}>
          Transactions · {visibleTxs.length}
        </div>
        {dayKeys.length === 0 ? (
          <div className="m-card" style={{ padding:'24px 0', textAlign:'center', border:`1px solid ${M.line}`, color:M.ink3, fontSize:13 }}>No transactions</div>
        ) : dayKeys.map(day => (
          <div key={day} style={{ marginBottom:8 }}>
            <div style={{ fontSize:11, fontWeight:600, color:M.ink3, paddingLeft:4, marginBottom:4 }}>{dayLabel(day)}</div>
            <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}` }}>
              {byDay[day].map((t, i, a) => (
                <React.Fragment key={t.id}>
                  <TxRow tx={t} onClick={() => nav.push('txDetail', { id: t.id })}
                    showCat={isParent}
                    catLabel={isParent ? ((CATEGORIES[t.cat] || _catExt[t.cat])?.name || undefined) : undefined}
                  />
                  {i < a.length-1 && <Divider inset={50}/>}
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
