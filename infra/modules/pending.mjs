// What runs versus what is configured. The wizard's "changes waiting to be
// applied" strip is computed from these, never from a flag the page
// remembers: on the NAS the applied config is the commit the last successful
// Bootstrap / Deploy run checked out, on this computer it is the config the
// stack was last started with. Both sides are the same normalized shape
// (saveEnv / loadPlatform write and read it), so a difference is a real one.

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
