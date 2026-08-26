import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, generateValue, vapidPair } from './secrets.mjs';

// MUNNI_RENDER_DIR: test override so specs never touch a real rendered/
const OUT_DIR = process.env.MUNNI_RENDER_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'rendered');

/**
 * Secret store for target:"local" stacks — the file-backed twin of the
 * GitHub Environment. Lives in infra/rendered/<stack>/.secrets.local.json
 * (gitignored with the rest of rendered/), so re-running bootstrap keeps
 * the postgres password and VAPID pair STABLE instead of re-minting over
 * live data. Operator values are absorbed from the process env whenever
 * present (e.g. `$env:NAS_GHCR_PAT='…'; node infra/bootstrap.mjs --stack
 * munni-local`) and remembered; module write-backs (logto, glitchtip)
 * land here through saveLocalValues.
 */
const storeFile = (stack) => join(OUT_DIR, stack.stack, '.secrets.local.json');

export function loadLocalValues(stack) {
  const file = storeFile(stack);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export function saveLocalValues(stack, values) {
  const file = storeFile(stack);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
  return values;
}

/** manifest entries that apply to a local stack (nas/ci platforms skip) */
export const localManifestEntries = () => MANIFEST.secrets.filter((s) => !['nas', 'ci'].includes(s.platform));

/**
 * Mint every generated secret missing from the store, absorb operator
 * values offered via process.env, report which required operator values
 * are still absent. Mirrors ensureSecrets() against the local file.
 */
export function ensureLocalSecrets(stack, { rotate = [] } = {}) {
  const values = loadLocalValues(stack);
  const minted = [];
  const missingOperator = [];

  const vapidNeeded =
    rotate.includes('NAS_PUSH_VAPID_PUBLIC_KEY') || !values.NAS_PUSH_VAPID_PUBLIC_KEY || !values.NAS_PUSH_VAPID_PRIVATE_KEY;
  if (vapidNeeded) {
    const pair = vapidPair();
    values.NAS_PUSH_VAPID_PUBLIC_KEY = pair.publicKey;
    values.NAS_PUSH_VAPID_PRIVATE_KEY = pair.privateKey;
    minted.push('NAS_PUSH_VAPID_PUBLIC_KEY', 'NAS_PUSH_VAPID_PRIVATE_KEY');
  }

  for (const entry of localManifestEntries()) {
    if (entry.name.startsWith('NAS_PUSH_VAPID_')) continue;
    if (entry.owner === 'operator' && process.env[entry.name]) values[entry.name] = process.env[entry.name];
    const needed = rotate.includes(entry.name) || !values[entry.name];
    if (!needed) continue;
    if (entry.owner === 'generated') {
      values[entry.name] = generateValue(entry.name);
      minted.push(entry.name);
    } else if (entry.owner === 'operator' && !entry.optional) {
      missingOperator.push(entry.name);
    }
    // owner === 'module': written back by logto/glitchtip via saveLocalValues
  }
  saveLocalValues(stack, values);
  return { values, minted, missingOperator };
}
