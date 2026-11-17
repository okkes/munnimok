// platform config is DATA on GitHub (#416): variable `MUNNI_PLATFORM_<ID>` holds platform + env files as one JSON document
// infra/platforms/<id>/ is git-ignored: the wizard's local copy, the run's copy in CI
// MUNNI_APPLIED on a stack's GitHub environment holds what its last run applied; branch = platform's, else by image channel
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORMS_DIR, loadEnv, loadPlatform, normalizeEnv, normalizePlatform, parseStackName, platformEnvs } from './stack.mjs';

export const PLATFORM_VARIABLE_PREFIX = 'MUNNI_PLATFORM_';
export const APPLIED_VARIABLE = 'MUNNI_APPLIED';
/** GitHub's ceiling for one variable's value */
export const VARIABLE_LIMIT_BYTES = 48 * 1024;

export const platformVariable = (id) => `${PLATFORM_VARIABLE_PREFIX}${String(id).toUpperCase()}`;

export function platformOfVariable(name) {
  if (typeof name !== 'string' || !name.startsWith(PLATFORM_VARIABLE_PREFIX)) return null;
  const id = name.slice(PLATFORM_VARIABLE_PREFIX.length);
  return /^[A-Z][A-Z0-9]*$/.test(id) ? id.toLowerCase() : null;
}

const asConfig = (platform) => {
  const { file: _file, ...rest } = platform;
  return rest;
};

export function platformDocument(id) {
  return {
    platform: asConfig(loadPlatform(id)),
    envs: Object.fromEntries(platformEnvs(id).map((e) => [e.env, e])),
  };
}

export function stackConfig(stackName) {
  const parsed = parseStackName(stackName);
  if (!parsed) throw new Error(`"${stackName}" is not a stack name`);
  const platform = asConfig(loadPlatform(parsed.platform));
  return parsed.env ? { ...loadEnv(parsed.platform, parsed.env), platform } : { platform };
}

export function documentStackConfig(doc, stackName) {
  const parsed = parseStackName(stackName);
  if (!parsed || !doc?.platform) return null;
  if (!parsed.env) return { platform: doc.platform };
  const env = doc.envs?.[parsed.env];
  return env ? { ...env, platform: doc.platform } : null;
}

/** writes a document's files; an environment the document dropped is removed (a cleanup publishes without it) */
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

// windowsHide: the wizard's helper may run without a console (restarted from the page) — gh must not open one
const run = (args, { execImpl = execFileSync, env = process.env } = {}) =>
  execImpl('gh', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const repoArgs = (repo) => (repo ? ['--repo', repo] : []);
const errorText = (e) => `${e?.stderr ?? ''}${e?.message ?? e}`;
const isMissing = (e) => /not found|HTTP 404|was not found/i.test(errorText(e));

/** a variable's parsed value, or null when absent; `environment` = GitHub environment, `env` = gh's process environment */
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

export const fetchPlatformVariable = (id, opts = {}) => getVariable(platformVariable(id), opts);

/** refuses a document over GitHub's 48 KB variable ceiling before any call */
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

export const readApplied = (stack, opts = {}) => getVariable(APPLIED_VARIABLE, { ...opts, environment: stack.githubEnvironment });
