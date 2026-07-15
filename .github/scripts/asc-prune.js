// Prune the Apple Development certificates that pile up from
// ephemeral-runner archives (each CI run mints one; unchecked they hit
// Apple's cap: "Choose a certificate to revoke").
//
// Race-safe without any cross-branch serialization: a cert younger than
// AGE_GUARD may belong to a run still archiving/exporting, so it is
// skipped — creation time is derived from expirationDate (dev certs are
// valid ~1 year). Distribution certificates are never touched.
//
// Env: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID.
const crypto = require('crypto');
const fs = require('fs');

const AGE_GUARD_MS = 6 * 3600 * 1000; // no run lives longer than this
const VALIDITY_MS = 365 * 24 * 3600 * 1000; // approx dev-cert lifetime

function jwt() {
  const key = fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8');
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
  // JOSE wants the raw r||s signature, not ASN.1/DER
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

async function main() {
  const auth = { Authorization: `Bearer ${jwt()}` };
  const url = 'https://api.appstoreconnect.apple.com/v1/certificates?filter%5BcertificateType%5D=DEVELOPMENT,IOS_DEVELOPMENT&limit=200';
  const res = await fetch(url, { headers: auth });
  const body = await res.json();
  if (!res.ok) throw new Error(`certificate list failed: ${res.status} ${JSON.stringify(body.errors ?? body)}`);

  let pruned = 0;
  for (const cert of body.data ?? []) {
    const createdAt = new Date(cert.attributes.expirationDate).getTime() - VALIDITY_MS;
    if (Date.now() - createdAt < AGE_GUARD_MS) {
      console.log(`keeping ${cert.id} (${cert.attributes.displayName ?? cert.attributes.name}) — young enough to belong to a running build`);
      continue;
    }
    const del = await fetch(`https://api.appstoreconnect.apple.com/v1/certificates/${cert.id}`, { method: 'DELETE', headers: auth });
    console.log(`revoked ${cert.id} (${cert.attributes.displayName ?? cert.attributes.name}) -> HTTP ${del.status}`);
    pruned++;
  }
  console.log(`${pruned} development certificate(s) pruned, ${(body.data ?? []).length - pruned} kept`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
