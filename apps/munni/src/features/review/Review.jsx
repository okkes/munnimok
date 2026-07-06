import React from 'react';
import { CATEGORIES, _catExt, catPath, catNameT, _GROUP_KEYS, TX_TYPES, TX_TYPE_META, deriveTxType, getTypeFallbackCat, isUncatId } from '../../shared/data/categories.js';
import { fmtEur, fmtDate } from '../../shared/utils/format.js';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav, Sheet } from '../../app/nav.jsx';
import { useTxCtx, useProfiles, useConnectedAccounts } from '../../app/providers.jsx';
import { useLocalStorage, useSpaceCats } from '../../shared/hooks.jsx';
import { getUserId } from '../../shared/utils/user.js';
import { HighlightText } from '../../shared/components/TxRow.jsx';
import { DetailRow } from '../transactions/Tx.jsx';


export function ScreenReviewSwipe() {
  const nav = useNav();
  const { t } = useLang();
  const { txs, updateTx } = useTxCtx();
  const { profiles } = useProfiles();
  const [reviewed, setReviewed] = React.useState(new Set());
  const [skipped, setSkipped] = React.useState(new Set());
  const myId = React.useMemo(() => getUserId(), []);
  const activeProfile = profiles.find(p => p.active) || profiles[0];
  const _sharedKey = (activeProfile?.isShared || (activeProfile?.members||[]).length > 0)
    ? `munni_shared_data_${activeProfile?.id}` : 'munni_shared_data_none';
  const [_activeSharedData] = useLocalStorage(_sharedKey, {});
  const [_userRegistry] = useLocalStorage('munni_global_users', {});
  const [connectedAccounts] = useConnectedAccounts();

  // Session-level review lock: first user to open the review screen claims the lock.
  // Others can only skip until the lock holder exits.
  const _sessionLockKey = _sharedKey !== 'munni_shared_data_none' ? _sharedKey : null;
  React.useEffect(() => {
    if (!_sessionLockKey) return;
    try {
      const sd = JSON.parse(localStorage.getItem(_sessionLockKey) || '{}');
      const lock = sd.reviewSession;
      // Don't claim if another user holds the lock and it's still fresh
      if (lock && lock.userId !== myId && (Date.now() - (lock.startedAt || 0)) < 300000) return;
      localStorage.setItem(_sessionLockKey, JSON.stringify({ ...sd, reviewSession: { userId: myId, startedAt: Date.now() } }));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: _sessionLockKey } }));
    } catch {}
    return () => {
      try {
        const sd = JSON.parse(localStorage.getItem(_sessionLockKey) || '{}');
        if (sd.reviewSession?.userId !== myId) return;
        const { reviewSession: _rs, ...rest } = sd;
        localStorage.setItem(_sessionLockKey, JSON.stringify(rest));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: _sessionLockKey } }));
      } catch {}
    };
  }, [_sessionLockKey, myId]);

  const sharedReviewed = React.useMemo(() => {
    const r = new Set();
    if (_sharedKey === 'munni_shared_data_none') return r;
    Object.keys(_activeSharedData?.reviewed || {}).forEach(txId => r.add(txId));
    return r;
  }, [_sharedKey, _activeSharedData]);

  const reviewTxs = txs
    .filter(t => t.needsReview && !sharedReviewed.has(t.id))
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
  const [showTypePicker, setShowTypePicker] = React.useState(false);
  const [showAcctPicker, setShowAcctPicker] = React.useState(false);

  const tx = queue[idx];
  const isNegative = tx && tx.amount < 0;

  const [reviewTxType, setReviewTxType] = React.useState(() => tx?.txType || (isNegative ? 'Expense' : 'Income'));
  const [reviewLinkedAcctId, setReviewLinkedAcctId] = React.useState(() => tx?.linkedAccount || null);

  // All accounts available to link (personal + shared space, excluding tx's own account)
  const reviewSharedAccounts = _activeSharedData?.accounts || [];
  const reviewAllLinkableAccounts = React.useMemo(() => {
    const all = [...connectedAccounts, ...reviewSharedAccounts];
    return all.filter((a, i, arr) => a.id !== tx?.account && arr.findIndex(x => x.id === a.id) === i);
  }, [connectedAccounts, reviewSharedAccounts, tx?.account]);
  const reviewTxAccount = [...connectedAccounts, ...reviewSharedAccounts].find(a => a.id === tx?.account);
  const reviewLinkedAcct = reviewAllLinkableAccounts.find(a => a.id === reviewLinkedAcctId);

  const initCats = (t) => [{ id: t.aiSuggestCat || t.cat, amount: Math.abs(t.amount) }];
  const [txCats, setTxCats] = React.useState(() => tx ? initCats(tx) : []);

  React.useEffect(() => {
    if (!tx) return;
    setTxCats(initCats(tx));
    setReviewTxType(tx.txType || (tx.amount < 0 ? 'Expense' : 'Income'));
    setReviewLinkedAcctId(tx.linkedAccount || null);
  }, [idx, queue.length]);
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

  // Session-level lock: first reviewer holds the lock for the whole session
  const _sessionLock = _activeSharedData?.reviewSession;
  const isReviewLockedByOther = !!_sessionLock && _sessionLock.userId !== myId
    && (Date.now() - (_sessionLock.startedAt || 0)) < 300000;
  const _lockHolderName = _userRegistry[_sessionLock?.userId]?.displayName || _sessionLock?.userId || 'Someone';

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
      updateTx(id, { needsReview: false, cats, cat: cats[0]?.catId || t.cat, txType: reviewTxType, linkedAccount: reviewLinkedAcctId || undefined });
      // Mark reviewed in shared data for transactions that belong to shared spaces
      profiles.forEach(p => {
        try {
          const sdKey = `munni_shared_data_${p.id}`;
          const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
          if ((sd.txs || []).some(st => st.id === id)) {
            const updSd = {
              ...sd,
              reviewed: { ...(sd.reviewed || {}), [id]: { by: myId, at: Date.now() } },
              txs: (sd.txs || []).map(st => st.id === id ? { ...st, needsReview: false } : st),
            };
            localStorage.setItem(sdKey, JSON.stringify(updSd));
            window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
          }
        } catch {}
      });
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

      <div style={{ padding:'0 20px 14px', flexShrink:0 }}>
        <div style={{ width:'100%', height:3, borderRadius:999, background:M.line2 }}>
          <div style={{
            width:`${Math.min(100, ((reviewed.size + skipped.size) / Math.max(1, initialCount)) * 100)}%`,
            height:'100%', borderRadius:999, background:M.sage,
            transition:'width 0.3s ease'
          }}/>
        </div>
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

          {/* Type + linked account row */}
          <div style={{ display:'flex', gap:8, marginTop:12 }}>
            <button className="m-tap" onClick={() => !reviewLinkedAcctId && setShowTypePicker(true)} style={{
              flex:1, display:'flex', alignItems:'center', gap:6, padding:'8px 10px', borderRadius:10,
              background:M.paper2, border:`1px solid ${M.line2}`, cursor: reviewLinkedAcctId ? 'default' : 'pointer',
            }}>
              <IcoMDI name={TX_TYPE_META[reviewTxType]?.icon || 'help-circle-outline'} size={13} color={TX_TYPE_META[reviewTxType]?.color || M.ink2}/>
              <span style={{ fontSize:12, fontWeight:600, color: TX_TYPE_META[reviewTxType]?.color || M.ink2, flex:1, textAlign:'left' }}>{reviewTxType}</span>
              {reviewLinkedAcctId ? <IcoMDI name="lock-outline" size={11} color={M.ink4}/> : <IcoMDI name="chevron-down" size={13} color={M.ink4}/>}
            </button>
            <button className="m-tap" onClick={() => setShowAcctPicker(true)} style={{
              flex:1, display:'flex', alignItems:'center', gap:6, padding:'8px 10px', borderRadius:10,
              background:M.paper2, border:`1px solid ${M.line2}`,
            }}>
              <IcoMDI name="bank-outline" size={13} color={M.ink3}/>
              <span style={{ fontSize:12, color: reviewLinkedAcct ? M.ink : M.ink4, flex:1, textAlign:'left', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {reviewLinkedAcct ? reviewLinkedAcct.name : 'Link account'}
              </span>
              {reviewLinkedAcctId
                ? <button onClick={e => { e.stopPropagation(); setReviewLinkedAcctId(null); setReviewTxType(isNegative ? 'Expense' : 'Income'); }} style={{ background:'none', border:'none', color:M.clay, fontSize:14, lineHeight:1, cursor:'pointer', padding:0, fontFamily:M.fontUI }}>×</button>
                : <IcoMDI name="chevron-down" size={13} color={M.ink4}/>
              }
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

      {isReviewLockedByOther && (
        <div style={{ margin:'0 20px 8px', padding:'9px 12px', borderRadius:10, background:M.ochreSoft, border:`1px solid ${M.ochre}`, display:'flex', alignItems:'center', gap:8 }}>
          <I name="lock" size={13} color={M.ochre}/>
          <span style={{ fontSize:12, color:M.ochre, fontWeight:500 }}>{t('tx.reviewingViewOnly').replace('{name}', _lockHolderName)}</span>
        </div>
      )}
      <div style={{ display:'flex', gap:12, padding:'12px 20px 20px', flexShrink:0 }}>
        <button className="m-tap" onClick={() => { setSkipped(s => new Set([...s, tx.id])); setIdx(0); }} style={{
          flex:1, height:54, borderRadius:16, border:`1px solid ${M.line}`,
          background:'#fff', display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          fontSize:14, fontWeight:600, color:M.ink3,
        }}>
          <I name="x" size={18} color={M.ink3}/> Skip
        </button>
        <button className={isReviewLockedByOther ? '' : 'm-tap'} onClick={isReviewLockedByOther ? undefined : confirmCurrent} disabled={isReviewLockedByOther} style={{
          flex:2, height:54, borderRadius:16, border:'none',
          background: isReviewLockedByOther ? M.line2 : (txCats.length > 0 ? M.sage : M.line2),
          color: isReviewLockedByOther ? M.ink4 : (txCats.length > 0 ? '#fff' : M.ink4),
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2,
          fontSize:14, fontWeight:600,
          opacity: (isReviewLockedByOther || txCats.length === 0) ? 0.6 : 1,
          cursor: (isReviewLockedByOther || txCats.length === 0) ? 'default' : 'pointer',
        }}>
          {isReviewLockedByOther ? (
            <>
              <I name="lock" size={16} color={M.ink4}/>
              <span style={{ fontSize:11, color:M.ink4 }}>{t('tx.reviewingViewOnly').replace('{name}', _lockHolderName)}</span>
            </>
          ) : (
            <>
              <I name="check" size={20} color={txCats.length > 0 ? '#fff' : M.ink4} stroke={2.5}/>
              {totalToConfirm > 1 ? `Confirm · ${totalToConfirm} txs` : 'Confirm'}
            </>
          )}
        </button>
      </div>

      {picking && <CategoryPicker
        selected={txCats[txCats.length-1]?.id}
        txType={reviewTxType}
        defaultAmount={unallocated || txAbs}
        maxAmount={unallocated || txAbs}
        onClose={() => setPicking(false)}
        onPick={(id, amt) => {
          setTxCats(cs => {
            const idx = cs.findIndex(c => c.id === id);
            if (idx >= 0) return cs.map((c, i) => i === idx ? { ...c, amount: Math.round((c.amount + amt) * 100) / 100 } : c);
            return [...cs, { id, amount: amt }];
          });
          setPicking(false);
        }}
      />}

      {showTypePicker && (
        <TypePickerSheet
          currentType={reviewTxType}
          onClose={() => setShowTypePicker(false)}
          onPick={(type) => {
            setReviewTxType(type);
            const curCatType = (CATEGORIES[txCats[0]?.id] || _catExt[txCats[0]?.id])?.type;
            if (curCatType !== type) {
              const fallback = getTypeFallbackCat(type, isNegative);
              setTxCats([{ id: fallback, amount: txAbs }]);
            }
          }}
        />
      )}

      {showAcctPicker && (
        <LinkedAccountPickerSheet
          txAccountId={tx?.account}
          myAccounts={connectedAccounts.filter(a => a.id !== tx?.account)}
          sharedAccounts={reviewSharedAccounts.filter(a => a.id !== tx?.account)}
          linkedAcctId={reviewLinkedAcctId}
          onClose={() => setShowAcctPicker(false)}
          onPick={(acctId) => {
            setReviewLinkedAcctId(acctId);
            const linked = reviewAllLinkableAccounts.find(a => a.id === acctId);
            const derived = acctId ? deriveTxType(reviewTxAccount, linked, tx.amount) : (isNegative ? 'Expense' : 'Income');
            setReviewTxType(derived);
            const curCatType = (CATEGORIES[txCats[0]?.id] || _catExt[txCats[0]?.id])?.type;
            if (curCatType !== derived) {
              const fallback = getTypeFallbackCat(derived, isNegative);
              setTxCats([{ id: fallback, amount: txAbs }]);
            }
          }}
        />
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
  const [amtStr, setAmtStr] = React.useState(initialAmount > 0 ? initialAmount.toFixed(2).replace('.', ',') : '');
  const val = parseFloat(amtStr.replace(',', '.')) || 0;
  const ok = val > 0 && val <= maxAmount + 0.005;
  return (
    <Sheet onClose={onClose} title={catPath(cat)}>
      <div style={{ padding:'4px 0 32px' }}>
        <input
          type="text" inputMode="decimal" autoFocus
          value={amtStr}
          onChange={e => setAmtStr(e.target.value)}
          onFocus={e => e.target.select()}
          placeholder={`Max ${fmtEur(maxAmount)}`}
          style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${val > maxAmount + 0.005 ? M.clay : M.line}`, fontSize:16, fontFamily:M.fontUI, color:M.ink, background:M.paper, outline:'none', boxSizing:'border-box', marginBottom:6 }}
        />
        {val > maxAmount + 0.005 && (
          <div style={{ fontSize:11, color:M.clay, marginBottom:8 }}>Max {fmtEur(maxAmount)}</div>
        )}
        <button onClick={() => ok && onConfirm(val)} disabled={!ok}
          style={{ width:'100%', padding:'14px 0', borderRadius:10, background: ok ? M.brand : M.paper2, color: ok ? '#fff' : M.ink4, border:'none', fontSize:14, fontWeight:600, cursor: ok ? 'pointer' : 'default', fontFamily:M.fontUI, marginTop:4 }}>
          {ok ? `Update · ${fmtEur(val)}` : 'Enter amount'}
        </button>
      </div>
    </Sheet>
  );
}

export function CategoryPicker({ selected, onClose, onPick, txType = 'Expense', skipAmount = false, defaultAmount = 0, maxAmount = 999 }) {
  const { t } = useLang();
  const [pickedId, setPickedId] = React.useState(null);
  const [amtStr, setAmtStr] = React.useState('');
  const [searchQ, setSearchQ] = React.useState('');
  const amtVal = parseFloat(amtStr.replace(',', '.')) || 0;
  const amtOk = amtVal > 0 && amtVal <= maxAmount + 0.005;
  const { profiles } = useProfiles();
  const activeProfile = profiles.find(p => p.active);
  const activeProfileId = activeProfile?.id;
  const isActiveShared = !!(activeProfile?.isShared || (activeProfile?.members || []).length > 0 || (activeProfileId && !!localStorage.getItem(`munni_shared_data_${activeProfileId}`)));
  const [spaceCatsForActive] = useSpaceCats(isActiveShared ? activeProfileId : null);
  const nav = useNav();

  const handlePickCat = (id) => {
    if (skipAmount) { onPick(id, 0); return; }
    setAmtStr(defaultAmount > 0 ? defaultAmount.toFixed(2).replace('.', ',') : '');
    setPickedId(id);
  };

  const groups = {};
  // In shared space: premade + space-specific custom cats only.
  // In private space: premade + user private custom cats.
  const extraCats = isActiveShared ? spaceCatsForActive : Object.values(_catExt).filter(c => !c.scope || c.scope === 'all_private' || c.scope?.allPrivate);
  const allCatValues = [...Object.values(CATEGORIES), ...extraCats];
  allCatValues.forEach(c => {
    if (c.isParent) return;
    const catType = c.type || 'Expense';
    if (catType !== txType) return;
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
  Object.values(groups).forEach(arr => arr.sort((a, b) => a.name === 'Other' ? 1 : b.name === 'Other' ? -1 : 0));

  const pickedCat = CATEGORIES[pickedId] || _catExt[pickedId] || {};

  return (
    <div style={{ position:'absolute', inset:0, zIndex:100, animation:'mFadeIn 0.2s ease-out both' }}>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.4)' }} onClick={onClose}/>
      <div style={{
        position:'absolute', left:0, right:0, bottom:0, top: pickedId ? '45%' : 80,
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
                <div style={{ textAlign:'center', padding:'32px 0 16px', color:M.ink3, fontSize:13 }}>
                  No results for "{searchQ}"
                  {isActiveShared && (
                    <div style={{ marginTop:14 }}>
                      <button className="m-tap" onClick={() => { onClose(); nav.push('spaceCats', { spaceId: activeProfileId, spaceName: activeProfile?.name }); }}
                        style={{ fontSize:12, color:M.sageDk, background:M.sageSoft, border:`1px solid ${M.line2}`, borderRadius:10, padding:'8px 14px', fontFamily:M.fontUI, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:6 }}>
                        <I name="info" size={12} color={M.sage}/> Add it to this shared space
                      </button>
                    </div>
                  )}
                </div>
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
            {(Object.keys(groups).length === 0 || searchQ) && !isActiveShared && (
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
            <div style={{ padding:'20px 20px 32px', display:'flex', flexDirection:'column', gap:10 }}>
              <input
                type="text" inputMode="decimal" autoFocus
                value={amtStr}
                onChange={e => setAmtStr(e.target.value)}
                onFocus={e => e.target.select()}
                placeholder={`Max ${fmtEur(maxAmount)}`}
                style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${amtVal > maxAmount + 0.005 ? M.clay : M.line}`, fontSize:16, fontFamily:M.fontUI, color:M.ink, background:M.paper, outline:'none', boxSizing:'border-box' }}
              />
              {amtVal > maxAmount + 0.005 && (
                <div style={{ fontSize:11, color:M.clay }}>Max {fmtEur(maxAmount)}</div>
              )}
              <button onClick={() => amtOk && onPick(pickedId, amtVal)} disabled={!amtOk}
                style={{ width:'100%', padding:'14px 0', borderRadius:10, background: amtOk ? M.brand : M.paper2, color: amtOk ? '#fff' : M.ink4, border:'none', fontSize:14, fontWeight:600, cursor: amtOk ? 'pointer' : 'default', fontFamily:M.fontUI, marginTop:4 }}>
                {amtOk ? `Add · ${catPath(pickedCat)} · ${fmtEur(amtVal)}` : `Add · ${catPath(pickedCat)}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function reduceCats(cats, reduceBy, txType, isNegative) {
  let toReduce = Math.round(reduceBy * 100) / 100;
  if (toReduce <= 0) return cats;
  let result = cats.map(c => ({ ...c }));
  const fallbackCatId = getTypeFallbackCat(txType, isNegative);

  const reduceOne = (catId) => {
    if (toReduce <= 0.005) return;
    const idx = result.findIndex(c => c.catId === catId);
    if (idx < 0) return;
    const canReduce = Math.min(result[idx].amount, toReduce);
    toReduce = Math.round((toReduce - canReduce) * 100) / 100;
    const newAmt = Math.round((result[idx].amount - canReduce) * 100) / 100;
    if (newAmt < 0.005 && result.length > 1) {
      result = result.filter((_, i) => i !== idx);
    } else {
      result[idx] = { ...result[idx], amount: newAmt };
    }
  };

  // Reduction order: reimburse/expenseReimburse → uncategorized/fallback → biggest specific
  reduceOne('reimburse');
  reduceOne('expenseReimburse');
  reduceOne('uncategorized');
  if (!isUncatId(fallbackCatId)) {
    reduceOne(fallbackCatId);
  }
  while (toReduce > 0.005 && result.length > 0) {
    let biggestIdx = 0;
    for (let i = 1; i < result.length; i++) {
      if (result[i].amount > result[biggestIdx].amount) biggestIdx = i;
    }
    const canReduce = Math.min(result[biggestIdx].amount, toReduce);
    toReduce = Math.round((toReduce - canReduce) * 100) / 100;
    const newAmt = Math.round((result[biggestIdx].amount - canReduce) * 100) / 100;
    if (newAmt < 0.005 && result.length > 1) {
      result = result.filter((_, i) => i !== biggestIdx);
    } else {
      result[biggestIdx] = { ...result[biggestIdx], amount: newAmt };
      break;
    }
  }
  return result.length > 0 ? result : [{ catId: fallbackCatId, amount: 0 }];
}

export function ScreenLinkReimburse({ params }) {
  const nav = useNav();
  const { txs, updateTx } = useTxCtx();
  const txId = params?.txId;
  const isPositive = params?.positive === true;
  const sourceTx = txs.find(t => t.id === txId);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(null);
  const [amtStr, setAmtStr] = React.useState('');

  const getRemaining = (t) => {
    const total = (t.reimbursements || []).reduce((s, r) => s + r.amount, 0);
    return Math.max(0, Math.abs(t.amount) - total);
  };

  const sourceRemaining = sourceTx ? getRemaining(sourceTx) : 0;

  // Opposite-type candidates that are not yet fully reimbursed
  const allCandidates = txs.filter(t => {
    if (t.id === txId) return false;
    if (getRemaining(t) < 0.005) return false;
    return isPositive
      ? (t.txType === 'Expense' || (!t.txType && t.amount < 0))
      : (t.txType === 'Income' || (!t.txType && t.amount > 0));
  });

  const filtered = query
    ? allCandidates.filter(t => {
        const q = query.toLowerCase();
        return (t.merchantDisplay || t.merchant).toLowerCase().includes(q) || (t.desc || '').toLowerCase().includes(q);
      })
    : allCandidates;

  const sorted = [...filtered].sort((a, b) => {
    if (!sourceTx) return 0;
    return Math.abs(new Date(a.date) - new Date(sourceTx.date)) - Math.abs(new Date(b.date) - new Date(sourceTx.date));
  });

  const selectedRemaining = selected ? getRemaining(selected) : 0;
  const maxAmt = Math.min(sourceRemaining, selectedRemaining);
  const val = parseFloat(amtStr.replace(',', '.')) || 0;
  const ok = val > 0 && val <= maxAmt + 0.005;

  const handleConfirm = () => {
    if (!ok || !sourceTx || !selected) return;
    const roundAmt = Math.round(Math.min(val, maxAmt) * 100) / 100;

    // Update reimbursements — merge if same tx already linked
    const srcExisting = (sourceTx.reimbursements || []).find(r => r.txId === selected.id);
    const newSrcReimb = srcExisting
      ? (sourceTx.reimbursements || []).map(r => r.txId === selected.id ? { ...r, amount: Math.round((r.amount + roundAmt) * 100) / 100 } : r)
      : [...(sourceTx.reimbursements || []), { txId: selected.id, amount: roundAmt }];
    const selExisting = (selected.reimbursements || []).find(r => r.txId === sourceTx.id);
    const newSelReimb = selExisting
      ? (selected.reimbursements || []).map(r => r.txId === sourceTx.id ? { ...r, amount: Math.round((r.amount + roundAmt) * 100) / 100 } : r)
      : [...(selected.reimbursements || []), { txId: sourceTx.id, amount: roundAmt }];

    // Reduce cats on source tx — update via callback into ScreenTxDetail's local state
    const srcCats = sourceTx.cats || [{ catId: sourceTx.cat, amount: Math.abs(sourceTx.amount) }];
    const srcIsNeg = sourceTx.amount < 0;
    const srcTxType = sourceTx.txType || (srcIsNeg ? 'Expense' : 'Income');
    const newSrcCats = reduceCats(srcCats, roundAmt, srcTxType, srcIsNeg);

    // Reduce cats on selected tx
    const selCats = selected.cats || [{ catId: selected.cat, amount: Math.abs(selected.amount) }];
    const selIsNeg = selected.amount < 0;
    const selTxType = selected.txType || (selIsNeg ? 'Expense' : 'Income');
    const newSelCats = reduceCats(selCats, roundAmt, selTxType, selIsNeg);

    updateTx(sourceTx.id, { reimbursements: newSrcReimb });
    params?.onCatsUpdate?.(newSrcCats);
    updateTx(selected.id, {
      reimbursements: newSelReimb,
      cats: newSelCats,
      cat: newSelCats.find(c => !isUncatId(c.catId))?.catId || newSelCats[0]?.catId || selected.cat,
    });
    nav.pop();
  };

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
            <span style={{ fontSize:12, color:M.ink3 }}>
              Linking to: <strong style={{ color:M.ink }}>{sourceTx.merchantDisplay || sourceTx.merchant}</strong> · {fmtEur(sourceRemaining)} remaining
            </span>
          </div>
        )}
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:10, background:M.paper2, marginBottom:12, border:`1px solid ${M.line}` }}>
          <I name="search" size={15} color={M.ink3}/>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search transactions…"
            style={{ flex:1, border:'none', background:'transparent', fontSize:13, color:M.ink, outline:'none', fontFamily:M.fontUI }}/>
          {query && <button onClick={() => setQuery('')} style={{ background:'none', border:'none', color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, fontSize:16, lineHeight:1 }}>×</button>}
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding:'32px 0', textAlign:'center', color:M.ink3, fontSize:13 }}>
            {query ? `No results for "${query}"` : 'No matching transactions'}
          </div>
        ) : (
          <div className="m-card" style={{ padding:'0 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
            {sorted.map((t, i, a) => {
              const tCat = CATEGORIES[t.cat] || _catExt[t.cat] || {};
              const txPositive = t.amount > 0;
              const tRemaining = getRemaining(t);
              return (
                <React.Fragment key={t.id}>
                  <div className="m-tap" onClick={() => {
                    const selRem = getRemaining(t);
                    const srcRem = sourceTx ? getRemaining(sourceTx) : 0;
                    const max = Math.min(srcRem, selRem);
                    setSelected(t);
                    setAmtStr(max > 0 ? max.toFixed(2).replace('.', ',') : '');
                  }}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background: txPositive ? M.sageSoft : M.claySoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <IcoMDI name={tCat.icon||'help-circle-outline'} size={16} color={txPositive ? M.sage : M.clay}/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        <HighlightText text={t.merchantDisplay || t.merchant} query={query}/>
                      </div>
                      <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>{fmtDate(t.date)} · {catPath(tCat)}</div>
                    </div>
                    <div style={{ textAlign:'right', flexShrink:0 }}>
                      <div className="m-num" style={{ fontSize:14, fontWeight:600, color: txPositive ? M.sage : M.ink }}>
                        {txPositive ? '+' : '−'}{fmtEur(tRemaining)}
                      </div>
                      {tRemaining < Math.abs(t.amount) - 0.005 && (
                        <div style={{ fontSize:10, color:M.ink4 }}>of {fmtEur(Math.abs(t.amount))}</div>
                      )}
                    </div>
                  </div>
                  {i < a.length - 1 && <Divider inset={48}/>}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

      {selected && (
        <Sheet onClose={() => setSelected(null)} title="Set reimbursement">
          <div style={{ padding:'4px 20px 32px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderRadius:12, background:M.paper2, marginBottom:16 }}>
              <div style={{ width:36, height:36, borderRadius:10, background: isPositive ? M.claySoft : M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <IcoMDI name={(CATEGORIES[selected.cat] || _catExt[selected.cat] || {}).icon || 'help-circle-outline'} size={16} color={isPositive ? M.clay : M.sage}/>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:500 }}>{selected.merchantDisplay || selected.merchant}</div>
                <div style={{ fontSize:11, color:M.ink3, marginTop:2 }}>
                  {fmtDate(selected.date)} · {selectedRemaining < Math.abs(selected.amount) - 0.005 ? `${fmtEur(selectedRemaining)} remaining` : `total ${fmtEur(Math.abs(selected.amount))}`}
                </div>
              </div>
            </div>
            <div style={{ fontSize:12, color:M.ink3, marginBottom:8 }}>How much was reimbursed?</div>
            <input
              type="text" inputMode="decimal" autoFocus
              value={amtStr}
              onChange={e => setAmtStr(e.target.value)}
              onFocus={e => e.target.select()}
              placeholder={`Max ${fmtEur(maxAmt)}`}
              style={{ width:'100%', padding:'12px 14px', borderRadius:10, border:`1px solid ${val > maxAmt + 0.005 ? M.clay : M.line}`, fontSize:16, fontFamily:M.fontUI, color:M.ink, background:M.paper, outline:'none', boxSizing:'border-box', marginBottom:6 }}
            />
            {val > maxAmt + 0.005 && (
              <div style={{ fontSize:11, color:M.clay, marginBottom:8 }}>Maximum is {fmtEur(maxAmt)}</div>
            )}
            <button onClick={handleConfirm} disabled={!ok}
              style={{ width:'100%', padding:'14px 0', borderRadius:10, background: ok ? M.brand : M.paper2, color: ok ? '#fff' : M.ink4, border:'none', fontSize:14, fontWeight:600, cursor: ok ? 'pointer' : 'default', fontFamily:M.fontUI, marginTop:4 }}>
              {ok ? `Link · ${fmtEur(val)} reimbursed` : 'Enter amount'}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// ── Shared pickers (exported for use in Tx.jsx) ─────────────────────────────

export function TypeBadge({ type, size = 'normal' }) {
  const meta = TX_TYPE_META[type] || {};
  const pad = size === 'small' ? '2px 7px' : '3px 9px';
  const fs = size === 'small' ? 10 : 12;
  return (
    <span style={{
      fontSize: fs, fontWeight:700, letterSpacing:'0.01em',
      color: meta.color || M.ink2,
      background: (meta.color || M.ink2) + '1A',
      borderRadius:999, padding: pad, display:'inline-flex', alignItems:'center', gap:4,
    }}>
      {meta.icon && <IcoMDI name={meta.icon} size={fs} color={meta.color || M.ink2}/>}
      {type}
    </span>
  );
}

export function TypePickerSheet({ currentType, onClose, onPick }) {
  return (
    <Sheet onClose={onClose} title="Transaction type">
      <div style={{ padding:'4px 20px 32px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {TX_TYPES.map(type => {
            const meta = TX_TYPE_META[type] || {};
            const active = currentType === type;
            return (
              <button key={type} onClick={() => { onPick(type); onClose(); }} className="m-tap" style={{
                padding:'14px 12px', borderRadius:12, textAlign:'left',
                border:`1.5px solid ${active ? meta.color : M.line}`,
                background: active ? (meta.color + '18') : M.paper2,
                display:'flex', alignItems:'center', gap:8,
              }}>
                <IcoMDI name={meta.icon || 'help-circle-outline'} size={18} color={active ? meta.color : M.ink3}/>
                <span style={{ fontSize:13, fontWeight:600, color: active ? meta.color : M.ink }}>{type}</span>
                {active && <I name="check" size={14} color={meta.color} stroke={2.5} style={{ marginLeft:'auto' }}/>}
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}

export function LinkedAccountPickerSheet({ txAccountId, myAccounts, sharedAccounts, linkedAcctId, onClose, onPick, onGoToSettings }) {
  const ACCT_TYPE_LABEL = { checking:'Checking', savings:'Savings', invest:'Brokerage', credit:'Credit' };
  const renderAcct = (a) => (
    <div key={a.id} className="m-tap" onClick={() => { onPick(a.id); onClose(); }} style={{
      display:'flex', alignItems:'center', gap:12, padding:'13px 0',
    }}>
      <div style={{ width:36, height:36, borderRadius:10, background:a.color || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <IcoMDI name={a.type === 'savings' ? 'piggy-bank-outline' : a.type === 'invest' ? 'chart-timeline-variant' : a.type === 'credit' ? 'credit-card-outline' : 'bank-outline'} size={17} color="#fff"/>
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.name}</div>
        <div style={{ fontSize:11, color:M.ink3, marginTop:1, fontFamily:M.fontMono }}>{a.iban || ACCT_TYPE_LABEL[a.type] || a.type}</div>
      </div>
      {linkedAcctId === a.id && <I name="check" size={16} color={M.sage} stroke={2.5}/>}
    </div>
  );
  return (
    <Sheet onClose={onClose} title="Link account">
      <div style={{ padding:'4px 20px 32px', maxHeight:'70vh', overflowY:'auto' }}>
        {linkedAcctId && (
          <div className="m-card m-tap" onClick={() => { onPick(null); onClose(); }} style={{ padding:'12px 16px', marginBottom:12, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', gap:10 }}>
            <I name="x" size={16} color={M.clay}/>
            <span style={{ fontSize:13, fontWeight:500, color:M.clay }}>Remove linked account</span>
          </div>
        )}
        {myAccounts.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:4 }}>My accounts</div>
            <div className="m-card" style={{ padding:'0 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
              {myAccounts.map((a, i, arr) => (
                <React.Fragment key={a.id}>
                  {renderAcct(a)}
                  {i < arr.length - 1 && <Divider inset={48}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}
        {sharedAccounts.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:4 }}>Space accounts</div>
            <div className="m-card" style={{ padding:'0 16px', border:`1px solid ${M.line}` }}>
              {sharedAccounts.map((a, i, arr) => (
                <React.Fragment key={a.id}>
                  {renderAcct(a)}
                  {i < arr.length - 1 && <Divider inset={48}/>}
                </React.Fragment>
              ))}
            </div>
          </>
        )}
        {myAccounts.length === 0 && sharedAccounts.length === 0 && (
          <div style={{ textAlign:'center', padding:'32px 0', color:M.ink3, fontSize:13 }}>No other accounts available</div>
        )}
        {onGoToSettings && (
          <div style={{ textAlign:'center', marginTop:16, padding:'12px 0', borderTop:`1px solid ${M.line}` }}>
            <span style={{ fontSize:12, color:M.ink4 }}>Missing an account? </span>
            <button onClick={onGoToSettings} style={{ background:'none', border:'none', color:M.brand, fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, padding:0 }}>
              Manage space →
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
