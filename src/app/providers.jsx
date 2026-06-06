import React from 'react';
import { CATEGORIES, _catExt, catPath } from '../shared/data/categories.js';
import { fmtEur } from '../shared/utils/format.js';
import { getUserId, computeUserDataKey } from '../shared/utils/user.js';
import { computeProfileKey, getDefaultProfiles } from '../features/profile/data.js';
import { getDefaultAccounts, getDefaultTxs } from '../features/accounts/data.js';
import { RECURRING } from '../features/recurring/data.js';
import { ALLOCATE_TOPICS } from '../features/events/data.js';
import { BUDGETS } from '../features/budgets/data.js';
import { GOALS } from '../features/goals/data.js';
import { DEBTS } from '../features/investments/data.js';
import { M, I, IcoMDI, Divider, StatusBar, AppBar } from './theme.jsx';
import { useLang } from '../shared/i18n.jsx';
import { useNav, Sheet } from './nav.jsx';
import { useLocalStorage, useSessionStorage } from '../shared/hooks.jsx';
import { BarChart, StackedBar } from '../shared/components/Charts.jsx';
import { TxRow } from '../shared/components/TxRow.jsx';
import { Toggle } from '../features/events/Events.jsx';
import { CategoryPicker } from '../features/review/Review.jsx';

export const AppCtx = React.createContext({ logout: () => {} });
export const useAppCtx = () => React.useContext(AppCtx);

export const CatCtx = React.createContext(null);
export function CatProvider({ children }) {
  const [customCats, setCustomCats] = useLocalStorage('munni_customCats', []);
  const newEntries = Object.fromEntries(customCats.map(c => [c.id, c]));
  Object.keys(_catExt).forEach(k => delete _catExt[k]);
  Object.assign(_catExt, newEntries);
  React.useEffect(() => {
    const entries = Object.fromEntries(customCats.map(c => [c.id, c]));
    Object.keys(_catExt).forEach(k => delete _catExt[k]);
    Object.assign(_catExt, entries);
  }, [customCats]);
  return <CatCtx.Provider value={{ customCats, setCustomCats }}>{children}</CatCtx.Provider>;
}
export const useCatCtx = () => React.useContext(CatCtx);

// Listen for demo reset from any tab — wipe session and reload to login
export function ResetSignalListener() {
  React.useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'munni_reset_signal') {
        sessionStorage.clear();
        window.location.reload();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return null;
}

export const ProfilesCtx = React.createContext(null);

export function ProfilesProvider({ children }) {
  // Reactive: re-compute key whenever login method changes
  const [loginMethod] = useSessionStorage('munni_last_login_method', '');
  const [email] = useSessionStorage('munni_profile_email', '');
  const { lang } = useLang();
  const safeEmail = React.useMemo(() => { try { return JSON.parse(email || '""') || ''; } catch { return ''; } }, [email]);
  const profileKey = computeProfileKey(loginMethod, safeEmail);
  // Pass lang so the fallback (no stored data) uses the correct localised name
  const defaultProfiles = React.useMemo(() => getDefaultProfiles(loginMethod, lang), [loginMethod, lang]);
  const [profiles, setProfiles] = useLocalStorage(profileKey, defaultProfiles);
  const myId = React.useMemo(() => getUserId(), []);

  // Global shared-profile signal detection: expelled (kicked) and left (voluntary leave)
  React.useEffect(() => {
    const checkSharedSignals = () => {
      setProfiles(ps => {
        let changed = false;
        const updated = ps.map(p => {
          try {
            const sd = JSON.parse(localStorage.getItem(`munni_shared_data_${p.id}`) || '{}');
            // Expelled: remove this isShared profile from my list
            if (p.isShared && sd.expelled?.[myId]) { changed = true; return null; }
            // Owner profile: remove left members + add members joined via other owners (sharedData.memberPerms)
            if (!p.isShared && (p.members || []).length > 0) {
              const leftIdsSet = new Set(Object.keys(sd.left || {}));
              const expelledIdsSet = new Set(Object.keys(sd.expelled || {}));
              const trimmedMembers = leftIdsSet.size > 0
                ? (p.members || []).filter(m => !leftIdsSet.has(m.userId))
                : (p.members || []);
              const membersTrimmed = trimmedMembers.length < (p.members || []).length;
              const existingIds = new Set(trimmedMembers.map(m => m.userId));
              const sdNewIds = Object.keys(sd.memberPerms || {}).filter(id => id !== myId && !existingIds.has(id) && !expelledIdsSet.has(id) && !leftIdsSet.has(id));
              const detachedIds = new Set(Object.keys(sd.detached || {}));
              const detachedToRemove = (p.accountIds || []).filter(id => detachedIds.has(id));
              const permUpdatedMembers = trimmedMembers.filter(m => sd.memberPerms?.[m.userId] && sd.memberPerms[m.userId] !== m.permission);
              if (membersTrimmed || sdNewIds.length > 0 || detachedToRemove.length > 0 || permUpdatedMembers.length > 0) {
                changed = true;
                const added = sdNewIds.map(userId => ({ userId, permission: sd.memberPerms[userId], joinedAt: Date.now() }));
                const syncedMembers = trimmedMembers.map(m => sd.memberPerms?.[m.userId] ? { ...m, permission: sd.memberPerms[m.userId] } : m);
                const newAccountIds = detachedToRemove.length > 0
                  ? (p.accountIds || []).filter(id => !detachedIds.has(id))
                  : (p.accountIds || []);
                return { ...p, members: [...syncedMembers, ...added], accountIds: newAccountIds };
              }
            }
            // isShared member view: remove left members, detect owner transfer, add new members from sharedData.memberPerms
            if (p.isShared) {
              const leftIdsSet = new Set(Object.keys(sd.left || {}));
              const expelledIdsSet = new Set(Object.keys(sd.expelled || {}));
              const baseMembers = (p.members || []).filter(m => !leftIdsSet.has(m.userId));
              const membersTrimmed = baseMembers.length < (p.members || []).length;
              const newOwnerId = sd.meta?.newOwnerId;
              const ownerChanged = newOwnerId && newOwnerId !== p.ownerId;
              const existingIds = new Set(baseMembers.map(m => m.userId));
              const sdNewIds = Object.keys(sd.memberPerms || {}).filter(id => id !== myId && !existingIds.has(id) && !expelledIdsSet.has(id) && !leftIdsSet.has(id));
              const detachedIds = new Set(Object.keys(sd.detached || {}));
              const detachedToRemove = (p.accountIds || []).filter(id => detachedIds.has(id));
              const permUpdatedMembers = baseMembers.filter(m => sd.memberPerms?.[m.userId] && sd.memberPerms[m.userId] !== m.permission);
              if (membersTrimmed || ownerChanged || sdNewIds.length > 0 || detachedToRemove.length > 0 || permUpdatedMembers.length > 0) {
                changed = true;
                const added = sdNewIds.map(userId => ({ userId, permission: sd.memberPerms[userId], joinedAt: Date.now() }));
                const syncedMembers = baseMembers.map(m => sd.memberPerms?.[m.userId] ? { ...m, permission: sd.memberPerms[m.userId] } : m);
                let result = { ...p, members: [...syncedMembers, ...added] };
                if (ownerChanged) result = { ...result, ownerId: newOwnerId };
                if (detachedToRemove.length > 0) result = { ...result, accountIds: (p.accountIds || []).filter(id => !detachedIds.has(id)) };
                return result;
              }
            }
            // Name/picture sync: apply changes written by the other side
            const isSharedVariant = p.isShared || (p.members || []).length > 0;
            if (isSharedVariant && sd.meta) {
              const metaName = sd.meta.name;
              const metaPic = sd.meta.picture;
              const nameChanged = !p.localName && metaName && metaName !== p.name;
              const picChanged = !p.localPicture && metaPic !== undefined && metaPic !== p.picture;
              if (nameChanged || picChanged) {
                changed = true;
                return { ...p, ...(nameChanged ? { name: metaName } : {}), ...(picChanged ? { picture: metaPic } : {}) };
              }
            }
          } catch {}
          return p;
        });
        if (!changed) return ps;
        const remaining = updated.filter(Boolean);
        if (!remaining.find(p => p.active) && remaining.length > 0) remaining[0] = { ...remaining[0], active: true };
        return remaining;
      });
    };
    checkSharedSignals();
    const onStorage = (e) => { if (e.key?.startsWith('munni_shared_data_')) checkSharedSignals(); };
    const onCustom = (e) => { if (e.detail?.key?.startsWith('munni_shared_data_')) checkSharedSignals(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('munni-ls', onCustom);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('munni-ls', onCustom); };
  }, [myId]);

  return <ProfilesCtx.Provider value={{ profiles, setProfiles }}>{children}</ProfilesCtx.Provider>;
}
export const useProfiles = () => React.useContext(ProfilesCtx);

export const TxCtx = React.createContext(null);
export function TxProvider({ children }) {
  const [loginMethod] = useSessionStorage('munni_last_login_method', '');
  const [rawEmail] = useSessionStorage('munni_profile_email', '');
  const safeEmail = React.useMemo(() => { try { return JSON.parse(rawEmail||'""')||''; } catch { return rawEmail||''; } }, [rawEmail]);
  const txKey = computeUserDataKey(loginMethod, safeEmail, 'munni_txs');
  const [ownTxs, setOwnTxs] = useLocalStorage(txKey, getDefaultTxs(loginMethod || sessionStorage.getItem('munni_last_login_method') || ''));
  const { profiles } = useProfiles();

  const activeProfile = profiles.find(p => p.active) || profiles[0];

  // Merge in shared profile data so invited members see the owner's accounts/txs
  const isSharedOrHasMembers = !!(activeProfile?.isShared || (activeProfile?.members||[]).length > 0);
  const sharedDataKey = isSharedOrHasMembers ? `munni_shared_data_${activeProfile.id}` : 'munni_shared_data_none';
  const [sharedData] = useLocalStorage(sharedDataKey, { accounts: [], txs: [] });

  // For shared profiles (invited members), profile.accountIds is a stale invite-time snapshot.
  // Use the live sharedData.accounts IDs instead so newly attached accounts are always visible.
  const activeAccountIds = (isSharedOrHasMembers && (sharedData?.accounts?.length ?? 0) > 0)
    ? (sharedData.accounts || []).map(a => a.id)
    : (activeProfile?.accountIds || []);

  const allTxs = React.useMemo(() => {
    const sharedTxs = sharedData?.txs || [];
    if (!sharedTxs.length) return ownTxs;
    // sharedData.txs takes priority so cross-user edits are visible in both tabs
    const sharedIds = new Set(sharedTxs.map(t => t.id));
    return [...ownTxs.filter(t => !sharedIds.has(t.id)), ...sharedTxs];
  }, [ownTxs, sharedData]);

  // Only show transactions whose account is in the active profile; empty profile = no transactions
  const txs = activeAccountIds.length > 0
    ? allTxs.filter(t => t.account && activeAccountIds.includes(t.account))
    : [];

  const updateTx = (id, changes) => {
    setOwnTxs(ts => ts.map(t => t.id === id ? {...t, ...changes} : t));
    // Also sync to sharedData.txs so the other tab picks it up via storage event
    if (isSharedOrHasMembers && sharedDataKey !== 'munni_shared_data_none') {
      try {
        const sd = JSON.parse(localStorage.getItem(sharedDataKey) || '{"accounts":[],"txs":[]}');
        if ((sd.txs || []).some(t => t.id === id)) {
          localStorage.setItem(sharedDataKey, JSON.stringify({ ...sd, txs: (sd.txs || []).map(t => t.id === id ? {...t, ...changes} : t) }));
          window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sharedDataKey } }));
        }
      } catch {}
    }
  };
  const addTxs = (newTxs) => setOwnTxs(ts => [...newTxs, ...ts]);
  const setTxs = setOwnTxs;
  return <TxCtx.Provider value={{ txs, allTxs, updateTx, addTxs, setTxs }}>{children}</TxCtx.Provider>;
}
export const useTxCtx = () => React.useContext(TxCtx);

export const RecurCtx = React.createContext(null);
export function RecurProvider({ children }) {
  const [recurList, setRecurList] = useLocalStorage('munni_recur', () => RECURRING.slice());
  const addRecur = (r) => setRecurList(rs => [r, ...rs]);
  const updateRecur = (id, changes) => setRecurList(rs => rs.map(r => r.id === id ? {...r, ...changes} : r));
  return <RecurCtx.Provider value={{ recurList, addRecur, updateRecur }}>{children}</RecurCtx.Provider>;
}
export const useRecurCtx = () => React.useContext(RecurCtx);

export const AllocCtx = React.createContext(null);
export const useAlloc = () => React.useContext(AllocCtx);

export function useConnectedAccounts() {
  const [loginMethod] = useSessionStorage('munni_last_login_method', '');
  const [rawEmail] = useSessionStorage('munni_profile_email', '');
  const safeEmail = React.useMemo(() => { try { return JSON.parse(rawEmail||'""')||''; } catch { return rawEmail||''; } }, [rawEmail]);
  const acctKey = computeUserDataKey(loginMethod, safeEmail, 'munni_bank_accounts');
  const defaultAccts = React.useMemo(() => getDefaultAccounts(loginMethod), [loginMethod]);
  return useLocalStorage(acctKey, defaultAccts);
}

export const DEFAULT_PROFILE_IDS = ['p_google','p_apple','p_demo','p_email'];
export function useProfileBudgets() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(`munni_budgets_${activeProfileId}`, DEFAULT_PROFILE_IDS.includes(activeProfileId) ? BUDGETS : []);
}
export function useProfileGoals() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(`munni_goals_${activeProfileId}`, DEFAULT_PROFILE_IDS.includes(activeProfileId) ? GOALS : []);
}
export function useProfileDebts() {
  const { profiles } = useProfiles();
  const activeProfileId = (profiles.find(p => p.active) || profiles[0])?.id || 'default';
  return useLocalStorage(`munni_debts_${activeProfileId}`, DEFAULT_PROFILE_IDS.includes(activeProfileId) ? DEBTS : []);
}

const ALLOC_PERIODS = [
  { label:'20 Sep – 19 Oct', income:2380, setaside:890, topics:[
    { id:'at_rent', name:'Rent', icon:'house', allocated:740, actual:738, estimate:740, cats:['housingRent'], group:'recurring' },
    { id:'at_energy', name:'Energy', icon:'flame', allocated:65, actual:72, estimate:65, cats:['housingUtility'], group:'recurring' },
    { id:'at_subs', name:'Subscriptions', icon:'film', allocated:25, actual:23.98, estimate:25, cats:['subs'], group:'recurring' },
    { id:'at_food', name:'Food & Dining', icon:'fork', allocated:260, actual:285, estimate:290, cats:['groceries','restaurants','coffee'], group:'var' },
    { id:'at_trans', name:'Transport', icon:'car', allocated:80, actual:42, estimate:75, cats:['transportPublic','transportCar','transportFuel'], group:'var' },
    { id:'at_health', name:'Health', icon:'health', allocated:40, actual:45, estimate:35, cats:['healthcare','doctorVisit','prescription'], group:'var' },
    { id:'at_hobby', name:'Hobby', icon:'bag', allocated:110, actual:120, estimate:130, cats:['hobby','videoGame','sportsEquipment'], group:'var' },
  ]},
  { label:'20 Oct – 19 Nov', income:2380, setaside:890, topics:[
    { id:'at_rent', name:'Rent', icon:'house', allocated:740, actual:740, estimate:740, cats:['housingRent'], group:'recurring' },
    { id:'at_energy', name:'Energy', icon:'flame', allocated:65, actual:58, estimate:65, cats:['housingUtility'], group:'recurring' },
    { id:'at_subs', name:'Subscriptions', icon:'film', allocated:25, actual:23.98, estimate:25, cats:['subs'], group:'recurring' },
    { id:'at_food', name:'Food & Dining', icon:'fork', allocated:260, actual:302, estimate:290, cats:['groceries','restaurants','coffee'], group:'var' },
    { id:'at_trans', name:'Transport', icon:'car', allocated:80, actual:55, estimate:75, cats:['transportPublic','transportCar','transportFuel'], group:'var' },
    { id:'at_health', name:'Health', icon:'health', allocated:40, actual:30, estimate:35, cats:['healthcare','doctorVisit','prescription'], group:'var' },
    { id:'at_hobby', name:'Hobby', icon:'bag', allocated:110, actual:0, estimate:130, cats:['hobby','videoGame','sportsEquipment'], group:'var' },
  ]},
  { label:'20 Nov – 19 Dec', income:2480, setaside:940, topics:[
    { id:'at_rent', name:'Rent', icon:'house', allocated:740, actual:740, estimate:740, cats:['housingRent'], group:'recurring' },
    { id:'at_energy', name:'Energy', icon:'flame', allocated:65, actual:80, estimate:70, cats:['housingUtility'], group:'recurring' },
    { id:'at_subs', name:'Subscriptions', icon:'film', allocated:25, actual:37.97, estimate:40, cats:['subs'], group:'recurring' },
    { id:'at_food', name:'Food & Dining', icon:'fork', allocated:280, actual:260, estimate:290, cats:['groceries','restaurants','coffee'], group:'var' },
    { id:'at_trans', name:'Transport', icon:'car', allocated:80, actual:68, estimate:75, cats:['transportPublic','transportCar','transportFuel'], group:'var' },
    { id:'at_health', name:'Health', icon:'health', allocated:40, actual:22, estimate:35, cats:['healthcare','doctorVisit','prescription'], group:'var' },
    { id:'at_hobby', name:'Hobby', icon:'bag', allocated:110, actual:80, estimate:130, cats:['hobby','videoGame','sportsEquipment'], group:'var' },
  ]},
  { label:'20 Dec – 19 Jan', income:2480, setaside:940, topics:[
    { id:'at_rent', name:'Rent', icon:'house', allocated:740, actual:740, estimate:740, cats:['housingRent'], group:'recurring' },
    { id:'at_energy', name:'Energy', icon:'flame', allocated:65, actual:65, estimate:65, cats:['housingUtility'], group:'recurring' },
    { id:'at_subs', name:'Subscriptions', icon:'film', allocated:30, actual:23.98, estimate:30, cats:['subs'], group:'recurring' },
    { id:'at_food', name:'Food & Dining', icon:'fork', allocated:300, actual:340, estimate:310, cats:['groceries','restaurants','coffee'], group:'var' },
    { id:'at_trans', name:'Transport', icon:'car', allocated:80, actual:50, estimate:75, cats:['transportPublic','transportCar','transportFuel'], group:'var' },
    { id:'at_health', name:'Health', icon:'health', allocated:40, actual:18, estimate:35, cats:['healthcare','doctorVisit','prescription'], group:'var' },
    { id:'at_hobby', name:'Hobby', icon:'bag', allocated:110, actual:240, estimate:130, cats:['hobby','videoGame','sportsEquipment'], group:'var' },
  ]},
];

const ALLOC_INCOME   = 2480;
const ALLOC_SETASIDE = 940;
const ALLOC_TOALLOC  = ALLOC_INCOME - ALLOC_SETASIDE;

export function Stat({ label, value, color }) {
  return (
    <div>
      <div className="m-cap">{label}</div>
      <div className="m-num" style={{ fontSize:18, fontWeight:600, color, marginTop:2 }}>{value}</div>
    </div>
  );
}

export function AllocProvider({ children }) {
  const { profiles } = useProfiles();
  const activeProfile = profiles.find(p => p.active) || profiles[0];
  const profileId = activeProfile?.id || 'default';
  const [topics, setTopics] = useLocalStorage(`munni_topics_${profileId}`, ALLOCATE_TOPICS);
  const [pOffset, setPOffset] = useLocalStorage('munni_pOffset', 0);
  const updateTopic = (id, changes) => setTopics(ts => ts.map(t => t.id === id ? { ...t, ...changes } : t));
  const addTopicCat = (topicId, catId) => setTopics(ts => ts.map(t => t.id === topicId ? { ...t, cats: [...t.cats, catId] } : t));
  const removeTopicCat = (topicId, catId) => setTopics(ts => ts.map(t => t.id === topicId ? { ...t, cats: t.cats.filter(c => c !== catId) } : t));
  const allocated = topics.reduce((s, t) => s + t.allocated, 0);
  const unallocated = (ALLOC_INCOME - ALLOC_SETASIDE) - allocated;
  return (
    <AllocCtx.Provider value={{ topics, setTopics, updateTopic, addTopicCat, removeTopicCat, pOffset, setPOffset, allocated, unallocated }}>
      {children}
    </AllocCtx.Provider>
  );
}

export function AllocateTopicRow({ topic, onClick }) {
  const { txs } = useTxCtx();
  const computedActual = txs.filter(t => topic.cats.includes(t.cat) && t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
  const over = computedActual > topic.allocated;
  const pct  = Math.min(computedActual / (topic.allocated || 1), 1);
  return (
    <div className="m-tap" onClick={onClick} style={{ padding:'12px 0' }}>
      <div style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
        <div style={{ width:36, height:36, borderRadius:10, background:over?M.claySoft:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
          <I name={topic.icon} size={16} color={over?M.clay:M.ink2}/>
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontSize:14, fontWeight:500 }}>{topic.name}</div>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              {over && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.claySoft, color:M.clay, textTransform:'uppercase', letterSpacing:'0.05em' }}>over</span>}
              <div className="m-num" style={{ fontSize:14, fontWeight:600, color:over?M.clay:M.ink }}>{fmtEur(computedActual, {decimals:0})}</div>
            </div>
          </div>
          <div style={{ margin:'7px 0 4px' }}>
            <div style={{ height:5, borderRadius:999, background:M.line2, overflow:'hidden' }}>
              <div style={{ width:`${pct*100}%`, height:'100%', background:over?M.clay:M.sage, borderRadius:999 }}/>
            </div>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <div className="m-cap">est. {fmtEur(topic.estimate, {decimals:0})}</div>
            <div className="m-cap">of {fmtEur(topic.allocated, {decimals:0})}</div>
          </div>
        </div>
        <I name="caretR" size={12} color={M.ink4} style={{ marginTop:12 }}/>
      </div>
    </div>
  );
}

export function ScreenAllocate() {
  const nav = useNav();
  const { t } = useLang();
  const { topics, updateTopic, pOffset, setPOffset, unallocated } = useAlloc();
  const { txs } = useTxCtx();
  const [showAutoConfirm, setShowAutoConfirm] = React.useState(false);
  const [recurringExpanded, setRecurringExpanded] = React.useState(false);

  const isCurrent = pOffset === 0;
  const periodIdx = ALLOC_PERIODS.length + pOffset;
  const periodLabel = isCurrent ? '20 Jan – 19 Feb' : (ALLOC_PERIODS[periodIdx]?.label || '');
  const displayTopics = isCurrent ? topics : (ALLOC_PERIODS[periodIdx]?.topics || []);
  const displayIncome = isCurrent ? ALLOC_INCOME : (ALLOC_PERIODS[periodIdx]?.income || ALLOC_INCOME);
  const displaySetaside = isCurrent ? ALLOC_SETASIDE : (ALLOC_PERIODS[periodIdx]?.setaside || ALLOC_SETASIDE);
  const displayAllocated = displayTopics.reduce((s, t) => s + t.allocated, 0);
  const displayUnallocated = isCurrent ? unallocated : ((displayIncome - displaySetaside) - displayAllocated);

  const recurring = displayTopics.filter(t => t.group === 'recurring');
  const varTopics = displayTopics.filter(t => t.group === 'var');
  const recurringAllocated = recurring.reduce((s, t) => s + t.allocated, 0);
  const recurringActual = isCurrent
    ? recurring.reduce((s, t) => s + txs.filter(tx => t.cats.includes(tx.cat) && tx.amount < 0).reduce((a, tx) => a + Math.abs(tx.amount), 0), 0)
    : recurring.reduce((s, t) => s + t.actual, 0);
  const recurringOver = recurringActual > recurringAllocated;

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('period.allocate')}
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div style={{ display:'flex', justifyContent:'center', alignItems:'center', gap:18, padding:'0 20px 14px', flexShrink:0 }}>
        <button className="m-iconbtn m-tap" onClick={() => setPOffset(o => Math.max(-(ALLOC_PERIODS.length), o-1))}
          style={{ opacity:periodIdx===0?0.3:1 }}><I name="arrowL" size={18}/></button>
        <div style={{ textAlign:'center' }}>
          <div className="m-cap">Period</div>
          <div style={{ fontSize:14, fontWeight:600, marginTop:2 }}>{periodLabel}</div>
          {isCurrent && <div style={{ fontSize:10, color:M.sage, fontWeight:600, marginTop:2 }}>Current</div>}
        </div>
        <button className="m-iconbtn m-tap" onClick={() => setPOffset(o => Math.min(0, o+1))}
          style={{ opacity:isCurrent?0.3:1 }}><I name="arrowR" size={18} color={M.ink4}/></button>
      </div>

      <div className="m-body-scroll">
        {/* Summary card */}
        <div className="m-card" style={{ padding:18, marginBottom:14, border:`1.5px solid ${displayUnallocated===0?M.sage:M.ochre}` }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom:12 }}>
            <div>
              <div className="m-cap">To allocate</div>
              <div className="m-num" style={{ fontSize:20, fontWeight:700, marginTop:2 }}>{fmtEur(displayIncome - displaySetaside)}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div className="m-cap">Unallocated</div>
              <div className="m-num" style={{ fontSize:20, fontWeight:700, color:displayUnallocated===0?M.sage:M.ochre, marginTop:2 }}>{fmtEur(displayUnallocated)}</div>
              {displayUnallocated===0 && <div style={{ fontSize:10, fontWeight:600, color:M.sage, marginTop:3 }}>Every euro planned ✓</div>}
            </div>
          </div>
          <StackedBar segments={[
            { value:displayAllocated,   color:M.ink },
            { value:Math.max(0,displayUnallocated), color:displayUnallocated===0?M.sage:M.ochre },
          ]} height={8}/>
        </div>

        {isCurrent && displayUnallocated > 0 && (
          <button className="m-btn sage m-tap" style={{ width:'100%', marginBottom:16 }} onClick={() => setShowAutoConfirm(true)}>
            <I name="check" size={16}/> Auto-allocate {fmtEur(displayUnallocated)}
          </button>
        )}

        {/* Recurring section — collapsible */}
        <div className="m-card" style={{ padding:'0 16px', marginBottom:16, border:`1px solid ${recurringOver?M.claySoft:M.line}` }}>
          <div className="m-tap" onClick={() => setRecurringExpanded(e => !e)} style={{ padding:'12px 0', display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:recurringOver?M.claySoft:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <I name="arrowDn" size={16} color={recurringOver?M.clay:M.ink2}/>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
                <div style={{ fontSize:14, fontWeight:500 }}>Recurring · {recurring.length} items</div>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  {recurringOver && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:999, background:M.claySoft, color:M.clay, textTransform:'uppercase' }}>over</span>}
                  <div className="m-num" style={{ fontSize:14, fontWeight:600, color:recurringOver?M.clay:M.ink }}>{fmtEur(recurringActual,{decimals:0})}</div>
                </div>
              </div>
              <div style={{ height:5, borderRadius:999, background:M.line2, overflow:'hidden' }}>
                <div style={{ width:`${Math.min(100,(recurringActual/recurringAllocated)*100)}%`, height:'100%', background:recurringOver?M.clay:M.sage, borderRadius:999 }}/>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:4 }}>
                <div className="m-cap">fixed costs</div>
                <div className="m-cap">of {fmtEur(recurringAllocated,{decimals:0})}</div>
              </div>
            </div>
            <I name={recurringExpanded?'arrowUp':'arrowDn'} size={12} color={M.ink4}/>
          </div>
          {recurringExpanded && (
            <>
              <div style={{ height:1, background:M.line2 }}/>
              {recurring.map((t, i, a) => (
                <React.Fragment key={t.id}>
                  <AllocateTopicRow topic={t} onClick={() => nav.push('allocateTopic', { id:t.id })}/>
                  {i < a.length-1 && <Divider inset={48}/>}
                </React.Fragment>
              ))}
            </>
          )}
        </div>

        {/* Variable topics section */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, paddingLeft:4 }}>
          <div className="m-cap">Topics · {varTopics.length}</div>
          {isCurrent && (
            <button className="m-tap" onClick={() => nav.push('allocateAddTopic')}
              style={{ display:'flex', alignItems:'center', gap:4, background:'transparent', border:'none', color:M.ink3, fontSize:12, fontWeight:600, fontFamily:M.fontUI, cursor:'pointer', padding:'4px 0' }}>
              <I name="plus" size={12} color={M.ink3}/> Add topic
            </button>
          )}
        </div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:20, border:`1px solid ${M.line}` }}>
          {varTopics.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <AllocateTopicRow topic={t} onClick={() => nav.push('allocateTopic', { id:t.id })}/>
              {i < a.length-1 && <Divider inset={48}/>}
            </React.Fragment>
          ))}
        </div>
      </div>

      {showAutoConfirm && (
        <Sheet onClose={() => setShowAutoConfirm(false)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div className="m-h2" style={{ marginBottom:6 }}>Auto-allocate</div>
            <div style={{ fontSize:13, color:M.ink3, marginBottom:16 }}>
              Distribute {fmtEur(displayUnallocated)} based on topic estimates.
            </div>
            {topics.filter(t => t.estimate > t.allocated).map(t => (
              <div key={t.id} style={{ display:'flex', justifyContent:'space-between', padding:'7px 0', fontSize:13, borderBottom:`1px solid ${M.line2}` }}>
                <span>{t.name}</span>
                <span className="m-num" style={{ color:M.sage, fontWeight:600 }}>+{fmtEur(t.estimate - t.allocated, {decimals:0})}</span>
              </div>
            ))}
            <button className="m-btn sage m-tap" style={{ width:'100%', marginTop:20 }} onClick={() => setShowAutoConfirm(false)}>
              Confirm
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function ScreenAllocateTopic({ params }) {
  const nav = useNav();
  const { topics, addTopicCat, removeTopicCat } = useAlloc();
  const [showMove, setShowMove] = React.useState(false);
  const [showCatPicker, setShowCatPicker] = React.useState(false);

  const { txs } = useTxCtx();
  const topic = topics.find(t => t.id === params?.id) || topics[0];
  const topicTxs = txs.filter(t => topic.cats.includes(t.cat) && t.amount < 0);
  const computedActual = topicTxs.reduce((s, t) => s + Math.abs(t.amount), 0);
  const over    = computedActual > topic.allocated;
  const pct     = Math.min(computedActual / (topic.allocated || 1), 1);
  const history  = [topic.allocated*0.82, topic.allocated*0.95, topic.allocated*1.08, topic.allocated*0.91, topic.allocated*0.98, topic.actual];
  const availableCats = Object.values(CATEGORIES).filter(c => !c.isParent && !c.positive && !topic.cats.includes(c.id));

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title=""
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="arrowL" size={20}/></button>}
      />
      <div className="m-body-scroll">
        <div style={{ textAlign:'center', padding:'8px 0 20px' }}>
          <div style={{ width:64, height:64, borderRadius:18, background:over?M.claySoft:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px' }}>
            <I name={topic.icon} size={28} color={over?M.clay:M.ink2}/>
          </div>
          <div className="m-h2">{topic.name}</div>
          {over && (
            <div style={{ display:'inline-flex', alignItems:'center', gap:6, marginTop:8, padding:'5px 12px', borderRadius:999, background:M.claySoft }}>
              <I name="alert" size={12} color={M.clay}/>
              <span style={{ fontSize:12, fontWeight:600, color:M.clay }}>Over budget by {fmtEur(computedActual - topic.allocated, {decimals:0})}</span>
            </div>
          )}
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:14, border:`1px solid ${over?M.claySoft:M.line}` }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:14 }}>
            <Stat label="Allocated" value={fmtEur(topic.allocated, {decimals:0})} color={M.ink}/>
            <Stat label="Actual" value={fmtEur(computedActual, {decimals:0})} color={over?M.clay:M.sage}/>
            <Stat label="Estimate" value={fmtEur(topic.estimate, {decimals:0})} color={M.ink3}/>
          </div>
          <div style={{ height:8, borderRadius:999, background:M.line2, overflow:'hidden' }}>
            <div style={{ width:`${pct*100}%`, height:'100%', background:over?M.clay:M.sage, borderRadius:999 }}/>
          </div>
          <div className="m-cap" style={{ marginTop:6, textAlign:'right' }}>{(pct*100).toFixed(0)}% used</div>
        </div>

        <div className="m-card" style={{ padding:16, marginBottom:14, border:`1px solid ${M.line}` }}>
          <div className="m-cap" style={{ marginBottom:10 }}>History · 6 periods</div>
          <BarChart data={history} labels={['Sep–Oct','Oct–Nov','Nov–Dec','Dec–Jan','Jan–Feb','Feb–Mar']} showValues height={84} accent={over?M.clay:M.sage}/>
        </div>

        {/* Category CRUD */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, paddingLeft:4 }}>
          <div className="m-cap">Categories · {topic.cats.length}</div>
          {availableCats.length > 0 && (
            <button className="m-tap" onClick={() => setShowCatPicker(true)}
              style={{ display:'flex', alignItems:'center', gap:4, background:'transparent', border:'none', color:M.ink3, fontSize:12, fontWeight:600, fontFamily:M.fontUI, cursor:'pointer', padding:'4px 0' }}>
              <I name="plus" size={12} color={M.ink3}/> Add category
            </button>
          )}
        </div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {topic.cats.map((catId, i, a) => {
            const c = CATEGORIES[catId] || { id:catId, name:catId, icon:'help-circle-outline' };
            const catTotal = topicTxs.filter(t => t.cat === catId).reduce((s, t) => s + Math.abs(t.amount), 0);
            return (
              <React.Fragment key={catId}>
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0' }}>
                  <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <IcoMDI name={c.icon || 'help-circle-outline'} size={15} color={M.ink2}/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:500 }}>{catPath(c)}</div>
                    {catTotal > 0 && <div style={{ fontSize:11, color:M.ink3, marginTop:1 }}>{fmtEur(catTotal, {decimals:0})} actual</div>}
                  </div>
                  {topic.cats.length > 1 && (
                    <button className="m-tap" onClick={() => removeTopicCat(topic.id, catId)}
                      style={{ width:28, height:28, borderRadius:8, background:'transparent', border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <I name="x" size={14} color={M.ink4}/>
                    </button>
                  )}
                </div>
                {i < a.length-1 && <Divider inset={44}/>}
              </React.Fragment>
            );
          })}
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Transactions · {topicTxs.length}</div>
        <div className="m-card" style={{ padding:'0 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {topicTxs.length === 0 && (
            <div style={{ padding:'20px 0', textAlign:'center', color:M.ink4, fontSize:13 }}>No transactions this period</div>
          )}
          {topicTxs.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <TxRow tx={t} showDate onClick={() => nav.push('txDetail', { id:t.id })}/>
              {i < a.length-1 && <Divider inset={50}/>}
            </React.Fragment>
          ))}
        </div>

        <div style={{ display:'flex', gap:10, marginBottom:20 }}>
          <button className="m-btn outline m-tap" style={{ flex:1 }} onClick={() => setShowMove(true)}>
            <I name="swap" size={16}/> Move funds
          </button>
          {over ? (
            <button className="m-btn m-tap" style={{ flex:1, background:M.clay, color:'#fff', borderColor:M.clay }} onClick={() => setShowMove(true)}>
              <I name="swap" size={16} color="#fff"/> Fix overage
            </button>
          ) : (
            <button className="m-btn outline m-tap" style={{ flex:1 }}>
              <I name="edit" size={16}/> Edit topic
            </button>
          )}
        </div>
      </div>

      {showMove && <AllocateMoveSheet topic={topic} onClose={() => setShowMove(false)}/>}

      {showCatPicker && (
        <Sheet onClose={() => setShowCatPicker(false)}>
          <div style={{ padding:'4px 20px 32px' }}>
            <div className="m-h2" style={{ marginBottom:16 }}>Add category</div>
            {availableCats.map((c, i, a) => (
              <React.Fragment key={c.id}>
                <div className="m-tap" onClick={() => { addTopicCat(topic.id, c.id); setShowCatPicker(false); }}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'11px 0' }}>
                  <div style={{ width:32, height:32, borderRadius:9, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <I name={c.icon} size={15} color={M.ink2}/>
                  </div>
                  <div style={{ flex:1, fontSize:14, fontWeight:500 }}>{catPath(c)}</div>
                  <I name="plus" size={14} color={M.ink3}/>
                </div>
                {i < a.length-1 && <div style={{ height:1, background:M.line2, marginLeft:44 }}/>}
              </React.Fragment>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function AllocateMoveSheet({ topic, onClose }) {
  const others = ALLOCATE_TOPICS.filter(t => t.id !== topic.id);
  const [fromId, setFromId] = React.useState(others[0]?.id);
  const [amount, setAmount] = React.useState('');
  const fromTopic = ALLOCATE_TOPICS.find(t => t.id === fromId);
  const amt = parseFloat((amount||'').replace(',','.')) || 0;

  return (
    <Sheet onClose={onClose}>
      <div style={{ padding:'4px 20px 32px', overflowY:'auto', maxHeight:'70vh' }}>
        <div className="m-h2" style={{ marginBottom:4 }}>Move funds</div>
        <div style={{ fontSize:13, color:M.ink3, marginBottom:20 }}>Take allocated money from another topic.</div>

        <div className="m-cap" style={{ marginBottom:6 }}>Move from</div>
        <div className="m-card" style={{ padding:'4px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {others.map((t, i, a) => (
            <React.Fragment key={t.id}>
              <div className="m-tap" onClick={() => setFromId(t.id)} style={{ display:'flex', alignItems:'center', gap:12, padding:'11px 0' }}>
                <div style={{ width:20, height:20, borderRadius:999, border:`2px solid ${fromId===t.id?M.ink:M.line}`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  {fromId===t.id && <div style={{ width:10, height:10, borderRadius:999, background:M.ink }}/>}
                </div>
                <div style={{ flex:1, fontSize:13 }}>{t.name}</div>
                <div className="m-num" style={{ fontSize:12, color:M.ink3 }}>{fmtEur(t.allocated, {decimals:0})}</div>
              </div>
              {i < a.length-1 && <Divider/>}
            </React.Fragment>
          ))}
        </div>

        <div className="m-cap" style={{ marginBottom:6 }}>Move to</div>
        <div className="m-card" style={{ padding:'12px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <I name={topic.icon} size={16} color={M.ink2}/>
            </div>
            <div style={{ fontSize:14, fontWeight:500 }}>{topic.name}</div>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom:6 }}>Amount</div>
        <div className="m-input" style={{ marginBottom:16 }}>
          <span style={{ color:M.ink3, marginRight:4 }}>€</span>
          <span style={{ color:amount?M.ink:M.ink4 }}>{amount || '0,00'}</span>
        </div>

        {fromTopic && amt > 0 && (
          <div className="m-card" style={{ padding:14, marginBottom:16, background:M.paper2, border:`1px solid ${M.line2}` }}>
            <div className="m-cap" style={{ marginBottom:8 }}>Preview</div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:6 }}>
              <span>{fromTopic.name}</span>
              <span className="m-num">{fmtEur(fromTopic.allocated, {decimals:0})} → <span style={{ color:M.clay }}>{fmtEur(fromTopic.allocated-amt, {decimals:0})}</span></span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13 }}>
              <span>{topic.name}</span>
              <span className="m-num">{fmtEur(topic.allocated, {decimals:0})} → <span style={{ color:M.sage }}>{fmtEur(topic.allocated+amt, {decimals:0})}</span></span>
            </div>
          </div>
        )}

        <div style={{ display:'flex', gap:10 }}>
          <button className="m-btn outline m-tap" style={{ flex:1 }} onClick={onClose}>Cancel</button>
          <button className="m-btn sage m-tap" style={{ flex:1 }} onClick={onClose}>Move</button>
        </div>
      </div>
    </Sheet>
  );
}

export function ScreenAllocateAddTopic() {
  const nav = useNav();
  const { unallocated } = useAlloc();
  const { txs } = useTxCtx();
  const icons = ['fork','shop','car','flame','film','health','bag','globe','rocket','star','house','heart'];
  const [icon, setIcon] = React.useState('fork');
  const [topicName, setTopicName] = React.useState('');
  const [selCats, setSelCats] = React.useState([]); // [{catId, amount}]
  const [showCatPicker, setShowCatPicker] = React.useState(false);
  const [autoFund, setAutoFund] = React.useState(false);
  const [estimateStr, setEstimateStr] = React.useState('');
  const [estimateUserEdited, setEstimateUserEdited] = React.useState(false);

  const estimate = selCats.reduce((s, c) => s + c.amount, 0);

  React.useEffect(() => {
    if (!estimateUserEdited && estimate > 0) setEstimateStr(String(estimate));
    if (!estimateUserEdited && estimate === 0) setEstimateStr('');
  }, [estimate, estimateUserEdited]);

  const effectiveEstimate = estimateUserEdited ? (parseFloat(estimateStr) || 0) : estimate;
  const canAutoFund = unallocated >= effectiveEstimate && effectiveEstimate > 0;
  const allocated = autoFund && canAutoFund ? effectiveEstimate : 0;
  const canCreate = topicName.trim().length > 0 && selCats.length > 0 && effectiveEstimate > 0;

  // Auto-estimate from transaction history per category
  const autoEstimate = (catId) => {
    const catTxs = txs.filter(t => t.cat === catId && t.amount < 0);
    if (catTxs.length === 0) return 50;
    const avg = catTxs.reduce((s, t) => s + Math.abs(t.amount), 0) / catTxs.length;
    return Math.round(avg * 10) / 10;
  };

  return (
    <div className="m-screen" style={{ position: 'relative' }}>
      <StatusBar/>
      <AppBar title="New topic"
        leading={<button className="m-iconbtn m-tap" onClick={() => nav.pop()}><I name="x" size={20}/></button>}
      />
      <div className="m-body-scroll">
        {/* 1. Icon */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Icon</div>
        <div style={{ display:'flex', gap:8, overflowX:'auto', paddingBottom:4, marginBottom:14 }}>
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

        {/* 2. Topic name */}
        <div className="m-cap" style={{ marginBottom:6, paddingLeft:4 }}>Topic name</div>
        <input
          value={topicName}
          onChange={e => setTopicName(e.target.value)}
          placeholder="e.g. Family dining"
          style={{ width:'100%', padding:'12px 16px', borderRadius:14, border:`1.5px solid ${topicName ? M.ink : M.line}`, fontSize:15, fontFamily:M.fontUI, outline:'none', marginBottom:14, background:M.paper2, color:M.ink, boxSizing:'border-box' }}
        />

        {/* 3. Categories */}
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>Categories · {selCats.length}</div>
        <div className="m-card" style={{ padding:'0 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          {selCats.length === 0 && (
            <div style={{ padding:'14px 0', fontSize:13, color:M.ink4, textAlign:'center' }}>Add categories to estimate spending</div>
          )}
          {selCats.map((c, i) => {
            const cat = CATEGORIES[c.catId] || _catExt[c.catId] || {};
            return (
              <React.Fragment key={c.catId}>
                <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0' }}>
                  <div style={{ width:28, height:28, borderRadius:8, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <IcoMDI name={cat.icon||'help-circle-outline'} size={14} color={M.ink2}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:500 }}>{catPath(cat)}</div>
                    <div style={{ fontSize:11, color:M.ink4, marginTop:1 }}>avg estimate · <span className="m-num">{fmtEur(c.amount)}</span></div>
                  </div>
                  <button onClick={() => setSelCats(s => s.filter(x => x.catId !== c.catId))} style={{ background:'none', border:'none', color:M.clay, padding:'0 4px', fontSize:18, lineHeight:1, cursor:'pointer', fontFamily:M.fontUI }}>×</button>
                </div>
                {i < selCats.length - 1 && <Divider/>}
              </React.Fragment>
            );
          })}
          <div className="m-tap" onClick={() => setShowCatPicker(true)} style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 0', borderTop: selCats.length > 0 ? `1px solid ${M.line2}` : 'none' }}>
            <div style={{ width:28, height:28, borderRadius:8, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <I name="plus" size={14} color={M.sage}/>
            </div>
            <span style={{ fontSize:13, color:M.sage, fontWeight:500 }}>Add category</span>
          </div>
        </div>

        {/* 4. Estimate */}
        <div className="m-cap" style={{ marginBottom:6, paddingLeft:4 }}>Estimate</div>
        <div className="m-card" style={{ padding:'12px 16px', marginBottom:14, border:`1px solid ${M.line}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom: estimateUserEdited ? 6 : 0 }}>
            <I name="wallet" size={16} color={M.ink3}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, color:M.ink4, marginBottom:4 }}>
                {estimate > 0 && !estimateUserEdited ? 'Based on avg category history' : estimateUserEdited ? 'Custom estimate' : 'Add categories to auto-calculate'}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:13, color:M.ink3 }}>€</span>
                <input
                  type="number"
                  inputMode="decimal"
                  value={estimateStr}
                  onChange={e => { setEstimateStr(e.target.value); setEstimateUserEdited(true); }}
                  placeholder={estimate > 0 ? String(estimate) : '0'}
                  style={{ flex:1, border:'none', outline:'none', fontSize:16, fontWeight:600, fontFamily:M.fontMono, background:'transparent', color: estimateStr ? M.ink : M.ink4, minWidth:0 }}
                />
                {!estimateUserEdited && estimate > 0 && (
                  <span style={{ fontSize:10, fontWeight:700, color:M.sage, textTransform:'uppercase', letterSpacing:'0.05em' }}>auto</span>
                )}
                {estimateUserEdited && (
                  <button onClick={() => { setEstimateUserEdited(false); setEstimateStr(''); }}
                    style={{ background:'none', border:'none', fontSize:11, color:M.ink4, cursor:'pointer', fontFamily:M.fontUI, padding:'2px 6px' }}>reset</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 5. Allocated — auto-fund checkbox */}
        <div className="m-cap" style={{ marginBottom:6, paddingLeft:4 }}>Auto-fund</div>
        <div className="m-card" style={{ padding:'14px 16px', marginBottom:20, border:`1px solid ${M.line}` }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:500 }}>Fund from unallocated income</div>
              <div style={{ fontSize:12, color:M.ink3, marginTop:2 }}>
                {canAutoFund
                  ? `Allocate ${fmtEur(effectiveEstimate)} from ${fmtEur(unallocated)} available`
                  : effectiveEstimate > 0
                    ? `Not enough unallocated (${fmtEur(unallocated)} available)`
                    : 'Set estimate first'}
              </div>
            </div>
            <button
              onClick={() => canAutoFund && setAutoFund(v => !v)}
              style={{ background:'none', border:'none', cursor: canAutoFund ? 'pointer' : 'default', opacity: canAutoFund ? 1 : 0.4, padding:0 }}
            >
              <Toggle on={autoFund && canAutoFund}/>
            </button>
          </div>
          {autoFund && canAutoFund && (
            <div style={{ marginTop:10, padding:'8px 12px', borderRadius:10, background:M.sageSoft, fontSize:12, color:M.sage, fontWeight:500 }}>
              {fmtEur(effectiveEstimate)} will be allocated when you create this topic
            </div>
          )}
        </div>

        <button
          className="m-btn sage m-tap"
          style={{ width:'100%', marginBottom:18, opacity: canCreate ? 1 : 0.5, cursor: canCreate ? 'pointer' : 'default' }}
          onClick={() => canCreate && nav.pop()}
          disabled={!canCreate}
        >
          Create topic
        </button>
        {!canCreate && (
          <div style={{ textAlign:'center', fontSize:12, color:M.ink3, marginBottom:20, marginTop:-10 }}>
            {!topicName.trim() ? 'Enter a topic name' : 'Add at least one category'}
          </div>
        )}
      </div>

      {showCatPicker && (
        <CategoryPicker
          filterPositive={false}
          positiveOnly={false}
          skipAmount={true}
          defaultAmount={0}
          maxAmount={9999}
          onClose={() => setShowCatPicker(false)}
          onPick={(catId) => {
            const est = autoEstimate(catId);
            setSelCats(s => {
              if (s.findIndex(x => x.catId === catId) >= 0) return s;
              return [...s, { catId, amount: est }];
            });
            setShowCatPicker(false);
          }}
        />
      )}
    </div>
  );
}
