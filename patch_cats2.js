// patch_cats2.js
const fs = require('fs');
let c = fs.readFileSync('munni.html', 'utf8').replace(/\r\n/g, '\n');

function rep(from, to, label) {
  if (c.indexOf(from) === -1) { console.warn('NOT FOUND:', label || from.slice(0, 70)); return; }
  c = c.replace(from, to);
  console.log('✓', label || from.slice(0, 70));
}

// ═══════════════════════════════════════════════════════════════════
// 1. clearAllStorage — wipe ALL user data including login keys
// ═══════════════════════════════════════════════════════════════════
rep(
  `const STORAGE_KEYS = ['munni_txs','munni_recur','munni_topics','munni_pOffset','munni_customCats','munni_dark','munni_profile_name','munni_profile_email','munni_integrations','munni_bank_accounts','munni_selected_bank','munni_profiles','munni_disabled_save_accounts','munni_home_cards'];
function clearAllStorage() { STORAGE_KEYS.forEach(k => localStorage.removeItem(k)); }`,
  `function clearAllStorage() { localStorage.clear(); }`,
  'clearAllStorage wipes everything'
);

// ═══════════════════════════════════════════════════════════════════
// 2. doLogin — always activate p1 for non-demo logins
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const doLogin = (method, email, displayName, activateDemo = false) => {
    const methods = [...new Set([...getSignupMethods(), method])];
    localStorage.setItem('munni_signup_methods', JSON.stringify(methods));
    localStorage.setItem('munni_opened_before', 'true');
    if (email) localStorage.setItem('munni_profile_email', email);
    if (displayName) localStorage.setItem('munni_profile_name', displayName);
    if (activateDemo) {
      const profiles = JSON.parse(localStorage.getItem('munni_profiles') || JSON.stringify(DEFAULT_PROFILES));
      const updated = profiles.map(p => ({ ...p, active: p.id === 'p_demo' }));
      localStorage.setItem('munni_profiles', JSON.stringify(updated));
    }
    onLogin();
  };`,
  `  const doLogin = (method, email, displayName, activateDemo = false) => {
    const methods = [...new Set([...getSignupMethods(), method])];
    localStorage.setItem('munni_signup_methods', JSON.stringify(methods));
    localStorage.setItem('munni_opened_before', 'true');
    if (email) localStorage.setItem('munni_profile_email', email);
    if (displayName) localStorage.setItem('munni_profile_name', displayName);
    const profiles = JSON.parse(localStorage.getItem('munni_profiles') || JSON.stringify(DEFAULT_PROFILES));
    const targetId = activateDemo ? 'p_demo' : 'p1';
    const updated = profiles.map(p => ({ ...p, active: p.id === targetId }));
    localStorage.setItem('munni_profiles', JSON.stringify(updated));
    onLogin();
  };`,
  'doLogin activates correct profile'
);

// ═══════════════════════════════════════════════════════════════════
// 3. ScreenProfile identity card — show demo badge + lock editing for demo
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const activeProfile = profiles.find(p => p.active) || profiles[0];
  const connectedBanks = connectedAccounts.filter(a => a.type === 'checking').length;`,
  `  const activeProfile = profiles.find(p => p.active) || profiles[0];
  const isDemo = activeProfile?.id === 'p_demo' || activeProfile?.isDemo;
  const connectedBanks = connectedAccounts.filter(a => a.type === 'checking').length;`,
  'ScreenProfile isDemo flag'
);

rep(
  `          <div style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <input value={draft.name} onChange={e => setDraft(d => ({...d, name: e.target.value}))}
                style={{ width:'100%', fontSize:16, fontWeight:600, border:\`1px solid \${M.sage}\`, borderRadius:8, padding:'6px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:6 }}/>
            ) : (
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2 }}>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{name}</div>
              </div>
            )}
            <div style={{ fontSize: 12, color: M.ink3 }}>{email}</div>
          </div>
          {editing ? (
            <button className="m-tap" onClick={save} style={{ width:36, height:36, borderRadius:999, background:M.sage, border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="check" size={16} color="#fff" stroke={2.5}/>
            </button>
          ) : (
            <button className="m-tap" onClick={startEdit} style={{ width:36, height:36, borderRadius:999, background:M.paper2, border:\`1px solid \${M.line}\`, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="edit" size={16} color={M.ink3}/>
            </button>
          )}`,
  `          <div style={{ flex: 1, minWidth: 0 }}>
            {editing && !isDemo ? (
              <input value={draft.name} onChange={e => setDraft(d => ({...d, name: e.target.value}))}
                style={{ width:'100%', fontSize:16, fontWeight:600, border:\`1px solid \${M.sage}\`, borderRadius:8, padding:'6px 10px', fontFamily:M.fontUI, background:M.paper2, outline:'none', marginBottom:6 }}/>
            ) : (
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2, flexWrap:'wrap' }}>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{name}</div>
                {isDemo && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.ochreSoft, color:M.ochre, textTransform:'uppercase', letterSpacing:'0.05em' }}>Demo</span>}
              </div>
            )}
            <div style={{ fontSize: 12, color: M.ink3 }}>{email}</div>
            {isDemo && <div style={{ fontSize:11, color:M.ochre, marginTop:3 }}>Demo account · read-only profile</div>}
          </div>
          {!isDemo && (editing ? (
            <button className="m-tap" onClick={save} style={{ width:36, height:36, borderRadius:999, background:M.sage, border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="check" size={16} color="#fff" stroke={2.5}/>
            </button>
          ) : (
            <button className="m-tap" onClick={startEdit} style={{ width:36, height:36, borderRadius:999, background:M.paper2, border:\`1px solid \${M.line}\`, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="edit" size={16} color={M.ink3}/>
            </button>
          ))}`,
  'ScreenProfile demo badge + lock editing'
);

// ═══════════════════════════════════════════════════════════════════
// 4. deleteCustomParent — also update transactions
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const deleteCustomParent = (parentId) => {
    setCustomCats(prev => prev.filter(c => c.id !== parentId && c.parent !== parentId));
  };`,
  `  const deleteCustomParent = (parentId) => {
    const subsToDelete = new Set(customCats.filter(c => c.parent === parentId).map(c => c.id));
    subsToDelete.add(parentId);
    setCustomCats(prev => prev.filter(c => !subsToDelete.has(c.id) && c.parent !== parentId));
    setTxs(prev => prev.map(t => {
      if (subsToDelete.has(t.cat) || t.cat === parentId) {
        const fallback = (t.amount >= 0) ? 'incomeUncategorized' : 'expenseUncategorized';
        return { ...t, cat: fallback, cats: [{ catId: fallback, amount: Math.abs(t.amount) }] };
      }
      return t;
    }));
  };`,
  'deleteCustomParent updates transactions'
);

// ═══════════════════════════════════════════════════════════════════
// 5. renderParentCard — full rewrite with all fixes:
//    - whole row draggable (no hamburger handle)
//    - no popup for premade categories
//    - +Sub below 'other'
//    - expand/collapse fixed (button not div)
//    - 'other' always last
//    - 'other' gets parent color
//    - scroll to parent after cross-parent drag
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const renderParentCard = (parentKey, parentCat, isCustom) => {
    const premadeSubs = isCustom ? [] : getPremadeSubs(parentKey);
    const customSubsHere = isCustom ? getCustomSubs(parentKey) : getCustomSubsOfPremade(parentKey);
    const allSubs = isCustom ? customSubsHere : [...premadeSubs, ...customSubsHere];
    const subCount = allSubs.length;
    const isCollapsed = !!collapsedParents[parentKey];
    const isDropTarget = dropTarget?.type === 'parent' && dropTarget.parentId === parentKey;

    return (
      <div key={parentKey} className="m-card"
        style={{ marginBottom:12, border:\`1.5px solid \${isDropTarget ? (parentCat.color || M.sage) : M.line}\`, borderRadius:14, overflow:'hidden', background: isDropTarget ? (parentCat.color ? parentCat.color + '11' : M.sageSoft) : 'transparent', transition:'border-color 0.15s, background 0.15s' }}
        onPointerEnter={dragState ? () => setDropTarget({ type:'parent', parentId: parentKey }) : undefined}
      >
        {/* Parent header */}
        <div
          className="m-tap"
          style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:M.paper, cursor:'pointer' }}
          onClick={() => setEditSheet({ catId: parentKey, parentId: null, isCustom, isParent: true, name: parentCat.name, icon: parentCat.icon || 'box', color: parentCat.color })}
        >
          <div style={{ width:38, height:38, borderRadius:10, background:parentCat.color||M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={parentCat.icon||'help-circle-outline'} size={18} color={isCustom?'#fff':M.ink2}/>
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15, fontWeight:600 }}>{parentCat.name}</div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:12, color:M.ink3 }}>{subCount} subs</span>
            <button className="m-tap" onClick={(e) => { e.stopPropagation(); setNewSubSheet(parentKey); }}
              style={{ background:M.sageSoft, border:'none', borderRadius:8, padding:'4px 10px', color:M.sage, fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:M.fontUI, display:'flex', alignItems:'center', gap:4 }}>
              <I name="plus" size={11} color={M.sage}/> Sub
            </button>
            <div style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition:'transform 0.2s ease', display:'flex' }}
              onClick={(e) => { e.stopPropagation(); setCollapsedParents(prev => ({ ...prev, [parentKey]: !prev[parentKey] })); }}>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
          </div>
        </div>
        {/* Sub-categories */}
        <div style={{ overflow:'hidden', maxHeight: isCollapsed ? 0 : 2000, transition:'max-height 0.3s ease' }}>
          {allSubs.map((sub) => {
            const subKey = Array.isArray(sub) ? sub[0] : sub.id;
            const subCat = Array.isArray(sub) ? sub[1] : sub;
            const isCustomSub = !Array.isArray(sub);
            const isOther = isCustomSub && sub.id === \`\${parentKey}_other\`;
            const subBg = !isCustomSub
              ? (parentCat.color ? parentCat.color + '33' : M.paper2)
              : (parentCat.color ? parentCat.color + '33' : subCat.color || M.paper2);
            const subIconColor = !isCustomSub ? M.ink2 : (parentCat.color || '#fff');

            return (
              <div key={subKey}
                className={isCustomSub && !isOther ? 'm-tap' : ''}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 16px', borderTop:\`1px solid \${M.line2}\`, background: dropTarget?.catId === subKey ? M.sageSoft : 'transparent', transition:'background 0.1s', cursor: isCustomSub && !isOther ? 'pointer' : 'default' }}
                onClick={isCustomSub && !isOther ? () => setEditSheet({ catId: subKey, parentId: parentKey, isCustom: true, isParent: false, name: subCat.name, icon: subCat.icon || 'box' }) : (!isCustomSub ? () => setEditSheet({ catId: subKey, parentId: parentKey, isCustom: false, isParent: false, name: subCat.name, icon: subCat.icon }) : undefined)}
                onPointerEnter={(dragState && dragState.parentId === parentKey && !isOther) ? () => setDropTarget({ type:'reorder', catId: subKey, parentId: parentKey }) : undefined}
              >
                {(isCustomSub && !isOther) && (
                  <div
                    style={{ padding:'4px 2px', cursor:'grab', touchAction:'none', flexShrink:0 }}
                    onPointerDown={(e) => startDrag(e, subKey, parentKey, subCat.name, subCat.icon, parentCat.color || M.paper2)}
                  >
                    <I name="menu" size={15} color={M.ink4}/>
                  </div>
                )}
                <div style={{ width:28, height:28, borderRadius:8, background: isOther ? M.paper2 : subBg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <IcoMDI name={subCat.icon||'help-circle-outline'} size={13} color={isOther ? M.ink3 : subIconColor}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:isOther?400:500, color:isOther?M.ink3:M.ink, fontStyle:isOther?'italic':'normal' }}>{subCat.name}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };`,
  `  const [flashCatId, setFlashCatId] = React.useState(null);
  const parentRefs = React.useRef({});

  const renderParentCard = (parentKey, parentCat, isCustom) => {
    const premadeSubs = isCustom ? [] : getPremadeSubs(parentKey);
    const customSubsHere = isCustom ? getCustomSubs(parentKey) : getCustomSubsOfPremade(parentKey);
    const rawSubs = isCustom ? customSubsHere : [...premadeSubs, ...customSubsHere];
    // 'other' always last
    const otherSub = rawSubs.find(s => (Array.isArray(s) ? false : s.id === \`\${parentKey}_other\`));
    const nonOther = rawSubs.filter(s => !(Array.isArray(s) ? false : s.id === \`\${parentKey}_other\`));
    const allSubs = otherSub ? [...nonOther, otherSub] : nonOther;
    const subCount = allSubs.length;
    const isCollapsed = !!collapsedParents[parentKey];
    const isDropTarget = dropTarget?.type === 'parent' && dropTarget.parentId === parentKey;

    return (
      <div key={parentKey} ref={el => parentRefs.current[parentKey] = el}
        data-parentkey={parentKey}
        className="m-card"
        style={{ marginBottom:12, border:\`1.5px solid \${isDropTarget ? (parentCat.color || M.sage) : M.line}\`, borderRadius:14, overflow:'hidden', background: isDropTarget ? (parentCat.color ? parentCat.color + '11' : M.sageSoft) : 'transparent', transition:'border-color 0.15s, background 0.15s' }}
        onPointerEnter={dragState ? () => setDropTarget({ type:'parent', parentId: parentKey }) : undefined}
      >
        {/* Parent header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 16px', background:M.paper }}>
          <div style={{ width:38, height:38, borderRadius:10, background:parentCat.color||M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={parentCat.icon||'help-circle-outline'} size={18} color={isCustom?'#fff':M.ink2}/>
          </div>
          <div className={isCustom ? 'm-tap' : ''} style={{ flex:1, cursor: isCustom ? 'pointer' : 'default' }}
            onClick={isCustom ? () => setEditSheet({ catId: parentKey, parentId: null, isCustom:true, isParent: true, name: parentCat.name, icon: parentCat.icon || 'help-circle-outline', color: parentCat.color }) : undefined}
          >
            <div style={{ fontSize:15, fontWeight:600 }}>{parentCat.name}</div>
          </div>
          <span style={{ fontSize:12, color:M.ink3 }}>{subCount} subs</span>
          <button className="m-tap" onClick={() => setCollapsedParents(prev => ({ ...prev, [parentKey]: !prev[parentKey] }))}
            style={{ background:'none', border:'none', cursor:'pointer', padding:4, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition:'transform 0.2s ease', display:'flex' }}>
              <I name="caretR" size={14} color={M.ink4}/>
            </div>
          </button>
        </div>
        {/* Sub-categories */}
        <div style={{ overflow:'hidden', maxHeight: isCollapsed ? 0 : 9999, transition:'max-height 0.35s ease' }}>
          {allSubs.map((sub) => {
            const subKey = Array.isArray(sub) ? sub[0] : sub.id;
            const subCat = Array.isArray(sub) ? sub[1] : sub;
            const isCustomSub = !Array.isArray(sub);
            const isOther = isCustomSub && sub.id === \`\${parentKey}_other\`;
            // 'other' uses parent color same as other custom subs
            const subBg = parentCat.color ? parentCat.color + '33' : M.paper2;
            const subIconColor = parentCat.color || M.ink2;
            const isFlashing = flashCatId === subKey;

            return (
              <div key={subKey}
                className={isCustomSub && !isOther ? 'm-tap' : ''}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 16px', borderTop:\`1px solid \${M.line2}\`,
                  background: isFlashing ? (parentCat.color || M.sage) + '22' : dropTarget?.catId === subKey ? M.sageSoft : 'transparent',
                  transition:'background 0.3s',
                  cursor: (isCustomSub && !isOther) ? 'grab' : 'default',
                  touchAction: (isCustomSub && !isOther) ? 'none' : 'auto',
                }}
                onClick={isCustomSub && !isOther ? () => setEditSheet({ catId: subKey, parentId: parentKey, isCustom: true, isParent: false, name: subCat.name, icon: subCat.icon || 'help-circle-outline' }) : undefined}
                onPointerDown={(isCustomSub && !isOther) ? (e) => startDrag(e, subKey, parentKey, subCat.name, subCat.icon, parentCat.color || M.paper2) : undefined}
                onPointerEnter={(dragState && !isOther) ? () => setDropTarget({ type:'reorder', catId: subKey, parentId: parentKey }) : undefined}
              >
                <div style={{ width:28, height:28, borderRadius:8, background: isOther ? (parentCat.color ? parentCat.color+'33' : M.paper2) : subBg, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <IcoMDI name={subCat.icon||'help-circle-outline'} size={13} color={isOther ? (parentCat.color || M.ink3) : subIconColor}/>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:isOther?400:500, color:isOther?M.ink3:M.ink, fontStyle:isOther?'italic':'normal' }}>{subCat.name}</div>
                </div>
                {(isCustomSub && !isOther) && (
                  <div style={{ opacity:0.35, flexShrink:0 }}>
                    <I name="menu" size={13} color={M.ink3}/>
                  </div>
                )}
              </div>
            );
          })}
          {/* +Sub button at bottom, after 'other' */}
          {isCustom && (
            <button className="m-tap" onClick={() => setNewSubSheet(parentKey)}
              style={{ width:'100%', padding:'10px 16px', borderTop:\`1px solid \${M.line2}\`, background:'transparent', border:'none', borderTopStyle:'solid', borderTopWidth:1, borderTopColor:M.line2, display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontFamily:M.fontUI, color:M.sage }}>
              <I name="plus" size={13} color={M.sage}/>
              <span style={{ fontSize:13, fontWeight:500 }}>Add sub-category</span>
            </button>
          )}
        </div>
      </div>
    );
  };`,
  'renderParentCard full rewrite'
);

// ═══════════════════════════════════════════════════════════════════
// 6. endDrag — scroll to destination parent + flash animation
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const endDrag = () => {
    if (!dragState || !dropTarget) { setDragState(null); setDropTarget(null); setCollapsedParents({}); return; }
    const { catId } = dragState;
    if (dropTarget.type === 'parent') {
      setCustomCats(prev => prev.map(c => c.id === catId ? { ...c, parent: dropTarget.parentId } : c));
    } else if (dropTarget.type === 'reorder' && dropTarget.catId !== catId) {
      setCustomCats(prev => {
        const subs = prev.filter(c => !c.isParent && c.parent === dropTarget.parentId);
        const others = prev.filter(c => c.isParent || c.parent !== dropTarget.parentId);
        const dragIdx = subs.findIndex(c => c.id === catId);
        const targetIdx = subs.findIndex(c => c.id === dropTarget.catId);
        if (dragIdx < 0 || targetIdx < 0) return prev;
        const reordered = [...subs];
        const [item] = reordered.splice(dragIdx, 1);
        reordered.splice(targetIdx, 0, item);
        return [...others, ...reordered];
      });
    }
    setDragState(null);
    setDropTarget(null);
    setCollapsedParents({});
  };`,
  `  const endDrag = () => {
    if (!dragState || !dropTarget) { setDragState(null); setDropTarget(null); setCollapsedParents({}); return; }
    const { catId } = dragState;
    let destParentId = null;
    if (dropTarget.type === 'parent') {
      destParentId = dropTarget.parentId;
      setCustomCats(prev => prev.map(c => c.id === catId ? { ...c, parent: dropTarget.parentId } : c));
    } else if (dropTarget.type === 'reorder' && dropTarget.catId !== catId) {
      destParentId = dropTarget.parentId;
      setCustomCats(prev => {
        const subs = prev.filter(c => !c.isParent && c.parent === dropTarget.parentId);
        const others = prev.filter(c => c.isParent || c.parent !== dropTarget.parentId);
        const dragIdx = subs.findIndex(c => c.id === catId);
        const targetIdx = subs.findIndex(c => c.id === dropTarget.catId);
        if (dragIdx < 0 || targetIdx < 0) return prev;
        const reordered = [...subs];
        const [item] = reordered.splice(dragIdx, 1);
        reordered.splice(targetIdx, 0, item);
        return [...others, ...reordered];
      });
    }
    setDragState(null);
    setDropTarget(null);
    setCollapsedParents({});
    // Scroll to and flash the destination parent
    if (destParentId && destParentId !== dragState.parentId) {
      setTimeout(() => {
        const el = parentRefs.current[destParentId];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setFlashCatId(catId);
        setTimeout(() => setFlashCatId(null), 1000);
      }, 50);
    }
  };`,
  'endDrag scroll+flash to destination parent'
);

// ═══════════════════════════════════════════════════════════════════
// 7. Ghost icon: use IcoMDI instead of I
// ═══════════════════════════════════════════════════════════════════
rep(
  `          <div style={{ width:28, height:28, borderRadius:8, background: dragState.ghostColor || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <I name={dragState.ghostIcon || 'box'} size={13} color="#fff"/>
          </div>`,
  `          <div style={{ width:28, height:28, borderRadius:8, background: dragState.ghostColor || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <IcoMDI name={dragState.ghostIcon || 'help-circle-outline'} size={13} color="#fff"/>
          </div>`,
  'ghost icon uses IcoMDI'
);

// ═══════════════════════════════════════════════════════════════════
// 8. Ghost position — center on cursor instead of fixed offset
// ═══════════════════════════════════════════════════════════════════
rep(
  `          position:'fixed',
          left: dragState.x - 80,
          top: dragState.y - 20,`,
  `          position:'fixed',
          left: dragState.x - 60,
          top: dragState.y - 22,
          transform: 'translateY(-50%)',`,
  'ghost position centered on cursor'
);

// ═══════════════════════════════════════════════════════════════════
// 9. startDrag — add pointerId capture for smooth dragging
// ═══════════════════════════════════════════════════════════════════
rep(
  `  const startDrag = (e, catId, parentId, label, icon, color) => {
    e.preventDefault();
    setDragState({ catId, parentId, x: e.clientX, y: e.clientY, ghostLabel: label, ghostIcon: icon, ghostColor: color });`,
  `  const startDrag = (e, catId, parentId, label, icon, color) => {
    e.preventDefault();
    e.stopPropagation();
    setDragState({ catId, parentId, x: e.clientX, y: e.clientY, ghostLabel: label, ghostIcon: icon, ghostColor: color });`,
  'startDrag stopPropagation to prevent edit sheet opening'
);

// ═══════════════════════════════════════════════════════════════════
// 10. txCount in delete confirmation — pass txCount to EditCatSheet
//     (already passed as txCount prop; make sure body shows it)
// ═══════════════════════════════════════════════════════════════════
// The EditCatSheet already receives txCount — fix the body text in the sheet to show it
rep(
  `function EditCatSheet({ entry, txCount, onSave, onDelete, isPrebuilt = false }) {`,
  `function EditCatSheet({ entry, txCount = 0, onSave, onDelete, isPrebuilt = false }) {`,
  'EditCatSheet txCount default'
);

// Find the delete button section in EditCatSheet and add tx count
rep(
  `        <div style={{ padding:'16px 0 0', borderTop:\`1px solid \${M.line2}\`, marginTop:8 }}>
          <button onClick={() => setConfirmDelete(true)}`,
  `        <div style={{ padding:'16px 0 0', borderTop:\`1px solid \${M.line2}\`, marginTop:8 }}>
          {txCount > 0 && <div style={{ fontSize:12, color:M.ochre, marginBottom:10 }}>{txCount} transaction{txCount!==1?'s':''} will be set to uncategorized</div>}
          <button onClick={() => setConfirmDelete(true)}`,
  'EditCatSheet delete shows tx count'
);

fs.writeFileSync('munni.html', c.replace(/\n/g, '\r\n'), 'utf8');
console.log('\nDone');
