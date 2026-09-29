import { execFileSync } from 'node:child_process';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformEnvStacks } from './stack.mjs';

export const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'secrets.manifest.json'), 'utf8'),
);

const b64url = (buf) => buf.toString('base64url');

/** RFC 8292 VAPID pair: raw P-256 public point (65B) + private scalar, base64url */
export function vapidPair() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64url(pub), privateKey: jwk.d };
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function generateValue(name) {
  if (name.startsWith('PUSH_VAPID_')) throw new Error('VAPID keys are generated as a pair — handled by ensureSecrets');
  // Logto machine credentials: an application id is 21 characters (Logto's column), a secret up to 64
  if (/^LOGTO_[A-Z]+_M2M_ID$/.test(name)) return `${name.includes('ADMIN') ? 'admin' : 'infra'}${randomBytes(8).toString('hex')}`;
  if (/^LOGTO_[A-Z]+_M2M_SECRET$/.test(name)) return randomBytes(24).toString('hex');
  // GlitchTip API tokens are 40 hex characters (its own generator's shape)
  if (name === 'GLITCHTIP_API_TOKEN') return randomBytes(20).toString('hex');
  return b64url(randomBytes(32));
}

/** does the environment enable the feature a manifest entry belongs to? */
export function featureOn(stack, feature) {
  if (!feature) return true;
  const f = stack.features ?? {};
  switch (feature) {
    case 'gocardless':
    case 'enablebanking':
      return (f.banking ?? []).includes(feature);
    case 'google':
    case 'apple':
      return (f.signin ?? []).includes(feature);
    case 'email':
      return true; // optional anyway: mails or the web UI
    default:
      return Boolean(f[feature]);
  }
}

/** the manifest entries that apply to a platform at all (never the wizard's own) */
export const platformEntries = (platform) => MANIFEST.secrets.filter((s) => s.scope !== 'wizard' && (!s.platforms || s.platforms.includes(platform)));

/**
 * the entries ONE stack is responsible for: the shared stack owns the
 * platform-scoped ones (+ its own POSTGRES_PASSWORD); an environment
 * stack owns the env-scoped ones its features need (+ its own postgres)
 */
export function entriesFor(stack) {
  return platformEntries(stack.platform).filter((s) => {
    if (s.scope === 'stack') return true;
    if (s.scope === 'platform') return stack.role === 'shared';
    if (s.scope === 'env') return stack.role === 'env' && featureOn(stack, s.feature);
    return false;
  });
}

/** platform-scoped entries an ENVIRONMENT stack must also see (mirrored into its GitHub environment) — a sharedOnly value (GlitchTip's own keys, pgAdmin's login) stays with the shared stack */
export const mirroredEntries = (stack) => (stack.role === 'env' ? platformEntries(stack.platform).filter((s) => s.scope === 'platform' && !s.sharedOnly) : []);

/* ── GitHub (the nas platform) ───────────────────────────────────────── */

export function ensureEnvironment(env) {
  gh(['api', '-X', 'PUT', `repos/{owner}/{repo}/environments/${encodeURIComponent(env)}`]);
}

export function deleteEnvironment(env) {
  try {
    gh(['api', '-X', 'DELETE', `repos/{owner}/{repo}/environments/${encodeURIComponent(env)}`]);
    return true;
  } catch (e) {
    if (/404|Not Found/.test(String(e.stderr ?? e.message))) return false;
    throw e;
  }
}

export function existingEnvSecrets(env) {
  const out = gh(['api', `repos/{owner}/{repo}/environments/${encodeURIComponent(env)}/secrets`, '--paginate', '-q', '.secrets[].name']);
  return new Set(out.split(/\s+/).filter(Boolean));
}

export function existingEnvVariables(env) {
  const out = gh(['api', `repos/{owner}/{repo}/environments/${encodeURIComponent(env)}/variables?per_page=100`, '--paginate', '-q', '.variables[] | "\\(.name)=\\(.value)"']);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
}

export function setEnvSecret(env, name, value) {
  gh(['secret', 'set', name, '--env', env, '--body', value]);
}

export function setEnvVariable(env, name, value) {
  gh(['variable', 'set', name, '--env', env, '--body', value]);
}

/** every GitHub environment a platform-scoped value lives in: the shared one and every environment's */
export function platformEnvironments(stack) {
  return [...new Set([stack.sharedStack.replace(/^munni-/, '').replace(/-shared$/, '-shared'), ...platformEnvStacks(stack.platform).map((s) => s.githubEnvironment)])];
}

/** a platform-scoped write: the same value into every environment of the platform */
export function setPlatformSecret(stack, name, value) {
  for (const env of platformEnvironments(stack)) {
    ensureEnvironment(env);
    setEnvSecret(env, name, value);
  }
}

export function setPlatformVariable(stack, name, value) {
  for (const env of platformEnvironments(stack)) {
    ensureEnvironment(env);
    setEnvVariable(env, name, value);
  }
}

/**
 * First-run + drift repair for a nas stack: mint every generated secret
 * missing from its environment (platform-scoped ones from the shared
 * stack, mirrored into every environment of the platform), report the
 * operator secrets still absent, and — for an environment stack — the
 * platform-scoped values its environment does not carry yet (the shared
 * stack's bootstrap mirrors them). `rotate` re-mints named generated ones.
 */
export function ensureSecrets(stack, { rotate = [] } = {}) {
  const env = stack.githubEnvironment;
  ensureEnvironment(env);
  const present = existingEnvSecrets(env);
  const minted = [];
  const mirrored = [];
  const missingOperator = [];
  const waitingForShared = [];
  const setOwn = (name, value) => {
    const entry = MANIFEST.secrets.find((s) => s.name === name);
    // a platform value reaches every environment of the platform — a sharedOnly one stays in the shared stack's own environment
    return entry?.scope === 'platform' && !entry.sharedOnly ? setPlatformSecret(stack, name, value) : setEnvSecret(env, name, value);
  };

  if (stack.role === 'env') {
    const vapidNeeded = rotate.includes('PUSH_VAPID_PUBLIC_KEY') || !present.has('PUSH_VAPID_PUBLIC_KEY') || !present.has('PUSH_VAPID_PRIVATE_KEY');
    if (vapidNeeded) {
      const pair = vapidPair();
      setEnvSecret(env, 'PUSH_VAPID_PUBLIC_KEY', pair.publicKey);
      setEnvSecret(env, 'PUSH_VAPID_PRIVATE_KEY', pair.privateKey);
      minted.push('PUSH_VAPID_PUBLIC_KEY', 'PUSH_VAPID_PRIVATE_KEY');
    }
    for (const entry of mirroredEntries(stack)) {
      if (!entry.optional && entry.owner !== 'module' && !present.has(entry.name)) waitingForShared.push(entry.name);
    }
  }
  for (const entry of entriesFor(stack)) {
    if (entry.name.startsWith('PUSH_VAPID_')) continue;
    // a platform-scoped generated value must also reach every environment of the platform — unless it is the shared stack's alone
    const envsLacking = entry.owner === 'generated' && entry.scope === 'platform' && !entry.sharedOnly
      ? platformEnvStacks(stack.platform).map((s) => s.githubEnvironment).filter((e) => { ensureEnvironment(e); return !existingEnvSecrets(e).has(entry.name); })
      : [];
    const have = present.has(entry.name) && !rotate.includes(entry.name);
    if (have && !envsLacking.length) continue;
    if (entry.owner === 'generated') {
      // an environment added later gets the value the shared stack already runs with — the job carries it — never a re-mint that would strand the running services
      const known = have ? process.env[entry.name] : '';
      if (known) {
        for (const e of envsLacking) setEnvSecret(e, entry.name, known);
        mirrored.push(entry.name);
      } else {
        setOwn(entry.name, generateValue(entry.name));
        minted.push(entry.name);
      }
    } else if (entry.owner === 'operator' && !entry.optional) {
      missingOperator.push(entry.name);
    }
    // module-owned: written back later — never minted
  }
  return { minted, mirrored, missingOperator, waitingForShared };
}

/** manifest-vs-reality check used by --verify (no writes) */
export function verifySecrets(stack) {
  const present = existingEnvSecrets(stack.githubEnvironment);
  const expected = [...entriesFor(stack), ...mirroredEntries(stack)];
  const missing = expected.filter((s) => !s.optional && s.owner !== 'module' && !present.has(s.name)).map((s) => s.name);
  const unmanaged = [...present].filter((name) => !MANIFEST.secrets.some((s) => s.name === name));
  return { missing, unmanaged };
}
