import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'stacks');
// MUNNI_RENDER_DIR: same test override render/localstore honor
const RENDER_DIR = () => process.env.MUNNI_RENDER_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'rendered');

/**
 * LAN MODE (native-apps ruling 2026-08-28): when infra/rendered/lan-host
 * holds an address (the machine's 192.168.x.y, written by the wizard),
 * every LOCAL stack derives its urls from it instead of localhost — so a
 * phone on the same network reaches web/api/logto, and CI-built native
 * apps can bake these origins. A plain file (not the secret stores)
 * because localstore imports THIS module — a store read here would cycle.
 * Deleting the file + re-running bootstrap flips everything back.
 */
export function lanHost() {
  const file = join(RENDER_DIR(), 'lan-host');
  if (!existsSync(file)) return null;
  const host = readFileSync(file, 'utf8').trim();
  return /^[0-9a-zA-Z.-]+$/.test(host) ? host : null;
}

/** strip // and /* *​/ comments (naive but our files avoid urls-in-strings pitfalls via lookbehind on ':') */
function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.search(/(?<!:)\/\/(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/);
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

export function listStacks() {
  return readdirSync(STACKS_DIR)
    .filter((f) => f.endsWith('.jsonc'))
    .map((f) => f.replace(/\.jsonc$/, ''));
}

/** load a stack file and derive the values every module needs */
export function loadStack(name) {
  const file = join(STACKS_DIR, `${name}.jsonc`);
  const cfg = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
  // the NAS domain is treated as a SECRET (public repo): stack files
  // carry a placeholder, the environment provides the value
  if (cfg.domain === '${IAC_DOMAIN}') {
    if (!process.env.IAC_DOMAIN) throw new Error('IAC_DOMAIN is not set — export it (locally) or add the repo secret (CI)');
    cfg.domain = process.env.IAC_DOMAIN;
  }
  if (cfg.stack !== name) throw new Error(`stack file ${file} declares "${cfg.stack}" — must match its filename`);
  // target "local": everything on one host over plain http (Docker
  // Desktop) — localhost, or the machine's LAN address in LAN mode —
  // no DSM, no DDNS, no GitHub Environment
  const local = cfg.target === 'local';
  const localHost = local ? (lanHost() ?? 'localhost') : null;
  const host = (key) => (local ? localHost : `${cfg.hosts[key]}.${cfg.domain}`);
  const url = (key) => (local ? `http://${localHost}:${cfg.ports[key]}` : `https://${host(key)}`);
  // a stack only gets urls for services it actually addresses (a shared
  // stack has no web/api; an env stack pointing at a shared stack has no
  // glitchtip of its own) — locally that is "port defined", hosted
  // "host defined"
  const keys = ['web', 'api', 'admin', 'logto', 'logtoAdmin', 'glitchtip', 'vault', 'control', 'pgadmin'];
  const urls = Object.fromEntries(
    keys.filter((k) => (local ? cfg.ports?.[k] !== undefined : cfg.hosts?.[k] !== undefined)).map((k) => [k, url(k)]),
  );
  return { ...cfg, file, urls, host };
}

/** the prod twin of a stack's pair (where the pair's services live);
 * self for prod twins and for role:"shared" stacks */
export function pairProd(stack) {
  if (stack.role === 'prod' || stack.role === 'shared') return stack;
  const sibling = listStacks()
    .map((name) => loadStack(name))
    .find((s) => s.pair === stack.pair && s.role === 'prod');
  if (!sibling) throw new Error(`no prod twin found for pair "${stack.pair}"`);
  return sibling;
}

/** where a stack's cross-environment services (glitchtip, vault, ocr,
 * postgres) live: its declared sharedStack when the topology is split
 * (local three-stack), else the pair's prod twin (iac pairs) */
export function sharedOf(stack) {
  return stack.sharedStack ? loadStack(stack.sharedStack) : pairProd(stack);
}
