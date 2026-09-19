// Automatic signing archives against a DEVELOPMENT profile (the export re-signs
// for the store), and Apple issues one only for a team with at least one
// ENABLED registered device. Ask before archiving so a team without one is a
// notice naming the one-click fix — never an "ARCHIVE FAILED" on every push
// (nas-dev 2026-09-19: three iPhones registered, all disabled since the wipe).
//
// Env: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID. Writes enabled=<n>|unknown and
// disabled=<n> to GITHUB_OUTPUT and never fails the build — a probe that cannot
// answer leaves the archive to decide, as before.
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
  try {
    const res = await fetch('https://api.appstoreconnect.apple.com/v1/devices?filter%5Bplatform%5D=IOS&limit=200', { headers: { Authorization: `Bearer ${jwt()}` } });
    const body = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body.errors ?? body)}`);
    const list = body.data ?? [];
    const enabled = list.filter((d) => d.attributes?.status === 'ENABLED').length;
    const disabled = list.length - enabled;
    console.log(`Apple team devices (iOS): ${enabled} enabled, ${disabled} disabled${enabled ? ' — automatic signing can archive' : ' — nothing to generate a development profile from'}`);
    out('enabled', String(enabled));
    out('disabled', String(disabled));
  } catch (e) {
    console.log(`::warning title=Device check skipped::could not ask App Store Connect (${e.message}) — the archive decides`);
    out('enabled', 'unknown');
    out('disabled', '0');
  }
}

main();
