import React from 'react';
import { CATEGORIES, _catExt, catPath, catNameT, _GROUP_KEYS, fmtEur, fmtDate } from '../data.jsx';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../theme.jsx';
import { useLang } from '../i18n.jsx';
import { useNav, Sheet } from '../nav.jsx';
import { useTxCtx } from '../providers.jsx';
import { HighlightText, DetailRow } from './Tx.jsx';


export function ScreenReviewSwipe() {
  const nav = useNav();
  const { txs, updateTx } = useTxCtx();
  const [reviewed, setReviewed] = React.useState(new Set());
  const [skipped, setSkipped] = React.useState(new Set());
  const reviewTxs = txs
    .filter(t => t.needsReview)
    .sort((a, b) => {
      const aGP = a.merchant === 'Google Playstore' ? 0 : 1;
      const bGP = b.merchant === 'Google Playstore' ? 0 : 1;
      return aGP - bGP;
    });
  const queue = reviewTxs.filter(t => !reviewed.has(t.id) && !skipped.has(t.id));
  const [initialCount] = React.useState(() => reviewTxs.length || 1);
  const [idx, setIdx] = React.useState(0);
  const [drag, setDrag] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [editAmt, setEditAmt] = React.useState(null);
  const [bulkSelected, setBulkSelected] = React.useState(new Set());
  const [previewTx, setPreviewTx] = React.useState(null);
  const [dupError, setDupError] = React.useState(null);

  const tx = queue[idx];
  const isNegative = tx && tx.amount < 0;

  const initCats = (t) => [{ id: t.aiSuggestCat || t.cat, amount: Math.abs(t.amount) }];
  const [txCats, setTxCats] = React.useState(() => tx ? initCats(tx) : []);

  React.useEffect(() => { if (tx) setTxCats(initCats(tx)); }, [idx, queue.length]);
  React.useEffect(() => { setBulkSelected(new Set()); }, [idx]);

  const allocatedSum = txCats.reduce((s, c) => s + c.amount, 0);
  const txAbs = tx ? Math.abs(tx.amount) : 0;
  const unallocated = Math.max(0, txAbs - allocatedSum);

  // Conditional bulk: single cat → same merchant; multi-cat → same merchant + same amount
  const singleCat = txCats.length === 1;
  const queueSimilar = tx ? queue.filter(t => {
    if (t.id === tx.id) return false;
    if (singleCat) return t.merchant === tx.merchant;
    return t.merchant === tx.merchant && t.amount === tx.amount;
  }) : [];

  const totalToConfirm = 1 + bulkSelected.size;

  const advance = () => {
    setDrag(160);
    setTimeout(() => {
      const nextIdx = idx + 1 >= queue.length ? 0 : idx + 1;
      setIdx(nextIdx);
      setDrag(0);
      if (queue.length <= 1) setDone(true);
    }, 220);
  };

  const confirmCurrent = () => {
    if (txCats.length === 0) return;
    const toMark = new Set([tx.id, ...Array.from(bulkSelected)]);
    // Persist: clear needsReview and update categories in localStorage
    toMark.forEach(id => {
      const t = txs.find(x => x.id === id);
      if (!t) return;
      const cats = id === tx.id ? txCats.map(c => ({ catId: c.id, amount: c.amount })) : (t.cats || [{ catId: t.cat, amount: Math.abs(t.amount) }]);
      updateTx(id, { needsReview: false, cats, cat: cats[0]?.catId || t.cat });
    });
    setReviewed(r => new Set([...r, ...toMark]));
    setBulkSelected(new Set());
    setDrag(160);
    setTimeout(() => {
      setIdx(0);
      setDrag(0);
    }, 220);
  };

  if (queue.length === 0 || done) {
    const hasSkipped = skipped.size > 0;
    return (
      <div className="m-screen">
        <StatusBar/>
        <AppBar title="Review" leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}/>
        <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:32, textAlign:'center', gap:12 }}>
          <div style={{ width:80, height:80, borderRadius:24, background:hasSkipped ? M.ochreSoft : M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <I name={hasSkipped ? 'alert' : 'check'} size={36} color={hasSkipped ? M.ochre : M.sage} stroke={2.5}/>
          </div>
          <div className="m-h2" style={{ marginTop:8 }}>{hasSkipped ? 'Review paused' : 'All caught up'}</div>
          <div style={{ fontSize:14, color:M.ink3, lineHeight:1.5, maxWidth:260 }}>
            {hasSkipped
              ? `${skipped.size} transaction${skipped.size > 1 ? 's' : ''} skipped — they'll be waiting here next time you review.`
              : "Nice work. We'll let you know when new transactions need a quick review."}
          </div>
          <button className="m-btn m-tap" style={{ marginTop:16 }} onClick={() => nav.pop()}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="m-screen" style={{ background: M.paper2 }}>
      <StatusBar/>
      <AppBar title={`Review · ${reviewed.size + skipped.size + 1} / ${initialCount}`}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="x" size={20}/></button>}
      />

      <div style={{ display:'flex', justifyContent:'center', gap:4, padding:'0 20px 14px', flexShrink:0 }}>
        {Array.from({ length: Math.min(initialCount, 30) }).map((_, i) => {
          const done = i < reviewed.size + skipped.size;
          const isSkipped = i >= reviewed.size && i < reviewed.size + skipped.size;
          const isCurrent = i === reviewed.size + skipped.size;
          return (
            <div key={i} style={{ flex:1, height:3, borderRadius:999, background: done ? (isSkipped ? M.ink3 : M.sage) : (isCurrent ? M.ink : M.line2) }}/>
          );
        })}
      </div>

      <div style={{ flex:1, overflowY:'auto', padding:'0 20px' }}>
        <div className="m-card" style={{
          width:'100%', padding:20, border:`1px solid ${M.line}`, background:'#fff',
          transform:`translateX(${drag}px) rotate(${drag * 0.04}deg)`,
          opacity: 1 - Math.abs(drag) / 400,
          transition: drag === 0 ? 'transform 0.3s, opacity 0.3s' : 'transform 0.2s, opacity 0.2s',
          boxShadow:'0 8px 30px rgba(0,0,0,0.06)',
        }}>
          <div style={{ textAlign:'center', marginBottom:20 }}>
            <div className="m-num" style={{ fontSize:34, fontWeight:600, color: tx.amount > 0 ? M.sage : M.ink, letterSpacing:'-0.02em' }}>
              {tx.amount > 0 ? '+' : '−'}{fmtEur(Math.abs(tx.amount))}
            </div>
            <div style={{ fontSize:17, fontWeight:600, marginTop:10 }}>{tx.merchant}</div>
            <div style={{ fontSize:12, color:M.ink3, marginTop:4 }}>{fmtDate(tx.date, 'long')} · {tx.time}</div>
            <div style={{ fontSize:10, color:M.ink4, fontFamily:M.fontMono, marginTop:6 }}>{tx.desc}</div>
          </div>

          <div style={{ padding:'12px 14px', borderRadius:12, background:M.paper2, border:`1px solid ${M.line2}` }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:12, height:12, borderRadius:999, background:M.violet, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <div style={{ width:4, height:4, borderRadius:999, background:'#fff' }}/>
                </div>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:M.violet }}>Categories · {tx.confidence}% AI</div>
              </div>
              {unallocated > 0 && (
                <span style={{ fontSize:10, fontWeight:600, color:M.ochre }}>−{fmtEur(unallocated)} unallocated</span>
              )}
            </div>

            {txCats.map((tc, i) => {
              const c = CATEGORIES[tc.id] || {};
              const maxForThis = txAbs - txCats.reduce((s, x, j) => j !== i ? s + x.amount : s, 0);
              return (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', borderRadius:10, background:'#fff', border:`1px solid ${M.line}`, marginBottom:8 }}>
                  <div style={{ width:30, height:30, borderRadius:8, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <IcoMDI name={c.icon || 'help-circle-outline'} size={14} color={M.ink2}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:600 }}>{catPath(c) || tc.id}</div>
                  </div>
                  <button className="m-tap" onClick={() => setEditAmt({ idx: i, initial: tc.amount, max: maxForThis + tc.amount })}
                    style={{ display:'flex', alignItems:'center', gap:4, padding:'4px 8px', borderRadius:8, background:M.paper2, border:'none', cursor:'pointer' }}>
                    <span className="m-num" style={{ fontSize:13, fontWeight:600, color:M.ink }}>{fmtEur(tc.amount)}</span>
                    <I name="edit" size={11} color={M.ink4}/>
                  </button>
                  <button className="m-tap" onClick={() => setTxCats(cs => cs.filter((_, j) => j !== i))} style={{ background:'transparent', border:'none', cursor:'pointer', padding:2, flexShrink:0 }}>
                    <I name="x" size={14} color={M.ink4}/>
                  </button>
                </div>
              );
            })}

            <button className="m-tap" onClick={() => unallocated > 0 && setPicking(true)} style={{
              display:'flex', alignItems:'center', gap:8, width:'100%', padding:'8px 10px',
              borderRadius:10, border:`1px dashed ${unallocated > 0 ? M.line : M.line2}`, background:'transparent',
              fontSize:13, color: unallocated > 0 ? M.ink3 : M.ink4, fontFamily:M.fontUI,
              cursor: unallocated > 0 ? 'pointer' : 'default', opacity: unallocated > 0 ? 1 : 0.5,
            }}>
              <I name="plus" size={14} color={unallocated > 0 ? M.ink3 : M.ink4}/> Add category
            </button>
          </div>

          {queueSimilar.length > 0 && (
            <div style={{ marginTop:14, borderRadius:12, background:M.violetSoft||'#EEE8FF', border:`1px solid ${M.violet}22`, overflow:'hidden' }}>
              <div style={{ padding:'10px 14px 8px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:'0.05em', textTransform:'uppercase', color:M.violet }}>
                  {singleCat ? `Same merchant in queue` : `Same merchant & amount`} · {queueSimilar.length}
                </div>
                <button className="m-tap" onClick={() => {
                  const allIds = queueSimilar.map(t => t.id);
                  const allSelected = allIds.every(id => bulkSelected.has(id));
                  setBulkSelected(allSelected ? new Set() : new Set(allIds));
                }} style={{ fontSize:11, fontWeight:600, color:M.violet, background:'transparent', border:`1px solid ${M.violet}44`, borderRadius:6, padding:'3px 8px', cursor:'pointer', fontFamily:M.fontUI }}>
                  {queueSimilar.every(t => bulkSelected.has(t.id)) ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div style={{ maxHeight:220, overflowY:'auto' }}>
                {queueSimilar.map((st, stIdx) => (
                  <div key={st.id} style={{
                    display:'flex', alignItems:'center', gap:10,
                    padding:'9px 14px',
                    background: bulkSelected.has(st.id) ? M.violet+'18' : 'transparent',
                    borderTop: stIdx > 0 ? `1px solid ${M.violet}18` : 'none',
                    transition:'background 0.15s',
                  }}>
                    <div
                      className="m-tap"
                      onClick={() => setBulkSelected(s => { const n = new Set(s); n.has(st.id) ? n.delete(st.id) : n.add(st.id); return n; })}
                      style={{ width:22, height:22, borderRadius:7, border:`2px solid ${bulkSelected.has(st.id) ? M.violet : M.violet+'60'}`, background: bulkSelected.has(st.id) ? M.violet : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 0.15s', cursor:'pointer' }}
                    >
                      {bulkSelected.has(st.id) && <I name="check" size={10} color="#fff" stroke={3}/>}
                    </div>
                    <div className="m-tap" onClick={() => setBulkSelected(s => { const n = new Set(s); n.has(st.id) ? n.delete(st.id) : n.add(st.id); return n; })} style={{ flex:1, minWidth:0, cursor:'pointer' }}>
                      <div style={{ fontSize:12, fontWeight:600, color:M.ink }}>{fmtDate(st.date)} · {fmtEur(Math.abs(st.amount))}</div>
                      <div style={{ fontSize:11, color:M.violet+'BB', marginTop:1 }}>{st.desc}</div>
                    </div>
                    <button className="m-tap" onClick={e => { e.stopPropagation(); setPreviewTx(st); }}
                      style={{ width:28, height:28, borderRadius:8, background:M.violet+'18', border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name="caretR" size={13} color={M.violet}/>
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ padding:'8px 14px', borderTop:`1px solid ${M.violet}22`, fontSize:11, color:M.violet+'99' }}>
                {bulkSelected.size === 0
                  ? 'Tap a row or checkbox to also update these transactions'
                  : `Confirming will apply the same categories to all ${totalToConfirm} transactions`}
              </div>
            </div>
          )}
        </div>
        <div style={{ height:16 }}/>
      </div>

      <div style={{ display:'flex', gap:12, padding:'12px 20px 20px', flexShrink:0 }}>
        <button className="m-tap" onClick={() => { setSkipped(s => new Set([...s, tx.id])); setIdx(0); }} style={{
          flex:1, height:54, borderRadius:16, border:`1px solid ${M.line}`,
          background:'#fff', display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          fontSize:14, fontWeight:600, color:M.ink3,
        }}>
          <I name="x" size={18} color={M.ink3}/> Skip
        </button>
        <button className="m-tap" onClick={confirmCurrent} style={{
          flex:2, height:54, borderRadius:16, border:'none',
          background: txCats.length > 0 ? M.sage : M.line2,
          color: txCats.length > 0 ? '#fff' : M.ink4,
          display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          fontSize:14, fontWeight:600,
          opacity: txCats.length > 0 ? 1 : 0.6,
          cursor: txCats.length > 0 ? 'pointer' : 'default',
        }}>
          <I name="check" size={20} color={txCats.length > 0 ? '#fff' : M.ink4} stroke={2.5}/>
          {totalToConfirm > 1 ? `Confirm · ${totalToConfirm} txs` : 'Confirm'}
        </button>
      </div>

      {picking && <CategoryPicker
        selected={txCats[txCats.length-1]?.id}
        filterPositive={isNegative}
        defaultAmount={unallocated || txAbs}
        maxAmount={unallocated || txAbs}
        onClose={() => setPicking(false)}
        onPick={(id, amt) => {
          if (txCats.some(c => c.id === id)) {
            setDupError(CATEGORIES[id]?.name || id);
            setTimeout(() => setDupError(null), 2500);
            return;
          }
          setTxCats(cs => [...cs, { id, amount: amt }]);
          setPicking(false);
        }}
      />}

      {dupError && (
        <div style={{ position:'fixed', bottom:120, left:'50%', transform:'translateX(-50%)', background:M.ink, color:'#fff', borderRadius:10, padding:'10px 16px', fontSize:13, fontWeight:600, zIndex:200, whiteSpace:'nowrap', boxShadow:'0 4px 20px rgba(0,0,0,0.2)', animation:'fadeIn 0.2s ease' }}>
          "{dupError}" is already added
        </div>
      )}

      {editAmt !== null && (
        <AmountEditSheet
          cat={CATEGORIES[txCats[editAmt.idx]?.id] || {}}
          initialAmount={editAmt.initial}
          maxAmount={editAmt.max}
          onConfirm={(val) => { setTxCats(cs => cs.map((x, j) => j === editAmt.idx ? { ...x, amount: val } : x)); setEditAmt(null); }}
          onClose={() => setEditAmt(null)}
        />
      )}

      {previewTx && (
        <Sheet onClose={() => setPreviewTx(null)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
              <div style={{ width:36, height:36, borderRadius:10, background:M.claySoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <IcoMDI name={CATEGORIES[previewTx.cat]?.icon || 'help-circle-outline'} size={16} color={M.clay}/>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:15, fontWeight:600 }}>{previewTx.merchant}</div>
                <div style={{ fontSize:12, color:M.ink3 }}>{fmtDate(previewTx.date, 'long')} · {previewTx.time}</div>
              </div>
              <div className="m-num" style={{ fontSize:16, fontWeight:700, color:M.ink }}>−{fmtEur(Math.abs(previewTx.amount))}</div>
            </div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
              <DetailRow label="Category" value={catPath(CATEGORIES[previewTx.cat] || {})} icon={CATEGORIES[previewTx.cat]?.icon}/>
              <Divider inset={0}/>
              <DetailRow label="Description" value={previewTx.desc} mono/>
              <Divider inset={0}/>
              <DetailRow label="AI confidence" value={`${previewTx.confidence || 0}%`}/>
            </div>
            <button className="m-btn outline m-tap" style={{ width:'100%' }} onClick={() => setPreviewTx(null)}>Close</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}


export function AmountNumpad({ amtStr, onPress, onConfirm, maxAmount, confirmLabel }) {
  const val = parseFloat(amtStr.replace(',', '.')) || 0;
  const capped = maxAmount !== undefined && val > maxAmount;
  const ok = val > 0 && !capped;
  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1 }}>
      <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'8px 0' }}>
        <div className="m-num" style={{ fontSize:52, fontWeight:600, letterSpacing:'-0.03em', color: capped ? M.clay : M.ink }}>
          €{amtStr}
        </div>
        {capped && <div style={{ fontSize:12, color:M.clay, marginTop:6, fontWeight:500 }}>Max {fmtEur(maxAmount)}</div>}
      </div>
      <div style={{ padding:'0 20px 28px', flexShrink:0 }}>
        {[['1','2','3'],['4','5','6'],['7','8','9'],[',','0','⌫']].map((row, ri) => (
          <div key={ri} style={{ display:'flex', gap:8, marginBottom:8 }}>
            {row.map(k => (
              <button key={k} onClick={() => onPress(k)} style={{
                flex:1, height:54, borderRadius:14, border:`1px solid ${M.line}`,
                background: k === '⌫' ? M.paper2 : '#fff',
                fontSize: k === '⌫' ? 20 : 24, fontWeight:500, color:M.ink,
                cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
              }}>{k}</button>
            ))}
          </div>
        ))}
        <button onClick={() => ok && onConfirm(val)} style={{
          width:'100%', height:54, borderRadius:16, border:'none', marginTop:4,
          background: ok ? M.sage : M.line2, color: ok ? '#fff' : M.ink4,
          fontSize:16, fontWeight:600, cursor: ok ? 'pointer' : 'default',
        }}>{confirmLabel || `Confirm ${fmtEur(val)}`}</button>
      </div>
    </div>
  );
}

export function useNumpadStr(initial) {
  const [str, setStr] = React.useState(
    initial > 0 ? initial.toFixed(2).replace('.', ',') : '0'
  );
  const [fresh, setFresh] = React.useState(initial > 0);
  const press = (k) => {
    if (fresh && k !== '⌫') {
      setFresh(false);
      if (k === ',') { setStr('0,'); return; }
      setStr(k === '0' ? '0' : k);
      return;
    }
    setStr(s => {
      if (k === '⌫') { setFresh(false); return s.length > 1 ? s.slice(0, -1) : '0'; }
      if (k === ',') return s.includes(',') ? s : (s === '0' ? '0,' : s + ',');
      if (s === '0') return k;
      const dec = s.split(',')[1];
      if (dec !== undefined && dec.length >= 2) return s;
      return s + k;
    });
  };
  const resetStr = (val) => {
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.')) || 0;
    const s = n > 0 ? n.toFixed(2).replace('.', ',') : '0';
    setStr(s); setFresh(n > 0);
  };
  return [str, press, resetStr];
}

// Standalone amount-edit sheet — used to edit an existing category's amount
function AmountEditSheet({ cat, initialAmount, maxAmount, onConfirm, onClose }) {
  const [str, press] = useNumpadStr(initialAmount);
  return (
    <Sheet onClose={onClose}>
      <div style={{ display:'flex', flexDirection:'column', height:460 }}>
        <div style={{ padding:'4px 20px 0', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <IcoMDI name={cat.icon || 'help-circle-outline'} size={15} color={M.ink2}/>
          </div>
          <div style={{ fontSize:15, fontWeight:600 }}>{catPath(cat)}</div>
        </div>
        <AmountNumpad amtStr={str} onPress={press} onConfirm={onConfirm} maxAmount={maxAmount} confirmLabel="Update amount"/>
      </div>
    </Sheet>
  );
}

export function CategoryPicker({ selected, onClose, onPick, filterPositive = false, positiveOnly = false, skipAmount = false, defaultAmount = 0, maxAmount = 999 }) {
  const { t } = useLang();
  const [pickedId, setPickedId] = React.useState(null);
  const [str, press, setStr] = useNumpadStr(defaultAmount);
  const [searchQ, setSearchQ] = React.useState('');

  const handlePickCat = (id) => {
    if (skipAmount) { onPick(id, 0); return; }
    setStr(defaultAmount);
    setPickedId(id);
  };

  const groups = {};
  const allCatValues = [...Object.values(CATEGORIES), ...Object.values(_catExt)];
  allCatValues.forEach(c => {
    if (c.isParent) return;
    if (positiveOnly && !c.positive) return;
    if (!positiveOnly && c.positive) return;
    if (!positiveOnly && c.group === 'Saving') return;
    // For custom cats without group, derive group from parent name
    const groupKey = c.group || (c.parent && (CATEGORIES[c.parent] || _catExt[c.parent])?.name) || 'Custom';
    if (searchQ) {
      const q = searchQ.toLowerCase();
      const parentName = c.parent ? ((CATEGORIES[c.parent] || _catExt[c.parent])?.name || '').toLowerCase() : '';
      if (!c.name.toLowerCase().includes(q) && !parentName.includes(q) && !(groupKey||'').toLowerCase().includes(q)) return;
    }
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(c);
  });

  const pickedCat = CATEGORIES[pickedId] || _catExt[pickedId] || {};

  return (
    <div style={{ position:'absolute', inset:0, zIndex:100, animation:'mFadeIn 0.2s ease-out both' }}>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.4)' }} onClick={onClose}/>
      <div style={{
        position:'absolute', left:0, right:0, bottom:0, top: pickedId ? 100 : 80,
        background:'#fff', borderTopLeftRadius:24, borderTopRightRadius:24,
        display:'flex', flexDirection:'column', overflow:'hidden',
        transition:'top 0.2s ease',
      }}>
        {!pickedId ? (
          <>
            <div style={{ padding:'14px 20px 12px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:`1px solid ${M.line2}`, flexShrink:0 }}>
              <button className="m-tap" onClick={onClose} style={{ background:'transparent', border:'none', fontSize:14, color:M.ink3 }}>Cancel</button>
              <div style={{ fontSize:15, fontWeight:600 }}>Pick category</div>
              <div style={{ width:50 }}/>
            </div>
            <div style={{ padding:'10px 12px 4px', flexShrink:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:10, background:M.paper2, border:`1px solid ${M.line}` }}>
                <I name="search" size={15} color={M.ink3}/>
                <input
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  placeholder="Search categories…"
                  autoFocus={false}
                  style={{ flex:1, border:'none', background:'transparent', fontSize:13, color:M.ink, outline:'none', fontFamily:M.fontUI }}
                />
                {searchQ ? <button onClick={() => setSearchQ('')} style={{ background:'none', border:'none', color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, fontSize:16, lineHeight:1 }}>×</button> : null}
              </div>
            </div>
            <div style={{ flex:1, overflowY:'auto', padding:'0 20px 20px' }}>
              {Object.keys(groups).length === 0 && (
                <div style={{ textAlign:'center', padding:'32px 0', color:M.ink3, fontSize:13 }}>No results for "{searchQ}"</div>
              )}
              {Object.entries(groups).map(([groupName, cats]) => {
                const gKey = _GROUP_KEYS[groupName];
                const gLabel = gKey ? t(gKey) : groupName;
                return (
                <div key={groupName} style={{ marginBottom:18 }}>
                  <div className="m-cap" style={{ marginBottom:8 }}>
                    {searchQ ? <HighlightText text={gLabel} query={searchQ}/> : gLabel}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {cats.map(c => {
                      const cLabel = catNameT(c.id, t);
                      return (
                      <button key={c.id} onClick={() => handlePickCat(c.id)} className="m-tap" style={{
                        padding:'12px 14px', borderRadius:12,
                        border:`1px solid ${selected === c.id ? M.sage : M.line}`,
                        background: selected === c.id ? M.sageSoft : '#fff',
                        display:'flex', alignItems:'center', gap:10, textAlign:'left',
                      }}>
                        <IcoMDI name={c.icon || 'help-circle-outline'} size={16} color={selected === c.id ? M.sage : M.ink2}/>
                        <span style={{ fontSize:13, fontWeight:500, color:M.ink, flex:1 }}>
                          {searchQ ? <HighlightText text={cLabel} query={searchQ}/> : cLabel}
                        </span>
                        {selected === c.id && <I name="check" size={14} color={M.sage} stroke={2.5}/>}
                      </button>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
            {(Object.keys(groups).length === 0 || searchQ) && (
              <div style={{ padding:'8px 20px 20px', borderTop:`1px solid ${M.line2}`, flexShrink:0 }}>
                <button className="m-tap" onClick={onClose} style={{ fontSize:12, color:M.ink3, background:'transparent', border:'none', fontFamily:M.fontUI, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                  <I name="plus" size={12} color={M.ink3}/> Manage custom categories
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ padding:'14px 20px 12px', display:'flex', alignItems:'center', gap:12, borderBottom:`1px solid ${M.line2}`, flexShrink:0 }}>
              <button className="m-tap" onClick={() => setPickedId(null)} style={{ background:'transparent', border:'none', display:'flex', alignItems:'center', gap:4, color:M.ink3, fontSize:14, cursor:'pointer' }}>
                <I name="arrowL" size={16} color={M.ink3}/> Back
              </button>
              <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                <div style={{ width:28, height:28, borderRadius:8, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <IcoMDI name={pickedCat.icon || 'help-circle-outline'} size={14} color={M.ink2}/>
                </div>
                <div style={{ fontSize:14, fontWeight:600 }}>{catPath(pickedCat)}</div>
              </div>
              <div style={{ width:60 }}/>
            </div>
            <AmountNumpad
              amtStr={str}
              onPress={press}
              maxAmount={maxAmount}
              onConfirm={(val) => onPick(pickedId, val)}
              confirmLabel={`Add · ${catPath(pickedCat)}`}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function ScreenLinkReimburse({ params }) {
  const nav = useNav();
  const { txs, updateTx } = useTxCtx();
  const txId = params?.txId;
  const isPositive = params?.positive === true;
  const sourceTx = txs.find(t => t.id === txId);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(null);
  const [str, pressStr, setStr] = useNumpadStr(0);

  const maxAmt = sourceTx ? Math.abs(sourceTx.amount) : 999;

  // Opposite-type transactions: if source is expense (negative), show income; if source is income, show expenses
  const allCandidates = txs.filter(t => {
    if (t.id === txId) return false;
    return isPositive ? t.amount < 0 : t.amount > 0;
  });

  const filtered = query
    ? allCandidates.filter(t => {
        const q = query.toLowerCase();
        return t.merchant.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q);
      })
    : allCandidates;

  // Sort by proximity to source transaction date
  const sorted = [...filtered].sort((a, b) => {
    if (!sourceTx) return 0;
    const da = Math.abs(new Date(a.date) - new Date(sourceTx.date));
    const db = Math.abs(new Date(b.date) - new Date(sourceTx.date));
    return da - db;
  });

  if (selected) {
    const selCat = CATEGORIES[selected.cat] || {};
    const val = parseFloat(str.replace(',', '.')) || 0;
    const ok = val > 0 && val <= maxAmt;
    return (
      <div className="m-screen">
        <StatusBar/>
        <AppBar title="Set amount"
          leading={<button className="m-iconbtn m-tap" onClick={() => setSelected(null)}><I name="arrowL" size={20}/></button>}
        />
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderRadius:12, background:M.paper2, marginBottom:8 }}>
            <div style={{ width:36, height:36, borderRadius:10, background: isPositive ? M.claySoft : M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <IcoMDI name={selCat.icon||'help-circle-outline'} size={16} color={isPositive ? M.clay : M.sage}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>{selected.merchant}</div>
              <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{fmtDate(selected.date)} · total {fmtEur(Math.abs(selected.amount))}</div>
            </div>
          </div>
          <div style={{ fontSize:12, color:M.ink3, marginBottom:4, paddingLeft:4 }}>How much of this transaction is reimbursed?</div>
        </div>
        <AmountNumpad
          amtStr={str}
          onPress={pressStr}
          maxAmount={maxAmt}
          onConfirm={(v) => {
            // Persist the link: selected tx links back to source
            updateTx(selected.id, { linkedTo: txId, amount: isPositive ? -v : v });
            nav.pop();
          }}
          confirmLabel={ok ? `Link · ${fmtEur(val)} reimbursed` : 'Enter amount'}
        />
      </div>
    );
  }

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={isPositive ? 'Link reimbursed expense' : 'Link a reimbursement'}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {sourceTx && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 16px', borderRadius:12, background:M.paper2, marginBottom:12 }}>
            <I name="link" size={14} color={M.ink3}/>
            <span style={{ fontSize:12, color:M.ink3 }}>Linking to: <strong style={{ color:M.ink }}>{sourceTx.merchant}</strong> · {fmtEur(Math.abs(sourceTx.amount))}</span>
          </div>
        )}

        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:10, background:M.paper2, marginBottom:12, border:`1px solid ${M.line}` }}>
          <I name="search" size={15} color={M.ink3}/>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search transactions…"
            style={{ flex:1, border:'none', background:'transparent', fontSize:13, color:M.ink, outline:'none', fontFamily:M.fontUI }}
          />
          {query ? <button onClick={() => setQuery('')} style={{ background:'none', border:'none', color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, fontSize:16, lineHeight:1 }}>×</button> : null}
        </div>

        {sorted.length === 0 ? (
          <div style={{ padding:'32px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>
            {query ? `No results for "${query}"` : 'No transactions found'}
          </div>
        ) : (
          <div className="m-card" style={{ padding:'0 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
            {sorted.map((t, i, a) => {
              const tCat = CATEGORIES[t.cat] || {};
              const txPositive = t.amount > 0;
              return (
                <React.Fragment key={t.id}>
                  <div className="m-tap" onClick={() => { setSelected(t); setStr(Math.abs(t.amount).toFixed(2).replace('.', ',')); }} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background: txPositive ? M.sageSoft : M.claySoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <IcoMDI name={tCat.icon||'help-circle-outline'} size={16} color={txPositive ? M.sage : M.clay}/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        <HighlightText text={t.merchant} query={query}/>
                      </div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{fmtDate(t.date)} · {catPath(tCat)}</div>
                    </div>
                    <div className="m-num" style={{ fontSize:14, fontWeight:600, color:txPositive ? M.sage : M.ink, flexShrink:0 }}>
                      {txPositive ? '+' : '−'}{fmtEur(Math.abs(t.amount))}
                    </div>
                  </div>
                  {i < a.length - 1 && <Divider inset={48}/>}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
