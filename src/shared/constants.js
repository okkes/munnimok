import { M } from '../app/theme.jsx';

export const DEFAULT_API_URL = 'apollousa.okkes.synology.me:443';
export const DEMO_API_URL    = 'apollousa-demo.okkes.synology.me:443';

export const PROFILE_NAME_MAX = 30;
export const PROFILE_NAME_RE  = /^[\p{L}0-9 '.\-]{1,30}$/u;

export const STORAGE_KEYS = {
  lang:              'munni_lang',
  langTab:           'munni_lang_tab',
  profileEmail:      'munni_profile_email',
  globalUsers:       'munni_global_users',
  globalInvitations: 'munni_global_invitations',
  globalFriendships: 'munni_global_friendships',
  globalBlocks:      'munni_global_blocks',
  resetSignal:       'munni_reset_signal',
  sharedData:        (profileId) => `munni_shared_data_${profileId}`,
};

// av1-av8: authoritative from Profile.jsx picker; av9-av10: extra user avatars from App.jsx
export const STOCK_AVATARS = [
  { id:'av1',  emoji:'🧑',    bg:'#FF6B6B' },
  { id:'av2',  emoji:'👩',    bg:'#4ECDC4' },
  { id:'av3',  emoji:'👨',    bg:'#45B7D1' },
  { id:'av4',  emoji:'🧔',    bg:'#96CEB4' },
  { id:'av5',  emoji:'👱',    bg:'#FFEAA7' },
  { id:'av6',  emoji:'🧕',    bg:'#DDA0DD' },
  { id:'av7',  emoji:'🧑‍💼', bg:'#98D8C8' },
  { id:'av8',  emoji:'👨‍🎨', bg:'#F7DC6F' },
  { id:'av9',  emoji:'🧙',    bg:'#50C878' },
  { id:'av10', emoji:'🐱',    bg:'#FF9AA2' },
];

export const PERM_LEVELS = ['reader', 'contributor', 'owner'];

export const PERM_COLOR = { reader: M.ink3, contributor: M.sage,     owner: M.ochre     };
export const PERM_BG    = { reader: M.paper2, contributor: M.sageSoft, owner: M.ochreSoft };

// Use instead of static PERM_LABEL object so i18n works correctly
export const permLabel = (perm, t) =>
  t(`profile.perm${perm.charAt(0).toUpperCase()}${perm.slice(1)}`);
