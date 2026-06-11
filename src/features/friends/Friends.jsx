import React from 'react';
import { getUserId, computeUserDataKey, registerUserInGlobalRegistry } from '../../shared/utils/user.js';
import { M, I, Divider, StatusBar, AppBar } from '../../app/theme.jsx';
import { useLang } from '../../shared/i18n.jsx';
import { useNav, Sheet } from '../../app/nav.jsx';
import { useLocalStorage, useSessionStorage } from '../../shared/hooks.jsx';
import { useProfiles } from '../../app/providers.jsx';
import { STOCK_AVATARS, PERM_LEVELS, PERM_COLOR, PERM_BG, permLabel } from '../../shared/constants.js';
import { applyPermChange, kickMember, buildEffectivePerm, getMemberAccounts } from '../../shared/sharedProfile.js';


export function UserAvatar({ info, fid, size = 36 }) {
  const pic = info?.picture;
  const av = pic?.startsWith('av') ? STOCK_AVATARS.find(a => a.id === pic) : null;
  const br = Math.round(size * 0.5);
  return (
    <div style={{ width:size, height:size, borderRadius:br, background: av ? av.bg : M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, overflow:'hidden' }}>
      {pic?.startsWith('data:')
        ? <img src={pic} style={{ width:size, height:size, objectFit:'cover' }}/>
        : av ? <span style={{ fontSize: Math.round(size * 0.5) }}>{av.emoji}</span>
        : <span style={{ fontSize: Math.round(size * 0.42), fontWeight:700, color:M.sage }}>{(info?.displayName || fid || '?').charAt(0).toUpperCase()}</span>
      }
    </div>
  );
}


export function ScreenFriends() {
  const nav = useNav();
  const { t } = useLang();
  const myId = React.useMemo(() => getUserId(), []);
  const [_loginMethod] = useSessionStorage('munni_last_login_method', '');
  const [_rawEmail] = useSessionStorage('munni_profile_email', '');
  const _safeEmail = React.useMemo(() => { try { return JSON.parse(_rawEmail||'""')||''; } catch { return _rawEmail||''; } }, [_rawEmail]);
  const _nameKey = computeUserDataKey(_loginMethod, _safeEmail, 'munni_profile_name');
  const [myName] = useLocalStorage(_nameKey, myId);
  const _pictureKey = computeUserDataKey(_loginMethod, _safeEmail, 'munni_user_picture');
  const [myPicture] = useLocalStorage(_pictureKey, null);
  const { profiles, setProfiles } = useProfiles();
  const [inviteInput, setInviteInput] = React.useState('');
  const [inviteError, setInviteError] = React.useState('');
  const [inviteSent, setInviteSent] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [invitations, setInvitations] = useLocalStorage('munni_global_invitations', []);
  const [friendships, setFriendships] = useLocalStorage('munni_global_friendships', []);
  const [userRegistry] = useLocalStorage('munni_global_users', {});
  const [blocks, setBlocks] = useLocalStorage('munni_global_blocks', {});
  const [friendSheet, setFriendSheet] = React.useState(null);
  const [showBlocked, setShowBlocked] = React.useState(false);

  React.useEffect(() => { registerUserInGlobalRegistry(myId, myName, myPicture); }, [myId, myName, myPicture]);

  const myBlocks = blocks[myId] || [];
  const myBlockedIds = new Set(myBlocks.map(b => b.userId));
  const myFriendships = friendships.filter(f => f.users.includes(myId));
  const myFriendIds = myFriendships.map(f => f.users.find(u => u !== myId)).filter(fid => !myBlockedIds.has(fid));
  const sentInvites = invitations.filter(i => i.fromId === myId && i.type === 'friend' && i.status === 'pending');
  const receivedInvites = invitations.filter(i => i.toId === myId && i.type === 'friend' && i.status === 'pending' && !myBlockedIds.has(i.fromId));

  const sendInvite = () => {
    const toId = inviteInput.trim().toLowerCase();
    if (!toId) return;
    if (toId === myId) { setInviteError(t('friends.inviteSelf')); return; }
    if (myFriendIds.includes(toId)) { setInviteError(t('friends.alreadyFriends')); return; }
    if (sentInvites.some(i => i.toId === toId)) { setInviteError(t('friends.sent')); return; }
    const isBlockedByRecipient = (blocks[toId] || []).some(b => b.userId === myId);
    if (!isBlockedByRecipient) {
      const theirPendingInvite = invitations.find(i => i.fromId === toId && i.toId === myId && i.type === 'friend' && i.status === 'pending');
      if (theirPendingInvite) {
        setInvitations(arr => arr.map(i => i.id === theirPendingInvite.id ? { ...i, status: 'accepted' } : i));
        setFriendships(arr => {
          if (arr.some(f => f.users.includes(myId) && f.users.includes(toId))) return arr;
          return [...arr, { id:`fr_${Date.now()}`, users:[myId, toId], since:Date.now() }];
        });
        setInviteInput(''); setInviteError(''); setInviteSent(true);
        setTimeout(() => setInviteSent(false), 2500);
        return;
      }
    }
    const inv = { id:`inv_${Date.now()}`, fromId:myId, fromName:myName, toId, type:'friend', status:'pending', sentAt:Date.now() };
    setInvitations(arr => [...arr, inv]);
    setInviteInput(''); setInviteError(''); setInviteSent(true);
    setTimeout(() => setInviteSent(false), 2500);
  };

  const cancelInvite = (invId) => setInvitations(arr => arr.filter(i => i.id !== invId));

  const [declineInvSheet, setDeclineInvSheet] = React.useState(null);

  const acceptFriendInvite = (inv) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: 'accepted' } : i));
    setFriendships(list => {
      if (list.some(f => f.users.includes(inv.fromId) && f.users.includes(myId))) return list;
      return [...list, { id: `fr_${Date.now()}`, users: [inv.fromId, myId], since: Date.now() }];
    });
  };

  const justDeclineFriendInvite = (inv) => {
    setInvitations(list => list.map(i => i.id === inv.id ? { ...i, status: 'declined' } : i));
    setDeclineInvSheet(null);
  };

  const declineAndBlockFriendInvite = (inv) => {
    setInvitations(list => list.filter(i => i.id !== inv.id));
    const senderInfo = userRegistry[inv.fromId] || {};
    setBlocks(prev => {
      const existing = prev[myId] || [];
      if (existing.some(b => b.userId === inv.fromId)) return prev;
      return { ...prev, [myId]: [...existing, { userId: inv.fromId, displayName: senderInfo.displayName || inv.fromId, picture: senderInfo.picture || null, blockedAt: Date.now() }] };
    });
    setDeclineInvSheet(null);
  };

  const cleanupSharedProfilesForFriend = (friendId) => {
    setProfiles(ps => {
      const updated = ps.map(p => {
        if (!p.isShared && (p.members || []).some(m => m.userId === friendId)) {
          try {
            const sdKey = `munni_shared_data_${p.id}`;
            const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
            const kickedAcctIds = new Set((sd.accounts || []).filter(a => a.attachedBy === friendId).map(a => a.id));
            localStorage.setItem(sdKey, JSON.stringify({
              ...sd,
              accounts: (sd.accounts || []).filter(a => a.attachedBy !== friendId),
              txs: (sd.txs || []).filter(t => !kickedAcctIds.has(t.account)),
              expelled: { ...(sd.expelled || {}), [friendId]: Date.now() },
            }));
            window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
          } catch {}
          return { ...p, members: (p.members || []).filter(m => m.userId !== friendId) };
        }
        return p;
      });
      const toLeave = updated.filter(p => p.isShared && p.ownerId === friendId);
      toLeave.forEach(p => {
        try {
          const sdKey = `munni_shared_data_${p.id}`;
          const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
          const myAcctIds = new Set((sd.accounts || []).filter(a => a.attachedBy === myId).map(a => a.id));
          localStorage.setItem(sdKey, JSON.stringify({
            ...sd,
            accounts: (sd.accounts || []).filter(a => a.attachedBy !== myId),
            txs: (sd.txs || []).filter(t => !myAcctIds.has(t.account)),
            left: { ...(sd.left || {}), [myId]: Date.now() },
          }));
          window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
        } catch {}
      });
      const remaining = updated.filter(p => !(p.isShared && p.ownerId === friendId));
      if (!remaining.find(p => p.active) && remaining.length > 0) remaining[0] = { ...remaining[0], active: true };
      return remaining;
    });
  };

  const removeFriend = (friendId) => {
    cleanupSharedProfilesForFriend(friendId);
    setFriendships(arr => arr.filter(f => !(f.users.includes(myId) && f.users.includes(friendId))));
    setInvitations(arr => arr.filter(i => !((i.fromId===myId&&i.toId===friendId)||(i.fromId===friendId&&i.toId===myId))));
  };

  const blockUser = (targetId, info) => {
    cleanupSharedProfilesForFriend(targetId);
    setFriendships(arr => arr.filter(f => !(f.users.includes(myId) && f.users.includes(targetId))));
    setInvitations(arr => arr.filter(i => !((i.fromId===myId&&i.toId===targetId)||(i.fromId===targetId&&i.toId===myId))));
    setBlocks(prev => {
      const existing = prev[myId] || [];
      if (existing.some(b => b.userId === targetId)) return prev;
      return { ...prev, [myId]: [...existing, { userId: targetId, displayName: info?.displayName || targetId, picture: info?.picture || null, blockedAt: Date.now() }] };
    });
    setFriendSheet(null);
  };

  const unblockUser = (targetId) => {
    setBlocks(prev => ({ ...prev, [myId]: (prev[myId] || []).filter(b => b.userId !== targetId) }));
    const theirPendingInvite = invitations.find(i =>
      i.fromId === targetId && i.toId === myId && i.type === 'friend' && i.status === 'pending'
    );
    if (theirPendingInvite) {
      setInvitations(list => list.map(i => i.id === theirPendingInvite.id ? { ...i, status: 'accepted' } : i));
      setFriendships(list => {
        if (list.some(f => f.users.includes(myId) && f.users.includes(targetId))) return list;
        return [...list, { id: `fr_${Date.now()}`, users: [myId, targetId], since: Date.now() }];
      });
    } else {
      const alreadySent = invitations.some(i => i.fromId === myId && i.toId === targetId && i.type === 'friend' && i.status === 'pending');
      if (!alreadySent && !myFriendIds.includes(targetId)) {
        setInvitations(list => [...list, { id: `inv_${Date.now()}`, fromId: myId, fromName: myName, toId: targetId, type: 'friend', status: 'pending', sentAt: Date.now() }]);
      }
    }
  };

  const copyId = () => { navigator.clipboard?.writeText(myId).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),1800); };

  return (
    <div className="m-screen">
      <StatusBar/>
      <AppBar title={t('settings.friends')} leading={<button className="m-iconbtn m-tap" onClick={()=>nav.pop()}><I name="arrowL" size={20}/></button>}/>
      <div className="m-body-scroll">
        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('friends.myId')}</div>
        <div className="m-card" style={{ padding:'14px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          <div style={{ fontSize:11, color:M.ink4, marginBottom:6 }}>{t('friends.myIdDesc')}</div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ fontSize:20, fontWeight:800, fontFamily:M.fontMono, letterSpacing:'0.08em', color:M.ink, flex:1 }}>{myId}</div>
            <button className="m-tap" onClick={copyId} style={{ padding:'7px 14px', borderRadius:10, background:copied?M.sageSoft:M.paper2, border:`1px solid ${copied?M.sage:M.line}`, fontSize:12, fontWeight:600, color:copied?M.sage:M.ink3, cursor:'pointer', fontFamily:M.fontUI, flexShrink:0 }}>
              {copied ? t('settings.copied') : t('settings.copyId')}
            </button>
          </div>
        </div>

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('friends.invite')}</div>
        <div className="m-card" style={{ padding:'14px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
          <input value={inviteInput} onChange={e=>{setInviteInput(e.target.value);setInviteError('');}}
            placeholder={t('friends.invitePlaceholder')}
            style={{ width:'100%', padding:'11px 12px', borderRadius:10, border:`1px solid ${inviteError?M.clay:M.line}`, fontSize:13, fontFamily:M.fontMono, background:M.paper2, color:M.ink, outline:'none', boxSizing:'border-box', marginBottom:10 }}
            onKeyDown={e=>e.key==='Enter'&&sendInvite()}/>
          <button onClick={sendInvite}
            style={{ width:'100%', padding:'12px 0', borderRadius:10, background:inviteInput.trim()?M.sage:M.line, color:inviteInput.trim()?'#fff':M.ink4, border:'none', fontSize:14, fontWeight:600, cursor:inviteInput.trim()?'pointer':'default', fontFamily:M.fontUI }}>
            {t('friends.send')}
          </button>
          {inviteError && <div style={{ fontSize:12, color:M.clay, marginTop:8 }}>{inviteError}</div>}
          {inviteSent && <div style={{ fontSize:12, color:M.sage, marginTop:8, fontWeight:500 }}>{t('friends.sent')}</div>}
        </div>

        {receivedInvites.length > 0 && (
          <>
            <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('friends.friendRequests')} ({receivedInvites.length})</div>
            <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.sage}` }}>
              {receivedInvites.map((inv,i)=>{
                const info = userRegistry[inv.fromId] || {};
                return (
                  <React.Fragment key={inv.id}>
                    {i>0&&<Divider inset={48}/>}
                    <div style={{ padding:'13px 0' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                        <UserAvatar info={info} fid={inv.fromId} size={36}/>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:600 }}>{info.displayName || inv.fromId}</div>
                          <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono }}>{inv.fromId}</div>
                        </div>
                      </div>
                      <div style={{ display:'flex', gap:8 }}>
                        <button className="m-tap" onClick={()=>acceptFriendInvite(inv)}
                          style={{ flex:2, padding:'9px 0', borderRadius:8, background:M.sage, color:'#fff', border:'none', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                          {t('friends.accept')}
                        </button>
                        <button className="m-tap" onClick={()=>setDeclineInvSheet({ inv, senderName: info.displayName || inv.fromId })}
                          style={{ flex:1, padding:'9px 0', borderRadius:8, background:M.paper2, color:M.ink3, border:`1px solid ${M.line}`, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
                          {t('friends.decline')}
                        </button>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </>
        )}
        {sentInvites.length > 0 && (<>
          <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('friends.pending')}</div>
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
            {sentInvites.map((inv,i)=>(
              <React.Fragment key={inv.id}>
                {i>0&&<Divider inset={40}/>}
                <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 0' }}>
                  <div style={{ width:32, height:32, borderRadius:999, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:13, fontWeight:700, color:M.ochre }}>{inv.toId.charAt(0).toUpperCase()}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, fontFamily:M.fontMono }}>{inv.toId}</div>
                    <div style={{ fontSize:11, color:M.ochre }}>{t('friends.pending')}</div>
                  </div>
                  <button className="m-tap" onClick={()=>cancelInvite(inv.id)} style={{ fontSize:11, padding:'4px 10px', borderRadius:8, background:M.paper2, border:`1px solid ${M.line}`, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI }}>✕</button>
                </div>
              </React.Fragment>
            ))}
          </div>
        </>)}

        <div className="m-cap" style={{ marginBottom:8, paddingLeft:4 }}>{t('friends.friendsLabel')} ({myFriendIds.length})</div>
        {myFriendIds.length === 0 ? (
          <div style={{ textAlign:'center', color:M.ink4, fontSize:13, padding:'28px 0' }}>{t('friends.noFriends')}</div>
        ) : (
          <div className="m-card" style={{ padding:'4px 16px', marginBottom:16, border:`1px solid ${M.line}` }}>
            {myFriendIds.map((fid,i)=>{
              const info = userRegistry[fid] || {};
              return (
                <React.Fragment key={fid}>
                  {i>0&&<Divider inset={48}/>}
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                    <UserAvatar info={info} fid={fid} size={36}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:600 }}>{info.displayName||fid}</div>
                      <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono }}>{fid}</div>
                    </div>
                    <button className="m-tap" onClick={()=>setFriendSheet({ fid, info })}
                      style={{ width:32, height:32, borderRadius:999, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', flexShrink:0 }}>
                      <I name="more" size={16} color={M.ink3}/>
                    </button>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}

        <button className="m-tap" onClick={()=>setShowBlocked(v=>!v)}
          style={{ display:'flex', alignItems:'center', gap:8, width:'100%', background:'none', border:'none', cursor:'pointer', padding:'4px 4px 8px', marginBottom:4 }}>
          <span style={{ fontSize:11, fontWeight:700, color:M.ink3, textTransform:'uppercase', letterSpacing:'0.06em', flex:1, textAlign:'left' }}>{t('friends.blockedUsers')}{myBlocks.length > 0 ? ` (${myBlocks.length})` : ''}</span>
          <I name={showBlocked?'caretD':'caretR'} size={12} color={M.ink4}/>
        </button>
        {showBlocked && (
          myBlocks.length === 0
            ? <div style={{ textAlign:'center', color:M.ink4, fontSize:13, padding:'16px 0 24px' }}>{t('friends.noBlocked')}</div>
            : <div className="m-card" style={{ padding:'4px 16px', marginBottom:24, border:`1px solid ${M.line}` }}>
                {myBlocks.map((b,i)=>(
                  <React.Fragment key={b.userId}>
                    {i>0&&<Divider inset={48}/>}
                    <div style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 0' }}>
                      <UserAvatar info={b} fid={b.userId} size={36}/>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:14, fontWeight:600, color:M.ink3 }}>{b.displayName||b.userId}</div>
                        <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono }}>{b.userId}</div>
                      </div>
                      <button className="m-tap" onClick={()=>unblockUser(b.userId)}
                        style={{ fontSize:11, padding:'5px 11px', borderRadius:8, background:M.paper2, border:`1px solid ${M.line}`, color:M.ink3, cursor:'pointer', fontFamily:M.fontUI, fontWeight:600 }}>
                        {t('friends.unblock')}
                      </button>
                    </div>
                  </React.Fragment>
                ))}
              </div>
        )}
      </div>

      {friendSheet && (
        <Sheet onClose={()=>setFriendSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0 16px' }}>
              <UserAvatar info={friendSheet.info} fid={friendSheet.fid} size={44}/>
              <div>
                <div style={{ fontSize:16, fontWeight:700 }}>{friendSheet.info?.displayName || friendSheet.fid}</div>
                <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono }}>{friendSheet.fid}</div>
              </div>
            </div>
            <button className="m-tap" onClick={()=>{ removeFriend(friendSheet.fid); setFriendSheet(null); }}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="user" size={16} color={M.ink3}/>
              </div>
              <span style={{ fontSize:15, fontWeight:500, color:M.ink, fontFamily:M.fontUI }}>{t('friends.removeFriend')}</span>
            </button>
            <button className="m-tap" onClick={()=>blockUser(friendSheet.fid, friendSheet.info)}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:'#FFF0F0', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="ban" size={16} color={M.clay}/>
              </div>
              <div style={{ flex:1, textAlign:'left' }}>
                <div style={{ fontSize:15, fontWeight:500, color:M.clay, fontFamily:M.fontUI }}>{t('friends.blockAction')}</div>
                <div style={{ fontSize:11, color:M.ink4 }}>{friendSheet.info?.displayName || friendSheet.fid}</div>
              </div>
            </button>
            <div style={{ height:8 }}/>
          </div>
        </Sheet>
      )}

      {declineInvSheet && (
        <Sheet onClose={() => setDeclineInvSheet(null)}>
          <div style={{ padding:'4px 16px 8px' }}>
            <div style={{ fontSize:15, fontWeight:700, padding:'12px 0 4px' }}>{declineInvSheet.senderName}</div>
            <div style={{ fontSize:12, color:M.ink4, marginBottom:16 }}>{t('friends.inviteNotif')} {declineInvSheet.senderName}</div>
            <button className="m-tap" onClick={() => justDeclineFriendInvite(declineInvSheet.inv)}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="x" size={16} color={M.ink3}/>
              </div>
              <span style={{ fontSize:15, fontWeight:500, color:M.ink, fontFamily:M.fontUI }}>{t('friends.justDecline')}</span>
            </button>
            <button className="m-tap" onClick={() => declineAndBlockFriendInvite(declineInvSheet.inv)}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:14, padding:'14px 0', background:'none', border:'none', cursor:'pointer', borderTop:`1px solid ${M.line2}` }}>
              <div style={{ width:36, height:36, borderRadius:10, background:'#FFF0F0', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <I name="ban" size={16} color={M.clay}/>
              </div>
              <div style={{ flex:1, textAlign:'left' }}>
                <div style={{ fontSize:15, fontWeight:500, color:M.clay, fontFamily:M.fontUI }}>{t('friends.declineAndBlock')}</div>
                <div style={{ fontSize:11, color:M.ink4 }}>{declineInvSheet.senderName}</div>
              </div>
            </button>
            <div style={{ height:8 }}/>
          </div>
        </Sheet>
      )}
    </div>
  );
}


export function ProfileMembersSheet({ profile, onClose }) {
  const { t } = useLang();
  const nav = useNav();
  const myId = React.useMemo(() => getUserId(), []);
  const [friendships] = useLocalStorage('munni_global_friendships', []);
  const [invitations, setInvitations] = useLocalStorage('munni_global_invitations', []);
  const [userRegistry] = useLocalStorage('munni_global_users', {});
  const [sharedData] = useLocalStorage(`munni_shared_data_${profile.id}`, { accounts: [], txs: [] });

  const myFriendIds = friendships.filter(f=>f.users&&f.users.includes(myId)).map(f=>f.users.find(u=>u!==myId));
  const members = profile.members || [];
  const pendingMemberInvites = invitations.filter(i=>i.fromId===myId&&i.type==='profile'&&i.profileId===profile.id&&i.status==='pending');
  const uninvitedFriends = myFriendIds.filter(fid => !members.some(m=>m.userId===fid) && !pendingMemberInvites.some(i=>i.toId===fid));

  const inviteFriend = (friendId) => {
    const inv = {
      id:`inv_${Date.now()}`, fromId:myId, toId:friendId, type:'profile',
      profileId:profile.id, profileName:profile.name, profileIcon:profile.icon,
      profilePicture:profile.picture, profileIsDemo:profile.isDemo || false,
      profileAccountIds:profile.accountIds || [],
      originalOwnerId: profile.creatorId || profile.ownerId || myId,
      originalCreatorId: profile.creatorId || profile.ownerId || myId,
      permission:'contributor', status:'pending', sentAt:Date.now(),
    };
    setInvitations(arr=>[...arr, inv]);
    try {
      const sdKey = `munni_shared_data_${profile.id}`;
      const sd = JSON.parse(localStorage.getItem(sdKey) || '{}');
      if (sd.left?.[friendId] || sd.expelled?.[friendId]) {
        const { [friendId]: _l, ...remainingLeft } = sd.left || {};
        const { [friendId]: _e, ...remainingExpelled } = sd.expelled || {};
        localStorage.setItem(sdKey, JSON.stringify({ ...sd, left: remainingLeft, expelled: remainingExpelled }));
        window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: sdKey } }));
      }
    } catch {}
  };

  return (
    <Sheet onClose={onClose}>
      <div style={{ padding:'4px 16px 0' }}>
        <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{t('space.addMember')}</div>
        <div style={{ fontSize:13, color:M.ink3, marginBottom:14 }}>{t('space.members')}</div>
      </div>
      <div style={{ padding:'0 16px', maxHeight:'60vh', overflowY:'auto' }}>
        {profile.isDemo ? (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 0', color:M.ink4, fontSize:13 }}>
            <I name="lock" size={15} color={M.ink4}/>{t('space.demoNoInvite')}
          </div>
        ) : (
          <>
            {pendingMemberInvites.length > 0 && (
              <>
                <div className="m-cap" style={{ marginBottom:8, marginTop:4 }}>{t('friends.pending')}</div>
                {pendingMemberInvites.map(inv => {
                  const info = userRegistry[inv.toId] || {};
                  return (
                    <div key={inv.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0', borderBottom:`1px solid ${M.line2}` }}>
                      <div style={{ width:36, height:36, borderRadius:999, background:M.ochreSoft, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:14, fontWeight:700, color:M.ochre }}>
                        {(info.displayName||inv.toId).charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.displayName||inv.toId}</div>
                        <div style={{ fontSize:11, color:M.ochre, fontWeight:500 }}>{t('friends.pending')}</div>
                      </div>
                      <button className="m-tap" onClick={() => setInvitations(arr => arr.filter(i => i.id !== inv.id))}
                        style={{ width:28, height:28, borderRadius:999, background:M.paper2, border:`1px solid ${M.line}`, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', flexShrink:0 }}>
                        <I name="x" size={13} color={M.ink3}/>
                      </button>
                    </div>
                  );
                })}
                <div style={{ height:8 }}/>
              </>
            )}
            {uninvitedFriends.length > 0 && (
              <>
                <div className="m-cap" style={{ marginBottom:8, marginTop: pendingMemberInvites.length > 0 ? 8 : 4 }}>{t('friends.friendsLabel')}</div>
                {uninvitedFriends.map(fid => {
                  const info = userRegistry[fid] || {};
                  return (
                    <div key={fid} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0', borderBottom:`1px solid ${M.line2}` }}>
                      <div style={{ width:36, height:36, borderRadius:999, background:M.sageSoft, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color:M.sage, flexShrink:0 }}>
                        {(info.displayName||fid).charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.displayName||fid}</div>
                        <div style={{ fontSize:10, color:M.ink4, fontFamily:M.fontMono, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{fid}</div>
                      </div>
                      <button className="m-tap" onClick={() => inviteFriend(fid)}
                        style={{ padding:'7px 16px', borderRadius:999, background:M.sage, color:'#fff', border:'none', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, flexShrink:0 }}>
                        + {t('space.invite')}
                      </button>
                    </div>
                  );
                })}
              </>
            )}
            {uninvitedFriends.length === 0 && pendingMemberInvites.length === 0 && (
              <div style={{ fontSize:13, color:M.ink4, padding:'12px 0 4px', lineHeight:1.6, textAlign:'center' }}>
                {t('friends.noFriendsToInvite')}
              </div>
            )}
          </>
        )}
        <div style={{ marginTop:20, paddingTop:14, borderTop:`1px solid ${M.line2}`, marginBottom:8 }}>
          <button className="m-tap" onClick={() => { onClose(); nav.push('friends'); }}
            style={{ width:'100%', padding:'13px 0', borderRadius:12, background:M.paper2, border:`1px solid ${M.line}`, fontSize:14, fontWeight:600, color:M.ink2, cursor:'pointer', fontFamily:M.fontUI, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {t('space.manageFriends')}
            <I name="caretR" size={14} color={M.ink3}/>
          </button>
        </div>
      </div>
    </Sheet>
  );
}


export function MemberActionSheet({ profile, memberId, onClose }) {
  const { t } = useLang();
  const { setProfiles } = useProfiles();
  const [userRegistry] = useLocalStorage('munni_global_users', {});
  const [sharedData] = useLocalStorage(`munni_shared_data_${profile.id}`, { accounts: [], txs: [] });
  const [kickConfirm, setKickConfirm] = React.useState(false);
  const [pendingPerm, setPendingPerm] = React.useState(null);
  const [removeAccts, setRemoveAccts] = React.useState(new Set());

  const members = profile.members || [];
  const member = members.find(m => m.userId === memberId);
  const info = userRegistry[memberId] || {};
  const currentPerm = sharedData?.memberPerms?.[memberId] || member?.permission || 'contributor';

  const PERM_DESC = { reader:'View transactions, budgets, goals', contributor:'Also add & edit data', owner:'Full access + manage members' };

  const updateProfile = (updater) => setProfiles(ps => ps.map(p => p.id===profile.id ? updater(p) : p));

  const applyPerm = (perm, acctIdsToRemove = new Set()) => {
    updateProfile(p => ({ ...p, members: (p.members||[]).map(m => m.userId===memberId ? {...m, permission:perm} : m) }));
    applyPermChange(profile.id, memberId, perm, acctIdsToRemove);
  };

  const changePerm = (perm) => {
    const isDowngrade = perm === 'reader' && currentPerm !== 'reader';
    const memberAccts = getMemberAccounts(sharedData, memberId);
    if (isDowngrade && memberAccts.length > 0) {
      setRemoveAccts(new Set());
      setPendingPerm(perm);
      return;
    }
    applyPerm(perm);
  };

  const doKick = () => {
    updateProfile(p => ({ ...p, members: (p.members||[]).filter(m => m.userId !== memberId) }));
    kickMember(profile.id, memberId);
    onClose();
  };

  if (pendingPerm) {
    const memberAccts = getMemberAccounts(sharedData, memberId);
    return (
      <Sheet onClose={() => setPendingPerm(null)}>
        <div style={{ padding:'4px 16px 20px' }}>
          <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>{t('space.downgradeTitle')}</div>
          <div style={{ fontSize:14, color:M.ink3, marginBottom:16, lineHeight:1.5 }}>
            {t('space.downgradeDesc').replace('{name}', info.displayName||memberId)}
          </div>
          <div style={{ background:M.paper2, borderRadius:12, marginBottom:16 }}>
            {memberAccts.map((a, i) => {
              const selected = removeAccts.has(a.id);
              return (
                <React.Fragment key={a.id}>
                  {i > 0 && <div style={{ height:1, background:M.line, marginLeft:60 }}/>}
                  <div className="m-tap" onClick={() => setRemoveAccts(prev => {
                    const next = new Set(prev);
                    if (next.has(a.id)) next.delete(a.id); else next.add(a.id);
                    return next;
                  })} style={{ display:'flex', alignItems:'center', gap:12, padding:'13px 12px', cursor:'pointer' }}>
                    <div style={{ width:36, height:36, borderRadius:10, background: a.color || M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                      <I name={a.type==='savings'?'piggy':a.type==='invest'?'rocket':'card'} size={16} color="#fff"/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14, fontWeight:500 }}>{a.name}</div>
                      <div style={{ fontSize:11, color:M.ink3, fontFamily:M.fontMono }}>{a.iban}</div>
                    </div>
                    <div style={{ width:22, height:22, borderRadius:6, border:`2px solid ${selected ? M.clay : M.line}`, background: selected ? M.clay : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all .15s' }}>
                      {selected && <I name="check" size={12} color="#fff"/>}
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
          <button onClick={() => { applyPerm(pendingPerm, removeAccts); setPendingPerm(null); onClose(); }}
            style={{ width:'100%', padding:'14px 0', background:M.sage, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
            {t('space.downgradeConfirm')}
          </button>
        </div>
      </Sheet>
    );
  }

  if (kickConfirm) {
    return (
      <Sheet onClose={() => setKickConfirm(false)}>
        <div style={{ padding:'4px 16px 8px' }}>
          <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>{t('space.kick')}?</div>
          <div style={{ fontSize:14, color:M.ink3, marginBottom:20, lineHeight:1.5 }}>{t('space.kickWarn')}</div>
          <button onClick={doKick} style={{ width:'100%', padding:'14px 0', background:M.clay, color:'#fff', border:'none', borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI, marginBottom:10 }}>{t('space.kick')}</button>
          <button onClick={() => setKickConfirm(false)} style={{ width:'100%', padding:'14px 0', background:M.paper2, color:M.ink, border:`1px solid ${M.line}`, borderRadius:12, fontSize:16, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>{t('action.cancel')}</button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose}>
      <div data-testid="member-action-sheet" style={{ padding:'4px 16px 20px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
          <div style={{ width:44, height:44, borderRadius:999, background:M.paper2, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, fontSize:17, fontWeight:700, color:M.ink2 }}>
            {(info.displayName||memberId).charAt(0).toUpperCase()}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:16, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{info.displayName||memberId}</div>
            <div style={{ fontSize:11, color:M.ink4, fontFamily:M.fontMono, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{memberId}</div>
          </div>
        </div>
        <div className="m-cap" style={{ marginBottom:10 }}>{t('space.memberPerm')}</div>
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:20 }}>
          {PERM_LEVELS.map(perm => {
            const active = currentPerm === perm;
            return (
              <button key={perm} data-testid={`member-perm-${perm}`} className="m-tap" onClick={() => changePerm(perm)}
                style={{ width:'100%', padding:'12px 14px', borderRadius:12, border:`2px solid ${active ? PERM_COLOR[perm] : M.line}`, background: active ? PERM_BG[perm] : M.paper, display:'flex', alignItems:'center', gap:12, cursor:'pointer', fontFamily:M.fontUI, textAlign:'left' }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background: active ? PERM_COLOR[perm] : M.line, flexShrink:0, marginTop:1 }}/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:700, color: active ? PERM_COLOR[perm] : M.ink2 }}>{permLabel(perm, t)}</div>
                  <div style={{ fontSize:11, color:M.ink4, marginTop:1 }}>{PERM_DESC[perm]}</div>
                </div>
                {active && <I name="check" size={15} color={PERM_COLOR[perm]}/>}
              </button>
            );
          })}
        </div>
        <button data-testid="member-kick-btn" className="m-tap" onClick={() => setKickConfirm(true)}
          style={{ width:'100%', padding:'13px 0', background:M.claySoft, color:M.clay, border:'none', borderRadius:12, fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:M.fontUI }}>
          {t('space.kick')}
        </button>
      </div>
    </Sheet>
  );
}
