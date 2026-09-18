// Credential validators: each mirrors the server's real auth flow, so
// these specs pin the request shapes (endpoints, JWT headers/claims) and
// the verdict mapping — with fetch faked and real freshly-minted keys.
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scratchPlatforms } from './fixture.mjs';

// hermetic: the machine's real platforms/ and rendered/ (LAN-mode marker
// included) must never leak into these urls
const fx = scratchPlatforms();
const { validate } = await import('../modules/validate.mjs');
test.after(() => fx.cleanup());

const capture = (status, body = {}) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
};

const decodeJwt = (jwt) => {
  const [h, p] = jwt.split('.');
  const part = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());
  return { header: part(h), payload: part(p) };
};

const rsaPem = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const ecPem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

test('gocardless: hits token/new with both secrets; maps accept and reject', async () => {
  const { calls, fetchImpl } = capture(200);
  const ok = await validate('gocardless', { GOCARDLESS_SECRET_ID: 'id1', GOCARDLESS_SECRET_KEY: 'key1' }, { fetchImpl });
  assert.equal(ok.ok, true);
  assert.match(calls[0].url, /bankaccountdata\.gocardless\.com\/api\/v2\/token\/new\/$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { secret_id: 'id1', secret_key: 'key1' });

  const bad = await validate('gocardless', { GOCARDLESS_SECRET_ID: 'id1', GOCARDLESS_SECRET_KEY: 'nope' }, { fetchImpl: capture(401).fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /401/);

  const gap = await validate('gocardless', { GOCARDLESS_SECRET_ID: 'id1' }, { fetchImpl });
  assert.match(gap.detail, /missing: GOCARDLESS_SECRET_KEY/);
});

test('enablebanking: RS256 JWT with kid=app id, iss/aud per the server, against /aspsps', async () => {
  const { calls, fetchImpl } = capture(200);
  const verdict = await validate('enablebanking', {
    ENABLEBANKING_APPLICATION_ID: 'app-123',
    ENABLEBANKING_PRIVATE_KEY_PEM: rsaPem(),
  }, { fetchImpl });
  assert.equal(verdict.ok, true);
  assert.match(calls[0].url, /api\.enablebanking\.com\/aspsps\?country=NL$/);
  const jwt = calls[0].init.headers.authorization.replace('Bearer ', '');
  const { header, payload } = decodeJwt(jwt);
  assert.equal(header.alg, 'RS256');
  assert.equal(header.kid, 'app-123');
  assert.equal(payload.iss, 'enablebanking.com');
  assert.equal(payload.aud, 'api.enablebanking.com');
  assert.ok(payload.exp > payload.iat);

  const badPem = await validate('enablebanking', { ENABLEBANKING_APPLICATION_ID: 'a', ENABLEBANKING_PRIVATE_KEY_PEM: 'not a pem' }, { fetchImpl });
  assert.equal(badPem.ok, false);
  assert.match(badPem.detail, /PEM does not parse/);
});

test('fcm: verifies the Google Play service account\'s roles — switches the Firebase Management API on and reads the project; a missing role is named with the IAM page; without the Play tile there is nothing to check', async () => {
  const sa = { type: 'service_account', project_id: 'munni-test', private_key: rsaPem(), client_email: 'svc@munni-test.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token' };
  const scripted = (answers) => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      const [, status, body] = answers.find(([m]) => url.includes(m)) ?? [null, 500, {}];
      return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
    };
    return { calls, fetchImpl };
  };
  const fine = scripted([['oauth2.googleapis.com/token', 200, { access_token: 'tok' }], [':enable', 200, {}], ['firebase.googleapis.com/v1beta1/projects/munni-test', 404, { error: { status: 'NOT_FOUND' } }]]);
  const verdict = await validate('fcm', { PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, { fetchImpl: fine.fetchImpl });
  assert.equal(verdict.ok, true, verdict.detail);
  assert.match(verdict.detail, /both roles in munni-test/);
  assert.match(verdict.detail, /not added yet/);
  const { payload } = decodeJwt(new URLSearchParams(fine.calls[0].init.body).get('assertion'));
  assert.equal(payload.iss, sa.client_email);
  assert.match(payload.scope, /cloud-platform/);
  assert.match(fine.calls[1].url, /serviceusage\.googleapis\.com\/v1\/projects\/munni-test\/services\/firebase\.googleapis\.com:enable$/);
  assert.equal(fine.calls[1].init.headers.authorization, 'Bearer tok');

  const noRoles = scripted([['oauth2.googleapis.com/token', 200, { access_token: 'tok' }], [':enable', 403, { error: { message: 'Permission denied to enable service', status: 'PERMISSION_DENIED' } }], ['firebase.googleapis.com/v1beta1/projects/munni-test', 403, { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }]]);
  const gap = await validate('fcm', { PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, { fetchImpl: noRoles.fetchImpl });
  assert.equal(gap.ok, false);
  assert.match(gap.detail, /Service Usage Admin/);
  assert.match(gap.detail, /Firebase Admin/);
  assert.match(gap.detail, /iam-admin\/iam\?project=munni-test/);

  const apiOff = scripted([['oauth2.googleapis.com/token', 200, { access_token: 'tok' }], [':enable', 200, {}], ['firebase.googleapis.com/v1beta1/projects/munni-test', 403, { error: { message: 'Firebase Management API has not been used in project munni-test before or it is disabled', status: 'PERMISSION_DENIED' } }]]);
  const justOn = await validate('fcm', { PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, { fetchImpl: apiOff.fetchImpl });
  assert.equal(justOn.ok, true, 'a still-propagating API switch is not a missing role');
  assert.match(justOn.detail, /just switched on/);

  const noPlay = await validate('fcm', {}, { fetchImpl: fine.fetchImpl });
  assert.match(noPlay.detail, /Google Play tile first/);
  assert.match((await validate('fcm', { PLAY_SERVICE_ACCOUNT_JSON: 'nope' }, { fetchImpl: fine.fetchImpl })).detail, /no valid service-account JSON/);
});

test('playstore: parses the service account and mints an androidpublisher-scoped grant', async () => {
  const sa = { private_key: rsaPem(), client_email: 'ci@sa.test', token_uri: 'https://oauth2.googleapis.com/token' };
  const { calls, fetchImpl } = capture(200, { access_token: 'x' });
  const verdict = await validate('playstore', { PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, { fetchImpl });
  assert.equal(verdict.ok, true);
  assert.match(verdict.detail, /Play-publishing scope/);
  const { payload } = decodeJwt(new URLSearchParams(calls[0].init.body).get('assertion'));
  assert.match(payload.scope, /androidpublisher/);

  const notJson = await validate('playstore', { PLAY_SERVICE_ACCOUNT_JSON: 'nope' }, { fetchImpl });
  assert.match(notJson.detail, /not valid JSON/);
  const rejected = await validate('playstore', { PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, { fetchImpl: capture(401, {}).fetchImpl });
  assert.equal(rejected.ok, false);
});

test('ascstore: ES256 App Store Connect jwt against /v1/apps; team-id format guard', async () => {
  const p8 = Buffer.from(ecPem()).toString('base64');
  const { calls, fetchImpl } = capture(200, { data: [] });
  const verdict = await validate('ascstore', { ASC_KEY_ID: 'K1', ASC_ISSUER_ID: 'ISS', ASC_KEY_P8: p8, APPLE_TEAM_ID: 'ABCDE12345' }, { fetchImpl });
  assert.equal(verdict.ok, true);
  assert.match(calls[0].url, /appstoreconnect\.apple\.com\/v1\/apps/);
  const jwt = calls[0].init.headers.authorization.replace('Bearer ', '');
  const { header, payload } = decodeJwt(jwt);
  assert.equal(header.kid, 'K1');
  assert.equal(payload.aud, 'appstoreconnect-v1');

  const badTeam = await validate('ascstore', { ASC_KEY_ID: 'K1', ASC_ISSUER_ID: 'ISS', ASC_KEY_P8: p8, APPLE_TEAM_ID: 'nope' }, { fetchImpl });
  assert.match(badTeam.detail, /10 letters/);
  const badKey = await validate('ascstore', { ASC_KEY_ID: 'K1', ASC_ISSUER_ID: 'ISS', ASC_KEY_P8: 'AAAA' }, { fetchImpl });
  assert.match(badKey.detail, /does not parse/);
  // a raw BEGIN/END paste (no base64) is accepted too
  const rawPaste = await validate('ascstore', { ASC_KEY_ID: 'K1', ASC_ISSUER_ID: 'ISS', ASC_KEY_P8: ecPem() }, { fetchImpl });
  assert.equal(rawPaste.ok, true);
});

test('logodev: swap detection first, then search (sk) + image (pk)', async () => {
  const swapped = await validate('logodev', { LOGODEV_SECRET_KEY: 'pk_x', LOGODEV_PUBLIC_TOKEN: 'sk_y' }, { fetchImpl: capture(200).fetchImpl });
  assert.equal(swapped.ok, false);
  assert.match(swapped.detail, /swapped/);

  const { calls, fetchImpl } = capture(200);
  const good = await validate('logodev', { LOGODEV_SECRET_KEY: 'sk_x', LOGODEV_PUBLIC_TOKEN: 'pk_y' }, { fetchImpl });
  assert.equal(good.ok, true);
  assert.match(calls[0].url, /api\.logo\.dev\/search/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_x');
  assert.match(calls[1].url, /img\.logo\.dev\/google\.com\?token=pk_y/);
});

test('synology: DSM error codes come with advice; a relative path is refused before any login', async () => {
  const { dsmLoginAdvice } = await import('../modules/validate.mjs');
  assert.match(dsmLoginAdvice('DSM SYNO.API.Auth.login failed: {"code":402}'), /code 402: DSM refused the login for the application it names/);
  assert.match(dsmLoginAdvice('DSM SYNO.API.Auth.login failed: {"code":400}'), /password is wrong/);
  assert.equal(dsmLoginAdvice('DSM SYNO.API.Auth.login failed: {"code":999}'), '');
  const rel = await validate('synology', { SYNOLOGY_URL: 'https://nas.example:5001', SYNOLOGY_USER: 'deploy', SYNOLOGY_PASS: 'x', SYNOLOGY_PATH: 'docker/munni/published' });
  assert.equal(rel.ok, false);
  assert.match(rel.detail, /must be absolute/);
  // the live dir (apply.sh, the poller) is the PARENT of this path: a share root has none
  const root = await validate('synology', { SYNOLOGY_URL: 'https://nas.example:5001', SYNOLOGY_USER: 'deploy', SYNOLOGY_PASS: 'x', SYNOLOGY_PATH: '/docker' });
  assert.equal(root.ok, false);
  assert.match(root.detail, /inside a shared folder/);
});

test('synology: a DSM that never answers reads as unreachable (stored with a warning); a DSM-answered code is a refusal', async () => {
  const vals = { SYNOLOGY_URL: 'https://nas.example:5001', SYNOLOGY_USER: 'deploy', SYNOLOGY_PASS: 'x', SYNOLOGY_PATH: '/docker/munni/published' };
  const down = await validate('synology', vals, { fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; } });
  assert.equal(down.ok, false);
  assert.equal(down.unreachable, true, 'the wizard stores with a note instead of demanding "Store anyway"');
  assert.match(down.detail, /could not reach DSM.*ECONNREFUSED/);
  const refused = await validate('synology', vals, { fetchImpl: async () => ({ status: 200, json: async () => ({ success: false, error: { code: 402 } }) }) });
  assert.equal(refused.ok, false);
  assert.ok(!refused.unreachable, 'a DSM answer is a refusal, not an outage');
  assert.match(refused.detail, /code 402: DSM refused the login for the application it names/);
});

test('ghcr: the registry token must authenticate AND carry read:packages', async () => {
  const mk = (status, scopes) => async () => ({ ok: status < 400, status, headers: { get: (k) => (k === 'x-oauth-scopes' ? scopes : null) }, json: async () => ({ login: 'okkes' }) });
  const missing = await validate('ghcr', {}, { fetchImpl: mk(200, 'read:packages') });
  assert.equal(missing.ok, false);
  const rejected = await validate('ghcr', { GHCR_PAT: 'ghp_x' }, { fetchImpl: mk(401, '') });
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /401/);
  const noScope = await validate('ghcr', { GHCR_PAT: 'ghp_x' }, { fetchImpl: mk(200, 'repo') });
  assert.equal(noScope.ok, false);
  assert.match(noScope.detail, /read:packages/);
  const good = await validate('ghcr', { GHCR_PAT: 'ghp_x' }, { fetchImpl: mk(200, 'read:packages, repo') });
  assert.equal(good.ok, true);
  assert.match(good.detail, /okkes/);
});

test('google + apple: the dummy-code trick — invalid_client is the ONLY failure', async () => {
  const badGoogle = await validate('google', { LOGTO_GOOGLE_CLIENT_ID: 'a', LOGTO_GOOGLE_CLIENT_SECRET: 'b' }, { fetchImpl: capture(401, { error: 'invalid_client' }).fetchImpl });
  assert.equal(badGoogle.ok, false);
  const okGoogle = await validate('google', { LOGTO_GOOGLE_CLIENT_ID: 'a', LOGTO_GOOGLE_CLIENT_SECRET: 'b' }, { fetchImpl: capture(400, { error: 'invalid_grant' }).fetchImpl });
  assert.equal(okGoogle.ok, true);

  const appleValues = { LOGTO_APPLE_CLIENT_ID: 'app.munni.signin', LOGTO_APPLE_TEAM_ID: 'TEAM123', LOGTO_APPLE_KEY_ID: 'KEY123', LOGTO_APPLE_PRIVATE_KEY: ecPem() };
  const { calls, fetchImpl } = capture(400, { error: 'invalid_grant' });
  const okApple = await validate('apple', appleValues, { fetchImpl });
  assert.equal(okApple.ok, true);
  const secret = new URLSearchParams(calls[0].init.body).get('client_secret');
  const { header, payload } = decodeJwt(secret);
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'KEY123');
  assert.equal(payload.iss, 'TEAM123');
  assert.equal(payload.sub, 'app.munni.signin');
  const badApple = await validate('apple', appleValues, { fetchImpl: capture(401, { error: 'invalid_client' }).fetchImpl });
  assert.equal(badApple.ok, false);
});

test('google + apple: every callback the page names is judged too — a refused one warns and names itself; the Team ID falls back to the TestFlight card', async () => {
  // Google's authError is a base64url proto whose first field is the error code
  const authErr = (code) => Buffer.from(`\n${String.fromCharCode(code.length)}${code}\x12\x04oops`, 'latin1').toString('base64url');
  const uriOf = (url) => decodeURIComponent(/redirect_uri=([^&]+)/.exec(url)[1]);
  const google = async (url) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    const refused = uriOf(url).includes('munni-dev');
    const location = refused
      ? `https://accounts.google.com/signin/oauth/error?authError=${authErr('redirect_uri_mismatch')}&client_id=a`
      : 'https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow';
    return { ok: false, status: 302, headers: { get: (k) => (k === 'location' ? location : null) }, text: async () => '' };
  };
  const uris = ['https://munni-prod-logto.192-168-2-2.sslip.io/callback/google-universal', 'https://munni-dev-logto.192-168-2-2.sslip.io/callback/google-universal'];
  const creds = { LOGTO_GOOGLE_CLIENT_ID: 'a', LOGTO_GOOGLE_CLIENT_SECRET: 'b' };
  const g = await validate('google', creds, { fetchImpl: google, redirectUris: uris });
  assert.equal(g.ok, true, 'the credentials themselves are fine');
  assert.equal(g.warn, true);
  assert.match(g.detail, /munni-dev-logto\S* \(redirect_uri_mismatch\)/);
  assert.doesNotMatch(g.detail, /munni-prod-logto/);
  const gOk = await validate('google', creds, { fetchImpl: google, redirectUris: [uris[0]] });
  assert.equal(gOk.warn, undefined);
  assert.match(gOk.detail, /accepts all 1 redirect URI/);
  // a probe that cannot be reached never blocks
  const flaky = async (url) => (url.startsWith('https://oauth2.googleapis.com/token') ? { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } : Promise.reject(new Error('ECONNRESET')));
  assert.equal((await validate('google', creds, { fetchImpl: flaky, redirectUris: uris })).warn, undefined);

  // Apple embeds {"errorCode":"…"} in its authorize page when it refuses
  const apple = async (url) => {
    if (url.startsWith('https://appleid.apple.com/auth/token')) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    const refused = uriOf(url).includes('munni-dev');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => (refused ? '{"direct":{"errorMessage":"Invalid client.","errorCode":"invalid_client"}}' : '<title>Sign in to Apple Account</title>') };
  };
  const appleValues = { LOGTO_APPLE_CLIENT_ID: 'app.munni.signin', APPLE_TEAM_ID: 'TEAM123', LOGTO_APPLE_KEY_ID: 'KEY123', LOGTO_APPLE_PRIVATE_KEY: ecPem() };
  const a = await validate('apple', appleValues, { fetchImpl: apple, redirectUris: uris.map((u) => u.replace('google', 'apple')) });
  assert.equal(a.ok, true);
  assert.equal(a.warn, true);
  assert.match(a.detail, /munni-dev-logto\S* \(invalid_client: Invalid client\.\)/, 'Apple’s own message rides along');
  assert.match(a.detail, /Services ID/);
  // the live 2026-09-09 mix-up: the App ID pasted as client id — named before Apple is even asked
  const mixup = await validate('apple', { ...appleValues, LOGTO_APPLE_CLIENT_ID: 'app.munni.local.prod' }, { fetchImpl: apple, iosAppIds: ['app.munni', 'app.munni.local.prod'] });
  assert.equal(mixup.ok, false);
  assert.match(mixup.detail, /app\.munni\.local\.prod is the App ID .* needs the SERVICES ID identifier/);
  // Apple's invalid_request (unsaved configuration, or a non-Services client) gets its own hint
  const unsaved = async (url) => {
    if (url.startsWith('https://appleid.apple.com/auth/token')) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"direct":{"errorMessage":"Invalid client id or web redirect url.","errorCode":"invalid_request"}}' };
  };
  const u = await validate('apple', appleValues, { fetchImpl: unsaved, redirectUris: [uris[0]] });
  assert.equal(u.warn, true);
  assert.match(u.detail, /invalid_request: Invalid client id or web redirect url\./);
  assert.match(u.detail, /never saved \(Configure → Done → Continue → Save\)/);
  const missingTeam = await validate('apple', { ...appleValues, APPLE_TEAM_ID: undefined }, { fetchImpl: apple });
  assert.equal(missingTeam.ok, false, 'no Team ID anywhere → named as missing');
  assert.match(missingTeam.detail, /LOGTO_APPLE_TEAM_ID/);
});

test('local logto/glitchtip validators target the lcl platform\'s stacks (the first environment\'s Logto, the shared GlitchTip); without an environment the Logto check says so', async () => {
  const logto = capture(200);
  const okM2m = await validate('logto-m2m', { LOGTO_INFRA_M2M_ID: 'id', LOGTO_INFRA_M2M_SECRET: 's' }, { fetchImpl: logto.fetchImpl });
  assert.equal(okM2m.ok, true);
  assert.match(logto.calls[0].url, /^http:\/\/localhost:3201\/oidc\/token$/);
  assert.match(logto.calls[0].init.headers.authorization, /^Basic /);
  assert.equal((await validate('logto-m2m', { LOGTO_INFRA_M2M_ID: 'id', LOGTO_INFRA_M2M_SECRET: 's' }, { fetchImpl: capture(401).fetchImpl })).ok, false);

  const gt = capture(200);
  const okGt = await validate('glitchtip-token', { GLITCHTIP_API_TOKEN: 't' }, { fetchImpl: gt.fetchImpl });
  assert.equal(okGt.ok, true);
  assert.match(gt.calls[0].url, /^http:\/\/localhost:8383\/api\/0\/organizations\/$/);

  fx.removeEnv('lcl', 'prod');
  fx.removeEnv('lcl', 'dev');
  try {
    const none = await validate('logto-m2m', { LOGTO_INFRA_M2M_ID: 'id', LOGTO_INFRA_M2M_SECRET: 's' }, { fetchImpl: capture(200).fetchImpl });
    assert.equal(none.ok, false);
    assert.match(none.detail, /no local environment exists yet/);
  } finally {
    fx.writeEnv('lcl', { env: 'prod', slot: 0, channel: 'dev' });
    fx.writeEnv('lcl', { env: 'dev', slot: 1, channel: 'dev' });
  }
});

test('network failures come back as unreachable, unknown providers refuse', async () => {
  const down = await validate('gocardless', { GOCARDLESS_SECRET_ID: 'a', GOCARDLESS_SECRET_KEY: 'b' }, { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(down.ok, false);
  assert.equal(down.unreachable, true);
  const unknown = await validate('rm -rf', {});
  assert.match(unknown.detail, /no validator/);
});

test('synology: the check says whether DSM treats the session as an administrator from this PC — a plain-user session is stored with a warning and never dispatches', async () => {
  const vals = { SYNOLOGY_URL: 'https://nas.example:5001', SYNOLOGY_USER: 'deploy', SYNOLOGY_PASS: 'x' };
  const dsm = (isAdmin) => async (url, init) => {
    const p = Object.fromEntries(new URLSearchParams(init.body));
    return { status: 200, json: async () => ({ success: true, data: p.api === 'SYNO.Core.Desktop.Initdata' ? { Session: { is_admin: isAdmin } } : { sid: 'S', synotoken: 'T' } }) };
  };
  const admin = await validate('synology', vals, { fetchImpl: dsm(true) });
  assert.equal(admin.ok, true);
  assert.equal(admin.admin, true);
  assert.match(admin.detail, /administrator from this PC ✓/);
  const plain = await validate('synology', vals, { fetchImpl: dsm(false) });
  assert.equal(plain.ok, true);
  assert.equal(plain.warn, true);
  assert.equal(plain.admin, false);
  assert.match(plain.detail, /NON-administrator from this PC.*Adaptive MFA/);
});
