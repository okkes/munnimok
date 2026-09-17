import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The platform/environment model (infra/platforms/README.md): every
 * platform runs ONE shared stack and N environment stacks, all described
 * by committed JSON the wizard writes and the workflows read. Nothing
 * here is hand-written per stack any more — names, hosts and ports are
 * derived from <platform, env, slot>.
 */

// MUNNI_PLATFORMS_DIR / MUNNI_RENDER_DIR: test overrides so specs never touch the real tree
const HERE = dirname(fileURLToPath(import.meta.url));
export const PLATFORMS_DIR = () => process.env.MUNNI_PLATFORMS_DIR ?? join(HERE, '..', 'platforms');
const RENDER_DIR = () => process.env.MUNNI_RENDER_DIR ?? join(HERE, '..', 'rendered');

export const PLATFORM_IDS = ['lcl', 'nas', 'rpi'];
export const PLATFORM_LABELS = { lcl: 'This computer', nas: 'Synology NAS', rpi: 'Raspberry Pi' };
export const RESERVED_ENV_NAMES = new Set(['shared', 'platform', 'all']);
/** 2-12 lowercase letters/digits, starting with a letter (hostnames, compose project names, GitHub environments) */
export const ENV_NAME_RE = /^[a-z][a-z0-9]{1,11}$/;

/** environment ports come from the SLOT — stable across deletions */
export const PORT_SLOT = { web: 8380, admin: 8381, api: 8382, logto: 3201, logtoAdmin: 3202 };
export const SHARED_PORTS = { glitchtip: 8383, vault: 8384, control: 8385, pgadmin: 8386 };
export const envPorts = (slot) => Object.fromEntries(Object.entries(PORT_SLOT).map(([k, base]) => [k, base + 100 * slot]));

export const stackName = (platform, env = null) => `munni-${platform}-${env ?? 'shared'}`;
export function parseStackName(name) {
  const m = /^munni-([a-z]{2,5})-([a-z0-9]{2,12})$/.exec(String(name ?? ''));
  if (!m) return null;
  return { platform: m[1], env: m[2] === 'shared' ? null : m[2] };
}

/** LAN mode (lcl only): infra/rendered/lan-host holds the machine's LAN address */
export function lanHost() {
  const file = join(RENDER_DIR(), 'lan-host');
  if (!existsSync(file)) return null;
  const host = readFileSync(file, 'utf8').trim();
  return /^[0-9a-zA-Z.-]+$/.test(host) ? host : null;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

const platformFile = (id) => join(PLATFORMS_DIR(), id, 'platform.json');
const envsDir = (id) => join(PLATFORMS_DIR(), id, 'envs');
const envFile = (id, env) => join(envsDir(id), `${env}.json`);

/* ── platforms ───────────────────────────────────────────────────────── */

export function listPlatforms() {
  const dir = PLATFORMS_DIR();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(platformFile(id)))
    .map((id) => loadPlatform(id));
}

export function loadPlatform(id) {
  const file = platformFile(id);
  if (!existsSync(file)) throw new Error(`unknown platform "${id}" — no ${file}`);
  const cfg = readJson(file);
  if (cfg.platform !== id) throw new Error(`${file} declares platform "${cfg.platform}" — must match its folder`);
  return {
    label: PLATFORM_LABELS[id] ?? id,
    registry: 'ghcr.io/okkes',
    sharedChannel: 'latest',
    ...cfg,
    delivery: cfg.delivery ?? (id === 'lcl' ? 'docker' : id === 'nas' ? 'synology' : 'ssh'),
    file,
  };
}

export function savePlatform(cfg) {
  const { file: _f, ...rest } = cfg;
  writeJson(platformFile(cfg.platform), rest);
  return loadPlatform(cfg.platform);
}

/* ── environments ────────────────────────────────────────────────────── */

export function platformEnvs(id) {
  const dir = envsDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => normalizeEnv(id, readJson(join(dir, f)), f.replace(/\.json$/, '')))
    .sort((a, b) => a.slot - b.slot);
}

function normalizeEnv(platform, raw, fromFile) {
  const env = raw.env ?? fromFile;
  if (!ENV_NAME_RE.test(env) || RESERVED_ENV_NAMES.has(env)) throw new Error(`environment name "${env}" is invalid (2-12 lowercase letters/digits, not ${[...RESERVED_ENV_NAMES].join('/')})`);
  if (!Number.isInteger(raw.slot) || raw.slot < 0) throw new Error(`environment "${env}" on ${platform} has no integer slot`);
  const features = { android: false, ios: false, push: false, logos: false, telemetry: true, pgadmin: true, banking: [], signin: [], ...(raw.features ?? {}) };
  return {
    env,
    slot: raw.slot,
    channel: raw.channel === 'dev' ? 'dev' : 'latest',
    appChannel: raw.appChannel ?? (env === 'prod' ? 'production' : 'staging'),
    label: raw.label ?? `munni ${env}-${platform}`,
    features,
    store: {
      androidPackage: raw.store?.androidPackage ?? `app.munni.${platform}.${env}`,
      iosBundleId: raw.store?.iosBundleId ?? raw.store?.androidPackage ?? `app.munni.${platform}.${env}`,
    },
  };
}

export function loadEnv(platform, env) {
  const file = envFile(platform, env);
  if (!existsSync(file)) throw new Error(`unknown environment "${env}" on ${platform} — no ${file}`);
  return normalizeEnv(platform, readJson(file), env);
}

/** the lowest free slot on a platform */
export function nextSlot(platform) {
  const used = new Set(platformEnvs(platform).map((e) => e.slot));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

export function saveEnv(platform, cfg) {
  const normalized = normalizeEnv(platform, cfg, cfg.env);
  writeJson(envFile(platform, normalized.env), normalized);
  return normalized;
}

export function removeEnv(platform, env) {
  const file = envFile(platform, env);
  if (existsSync(file)) rmSync(file);
}

/* ── stacks ──────────────────────────────────────────────────────────── */

/** every stack: per platform the shared stack first, then its environments by slot */
export function listStacks() {
  return listPlatforms().flatMap((p) => [stackName(p.platform), ...platformEnvs(p.platform).map((e) => stackName(p.platform, e.env))]);
}

export const hostsFor = (platform, env = null) => (env
  ? { web: `munni-${env}-${platform}`, admin: `munni-${env}-${platform}-admin`, api: `munni-${env}-${platform}-api`, logto: `munni-${env}-${platform}-logto`, logtoAdmin: `munni-${env}-${platform}-logto-admin` }
  : { glitchtip: `glitchtip-${platform}`, vault: `vault-${platform}`, control: `control-${platform}`, pgadmin: `pgadmin-${platform}` });

/** the platform's domain: the JSON's value, with ${PLATFORM_DOMAIN} taken from the environment (a secret in the public repo) */
export function platformDomain(p) {
  if (!p.domain) return null;
  if (p.domain !== '${PLATFORM_DOMAIN}') return p.domain;
  if (!process.env.PLATFORM_DOMAIN) throw new Error(`PLATFORM_DOMAIN is not set — the ${p.platform} platform's domain is a secret the environment provides`);
  return process.env.PLATFORM_DOMAIN;
}

/**
 * load a stack: {stack, platform, env, role, delivery, channel, slot,
 * ports, hosts, host(key), urls, sharedStack, githubEnvironment, native,
 * features, store, registry, domain, lan}
 */
export function loadStack(name) {
  const parsed = parseStackName(name);
  if (!parsed) throw new Error(`"${name}" is not a stack name (munni-<platform>-<env|shared>)`);
  const p = loadPlatform(parsed.platform);
  const shared = parsed.env === null;
  const envCfg = shared ? null : loadEnv(p.platform, parsed.env);
  const local = p.delivery === 'docker';
  const lan = local ? lanHost() : null;
  const domain = local ? (lan ? `${lan.replaceAll('.', '-')}.sslip.io` : null) : platformDomain(p);
  const ports = shared ? { ...SHARED_PORTS } : envPorts(envCfg.slot);
  const hosts = hostsFor(p.platform, parsed.env);
  const host = (key) => {
    if (!hosts[key]) throw new Error(`stack ${name} has no service "${key}"`);
    return domain ? `${hosts[key]}.${domain}` : 'localhost';
  };
  const url = (key) => {
    if (domain) return `https://${host(key)}`;
    // plain localhost (no LAN mode): http on the published port, except the vault (Bitwarden refuses http)
    return `${key === 'vault' ? 'https' : 'http'}://localhost:${ports[key]}`;
  };
  const urls = Object.fromEntries(Object.keys(hosts).map((k) => [k, url(k)]));
  const controlEnvName = shared ? (p.controlEnv ?? platformEnvs(p.platform)[0]?.env ?? null) : null;
  return {
    stack: name,
    platform: p.platform,
    platformLabel: p.label,
    delivery: p.delivery,
    env: parsed.env,
    role: shared ? 'shared' : 'env',
    channel: shared ? p.sharedChannel : envCfg.channel,
    appChannel: shared ? null : envCfg.appChannel,
    slot: shared ? null : envCfg.slot,
    ports,
    hosts,
    host,
    urls,
    domain,
    lan,
    registry: p.registry,
    publishedPath: p.publishedPath ?? null,
    sharedStack: stackName(p.platform),
    controlApi: controlEnvName ? stackName(p.platform, controlEnvName) : null,
    githubEnvironment: `${p.platform}-${parsed.env ?? 'shared'}`,
    features: shared ? { telemetry: true } : envCfg.features,
    store: shared ? null : envCfg.store,
    label: shared ? `munni shared (${p.label})` : envCfg.label,
    native: shared ? null : {
      appId: envCfg.store.androidPackage,
      iosAppId: envCfg.store.iosBundleId,
      label: envCfg.label,
      scheme: `munni-${parsed.env}-${p.platform}`,
    },
    file: shared ? p.file : envFile(p.platform, parsed.env),
  };
}

/** the platform's shared stack (self for a shared stack) */
export function sharedOf(stack) {
  return stack.role === 'shared' ? stack : loadStack(stack.sharedStack);
}

/** every environment stack of a platform, by slot */
export const platformEnvStacks = (platform) => platformEnvs(platform).map((e) => loadStack(stackName(platform, e.env)));

/* ── the helper's self-update settings (lcl) ─────────────────────────── */
const AUTONOMY_FILE = () => join(RENDER_DIR(), 'local-autonomy.json');
export const AUTONOMY_DEFAULTS = Object.freeze({ enabled: false, intervalMinutes: 10, lastCheckAt: null, lastResult: null });

export function loadAutonomy() {
  const file = AUTONOMY_FILE();
  if (!existsSync(file)) return { ...AUTONOMY_DEFAULTS };
  try {
    return { ...AUTONOMY_DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ...AUTONOMY_DEFAULTS };
  }
}

export function saveAutonomy(state) {
  const next = { ...AUTONOMY_DEFAULTS, ...state };
  mkdirSync(dirname(AUTONOMY_FILE()), { recursive: true });
  writeFileSync(AUTONOMY_FILE(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
