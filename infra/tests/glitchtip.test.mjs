// GlitchTip-as-code: org/team/projects ensured idempotently, DSNs
// returned per stack — against a faked Sentry-shaped API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGlitchTip } from '../modules/glitchtip.mjs';

function fakeGlitchTip() {
  const state = { orgs: [], teams: [], projects: [], keys: {}, writes: 0, tokens: new Set() };
  const respond = (body, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.tokens.add(init.headers?.authorization);
    if (method === 'POST') state.writes += 1;

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
    return respond({ detail: `unhandled ${method} ${pathname}` }, 404);
  };
  return { state, fetchImpl };
}

const pairStack = { urls: { glitchtip: 'https://glitchtip.test' } };
const stack = { pair: 'munni-iac', stack: 'munni-iac-prod' };

test('applyGlitchTip creates org + team + per-stack projects and returns their DSNs', async () => {
  const { state, fetchImpl } = fakeGlitchTip();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const dsns = await applyGlitchTip(pairStack, stack, 'tok-123');
    assert.deepEqual(Object.keys(dsns).sort(), ['admin', 'api', 'web']);
    for (const dsn of Object.values(dsns)) assert.match(dsn, /^https:\/\/key@glitchtip\.test\/\d+$/);
    assert.equal(state.orgs[0].slug, 'munni-iac');
    assert.deepEqual(
      state.projects.map((p) => p.slug).sort(),
      ['munni-iac-prod-admin', 'munni-iac-prod-api', 'munni-iac-prod-pwa'],
    );
    assert.deepEqual([...state.tokens], ['Bearer tok-123']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('applyGlitchTip is idempotent: a second run performs zero writes and returns the same DSNs', async () => {
  const { state, fetchImpl } = fakeGlitchTip();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const first = await applyGlitchTip(pairStack, stack, 'tok-123');
    const writesAfterFirst = state.writes;
    const second = await applyGlitchTip(pairStack, stack, 'tok-123');
    assert.deepEqual(second, first);
    assert.equal(state.writes, writesAfterFirst);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('applyGlitchTip surfaces API failures with status and body', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid token', json: async () => ({}) });
  try {
    await assert.rejects(() => applyGlitchTip(pairStack, stack, 'bad'), /401.*invalid token/s);
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { glitchtipAnswers } from '../modules/glitchtip.mjs';
test('glitchtipAnswers: a 200 with the token means the seed landed; 401 or no answer means not yet', async () => {
  const pair = { urls: { glitchtip: 'http://gt.test' } };
  const seen = [];
  const ok = async (url, init) => { seen.push({ url, auth: init.headers.authorization }); return { ok: true }; };
  assert.equal(await glitchtipAnswers(pair, 'tok', ok), true);
  assert.deepEqual(seen, [{ url: 'http://gt.test/api/0/organizations/', auth: 'Bearer tok' }]);
  assert.equal(await glitchtipAnswers(pair, 'tok', async () => ({ ok: false, status: 401 })), false);
  assert.equal(await glitchtipAnswers(pair, 'tok', async () => { throw new Error('ECONNREFUSED'); }), false);
});

import { removeProjects } from '../modules/glitchtip.mjs';
test('removeProjects: the stack\'s three projects go from the pair\'s org; others stay', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.endsWith('/organizations/')) return { ok: true, status: 200, json: async () => [{ slug: 'munni-iac', name: 'munni-iac' }] };
    if (url.endsWith('/organizations/munni-iac/projects/')) return { ok: true, status: 200, json: async () => [{ slug: 'munni-iac-staging-pwa', name: 'munni-iac-staging-pwa' }, { slug: 'munni-iac-staging-api', name: 'munni-iac-staging-api' }, { slug: 'munni-iac-prod-pwa', name: 'munni-iac-prod-pwa' }] };
    return { ok: true, status: 204 };
  };
  const r = await removeProjects({ urls: { glitchtip: 'http://gt.test' }, pair: 'munni-iac' }, { stack: 'munni-iac-staging' }, 'tok', fetchImpl);
  assert.deepEqual(r, { removed: ['munni-iac-staging-pwa', 'munni-iac-staging-api'], absent: ['munni-iac-staging-admin'] });
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url), ['http://gt.test/api/0/projects/munni-iac/munni-iac-staging-pwa/', 'http://gt.test/api/0/projects/munni-iac/munni-iac-staging-api/']);
});
