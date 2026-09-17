#!/usr/bin/env node
/**
 * After a Deploy of one stack: wait until the NAS poller has applied THIS
 * bundle (the marker in the live dir equals the uploaded stamp), print the
 * poller's log tail, and say whether the services now answer with the
 * credentials the deploy seeded — Logto with the environment's infra
 * credential, GlitchTip with the platform's API token. The workflow uses
 * the answers to run the bootstrap once more, which turns sign-in and
 * crash reports into code; no click is left.
 *
 *   node deploy/nas/after-apply.mjs --stack munni-nas-prod --stamp <sha>.<run>
 *
 * Env: SYNOLOGY_URL/USER/PASS/PATH, PLATFORM_DOMAIN, LOGTO_INFRA_M2M_ID/SECRET, GLITCHTIP_API_TOKEN.
 * Step outputs: applied=true|false, logto=answers|silent|no-credential|n/a, glitchtip=answers|silent|no-credential.
 * Never red: what it learns is printed; the next verify shows the rest.
 */
import { appendFileSync } from 'node:fs';
import { readLiveFile, readPollerLog } from '../../infra/modules/dsm.mjs';
import { loadStack, sharedOf } from '../../infra/modules/stack.mjs';
import { logtoAnswers } from '../../infra/modules/logto.mjs';
import { glitchtipAnswers } from '../../infra/modules/glitchtip.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const stackName = arg('stack', '');
const stamp = arg('stamp', '');
const waitMs = Number(arg('wait-minutes', '15')) * 60000;
const seedWaitMs = Number(arg('seed-wait-minutes', '10')) * 60000;
const pollMs = Number(arg('poll-seconds', '30')) * 1000;
const out = (name, value) => { console.log(`${name}=${value}`); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { SYNOLOGY_URL, SYNOLOGY_USER, SYNOLOGY_PASS, SYNOLOGY_PATH } = process.env;
if (!SYNOLOGY_URL || !SYNOLOGY_USER || !SYNOLOGY_PASS || !SYNOLOGY_PATH || !stamp || !stackName) {
  console.log('::error::SYNOLOGY_URL/USER/PASS/PATH, --stack and --stamp are needed');
  process.exitCode = 2;
} else {
  const creds = { url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS };
  const stack = loadStack(stackName);
  const shared = sharedOf(stack);
  const marker = `.applied_${stackName}`;
  const started = Date.now();
  let applied = false;
  let lastSeen = null;
  while (Date.now() - started < waitMs) {
    try {
      lastSeen = (await readLiveFile(creds, { publishedPath: SYNOLOGY_PATH, file: marker })).text.trim();
      if (lastSeen === stamp) { applied = true; break; }
    } catch (e) {
      lastSeen = `(unreadable: ${e.message})`;
    }
    await sleep(pollMs);
  }
  console.log(applied ? `poller applied ${stamp.slice(0, 8)} for ${stackName} (${Math.round((Date.now() - started) / 1000)} s)` : `::warning::the poller has not applied ${stamp.slice(0, 8)} for ${stackName} within ${waitMs / 60000} minutes (marker ${marker} holds ${lastSeen ?? 'nothing'}) — its log below says what it is doing`);
  out('applied', String(applied));
  try {
    const log = await readPollerLog(creds, { publishedPath: SYNOLOGY_PATH, lines: 40 });
    console.log(`poller log ${log.path} (last ${log.lines.length} lines):`);
    for (const l of log.lines) console.log(`    ${l}`);
  } catch (e) {
    console.log(`poller log not readable (${e.message})`);
  }
  const waitFor = async (label, check) => {
    const until = Date.now() + (applied ? seedWaitMs : 0);
    let state = 'silent';
    do {
      if (await check()) { state = 'answers'; break; }
      if (Date.now() >= until) break;
      await sleep(pollMs);
    } while (true);
    console.log(state === 'answers' ? `${label} answers with the seeded credential` : `${label} does not answer with the seeded credential yet — the poller seeds it once the service has booted; a later bootstrap picks it up`);
    return state;
  };
  let logto = 'n/a';
  if (stack.role === 'env') {
    const m2m = { m2mId: process.env.LOGTO_INFRA_M2M_ID, m2mSecret: process.env.LOGTO_INFRA_M2M_SECRET };
    logto = m2m.m2mId && m2m.m2mSecret ? await waitFor('logto', () => logtoAnswers(stack, m2m)) : 'no-credential';
  }
  out('logto', logto);
  const gtToken = process.env.GLITCHTIP_API_TOKEN;
  const glitchtip = gtToken ? await waitFor('glitchtip', () => glitchtipAnswers(shared, gtToken)) : 'no-credential';
  out('glitchtip', glitchtip);
}
