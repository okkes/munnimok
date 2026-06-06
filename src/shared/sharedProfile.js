const SD_KEY = (profileId) => `munni_shared_data_${profileId}`;

export function readSharedData(profileId) {
  try { return JSON.parse(localStorage.getItem(SD_KEY(profileId)) || '{}'); } catch { return {}; }
}

function writeSharedData(profileId, updater) {
  try {
    const key = SD_KEY(profileId);
    const sd = readSharedData(profileId);
    localStorage.setItem(key, JSON.stringify(updater(sd)));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key } }));
  } catch {}
}

export function applyPermChange(profileId, memberId, perm, acctIdsToRemove = new Set()) {
  writeSharedData(profileId, sd => ({
    ...sd,
    memberPerms: { ...(sd.memberPerms || {}), [memberId]: perm },
    accounts: acctIdsToRemove.size > 0 ? (sd.accounts || []).filter(a => !acctIdsToRemove.has(a.id)) : (sd.accounts || []),
    txs: acctIdsToRemove.size > 0 ? (sd.txs || []).filter(tx => !acctIdsToRemove.has(tx.account)) : (sd.txs || []),
  }));
}

export function kickMember(profileId, memberId) {
  writeSharedData(profileId, sd => {
    const kickedIds = new Set((sd.accounts || []).filter(a => a.attachedBy === memberId).map(a => a.id));
    return {
      ...sd,
      accounts: (sd.accounts || []).filter(a => a.attachedBy !== memberId),
      txs: (sd.txs || []).filter(t => !kickedIds.has(t.account)),
      expelled: { ...(sd.expelled || {}), [memberId]: Date.now() },
    };
  });
}

export function buildEffectivePerm(sharedData, userId, membershipPerm, isOwner = false) {
  if (isOwner) return 'owner';
  return sharedData?.memberPerms?.[userId] || membershipPerm || 'contributor';
}

export function getMemberAccounts(sharedData, memberId) {
  return (sharedData?.accounts || []).filter(a => a.attachedBy === memberId);
}
