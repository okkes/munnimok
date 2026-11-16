// automatic signing archives against a DEVELOPMENT profile, which Apple issues only for a team with an ENABLED device:
// ask first so a team without one is a notice naming the fix, not an "ARCHIVE FAILED" on every push; never fails the build
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

// one line per output: a value with a line break in it would otherwise write a second output of its own
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${String(v).replace(/[\r\n]+/g, ' ')}\n`); };

// exitCode, not process.exit(): exiting while the fetch socket is closing trips a libuv assertion on Windows
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
