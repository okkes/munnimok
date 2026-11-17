// revokes piled-up Development certs (each CI run without a persistent cert mints one; Apple's cap refuses more)
// the KEEP_NEWEST by expirationDate are spared (maybe in flight); age cannot come from expiry (certs are short-lived)
// PROTECT_SERIALS (the team's ONE persistent APPLE_DEV_CERT_P12) never revoke; serials ignore case and leading zeros
const crypto = require('node:crypto');
const fs = require('node:fs');

// dev + master in flight + one margin; the iOS workflow passes 1 once a persistent cert signs, the mint workflow 0
const KEEP_NEWEST = Number(process.env.KEEP_NEWEST ?? 3);
const DRY_RUN = process.env.DRY_RUN === '1';
const normSerial = (s) => String(s ?? '').trim().toUpperCase().replace(/^0+/, '');
const PROTECT = new Set((process.env.PROTECT_SERIALS ?? '').split(/[\s,]+/).map(normSerial).filter(Boolean));

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

  const certs = [...(body.data ?? [])].sort(
    (a, b) => new Date(b.attributes.expirationDate).getTime() - new Date(a.attributes.expirationDate).getTime(),
  );
  const seen = new Set();
  let pruned = 0;
  let kept = 0;
  let protectedCount = 0;
  for (const cert of certs) {
    const serial = normSerial(cert.attributes.serialNumber);
    const label = `${cert.id} (serial ${serial}, expires ${cert.attributes.expirationDate})`;
    if (PROTECT.has(serial)) {
      seen.add(serial);
      protectedCount++;
      console.log(`protected ${label} — the persistent certificate`);
      continue;
    }
    if (kept < KEEP_NEWEST) {
      kept++;
      console.log(`keeping ${label} — among the ${KEEP_NEWEST} newest`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`would revoke ${label}`);
      pruned++;
      continue;
    }
    const del = await fetch(`https://api.appstoreconnect.apple.com/v1/certificates/${cert.id}`, { method: 'DELETE', headers: auth });
    console.log(`revoked ${label} -> HTTP ${del.status}`);
    pruned++;
  }
  for (const serial of PROTECT) {
    if (!seen.has(serial)) console.log(`note: protected serial ${serial} is not among the team's Development certificates (revoked or expired?)`);
  }
  console.log(`${DRY_RUN ? 'dry run: ' : ''}${pruned} development certificate(s) ${DRY_RUN ? 'to prune' : 'pruned'}, ${kept} kept, ${protectedCount} protected`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
