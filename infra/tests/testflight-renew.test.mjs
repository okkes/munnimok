// TestFlight renewal (user 2026-10-09): a TestFlight build expires 90 days after its
// upload, so the weekly workflow asks App Store Connect for every iOS environment's
// newest build and rebuilds the stack when fewer than 30 days are left. The pure
// parts of the script (days left, the verdict, the App Store Connect calls against
// a fake fetch) and the workflow's shape are pinned here; the ES256 token itself is
// the same code every asc-*.js script runs live.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { RENEW_UNDER_DAYS, daysLeft, decide, latestBuild, row } = require('../../.github/scripts/asc-build-expiry.js');
const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const NOW = Date.parse('2026-10-09T12:00:00Z');
const build = (over = {}) => ({ id: 'b1', attributes: { version: '812', uploadedDate: '2026-09-01T10:00:00Z', expirationDate: '2026-11-30T10:00:00Z', expired: false, processingState: 'VALID', ...over } });

test('daysLeft: whole days until the date, negative once it passed, null without a date', () => {
  assert.equal(daysLeft('2026-11-08T12:00:00Z', NOW), 30);
  assert.equal(daysLeft('2026-11-08T11:59:00Z', NOW), 29, 'a part of a day is not a day');
  assert.equal(daysLeft('2026-10-01T00:00:00Z', NOW), -9);
  assert.equal(daysLeft(undefined, NOW), null);
  assert.equal(daysLeft('not a date', NOW), null);
});

test('decide: no build, an expired build and fewer than 30 days left all renew; 30 or more days left, and a build without a date, are left alone', () => {
  assert.equal(RENEW_UNDER_DAYS, 30);
  assert.deepEqual(decide(null, { now: NOW }), { renew: true, daysLeft: null, reason: 'no build on TestFlight yet' });
  const gone = decide(build({ expired: true, expirationDate: '2026-10-01T00:00:00Z' }), { now: NOW });
  assert.equal(gone.renew, true);
  assert.match(gone.reason, /build 812 expired on 2026-10-01/);
  const passed = decide(build({ expired: false, expirationDate: '2026-10-08T00:00:00Z' }), { now: NOW });
  assert.equal(passed.renew, true, 'the date is past even when the flag lags');
  const soon = decide(build({ expirationDate: '2026-11-07T12:00:00Z' }), { now: NOW });
  assert.deepEqual(soon, { renew: true, daysLeft: 29, reason: 'build 812 expires in 29 days (under 30)' });
  const edge = decide(build({ expirationDate: '2026-11-08T12:00:00Z' }), { now: NOW });
  assert.equal(edge.renew, false, 'exactly 30 days is not under 30');
  assert.equal(edge.daysLeft, 30);
  const fine = decide(build(), { now: NOW });
  assert.equal(fine.renew, false);
  assert.match(fine.reason, /good for 51 more days/);
  assert.equal(decide(build({ expirationDate: '2026-11-07T12:00:00Z' }), { now: NOW, under: 14 }).renew, false, 'the threshold is an input');
  const dateless = decide(build({ expirationDate: null }), { now: NOW });
  assert.equal(dateless.renew, false);
  assert.match(dateless.reason, /no expiration date/);
});

test('latestBuild: the app by bundle id, then its newest build by upload date, both with the bearer; no record → app null; a refusal names the status', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === '/v1/apps') {
      const id = u.searchParams.get('filter[bundleId]');
      return { ok: true, json: async () => ({ data: id === 'app.munni.nas.prod' ? [{ id: 'app-1', attributes: { bundleId: 'app.munni.nas.prod', name: 'munni' } }] : [] }) };
    }
    if (u.pathname === '/v1/builds') {
      assert.equal(u.searchParams.get('filter[app]'), 'app-1');
      assert.equal(u.searchParams.get('sort'), '-uploadedDate');
      assert.equal(u.searchParams.get('limit'), '1');
      return { ok: true, json: async () => ({ data: [build()] }) };
    }
    return { ok: false, status: 404, json: async () => ({ errors: [{ title: 'nope' }] }) };
  };
  const hit = await latestBuild('app.munni.nas.prod', { fetchImpl, token: 'T' });
  assert.equal(hit.app.id, 'app-1');
  assert.equal(hit.build.attributes.version, '812');
  assert.ok(calls.every((c) => c.auth === 'Bearer T'));
  assert.equal(calls.length, 2);
  const none = await latestBuild('app.munni.nas.never', { fetchImpl, token: 'T' });
  assert.deepEqual(none, { app: null, build: null });
  await assert.rejects(() => latestBuild('x', { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ title: 'NOT_AUTHORIZED' }] }) }), token: 'T' }), /401 .*NOT_AUTHORIZED/);
});

test('row: the table line a person reads — bundle id, app, version, uploaded, expires, days left, verdict', () => {
  const app = { id: 'app-1', attributes: { name: 'munni' } };
  assert.equal(row('app.munni.nas.prod', app, build(), { renew: false, daysLeft: 52 }), 'app.munni.nas.prod | munni | 812 | 2026-09-01 | 2026-11-30 | 52 | ok');
  assert.equal(row('app.munni.nas.dev', app, null, { renew: true, daysLeft: null }), 'app.munni.nas.dev | munni | - | - | - | - | RENEW');
});

test('the workflow: weekly on Mondays + by hand, one check per iOS environment in its GitHub environment, actions: write to dispatch native-ios.yml for the stack on its own branch, the Android remark, no Android job', () => {
  const yml = readFileSync(at('../../.github/workflows/testflight-renew.yml'), 'utf8');
  assert.match(yml, /schedule:\s*\n\s*- cron: '0 6 \* \* 1'/, 'Mondays 06:00 UTC');
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /actions: write/);
  assert.match(yml, /environment: \$\{\{ matrix\.environment \}\}/, 'the ASC key is an environment secret');
  assert.match(yml, /matrix\.mjs --role env --feature ios/);
  assert.match(yml, /node \.github\/scripts\/asc-build-expiry\.js/);
  assert.match(yml, /gh workflow run native-ios\.yml --ref "\$\{\{ matrix\.ref \}\}" -f stack="\$\{\{ matrix\.stack \}\}"/);
  assert.match(yml, /steps\.expiry\.outputs\.renew == 'true'/);
  assert.match(yml, /ASC_KEY_P8[\s\S]*ASC_KEY_ID[\s\S]*ASC_ISSUER_ID/);
  assert.match(yml, /Play internal-testing release never expires/i, 'why there is no Android job');
  assert.ok(!/native-android\.yml/.test(yml), 'no Android dispatch');
});
