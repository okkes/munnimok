import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, entriesFor, featureOn, generateValue, vapidPair } from './secrets.mjs';
import { loadStack } from './stack.mjs';

// MUNNI_RENDER_DIR: test override so specs never touch a real rendered/
const OUT_DIR = () => process.env.MUNNI_RENDER_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'rendered');

/**
 * The wizard's own store (infra/rendered/wizard/.secrets.json,
 * gitignored): what the operator typed, ONE SET PER PLATFORM under
 * `platforms` (bank providers, logos, push, sign-in providers, store
 * accounts, the GitHub token, the NAS account, the domain, the platform's
 * vault account and upload keystore) — platforms share nothing: each has
 * its own values here and its own GitHub environments. The one exception
 * lives under `machine`: the Apple Development certificate, because Apple
 * caps those per developer account and it identifies this computer's build
 * pipeline, not a platform; every platform's iOS environments ship it.
 * For the lcl platform the values are also what the stacks render with;
 * for nas the wizard copies them into the platform's GitHub environments.
 *
 * Stack stores (infra/rendered/<stack>/.secrets.local.json) hold what a
 * LOCAL stack minted or wrote back: the shared stack's platform-scoped
 * values, each environment's own.
 */
const WIZARD_FILE = () => join(OUT_DIR(), 'wizard', '.secrets.json');
const storeFile = (stackName) => join(OUT_DIR(), stackName, '.secrets.local.json');

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); return value; };

const entryOf = (name) => MANIFEST.secrets.find((s) => s.name === name);

/** this computer's, not a platform's: Apple caps Development certificates per account, and the certificate is this machine's build identity */
export const MACHINE_OWNED = new Set(['APPLE_DEV_CERT_P12', 'APPLE_DEV_CERT_PASSWORD', 'APPLE_DEV_CERT_SERIAL']);

export function loadWizardStore() {
  const raw = readJson(WIZARD_FILE()) ?? {};
  return { machine: raw.machine ?? {}, platforms: raw.platforms ?? {} };
}

export function saveWizardStore(store) {
  return writeJson(WIZARD_FILE(), { machine: store.machine ?? {}, platforms: store.platforms ?? {} });
}

const requirePlatform = (platform, what) => {
  if (typeof platform !== 'string' || !platform) throw new TypeError(`${what}: a platform is required — every value belongs to one platform`);
  return platform;
};

/** the machine-owned values alone (the Apple Development certificate) */
export function machineValues() {
  return { ...loadWizardStore().machine };
}

/** the wizard's values as ONE platform sees them: its own set plus the machine-owned ones — never another platform's */
export function wizardValues(platform) {
  const store = loadWizardStore();
  return { ...store.machine, ...(store.platforms[requirePlatform(platform, 'wizardValues')] ?? {}) };
}

/** where an operator value belongs: the machine for the Apple certificate, the named platform for everything else */
export function setWizardValues(values, platform = null) {
  const store = loadWizardStore();
  for (const [name, value] of Object.entries(values)) {
    if (MACHINE_OWNED.has(name)) { store.machine[name] = value; continue; }
    const p = requirePlatform(platform, `setWizardValues(${name})`);
    store.platforms[p] = { ...(store.platforms[p] ?? {}), [name]: value };
  }
  return saveWizardStore(store);
}

export function forgetWizardValues(names, platform = null) {
  const store = loadWizardStore();
  for (const name of names) {
    if (MACHINE_OWNED.has(name)) { delete store.machine[name]; continue; }
    const p = requirePlatform(platform, `forgetWizardValues(${name})`);
    if (store.platforms[p]) delete store.platforms[p][name];
  }
  return saveWizardStore(store);
}

/** a local stack's OWN stored values */
export function loadLocalValues(stack) {
  return readJson(storeFile(stack.stack)) ?? {};
}

/** the merged view a local stack renders with: the wizard's values, the shared stack's platform-scoped values, its own */
export function stackValues(stack) {
  const own = loadLocalValues(stack);
  const shared = stack.role === 'shared' ? {} : (readJson(storeFile(stack.sharedStack)) ?? {});
  // a stack-scoped value (every Postgres server has its own password) never leaks from the shared store into an environment
  const platformScoped = Object.fromEntries(Object.entries(shared).filter(([name]) => entryOf(name)?.scope !== 'stack'));
  return { ...wizardValues(stack.platform), ...platformScoped, ...own };
}

/**
 * save: operator/wizard values go to the wizard's store, platform-scoped
 * minted/written-back ones to the platform's shared stack store, the
 * rest to the stack's own store
 */
export function saveLocalValues(stack, values) {
  const own = {};
  const wizard = {};
  const shared = stack.role === 'shared' ? null : (readJson(storeFile(stack.sharedStack)) ?? {});
  let sharedChanged = false;
  for (const [name, value] of Object.entries(values)) {
    const entry = entryOf(name);
    if (entry?.owner === 'operator' || entry?.scope === 'wizard') {
      wizard[name] = value;
    } else if (entry?.scope === 'platform' && shared) {
      if (shared[name] !== value) { shared[name] = value; sharedChanged = true; }
    } else {
      own[name] = value;
    }
  }
  if (Object.keys(wizard).length) setWizardValues(wizard, stack.platform);
  if (sharedChanged) writeJson(storeFile(stack.sharedStack), shared);
  return writeJson(storeFile(stack.stack), own);
}

/** the manifest entries a local stack is responsible for */
export const stackManifestEntries = (stack) => entriesFor(stack);

function ensureVapid(values, rotate, minted) {
  const needed = rotate.includes('PUSH_VAPID_PUBLIC_KEY') || !values.PUSH_VAPID_PUBLIC_KEY || !values.PUSH_VAPID_PRIVATE_KEY;
  if (!needed) return;
  const pair = vapidPair();
  values.PUSH_VAPID_PUBLIC_KEY = pair.publicKey;
  values.PUSH_VAPID_PRIVATE_KEY = pair.privateKey;
  minted.push('PUSH_VAPID_PUBLIC_KEY', 'PUSH_VAPID_PRIVATE_KEY');
}

/**
 * Mint the generated secrets THIS local stack owns, absorb operator
 * values offered via process.env into the wizard's store, and report the
 * required operator values still absent for the features it enables.
 */
export function ensureLocalSecrets(stack, { rotate = [] } = {}) {
  const values = stackValues(stack);
  const own = loadLocalValues(stack);
  const minted = [];
  const missingOperator = [];
  const offered = {};
  if (stack.role === 'env') ensureVapid(own, rotate, minted);
  for (const entry of stackManifestEntries(stack)) {
    if (entry.name.startsWith('PUSH_VAPID_')) continue;
    if (entry.owner === 'operator' && process.env[entry.name]) { offered[entry.name] = process.env[entry.name]; values[entry.name] = process.env[entry.name]; }
    const present = entry.scope === 'stack' ? own[entry.name] : values[entry.name];
    const needed = rotate.includes(entry.name) || !present;
    if (!needed) continue;
    if (entry.owner === 'generated') {
      const value = generateValue(entry.name);
      if (entry.scope === 'stack' || stack.role === 'env') own[entry.name] = value;
      else own[entry.name] = value; // the shared stack's platform-scoped values live in its own store
      minted.push(entry.name);
    } else if (entry.owner === 'operator' && !entry.optional && featureOn(stack, entry.feature)) {
      missingOperator.push(entry.name);
    }
  }
  if (Object.keys(offered).length) setWizardValues(offered, stack.platform);
  writeJson(storeFile(stack.stack), own);
  return { values: stackValues(stack), minted, missingOperator };
}

/** re-export for callers that only need the stack loader alongside the stores */
export { loadStack };
