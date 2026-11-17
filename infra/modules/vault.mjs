import { createCipheriv, createDecipheriv, createHmac, generateKeyPairSync, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { insecureFetch } from './insecure-fetch.mjs';

// the master password is generated and KEPT in the local secret store (readable under Reveal)
// stretched key = HKDF-EXPAND only: the master key IS the PRK, node's hkdfSync would re-extract

export const KDF_ITERATIONS = 600000;

export const masterKey = (email, password) =>
  pbkdf2Sync(password, email.trim().toLowerCase(), KDF_ITERATIONS, 32, 'sha256');

export const masterPasswordHash = (key, password) =>
  pbkdf2Sync(key, password, 1, 32, 'sha256').toString('base64');

const hkdfExpand = (prk, info) =>
  createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).digest();

export const stretchKey = (key) => ({ enc: hkdfExpand(key, 'enc'), mac: hkdfExpand(key, 'mac') });

export const splitSymKey = (bytes) => ({ enc: bytes.subarray(0, 32), mac: bytes.subarray(32, 64) });

export function encString(keys, plaintext) {
  const iv = randomBytes(16);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const cipher = createCipheriv('aes-256-cbc', keys.enc, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const mac = createHmac('sha256', keys.mac).update(Buffer.concat([iv, ct])).digest();
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
}

export function decString(keys, enc) {
  const [type, rest] = [enc.slice(0, 2), enc.slice(2)];
  if (type !== '2.') throw new Error('unexpected EncString type (only type 2 — AES-CBC + HMAC — is written here)');
  const [iv, ct, mac] = rest.split('|').map((p) => Buffer.from(p, 'base64'));
  const expect = createHmac('sha256', keys.mac).update(Buffer.concat([iv, ct])).digest();
  if (!timingSafeEqual(mac, expect)) throw new Error('mac mismatch');
  const decipher = createDecipheriv('aes-256-cbc', keys.enc, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function buildAccount(email, password) {
  const key = masterKey(email, password);
  const hash = masterPasswordHash(key, password);
  const stretched = stretchKey(key);
  const symBytes = randomBytes(64);
  const userKeys = splitSymKey(symBytes);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const register = {
    email,
    name: 'munni operator',
    masterPasswordHash: hash,
    masterPasswordHint: null,
    key: encString(stretched, symBytes),
    kdf: 0, // PBKDF2-SHA256
    kdfIterations: KDF_ITERATIONS,
    keys: {
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      encryptedPrivateKey: encString(userKeys, privateKey.export({ type: 'pkcs8', format: 'der' })),
    },
    referenceData: null,
  };
  return { hash, userKeys, register };
}

// Vaultwarden 1.37+ REQUIRES `encryptedFor` (the account's user id) on every cipher (a bare 422 otherwise)
// older servers ignore it
export const buildCipher = (userKeys, item, { encryptedFor = null } = {}) => ({
  ...(encryptedFor ? { encryptedFor } : {}),
  ...(item.kind === 'note'
    ? { type: 2, name: encString(userKeys, item.name), notes: item.notes ? encString(userKeys, item.notes) : null, favorite: false, secureNote: { type: 0 }, fields: null, folderId: null }
    : {
      type: 1,
      name: encString(userKeys, item.name),
      notes: item.notes ? encString(userKeys, item.notes) : null,
      favorite: false,
      login: {
        username: item.username ? encString(userKeys, item.username) : null,
        password: item.password ? encString(userKeys, item.password) : null,
        uris: item.uri ? [{ uri: encString(userKeys, item.uri), match: null }] : null,
      },
      fields: null,
      folderId: null,
    }),
});

/** the account's user id as the sync answer carries it — what every cipher must name as `encryptedFor` */
export const syncUserId = (sync) => sync?.profile?.id ?? sync?.Profile?.Id ?? null;

/** a refused write, named: the status and whatever message the server gave (never the item's values) */
export async function refusalText(res) {
  let text = '';
  try { text = String(await res.text()).trim(); } catch { /* no body */ }
  let message = '';
  try { const body = JSON.parse(text); message = body?.message ?? body?.Message ?? body?.errorModel?.message ?? ''; } catch { message = /<html/i.test(text) ? '' : text; }
  return message ? `${res.status} ${String(message).slice(0, 120)}` : String(res.status);
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

export async function vaultLogin(base, email, hash, fetchImpl = insecureFetch) {
  const res = await fetchImpl(`${base}/identity/connect/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // vaultwarden requires the email echoed on token requests
      'auth-email': b64url(email),
      'device-type': '9',
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: email,
      password: hash,
      scope: 'api offline_access',
      client_id: 'web',
      deviceType: '9',
      deviceIdentifier: 'munni-setup-wizard',
      deviceName: 'munni setup',
    }).toString(),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token;
}

export const vaultRegister = (base, payload, fetchImpl = insecureFetch) =>
  fetchImpl(`${base}/identity/accounts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

export const vaultPurge = (base, token, hash, fetchImpl = insecureFetch) =>
  fetchImpl(`${base}/api/ciphers/purge`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ masterPasswordHash: hash }),
  });

export const vaultImport = (base, token, payload, fetchImpl = insecureFetch) => {
  const body = Array.isArray(payload) ? { ciphers: payload, folders: [], folderRelationships: [] } : payload;
  return fetchImpl(`${base}/api/ciphers/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
};

export async function vaultSync(base, token, fetchImpl = insecureFetch) {
  const res = await fetchImpl(`${base}/api/sync?excludeDomains=true`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`vault sync ${res.status}`);
  return res.json();
}

/** an EXISTING account's user key: the profile's key, encrypted under the stretched master key */
export function userKeysOf(email, password, profileKey) {
  return splitSymKey(decString(stretchKey(masterKey(email, password)), profileKey));
}

export const vaultDeleteCipher = (base, token, id, fetchImpl = insecureFetch) =>
  fetchImpl(`${base}/api/ciphers/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });

export const vaultCreateFolder = (base, token, encName, fetchImpl = insecureFetch) =>
  fetchImpl(`${base}/api/folders`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: encName }) });

/** POST /api/ciphers — one item, filed by its folderId (the create endpoint honours it; the import endpoint does not) */
export const vaultCreateCipher = (base, token, cipher, fetchImpl = insecureFetch) =>
  fetchImpl(`${base}/api/ciphers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(cipher) });

// other folders are the operator's and stay untouched; items are encrypted with the profile's real user key,
// so a hand-made account reads them too; registering needs signups open.
// `keep` names items that live only here: a run that could not make one again leaves the old one in place
export async function vaultReplaceFolder(base, { email, password, folder, items, keep = [] }, fetchImpl = insecureFetch) {
  const account = buildAccount(email, password);
  let token = await vaultLogin(base, email, account.hash, fetchImpl);
  let registered = false;
  if (!token) {
    const reg = await vaultRegister(base, account.register, fetchImpl);
    // the platform's vault e-mail is not named here: these messages end up in console output and the wizard page
    if (!reg.ok) throw new Error(`vault: no account for the platform's vault e-mail and registration refused (${reg.status}) — signups closed (VAULT_SIGNUPS_ALLOWED) or an account with a different master password`);
    registered = true;
    token = await vaultLogin(base, email, account.hash, fetchImpl);
    if (!token) throw new Error('vault: login failed right after registration');
  }
  const sync = await vaultSync(base, token, fetchImpl);
  const profileKey = sync.profile?.key ?? sync.Profile?.Key;
  const keys = registered ? account.userKeys : userKeysOf(email, password, profileKey);
  const folders = sync.folders ?? sync.Folders ?? [];
  const nameOf = (f) => { try { return decString(keys, f.name ?? f.Name).toString('utf8'); } catch { return null; } };
  const existing = folders.find((f) => nameOf(f) === folder);
  let folderId = existing ? (existing.id ?? existing.Id) : null;
  if (!folderId) {
    // the import endpoint files ciphers only through folderRelationships of folders it creates in the SAME call
    // and ignores a cipher's folderId: so the folder first, then every item on its own, which the create endpoint honours
    const made = await vaultCreateFolder(base, token, encString(keys, folder), fetchImpl);
    if (!made.ok) throw new Error(`vault: creating folder ${folder} failed (${made.status})`);
    const body = await made.json().catch(() => ({}));
    folderId = body.id ?? body.Id ?? null;
    if (!folderId) {
      const again = await vaultSync(base, token, fetchImpl);
      const found = (again.folders ?? again.Folders ?? []).find((f) => nameOf(f) === folder);
      folderId = found ? (found.id ?? found.Id) : null;
    }
    if (!folderId) throw new Error(`vault: folder ${folder} has no id after creation`);
  }
  const names = new Set(items.map((it) => it.name));
  // NEW items go in first, old ones go only once replaced: delete-then-create wiped a folder when a create was refused
  // a refused item never throws mid-way: the rest are filed, the refusals named at the end
  const userId = syncUserId(sync);
  let imported = 0;
  const refused = [];
  for (const it of items) {
    const made = await vaultCreateCipher(base, token, { ...buildCipher(keys, it, { encryptedFor: userId }), folderId }, fetchImpl);
    if (made.ok) imported++;
    else refused.push({ name: it.name, why: await refusalText(made) });
  }
  const created = new Set(items.filter((it) => !refused.some((r) => r.name === it.name)).map((it) => it.name));
  let replaced = 0;
  let unfiled = 0;
  for (const c of (sync.ciphers ?? sync.Ciphers ?? [])) {
    const inFolder = (c.folderId ?? c.FolderId) === folderId;
    const name = nameOf(c);
    // our own strays: unfiled items with a name this folder writes — leftovers of the import path, never the operator's
    const strayOfOurs = !(c.folderId ?? c.FolderId) && names.has(name);
    if (!inFolder && !strayOfOurs) continue;
    // a whole batch accepted replaces the folder; a partial one keeps every old item whose replacement was refused
    if (refused.length && !created.has(name)) continue;
    if (inFolder && keep.includes(name) && !created.has(name)) continue;
    const del = await vaultDeleteCipher(base, token, c.id ?? c.Id, fetchImpl);
    if (del.ok) { if (inFolder) replaced++; else unfiled++; }
  }
  if (refused.length) {
    const list = refused.map((r) => `"${r.name}" (${r.why})`).join(', ');
    throw new Error(`vault: ${refused.length} of ${items.length} items refused in folder ${folder} — ${list}${imported ? `; the other ${imported} filed` : ''}`);
  }
  return { registered, folder, replaced, unfiled, imported };
}

export async function vaultReadFolder(base, { email, password, folder }, fetchImpl = insecureFetch) {
  const account = buildAccount(email, password);
  const token = await vaultLogin(base, email, account.hash, fetchImpl);
  if (!token) throw new Error('vault: the sign-in with the platform\'s vault account failed (a different master password, or no account yet)');
  const sync = await vaultSync(base, token, fetchImpl);
  const profileKey = sync.profile?.key ?? sync.Profile?.Key;
  const keys = userKeysOf(email, password, profileKey);
  const dec = (v) => { if (!v) return ''; try { return decString(keys, v).toString('utf8'); } catch { return ''; } };
  const folders = sync.folders ?? sync.Folders ?? [];
  const wanted = folders.find((f) => dec(f.name ?? f.Name) === folder);
  const wantedId = wanted ? (wanted.id ?? wanted.Id) : null;
  if (!wantedId) return [];
  return (sync.ciphers ?? sync.Ciphers ?? [])
    .filter((c) => (c.folderId ?? c.FolderId) === wantedId)
    .map((c) => {
      const login = c.login ?? c.Login ?? {};
      return { name: dec(c.name ?? c.Name), username: dec(login.username ?? login.Username), password: dec(login.password ?? login.Password), uri: dec((login.uris ?? login.Uris ?? [])[0]?.uri ?? (login.uris ?? login.Uris ?? [])[0]?.Uri), notes: dec(c.notes ?? c.Notes) };
    });
}

/** the platform values an environment may need, as the shared stack's bootstrap files them in its vault folder (item name → secret name) */
export const VAULT_PLATFORM_ITEMS = { 'GlitchTip API token': 'GLITCHTIP_API_TOKEN', GlitchTip: 'GLITCHTIP_ADMIN_PASSWORD', pgAdmin: 'PGADMIN_PASSWORD' };

export function platformValuesFromItems(items) {
  const out = {};
  for (const item of items ?? []) {
    const name = VAULT_PLATFORM_ITEMS[item.name];
    if (name && item.password) out[name] = item.password;
  }
  return out;
}

export async function vaultPlatformValues(base, creds, fetchImpl = insecureFetch) {
  return platformValuesFromItems(await vaultReadFolder(base, creds, fetchImpl));
}
