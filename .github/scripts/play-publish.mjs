// Publish an .aab to a Play track with the bare androidpublisher API —
// replaces r0adkll/upload-google-play (deprecated 'track' input, ancient
// googleapis client full of DEP0040/DEP0169 noise, no retry when a
// concurrent edit — the wizard's store probe, an open Play Console tab —
// expires ours). Env: PLAY_JSON, PACKAGE, AAB_PATH, MAPPING_PATH?, TRACK?
import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const b64url = (b) => Buffer.from(b).toString('base64url');

async function token(sa) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: sa.token_uri,
    iat: now,
    exp: now + 600,
  }))}`;
  const sig = createSign('RSA-SHA256').update(input).end().sign(sa.private_key);
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${b64url(sig)}` }).toString(),
  });
  if (!res.ok) throw new Error(`token mint failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function publishOnce(access, { PACKAGE, AAB_PATH, MAPPING_PATH, TRACK }) {
  const BASE = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE)}`;
  const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE)}`;
  const api = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${access}`, ...init.headers } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.replace(BASE, '').replace(UPLOAD, '')} → ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  };
  const edit = await api(`${BASE}/edits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log(`edit ${edit.id} opened`);
  const bundle = await api(`${UPLOAD}/edits/${edit.id}/bundles?uploadType=media`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(AAB_PATH),
  });
  console.log(`bundle uploaded — versionCode ${bundle.versionCode}`);
  if (MAPPING_PATH && existsSync(MAPPING_PATH)) {
    await api(`${UPLOAD}/edits/${edit.id}/apks/${bundle.versionCode}/deobfuscationFiles/proguard?uploadType=media`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: readFileSync(MAPPING_PATH),
    });
    console.log('mapping uploaded');
  }
  await api(`${BASE}/edits/${edit.id}/tracks/${encodeURIComponent(TRACK)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ track: TRACK, releases: [{ status: 'completed', versionCodes: [String(bundle.versionCode)] }] }),
  });
  await api(`${BASE}/edits/${edit.id}:commit`, { method: 'POST' });
  console.log(`released versionCode ${bundle.versionCode} to the ${TRACK} track ✓`);
}

/** a CONCURRENT edit (store probe, an open Play Console tab) expires ours — a fresh edit wins the next time */
const expired = (message) => /edit has expired|editExpired|editAlreadyCommitted/i.test(message);
/** #596: a 5xx is the store's own bad minute — an edit that was never committed leaves nothing behind */
const temporary = (message) => /→ 5\d\d:/.test(message);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one whole publish (`once`: a fresh edit each time) until it gets through, for the failures another
 * try can cure. A commit the store answered with a 5xx may have gone through all the same: the try after
 * it then finds the version code taken, and that is the release it was asked for.
 */
export async function publishWithRetries(once, { attempts = 3, pauseMs = 30_000, sleep = pause, log = console.log } = {}) {
  let commitUnsure = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await once();
      return;
    } catch (e) {
      const message = String(e?.message ?? e);
      if (commitUnsure && /already been used/i.test(message)) {
        log('the version code is taken: the commit the store answered with an error went through after all ✓');
        return;
      }
      if (!(expired(message) || temporary(message)) || attempt >= attempts) throw e;
      commitUnsure ||= /:commit → 5\d\d:/.test(message);
      log(`attempt ${attempt} did not get through (${message.slice(0, 120)}) — trying again on a fresh edit`);
      if (temporary(message)) await sleep(pauseMs * attempt);
    }
  }
}

/** a store-side setup step the user still has to take — not a defect of this build */
export function setupGap(message) {
  return /→ 404:|Package not found|The caller does not have permission|has not been used in project|it is disabled/i.test(message);
}

async function main() {
  const { PLAY_JSON, PACKAGE, AAB_PATH, MAPPING_PATH, TRACK = 'internal' } = process.env;
  if (!PLAY_JSON || !PACKAGE || !AAB_PATH) {
    console.error('PLAY_JSON, PACKAGE and AAB_PATH are required');
    process.exit(1);
  }
  try {
    const access = await token(JSON.parse(PLAY_JSON));
    await publishWithRetries(() => publishOnce(access, { PACKAGE, AAB_PATH, MAPPING_PATH, TRACK }));
  } catch (e) {
    const message = String(e.message).replaceAll('\n', ' ');
    if (!setupGap(message)) throw e;
    // no app record yet, the service account not invited, or the API off: the signed
    // .aab artifact on this run is the deliverable until the store accepts
    console.log(`::warning title=Play upload waits for a store setup step::${PACKAGE}: ${message.slice(0, 400)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
