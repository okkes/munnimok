import { execFileSync } from 'node:child_process';
import { localAwareFetch } from './insecure-fetch.mjs';

/**
 * GlitchTip as code: ONE GlitchTip per platform (the shared stack) with
 * one organization and team per platform (`munni-<platform>`) and five
 * projects per environment (pwa, admin, api, android, ios). The API
 * token the shared stack's deploy created inside the container
 * (GLITCHTIP_API_TOKEN) is mirrored into every environment of the
 * platform, so each environment's bootstrap ensures its own projects and
 * writes its DSNs back. Sentry-shaped API: /api/0/…, Bearer auth.
 */

async function api(base, token, path, init = {}, fetchImpl = localAwareFetch) {
  const res = await fetchImpl(`${base}/api/0${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`glitchtip ${init.method ?? 'GET'} ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

export const orgSlug = (platform) => `munni-${platform}`;

async function ensureOrg(base, token, slug, fetchImpl) {
  const orgs = await api(base, token, '/organizations/', {}, fetchImpl);
  return orgs.find((o) => o.slug === slug || o.name === slug) ?? (await api(base, token, '/organizations/', { method: 'POST', body: JSON.stringify({ name: slug }) }, fetchImpl));
}

async function ensureTeam(base, token, org, slug, fetchImpl) {
  const teams = await api(base, token, `/organizations/${org}/teams/`, {}, fetchImpl);
  return teams.find((t) => t.slug === slug) ?? (await api(base, token, `/organizations/${org}/teams/`, { method: 'POST', body: JSON.stringify({ slug }) }, fetchImpl));
}

async function ensureProject(base, token, org, team, name, platform, fetchImpl) {
  const projects = await api(base, token, `/organizations/${org}/projects/`, {}, fetchImpl);
  return projects.find((p) => p.slug === name || p.name === name) ?? (await api(base, token, `/teams/${org}/${team}/projects/`, { method: 'POST', body: JSON.stringify({ name, platform }) }, fetchImpl));
}

async function projectDsn(base, token, org, project, fetchImpl) {
  const keys = await api(base, token, `/projects/${org}/${project}/keys/`, {}, fetchImpl);
  const key = keys[0] ?? (await api(base, token, `/projects/${org}/${project}/keys/`, { method: 'POST', body: JSON.stringify({ name: 'default' }) }, fetchImpl));
  const dsn = key?.dsn?.public;
  if (!dsn) throw new Error(`glitchtip project ${project} returned a key without a public DSN`);
  return dsn;
}

export const PROJECTS = [['web', 'pwa', 'javascript'], ['api', 'api', 'csharp'], ['admin', 'admin', 'javascript'], ['android', 'android', 'javascript'], ['ios', 'ios', 'javascript']];

/** ensure the platform's org/team and this environment's projects; returns {web, api, admin, android, ios} DSNs */
export async function applyGlitchTip(shared, stack, token, { fetchImpl = localAwareFetch } = {}) {
  const base = shared.urls.glitchtip;
  const slug = orgSlug(stack.platform);
  const org = await ensureOrg(base, token, slug, fetchImpl);
  const team = await ensureTeam(base, token, org.slug, slug, fetchImpl);
  const dsns = {};
  for (const [key, suffix, platform] of PROJECTS) {
    const project = await ensureProject(base, token, org.slug, team.slug, `${stack.stack}-${suffix}`, platform, fetchImpl);
    dsns[key] = await projectDsn(base, token, org.slug, project.slug, fetchImpl);
  }
  return dsns;
}

/** GitHub write-back (nas): the api's DSN as a secret, the frontends' as variables */
export function writeBackDsns(stack, dsns) {
  const env = stack.githubEnvironment;
  execFileSync('gh', ['secret', 'set', 'API_SENTRY_DSN', '--env', env, '--body', dsns.api]);
  execFileSync('gh', ['variable', 'set', 'VITE_GLITCHTIP_DSN', '--env', env, '--body', dsns.web]);
  execFileSync('gh', ['variable', 'set', 'VITE_GLITCHTIP_DSN_ADMIN', '--env', env, '--body', dsns.admin]);
  execFileSync('gh', ['variable', 'set', 'NATIVE_GLITCHTIP_DSN_ANDROID', '--env', env, '--body', dsns.android]);
  execFileSync('gh', ['variable', 'set', 'NATIVE_GLITCHTIP_DSN_IOS', '--env', env, '--body', dsns.ios]);
}

/** true once GlitchTip accepts the token — the shared stack's seed has landed */
export async function glitchtipAnswers(shared, token, fetchImpl = localAwareFetch) {
  try {
    const res = await fetchImpl(`${shared.urls.glitchtip}/api/0/organizations/`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** delete the environment's projects in the platform's org; returns {removed, absent} */
export async function removeProjects(shared, stack, token, { fetchImpl = localAwareFetch } = {}) {
  const base = shared.urls.glitchtip;
  const wanted = PROJECTS.map(([, suffix]) => `${stack.stack}-${suffix}`);
  const removed = [];
  for (const org of await api(base, token, '/organizations/', {}, fetchImpl)) {
    for (const p of await api(base, token, `/organizations/${org.slug}/projects/`, {}, fetchImpl)) {
      if (!wanted.includes(p.name) && !wanted.includes(p.slug)) continue;
      await api(base, token, `/projects/${org.slug}/${p.slug}/`, { method: 'DELETE' }, fetchImpl);
      removed.push(p.name);
    }
  }
  return { removed, absent: wanted.filter((n) => !removed.includes(n)) };
}
