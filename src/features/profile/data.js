import { computeUserDataKey, getUserId } from '../../shared/utils/user.js';
import { getDefaultAccounts, getDefaultTxs } from '../accounts/data.js';
// Schema version — bump when per-user data defaults change
export const SCHEMA_VERSION = '5';

export function computeProfileKey(method, email) {
  if (method === 'google') return 'munni_profiles_google';
  if (method === 'apple') return 'munni_profiles_apple';
  if (method === 'bank') return 'munni_profiles_bank';
  if (email && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(email))
    return `munni_profiles_${email}`;
  return 'munni_profiles';
}

// Returns the localized name for the default profile when a user signs up with email.
// The name is determined once at signup and stored in the profile — it never changes after that.
export function getDefaultProfileName(lang) {
  const names = { nl: 'Standaard', tr: 'Varsayılan', en: 'Default' };
  return names[lang] || 'Default';
}

export function getDefaultProfiles(method, lang = 'en') {
  const creatorId = getUserId();
  if (method === 'google') return [{ id:'p_google', name:'Private', icon:'user', active:true, accountIds:['main','save','inv'], picture:'av3', isDemo:false, creatorId }];
  if (method === 'apple')  return [{ id:'p_apple',  name:'Family',  icon:'house',active:true, accountIds:['abn_main'],           picture:'av4', isDemo:false, creatorId }];
  if (method === 'bank')   return [{ id:'p_demo',   name:'Demo',    icon:'user', active:true, accountIds:['demo_main','demo_save'], picture:'av7', isDemo:true,  creatorId }];
  return [{ id:'p_email', name:getDefaultProfileName(lang), icon:'user', active:true, accountIds:[], picture:'av1', isDemo:false, creatorId }];
}
export function initPerUserData(method, email, lang = 'en') {
  if (!method) return;

  // Accounts + txs: once per user (schema version gate is per-user for email)
  const vKey = computeUserDataKey(method, email, 'munni_schema_v');
  if (localStorage.getItem(vKey) !== SCHEMA_VERSION) {
    const acctKey = computeUserDataKey(method, email, 'munni_bank_accounts');
    localStorage.setItem(acctKey, JSON.stringify(getDefaultAccounts(method)));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: acctKey } }));

    const txKey = computeUserDataKey(method, email, 'munni_txs');
    localStorage.setItem(txKey, JSON.stringify(getDefaultTxs(method)));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: txKey } }));

    localStorage.setItem(vKey, SCHEMA_VERSION);
  }

  // Profiles: once per user (profile key). Uses signup lang so each new
  // user gets the localised default name; never overwrites existing data.
  const profileKey = computeProfileKey(method, email || '');
  if (!localStorage.getItem(profileKey)) {
    localStorage.setItem(profileKey, JSON.stringify(getDefaultProfiles(method, lang)));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: profileKey } }));
  }
}