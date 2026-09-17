// GlitchTip as code: ONE GlitchTip per platform (the shared stack), one
// org + team per platform, five projects per environment — against a
// faked Sentry-shaped API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms, fakeGh, DOMAIN } from './fixture.mjs';

const fx = scratchPlatforms();
const { applyGlitchTip, glitchtipAnswers, removeProjects, writeBackDsns, orgSlug, PROJECTS } = await import('../modules/glitchtip.mjs');
const { loadStack } = await import('../modules/stack.mjs');
test.after(() => fx.cleanup());

function fakeGlitchTip() {
  const state = { orgs: [], teams: [], projects: [], keys: {}, writes: 0, tokens: new Set(), hosts: new Set() };
  const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    const { pathname, host } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.tokens.add(init.headers?.authorization);
    state.hosts.add(host);
    if (method !== 'GET') state.writes += 1;
    if (pathname === '/api/0/organizations/') {
      if (method === 'GET') return respond(state.orgs);
      const org = { name: body.name, slug: body.name.toLowerCase() };
      state.orgs.push(org);
      return respond(org);
    }
    let m = /^\/api\/0\/organizations\/([^/]+)\/teams\/$/.exec(pathname);
    if (m) {
      if (method === 'GET') return respond(state.teams.filter((t) => t.org === m[1]));
      const team = { org: m[1], slug: body.slug };
      state.teams.push(team);
      return respond(team);
    }
    m = /^\/api\/0\/organizations\/([^/]+)\/projects\/$/.exec(pathname);
    if (m) return respond(state.projects.filter((p) => p.org === m[1]));
    m = /^\/api\/0\/teams\/([^/]+)\/([^/]+)\/projects\/$/.exec(pathname);
    if (m && method === 'POST') {
      const project = { org: m[1], team: m[2], name: body.name, slug: body.name, platform: body.platform };
      state.projects.push(project);
      return respond(project);
    }
    m = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/keys\/$/.exec(pathname);
    if (m) {
      const id = `${m[1]}/${m[2]}`;
      if (method === 'GET') return respond(state.keys[id] ?? []);
      const key = { dsn: { public: `https://key@glitchtip.test/${Object.keys(state.keys).length + 1}` } };
      state.keys[id] = [key];
      return respond(key);
    }
    m = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/$/.exec(pathname);
    if (m && method === 'DELETE') {
      state.projects = state.projects.filter((p) => !(p.org === m[1] && p.slug === m[2]));
      return { ok: true, status: 204, text: async () => '' };
    }
    return respond({ detail: `unhandled ${method} ${pathname}` }, 404);
  };
  return { state, fetchImpl };
}

const shared = () => loadStack('munni-nas-shared');
const prod = () => loadStack('munni-nas-prod');
const staging = () => loadStack('munni-nas-staging');

test('applyGlitchTip: the platform\'s org + team (munni-<platform>) and the environment\'s five projects, at the shared stack\'s GlitchTip with the platform token; five DSNs come back', async () => {
  const { state, fetchImpl } = fakeGlitchTip();
  const dsns = await applyGlitchTip(shared(), prod(), 'tok-123', { fetchImpl });
  assert.deepEqual(Object.keys(dsns).sort(), ['admin', 'android', 'api', 'ios', 'web']);
  for (const dsn of Object.values(dsns)) assert.match(dsn, /^https:\/\/key@glitchtip\.test\/\d+$/);
  assert.equal(new Set(Object.values(dsns)).size, 5, 'one key per project');
  assert.equal(orgSlug('nas'), 'munni-nas');
  assert.deepEqual(state.orgs, [{ name: 'munni-nas', slug: 'munni-nas' }]);
  assert.deepEqual(state.teams, [{ org: 'munni-nas', slug: 'munni-nas' }]);
  assert.deepEqual(state.projects.map((p) => [p.slug, p.platform]).sort(), [
    ['munni-nas-prod-admin', 'javascript'], ['munni-nas-prod-android', 'javascript'], ['munni-nas-prod-api', 'csharp'], ['munni-nas-prod-ios', 'javascript'], ['munni-nas-prod-pwa', 'javascript'],
  ]);
  assert.equal(PROJECTS.length, 5);
  assert.deepEqual([...state.tokens], ['Bearer tok-123']);
  assert.deepEqual([...state.hosts], [`glitchtip-nas.${DOMAIN}`], 'the shared stack\'s GlitchTip');

  const writes = state.writes;
  assert.deepEqual(await applyGlitchTip(shared(), prod(), 'tok-123', { fetchImpl }), dsns, 'idempotent: the same DSNs');
  assert.equal(state.writes, writes, 'and no write at all');

  const more = await applyGlitchTip(shared(), staging(), 'tok-123', { fetchImpl });
  assert.equal(new Set([...Object.values(dsns), ...Object.values(more)]).size, 10, 'another environment: its own five projects and keys');
  assert.equal(state.orgs.length, 1, 'one org per platform');
  assert.equal(state.teams.length, 1);
  assert.equal(state.projects.length, 10);
});

test('applyGlitchTip surfaces API failures with status and body', async () => {
  await assert.rejects(() => applyGlitchTip(shared(), prod(), 'bad', { fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid token', json: async () => ({}) }) }), /401.*invalid token/s);
  await assert.rejects(() => applyGlitchTip(shared(), prod(), 't', { fetchImpl: async (url, init = {}) => (init.method === 'POST' && url.endsWith('/keys/') ? { ok: true, status: 200, json: async () => ({ dsn: {} }), text: async () => '{}' } : { ok: true, status: 200, json: async () => (init.method === 'POST' ? { name: 'x', slug: 'x' } : []), text: async () => '[]' }) }), /without a public DSN/);
});

test('glitchtipAnswers: a 200 with the token means the seed landed; 401 or no answer means not yet', async () => {
  const seen = [];
  const answers = async (url, init) => { seen.push({ url, auth: init.headers.authorization }); return { ok: true }; };
  assert.equal(await glitchtipAnswers(shared(), 'tok', answers), true);
  assert.deepEqual(seen, [{ url: `https://glitchtip-nas.${DOMAIN}/api/0/organizations/`, auth: 'Bearer tok' }]);
  assert.equal(await glitchtipAnswers(shared(), 'tok', async () => ({ ok: false, status: 401 })), false);
  assert.equal(await glitchtipAnswers(shared(), 'tok', async () => { throw new Error('ECONNREFUSED'); }), false);
});

test('removeProjects: the environment\'s five projects go from the platform\'s org, another environment\'s stay; the ones already gone are named absent', async () => {
  const { state, fetchImpl } = fakeGlitchTip();
  await applyGlitchTip(shared(), prod(), 'tok', { fetchImpl });
  await applyGlitchTip(shared(), staging(), 'tok', { fetchImpl });
  const r = await removeProjects(shared(), staging(), 'tok', { fetchImpl });
  assert.deepEqual(r, { removed: ['munni-nas-staging-pwa', 'munni-nas-staging-api', 'munni-nas-staging-admin', 'munni-nas-staging-android', 'munni-nas-staging-ios'], absent: [] });
  assert.deepEqual(state.projects.map((p) => p.slug).sort(), ['munni-nas-prod-admin', 'munni-nas-prod-android', 'munni-nas-prod-api', 'munni-nas-prod-ios', 'munni-nas-prod-pwa']);
  state.projects = state.projects.filter((p) => p.slug !== 'munni-nas-prod-ios');
  assert.deepEqual(await removeProjects(shared(), prod(), 'tok', { fetchImpl }), { removed: ['munni-nas-prod-pwa', 'munni-nas-prod-api', 'munni-nas-prod-admin', 'munni-nas-prod-android'], absent: ['munni-nas-prod-ios'] });
  assert.deepEqual(state.projects, []);
});

test('writeBackDsns: the api\'s DSN becomes a secret of the environment, the frontends\' and the phones\' become variables', () => {
  const gh = fakeGh();
  try {
    gh.seed('nas-prod');
    writeBackDsns(prod(), { api: 'dsn-api', web: 'dsn-web', admin: 'dsn-admin', android: 'dsn-android', ios: 'dsn-ios' });
    assert.deepEqual(gh.secrets('nas-prod'), { API_SENTRY_DSN: 'dsn-api' });
    assert.deepEqual(gh.variables('nas-prod'), { VITE_GLITCHTIP_DSN: 'dsn-web', VITE_GLITCHTIP_DSN_ADMIN: 'dsn-admin', NATIVE_GLITCHTIP_DSN_ANDROID: 'dsn-android', NATIVE_GLITCHTIP_DSN_IOS: 'dsn-ios' });
  } finally {
    gh.cleanup();
  }
});
