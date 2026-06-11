export function getUserSyncKey() {
  const m = sessionStorage.getItem('munni_last_login_method') || 'default';
  return `munni_last_synced_${m}`;
}

function getUserAccountsKey() {
  const m = sessionStorage.getItem('munni_last_login_method') || 'default';
  return `munni_bank_accounts_${m}`;
}

export function getUserId() {
  const m = sessionStorage.getItem('munni_last_login_method') || '';
  if (m === 'google') return 'ggl-0001';
  if (m === 'apple') return 'apl-0001';
  if (m === 'bank') return 'dmo-0001';
  if (m === 'offline') {
    try {
      const pid = JSON.parse(sessionStorage.getItem('munni_profile_email') || '""') || '';
      if (pid) return pid;
    } catch {}
    return 'off-0000';
  }
  // Email user: generate/retrieve random ID
  try {
    const email = JSON.parse(sessionStorage.getItem('munni_profile_email') || '""') || '';
    if (email && !['google@munni.app','apple@munni.app','bank@munni.app',''].includes(email)) {
      const regKey = 'munni_user_ids';
      const reg = JSON.parse(localStorage.getItem(regKey) || '{}');
      if (!reg[email]) {
        reg[email] = Array.from({ length: 8 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
        localStorage.setItem(regKey, JSON.stringify(reg));
      }
      return reg[email];
    }
  } catch {}
  return 'usr-0000';
}

export function registerUserInGlobalRegistry(userId, displayName, picture) {
  try {
    const reg = JSON.parse(localStorage.getItem('munni_global_users') || '{}');
    const prev = reg[userId] || {};
    reg[userId] = { ...prev, displayName: displayName || userId, updatedAt: Date.now(), ...(picture !== undefined ? { picture } : {}) };
    localStorage.setItem('munni_global_users', JSON.stringify(reg));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: 'munni_global_users' } }));
  } catch {}
}

export function addDevLog(level, msg, src) {
  const KEY = 'munni_dev_logs';
  try {
    const existing = JSON.parse(localStorage.getItem(KEY) || 'null');
    const arr = Array.isArray(existing) ? existing : [];
    const now = new Date();
    const ts = `Today ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const log = { id: `log_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, level, msg, src: src || 'app', ts };
    const updated = [log, ...arr].slice(0, 200);
    localStorage.setItem(KEY, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: KEY } }));
    if (level === 'error' || level === 'warn') {
      const unreadKey = 'munni_notif_unread';
      const cur = parseInt(localStorage.getItem(unreadKey) || '0', 10) || 0;
      localStorage.setItem(unreadKey, JSON.stringify(cur + 1));
      window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: unreadKey } }));
    }
  } catch {}
}

export function computeUserDataKey(method, email, base) {
  if ((method === 'email' || method === 'offline') && email) {
    const safe = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
    return `${base}_${method}_${safe}`;
  }
  return `${base}_${method || 'default'}`;
}

export function formatCreatorLabel(creatorId, storedDisplayName, userRegistry) {
  if (!creatorId) return storedDisplayName || '';
  const entry = userRegistry?.[creatorId];
  if (entry?.deleted) return 'Unknown (deleted)';
  const liveName = entry?.displayName || storedDisplayName || creatorId;
  return `${liveName} (${creatorId})`;
}
