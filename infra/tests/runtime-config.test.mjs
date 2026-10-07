// The web image's start script (deploy/nginx/40-runtime-config.sh) against a
// temp html root: the runtime overlay and the two app-link files of THIS
// deployment's own app — rendered from env, never per channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'nginx', '40-runtime-config.sh');

function run(env) {
  const root = mkdtempSync(join(tmpdir(), 'munni-web-root-'));
  const out = execFileSync('sh', [SCRIPT], { env: { PATH: process.env.PATH, MUNNI_HTML_ROOT: root, MUNNI_CSP_SNIPPET: join(root, 'no-snippet'), ...env }, encoding: 'utf8' });
  const read = (f) => readFileSync(join(root, f), 'utf8');
  return { out, config: read('runtime-config.js'), assetlinks: JSON.parse(read('.well-known/assetlinks.json')), aasa: JSON.parse(read('.well-known/apple-app-site-association')) };
}

test('40-runtime-config: the overlay carries the MUNNI_* values; the app-link files claim exactly this deployment\'s app (fingerprints upper-cased, several allowed)', () => {
  const r = run({
    MUNNI_API_URL: 'https://munni-prod-nas-api.example', MUNNI_NATIVE_SCHEME: 'munni-prod-nas',
    MUNNI_ANDROID_PACKAGE: 'app.munni.nas.prod', MUNNI_ANDROID_CERT_SHA256: 'aa:bb:cc, DD:EE:FF',
    MUNNI_APPLE_TEAM_ID: 'TEAM123456', MUNNI_IOS_BUNDLE_ID: 'app.munni.nas.prod',
  });
  assert.match(r.config, /"API_URL":"https:\/\/munni-prod-nas-api\.example"/);
  assert.match(r.config, /"NATIVE_SCHEME":"munni-prod-nas"/);
  assert.deepEqual(r.assetlinks, [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'app.munni.nas.prod', sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'] } }]);
  assert.deepEqual(r.aasa.applinks.details[0].appIDs, ['TEAM123456.app.munni.nas.prod']);
  assert.deepEqual(r.aasa.applinks.details[0].components.map((c) => c['/']), ['/gc-callback*', '/splits/join/*', '/invite*', '/native-auth*', '/native-signed-out*']);
  assert.match(r.out, /assetlinks\.json claims app\.munni\.nas\.prod/);
});

test('40-runtime-config: without a fingerprint or a team id the files claim nothing — never a stale or a foreign app', () => {
  const r = run({ MUNNI_ANDROID_PACKAGE: 'app.munni.nas.dev', MUNNI_IOS_BUNDLE_ID: 'app.munni.nas.dev' });
  assert.deepEqual(r.assetlinks, []);
  assert.deepEqual(r.aasa, { applinks: { details: [] } });
  assert.match(r.config, /^window\.__MUNNI_CONFIG__=\{\};$/m, 'no MUNNI_* app values → the baked config applies');
});
