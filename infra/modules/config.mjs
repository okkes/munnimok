/**
 * The platform configuration as DATA on GitHub (#416, 2026-10-01).
 *
 * One repository variable per platform — `MUNNI_PLATFORM_<ID>` — holds the
 * platform file and every environment file as one JSON document. The
 * wizard's helper writes it on every save (Save settings, Add environment,
 * the platform card, a cleanup); every workflow reads it at the start of a
 * job (`infra/ci/materialize.mjs` writes the files the modules read). The
 * repository holds no platform config: `infra/platforms/<id>/` is ignored
 * by git — the wizard's local copy on this computer, the run's copy in CI.
 *
 * What a run APPLIED is a second variable, `MUNNI_APPLIED`, on the stack's
 * GitHub environment: the config the Bootstrap or Deploy ran with. The
 * wizard's pending strip compares it with what is configured now — no
 * commit, no branch, no sha involved.
 *
 * Which branch a stack's runs check out is the platform's `branch`, else
 * the stack's image channel decides (`latest` = master releases, `dev` =
 * the dev branch) — `loadStack(...).branch`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORMS_DIR, loadEnv, loadPlatform, normalizeEnv, normalizePlatform, parseStackName, platformEnvs } from './stack.mjs';

export const PLATFORM_VARIABLE_PREFIX = 'MUNNI_PLATFORM_';
export const APPLIED_VARIABLE = 'MUNNI_APPLIED';
/** GitHub's ceiling for one variable's value */
export const VARIABLE_LIMIT_BYTES = 48 * 1024;

export const platformVariable = (id) => `${PLATFORM_VARIABLE_PREFIX}${String(id).toUpperCase()}`;

/** the platform id a variable name stands for, or null for any other name */
export function platformOfVariable(name) {
  if (typeof name !== 'string' || !name.startsWith(PLATFORM_VARIABLE_PREFIX)) return null;
  const id = name.slice(PLATFORM_VARIABLE_PREFIX.length);
  return /^[A-Z][A-Z0-9]*$/.test(id) ? id.toLowerCase() : null;
}

/** the platform as config: every reader's normalized shape without the file it came from */
const asConfig = (platform) => {
  const { file: _file, ...rest } = platform;
  return rest;
};

/** the document the variable holds: the platform and its environments, normalized like every reader normalizes them */
export function platformDocument(id) {
  return {
    platform: asConfig(loadPlatform(id)),
    envs: Object.fromEntries(platformEnvs(id).map((e) => [e.env, e])),
  };
}

/**
 * The config a run applies for a stack, in the shape the pending verdict
 * compares: `{ ...env, platform }` for an environment, `{ platform }` for
 * the shared stack.
 */
export function stackConfig(stackName) {
  const parsed = parseStackName(stackName);
  if (!parsed) throw new Error(`"${stackName}" is not a stack name`);
  const platform = asConfig(loadPlatform(parsed.platform));
  return parsed.env ? { ...loadEnv(parsed.platform, parsed.env), platform } : { platform };
}

/** the same slice of a published document — null when the document does not know the environment */
export function documentStackConfig(doc, stackName) {
  const parsed = parseStackName(stackName);
  if (!parsed || !doc?.platform) return null;
  if (!parsed.env) return { platform: doc.platform };
  const env = doc.envs?.[parsed.env];
  return env ? { ...env, platform: doc.platform } : null;
}

/**
 * Write a document's files where the modules read them: the platform file
 * and ONLY the environments the document lists (an environment the
 * document dropped is removed — a cleanup publishes without it).
 */
export function materializePlatform(id, doc) {
  if (!doc || typeof doc !== 'object' || !doc.platform || doc.platform.platform !== id) {
    throw new Error(`${platformVariable(id)}: not a platform document for "${id}"`);
  }
  const dir = join(PLATFORMS_DIR(), id);
  const envsDir = join(dir, 'envs');
  mkdirSync(envsDir, { recursive: true });
  writeFileSync(join(dir, 'platform.json'), `${JSON.stringify(asConfig(normalizePlatform(id, doc.platform)), null, 2)}\n`);
  const listed = new Set();
  for (const [env, raw] of Object.entries(doc.envs ?? {})) {
    const normalized = normalizeEnv(id, raw, env);
    listed.add(normalized.env);
    writeFileSync(join(envsDir, `${normalized.env}.json`), `${JSON.stringify(normalized, null, 2)}\n`);
  }
  for (const f of readdirSync(envsDir)) {
    if (f.endsWith('.json') && !listed.has(f.replace(/\.json$/, ''))) rmSync(join(envsDir, f));
  }
  return { platform: id, envs: [...listed].sort() };
}

/** every `MUNNI_PLATFORM_*` in the environment → files; the ids written (none: nothing published yet) */
export function materializeFromEnv(env = process.env) {
  const ids = [];
  for (const [name, value] of Object.entries(env)) {
    const id = platformOfVariable(name);
    if (!id || !value) continue;
    let doc;
    try { doc = JSON.parse(value); } catch (e) { throw new Error(`${name}: not JSON (${e.message})`); }
    materializePlatform(id, doc);
    ids.push(id);
  }
  return ids.sort();
}

/* ── GitHub, through gh ─────────────────────────────────────────────── */

const run = (args, { execImpl = execFileSync, env = process.env } = {}) =>
  execImpl('gh', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
const repoArgs = (repo) => (repo ? ['--repo', repo] : []);
const errorText = (e) => `${e?.stderr ?? ''}${e?.message ?? e}`;
const isMissing = (e) => /not found|HTTP 404|was not found/i.test(errorText(e));

/** a variable's value as GitHub holds it (parsed), or null when it is not there — `environment` is the GitHub environment, `env` the process environment gh runs in */
function getVariable(name, { environment = null, repo = null, execImpl, env } = {}) {
  let out;
  try {
    out = run(['variable', 'get', name, ...(environment ? ['--env', environment] : []), ...repoArgs(repo)], { execImpl, env });
  } catch (e) {
    if (isMissing(e)) return null;
    throw new Error(`gh variable get ${name}${environment ? ` --env ${environment}` : ''} failed: ${errorText(e).trim()}`);
  }
  const text = String(out ?? '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error(`${name} on GitHub is not JSON`); }
}

/** the platform's document on GitHub, or null when nothing was published yet */
export const fetchPlatformVariable = (id, opts = {}) => getVariable(platformVariable(id), opts);

/**
 * Publish the platform's current files as its variable. Returns what was
 * written (name, size, environments). Refuses a document GitHub would
 * refuse (its 48 KB ceiling) before any call.
 */
export function publishPlatform(id, { repo = null, execImpl, env, now = new Date() } = {}) {
  const doc = platformDocument(id);
  const body = JSON.stringify({ ...doc, publishedAt: now.toISOString() });
  const bytes = Buffer.byteLength(body);
  if (bytes > VARIABLE_LIMIT_BYTES) throw new Error(`${platformVariable(id)} would be ${bytes} bytes — GitHub keeps a variable under ${VARIABLE_LIMIT_BYTES}`);
  try {
    run(['variable', 'set', platformVariable(id), ...repoArgs(repo), '--body', body], { execImpl, env });
  } catch (e) {
    throw new Error(`gh variable set ${platformVariable(id)} failed: ${errorText(e).trim()}`);
  }
  return { name: platformVariable(id), bytes, envs: Object.keys(doc.envs).sort(), publishedAt: JSON.parse(body).publishedAt };
}

/** fetch the platform's document and write its files here — a second computer, or after a cleanup changed it in CI */
export function pullPlatform(id, opts = {}) {
  const doc = fetchPlatformVariable(id, opts);
  if (!doc) return null;
  return { ...materializePlatform(id, doc), publishedAt: doc.publishedAt ?? null };
}

/** record what a run applied for a stack: the config it ran with, on the stack's GitHub environment */
export function writeApplied(stack, { by, run: runId = null, repo = null, execImpl, env, now = new Date() }) {
  const record = { at: now.toISOString(), by, run: runId, stack: stack.stack, config: stackConfig(stack.stack) };
  const body = JSON.stringify(record);
  try {
    run(['variable', 'set', APPLIED_VARIABLE, '--env', stack.githubEnvironment, ...repoArgs(repo), '--body', body], { execImpl, env });
  } catch (e) {
    throw new Error(`gh variable set ${APPLIED_VARIABLE} --env ${stack.githubEnvironment} failed: ${errorText(e).trim()}`);
  }
  return record;
}

/** what the last run applied for a stack, or null when no run recorded one */
export const readApplied = (stack, opts = {}) => getVariable(APPLIED_VARIABLE, { ...opts, environment: stack.githubEnvironment });
