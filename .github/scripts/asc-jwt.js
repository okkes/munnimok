// Mint a short-lived App Store Connect API JWT (ES256) from the CI's
// ASC key. Used by native-ios.yml to prune the development certificates
// that pile up from ephemeral-runner archives. Env: ASC_KEY_PATH,
// ASC_KEY_ID, ASC_ISSUER_ID. Prints the token to stdout.
const crypto = require('crypto');
const fs = require('fs');

const key = fs.readFileSync(process.env.ASC_KEY_PATH, 'utf8');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' }));
const now = Math.floor(Date.now() / 1000);
const payload = b64url(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));

// JOSE wants the raw r||s signature, not ASN.1/DER
const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
process.stdout.write(`${header}.${payload}.${b64url(signature)}`);
