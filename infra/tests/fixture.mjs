// Shared test fixture for the platform model (infra/platforms/README.md):
// a throwaway platforms tree + rendered dir, wired in through the
// modules' test overrides (MUNNI_PLATFORMS_DIR, MUNNI_RENDER_DIR,
// PLATFORM_DOMAIN), and a fake `gh` on PATH for the modules that shell
// out to GitHub. Not a test file itself (the runner only picks *.test.mjs).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOMAIN = 'nas.example';

/** the platforms every spec starts from: lcl (docker, two envs) + nas (synology, prod on latest, staging on dev) */
export const PLATFORMS = {
  lcl: {
    platform: { platform: 'lcl', label: 'This computer', delivery: 'docker', registry: 'ghcr.io/okkes', sharedChannel: 'dev' },
    envs: {
      prod: { env: 'prod', slot: 0, channel: 'dev', features: { push: true, banking: ['gocardless'], signin: ['google'] } },
      dev: { env: 'dev', slot: 1, channel: 'dev' },
    },
  },
  nas: {
    platform: { platform: 'nas', label: 'Synology NAS', delivery: 'synology', domain: '${PLATFORM_DOMAIN}', registry: 'ghcr.io/okkes', publishedPath: '/docker/munni-nas/published', sharedChannel: 'latest' },
    envs: {
      prod: { env: 'prod', slot: 0, channel: 'latest', features: { android: true, ios: true, push: true, logos: true, banking: ['gocardless'], signin: ['google', 'apple'] } },
      staging: { env: 'staging', slot: 1, channel: 'dev', features: { android: true } },
    },
  },
};

const writeJson = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

/**
 * Point the modules at a scratch tree. Call BEFORE importing the modules
 * (they read the overrides lazily, but a spec should never depend on that).
 */
export function scratchPlatforms({ platforms = PLATFORMS, domain = DOMAIN } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'munni-infra-'));
  const platformsDir = join(root, 'platforms');
  const renderDir = join(root, 'rendered');
  mkdirSync(renderDir, { recursive: true });
  process.env.MUNNI_PLATFORMS_DIR = platformsDir;
  process.env.MUNNI_RENDER_DIR = renderDir;
  if (domain) process.env.PLATFORM_DOMAIN = domain; else delete process.env.PLATFORM_DOMAIN;
  const writePlatform = (cfg) => writeJson(join(platformsDir, cfg.platform, 'platform.json'), cfg);
  const writeEnv = (platform, cfg) => writeJson(join(platformsDir, platform, 'envs', `${cfg.env}.json`), cfg);
  for (const { platform, envs } of Object.values(platforms)) {
    writePlatform(platform);
    for (const env of Object.values(envs)) writeEnv(platform.platform, env);
  }
  return {
    root,
    platformsDir,
    renderDir,
    writePlatform,
    writeEnv,
    removeEnv: (platform, env) => rmSync(join(platformsDir, platform, 'envs', `${env}.json`), { force: true }),
    /** LAN mode for lcl: the marker file with the machine's address */
    lanOn: (ip = '192.168.1.50') => writeFileSync(join(renderDir, 'lan-host'), `${ip}\n`),
    lanOff: () => rmSync(join(renderDir, 'lan-host'), { force: true }),
    readRendered: (stack, file) => readFileSync(join(renderDir, stack, file), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A fake `gh` first on PATH: node itself under the name gh (a .cmd shim
 * would not be spawned by execFile on Windows — and would fall through
 * to the REAL gh), told through NODE_OPTIONS to run fake-gh.mjs instead
 * of a script. Every call is recorded; secrets/variables live in a JSON
 * state file per GitHub environment, so a spec reads back what the
 * modules stored. Restores PATH/NODE_OPTIONS on cleanup.
 */
export function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'munni-fake-gh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const exe = join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh');
  if (process.platform === 'win32') copyFileSync(process.execPath, exe); else symlinkSync(process.execPath, exe);
  const stateFile = join(dir, 'state.json');
  const write = (state) => writeFileSync(stateFile, JSON.stringify(state));
  write({ environments: {}, repoVariables: {}, calls: [] });
  const prev = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, FAKE_GH_STATE: process.env.FAKE_GH_STATE };
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(join(import.meta.dirname, 'fake-gh.mjs')).href}`].filter(Boolean).join(' ');
  process.env.FAKE_GH_STATE = stateFile;
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  return {
    state,
    /** the secrets of one GitHub environment: {NAME: value} */
    secrets: (env) => state().environments[env]?.secrets ?? null,
    variables: (env) => state().environments[env]?.variables ?? null,
    calls: () => state().calls,
    /** seed an environment as GitHub would hold it */
    seed: (env, { secrets = {}, variables = {} } = {}) => { const s = state(); s.environments[env] = { secrets: { ...(s.environments[env]?.secrets ?? {}), ...secrets }, variables: { ...(s.environments[env]?.variables ?? {}), ...variables } }; write(s); },
    /** drop one secret from an environment (drift, a hand deletion) */
    forget: (env, name) => { const s = state(); delete s.environments[env]?.secrets[name]; write(s); },
    resetCalls: () => { const s = state(); s.calls = []; write(s); },
    reset: () => write({ environments: {}, repoVariables: {}, calls: [] }),
    cleanup: () => {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
