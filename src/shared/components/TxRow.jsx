import React from 'react';
import { CATEGORIES, _catExt, catPath } from '../data/categories.js';
import { fmtEur, fmtDate } from '../utils/format.js';
import { M, I, IcoMDI } from '../../app/theme.jsx';
import { useTxCtx } from '../../app/providers.jsx';

export function HighlightText({ text, query }) {
  if (!query) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark style={{ background: M.ochreSoft, color: M.ochre, borderRadius: 3, padding: '0 2px' }}>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </span>
  );
}


export function TxRow({ tx, onClick, showCat = true, showDate = false, dense = false, highlight = '' }) {
  // Fix undefined categories for saving transactions
  let effectiveCat = tx.cat;
  if (tx.savingAccount && (!effectiveCat || effectiveCat === 'savings' || (!CATEGORIES[effectiveCat] && !_catExt[effectiveCat]))) {
    effectiveCat = tx.amount < 0 ? 'savingDeposit' : 'savingWithdraw';
  }
  const cat = CATEGORIES[effectiveCat] || _catExt[effectiveCat] || CATEGORIES[tx.cat] || _catExt[tx.cat] || {};
  const { txs: allTxs } = useTxCtx();
  const positive = tx.amount > 0;
  const isLinkedReimburse = tx.linkedTo;
  const reimburseTx = !positive ? allTxs.find(t => t.linkedTo === tx.id) : null;
  const hasReimbursement = !!reimburseTx;
  const displayAmount = hasReimbursement ? tx.amount + reimburseTx.amount : tx.amount;
  const displayPositive = displayAmount > 0;
  return (
    <div data-testid="tx-row" onClick={onClick} className={onClick ? 'm-tap' : ''} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: dense ? '10px 0' : '12px 0',
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, background: M.paper2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <IcoMDI name={cat.icon || 'help-circle-outline'} size={18} color={M.ink2}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: M.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {highlight ? <HighlightText text={tx.merchant} query={highlight}/> : tx.merchant}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            {hasReimbursement && <div style={{ width:16, height:16, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}><I name="link" size={9} color={M.sage}/></div>}
            {isLinkedReimburse && <div style={{ width:16, height:16, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}><I name="link" size={9} color={M.sage}/></div>}
            <div className="m-num" style={{ fontSize: 15, fontWeight: 600, color: displayPositive ? M.sage : M.ink }}>
              {displayPositive ? '+' : ''}{fmtEur(displayAmount)}
            </div>
          </div>
        </div>
        {showCat && (
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 3 }}>
            <div style={{ fontSize: 12, color: M.ink3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
              {showDate ? fmtDate(tx.date) : (highlight ? <HighlightText text={catPath(cat)} query={highlight}/> : catPath(cat))}
            </div>
            {tx.recurring && <div style={{ width:14, height:14, borderRadius:4, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, title:'Recurring' }}><I name="receipt" size={7} color={M.ink3}/></div>}
            {tx.needsReview && <div style={{ width:14, height:14, borderRadius:4, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><I name="alert" size={7} color={M.ochre}/></div>}
          </div>
        )}
      </div>
    </div>
  );
}
