// Keep an environment's TestFlight build alive (user 2026-10-09): Apple expires
// a TestFlight build 90 days after its upload, so an app that sees no code
// change for three months stops installing on the testers' phones. This asks
// App Store Connect for the newest build of ONE bundle id and decides whether
// native-ios.yml must upload a fresh one — the same code rebuilt is fine, a new
// upload restarts the 90 days (a dispatch takes a fresh build number).
//
// Env: ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, BUNDLE_ID, RENEW_UNDER_DAYS
// (default 30). Writes renew=true|false, reason=<text>, days_left=<n|''> to
// GITHUB_OUTPUT, prints one table row (and appends it to the step summary); a
// probe that cannot answer is a warning with renew=false — nothing is
// dispatched on a guess. The pure parts are exported for the tests
// (infra/tests/testflight-renew.test.mjs); the run happens only as a script.
const crypto = require('node:crypto');
const fs = require('node:fs');

const RENEW_UNDER_DAYS = 30;
const DAY_MS = 86400000;
const ASC = 'https://api.appstoreconnect.apple.com/v1';

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

/** whole days until an ISO date — negative once it passed, null without a date */
function daysLeft(expirationDate, now = Date.now()) {
  const t = Date.parse(expirationDate ?? '');
  return Number.isFinite(t) ? Math.floor((t - now) / DAY_MS) : null;
}

/** the verdict for an app's newest build: renew when there is none, it expired, or fewer than `under` days remain */
function decide(build, { now = Date.now(), under = RENEW_UNDER_DAYS } = {}) {
  if (!build) return { renew: true, daysLeft: null, reason: 'no build on TestFlight yet' };
  const a = build.attributes ?? {};
  const version = a.version ?? '?';
  const left = daysLeft(a.expirationDate, now);
  if (a.expired || (left !== null && left < 0)) return { renew: true, daysLeft: left, reason: `build ${version} expired${a.expirationDate ? ` on ${String(a.expirationDate).slice(0, 10)}` : ''}` };
  if (left === null) return { renew: false, daysLeft: null, reason: `build ${version} carries no expiration date — left alone` };
  if (left < under) return { renew: true, daysLeft: left, reason: `build ${version} expires in ${left} day${left === 1 ? '' : 's'} (under ${under})` };
  return { renew: false, daysLeft: left, reason: `build ${version} is good for ${left} more days` };
}

/** the app record and its newest build; app null when App Store Connect has no record for the bundle id */
async function latestBuild(bundleId, { fetchImpl = fetch, token = null } = {}) {
  const headers = { Authorization: `Bearer ${token ?? jwt()}` };
  const ask = async (url) => {
    const res = await fetchImpl(url, { headers });
    const body = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body.errors ?? body)}`);
    return body;
  };
  const apps = await ask(`${ASC}/apps?filter%5BbundleId%5D=${encodeURIComponent(bundleId)}&limit=5`);
  const app = (apps.data ?? []).find((a) => a.attributes?.bundleId === bundleId) ?? null;
  if (!app) return { app: null, build: null };
  const builds = await ask(`${ASC}/builds?filter%5Bapp%5D=${encodeURIComponent(app.id)}&sort=-uploadedDate&limit=1`);
  return { app, build: (builds.data ?? [])[0] ?? null };
}

/** one line of the run's table: bundle id, app, version, uploaded, expires, days left, verdict */
function row(bundleId, app, build, verdict) {
  const a = build?.attributes ?? {};
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '-');
  return [bundleId, app?.attributes?.name ?? '(no record)', a.version ?? '-', day(a.uploadedDate), day(a.expirationDate), verdict.daysLeft ?? '-', verdict.renew ? 'RENEW' : 'ok'].join(' | ');
}

// exitCode instead of process.exit(): exiting while the fetch socket is
// still closing trips a libuv assertion on Windows (seen 2026-09-09)
async function main() {
  const bundleId = String(process.env.BUNDLE_ID ?? '').trim();
  const under = Number(process.env.RENEW_UNDER_DAYS) || RENEW_UNDER_DAYS;
  if (!bundleId) { console.log('::warning title=TestFlight expiry check skipped::BUNDLE_ID is empty'); out('renew', 'false'); out('reason', 'no bundle id'); out('days_left', ''); return; }
  try {
    const { app, build } = await latestBuild(bundleId);
    if (!app) {
      console.log(`${bundleId}: App Store Connect has no app record — nothing on TestFlight to keep alive (create the record once; the next build uploads)`);
      out('renew', 'false'); out('reason', 'no app record'); out('days_left', '');
      return;
    }
    const verdict = decide(build, { under });
    const line = row(bundleId, app, build, verdict);
    console.log(`bundle id | app | version | uploaded | expires | days left | verdict\n${line}`);
    console.log(`${bundleId}: ${verdict.reason}${verdict.renew ? ' — a fresh upload restarts the 90 days' : ''}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| ${line} |\n`);
    out('renew', String(verdict.renew)); out('reason', verdict.reason); out('days_left', verdict.daysLeft ?? '');
  } catch (e) {
    console.log(`::warning title=TestFlight expiry check skipped::could not ask App Store Connect for ${bundleId} (${e.message}) — nothing dispatched on a guess`);
    out('renew', 'false'); out('reason', `probe failed: ${e.message}`); out('days_left', '');
  }
}

module.exports = { RENEW_UNDER_DAYS, daysLeft, decide, latestBuild, row };
if (require.main === module) main();
