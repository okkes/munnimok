// Apple keeps ONE step of the phone pipeline manual: the App Store Connect
// app record (there is no create-API). Before exporting, ask whether the
// record exists so a missing one is a notice, never an "EXPORT FAILED".
//
// Env: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, BUNDLE_ID. Writes
// exists=true|false|unknown (+ app=<name> when found) to GITHUB_OUTPUT and
// never fails the build — a probe that cannot answer leaves the export to
// decide, as before.
const crypto = require('node:crypto');
const fs = require('node:fs');

function jwt() {
  const key = fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8');
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

// exitCode instead of process.exit(): exiting while the fetch socket is
// still closing trips a libuv assertion on Windows (seen 2026-09-09)
async function main() {
  const bundleId = String(process.env.BUNDLE_ID ?? '').trim();
  if (!bundleId) { console.log('::warning title=App record check skipped::BUNDLE_ID is empty'); out('exists', 'unknown'); return; }
  try {
    const url = `https://api.appstoreconnect.apple.com/v1/apps?filter%5BbundleId%5D=${encodeURIComponent(bundleId)}&limit=5`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt()}` } });
    const body = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body.errors ?? body)}`);
    const app = (body.data ?? []).find((a) => a.attributes?.bundleId === bundleId);
    if (app) {
      console.log(`App Store Connect record for ${bundleId}: "${app.attributes.name}" (${app.id}) — the export uploads to TestFlight`);
      out('exists', 'true');
      out('app', app.attributes.name);
    } else {
      console.log(`App Store Connect has no app record for ${bundleId} yet — the ONE step Apple keeps manual`);
      out('exists', 'false');
    }
  } catch (e) {
    console.log(`::warning title=App record check skipped::could not ask App Store Connect (${e.message}) — the export decides`);
    out('exists', 'unknown');
  }
}

main();
