// What runs versus what is configured. The wizard's "changes waiting to be
// applied" strip is computed from these, never from a flag the page
// remembers: on the NAS the applied config is the commit the last successful
// Bootstrap / Deploy run checked out, on this computer it is the config the
// stack was last started with. Both sides are the same normalized shape
// (saveEnv / loadPlatform write and read it), so a difference is a real one.

import { MANIFEST } from './secrets.mjs';

/** the keys the render alone carries — Deploy republishes them; anything else mints or registers something first (Bootstrap) */
export const DEPLOY_ONLY = new Set(['store.androidCertSha256', 'agents.pooled', 'agents.concurrency', 'agents.privateSlots']);
/** display names the wizard keeps for itself — no container reads them */
export const WIZARD_ONLY = new Set(['label', 'platform.label', 'platform.file']);

/** dotted paths → leaf values; arrays are leaves (compared whole) */
export function flattenConfig(value, prefix = '', into = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenConfig(v, prefix ? `${prefix}.${k}` : k, into);
    return into;
  }
  if (prefix) into[prefix] = value;
  return into;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** the leaves that differ, in path order; `before` / `after` are `{ ...env, platform }` shaped objects (or `{ platform }` for a shared stack) */
export function configChanges(before, after) {
  const a = flattenConfig(before ?? {});
  const b = flattenConfig(after ?? {});
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => !WIZARD_ONLY.has(p)).sort();
  // a leaf the applied side never had stays `undefined` (not null): the first appearance of a key is what needsFor looks for
  return paths.filter((p) => !same(a[p], b[p])).map((p) => ({ path: p, from: Object.hasOwn(a, p) ? (a[p] ?? null) : undefined, to: Object.hasOwn(b, p) ? (b[p] ?? null) : undefined }));
}

/** which run applies a set of changes on a deployed platform — a key the applied side never had (absent → a value) is new to the stack and may need something minted, so it takes the Bootstrap even when its path is deploy-only (#420: an environment's first `agents` brings its fleet code); a null that becomes a value (the fingerprint) is the plain deploy-only case */
export function needsFor(changes) {
  if (!changes.length) return null;
  return changes.every((c) => DEPLOY_ONLY.has(c.path) && c.from !== undefined && !firstPrivateSlot(c)) ? 'deploy' : 'bootstrap';
}

/** the first private slot of an environment mints its enrollment code (#420 A2): a Bootstrap, like the first agents block */
const firstPrivateSlot = (c) => c.path === 'agents.privateSlots' && !(Number(c.from) > 0) && Number(c.to) > 0;

const show = (path, v) => {
  if (v === null || v === undefined || v === '') return 'none';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : 'none';
  const text = String(v);
  if (/sha256/i.test(path)) return text.split(',').map((f) => `${f.trim().slice(0, 11)}…`).join(', ');
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
};

/** one line a person reads: `features.connectors: off → on` */
export const describeChange = ({ path, from, to }) => `${path}: ${show(path, from)} → ${show(path, to)}`;

/** the verdict for one stack from its applied and current configs */
export function pendingFrom(applied, current) {
  const changes = configChanges(applied, current);
  return { changes: changes.map(describeChange), needs: needsFor(changes) };
}

/* ── the difference the person reads BEFORE publishing (user 2026-10-09) ──
   The strip said "the config differs from what runs — Publish puts it on GitHub" without showing
   what. This is the platform document saved here against the one GitHub holds (config.mjs knows
   both: platformDocument / fetchPlatformVariable), per environment and for the platform itself,
   with every value in the open except what is named like a secret. The platform files carry no
   secret by design (secrets live in the wizard's store and on GitHub), but a key named like one,
   or a domain typed in place of its placeholder, is masked anyway — the manifest's names decide. */

/** the manifest's secret names, lower-cased, compared against a leaf's last segment (e.g. `ghcrPat` ↔ GHCR_PAT) */
const SECRET_NAMES = new Set(MANIFEST.secrets.map((s) => s.name.toLowerCase().replaceAll('_', '')));
const SECRET_WORD_RE = /(secret|password|passwd|token|privatekey|apikey|masterkey|credential)/i;

/** is this leaf's value one the diff must not show? a secret-named key, or the platform's domain typed in place of its `${PLATFORM_DOMAIN}` placeholder */
export function secretPath(path, value) {
  const leaf = String(path).split('.').at(-1) ?? '';
  if (SECRET_NAMES.has(leaf.toLowerCase().replaceAll('_', '')) || SECRET_WORD_RE.test(leaf)) return true;
  return path === 'platform.domain' && typeof value === 'string' && value !== '' && !value.startsWith('${');
}

const MASK = '(secret)';
const masked = (path, v) => (secretPath(path, v) ? MASK : (v ?? null));

/** the leaves of one config side by side: added (only here), removed (only on GitHub), changed (both, different) — secrets masked, `secret` says so */
export function leafDiff(published, local) {
  const changes = configChanges(published ?? {}, local ?? {});
  const out = { added: [], removed: [], changed: [] };
  for (const c of changes) {
    const secret = secretPath(c.path, c.from) || secretPath(c.path, c.to);
    if (c.from === undefined) out.added.push({ key: c.path, to: masked(c.path, c.to), secret });
    else if (c.to === undefined) out.removed.push({ key: c.path, from: masked(c.path, c.from), secret });
    else out.changed.push({ key: c.path, from: masked(c.path, c.from), to: masked(c.path, c.to), secret });
  }
  return out;
}

const emptyDiff = (d) => !d.added.length && !d.removed.length && !d.changed.length;

/**
 * The platform document saved here (`local`) against the one GitHub holds (`published`, null when
 * nothing was published yet), as the strip's "What changed?" table reads it: one entry for the
 * platform's own keys (id `shared`, keys `platform.<key>`, the shared stack's) and one per environment
 * (its own keys; the platform's are the shared entry's). `state`: new (not on GitHub yet), removed
 * (GitHub still lists it), changed, same.
 */
export function documentDiff(published, local, platform) {
  const envs = [];
  const shared = leafDiff({ platform: published?.platform ?? {} }, { platform: local?.platform ?? {} });
  envs.push({ id: 'shared', stack: `munni-${platform}-shared`, state: published?.platform ? (emptyDiff(shared) ? 'same' : 'changed') : 'new', ...shared });
  const names = [...new Set([...Object.keys(published?.envs ?? {}), ...Object.keys(local?.envs ?? {})])].sort();
  for (const name of names) {
    const before = published?.envs?.[name];
    const after = local?.envs?.[name];
    const d = leafDiff(before ?? {}, after ?? {});
    const state = !before ? 'new' : (!after ? 'removed' : (emptyDiff(d) ? 'same' : 'changed'));
    envs.push({ id: name, stack: `munni-${platform}-${name}`, state, ...d });
  }
  return { platform, published: Boolean(published), publishedAt: published?.publishedAt ?? null, envs };
}
