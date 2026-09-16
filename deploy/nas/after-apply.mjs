#!/usr/bin/env node
/**
 * After a Deploy of an IaC twin: wait until the NAS poller has applied THIS
 * bundle (the stamp marker in the live dir equals the uploaded stamp),
 * print the poller's log tail, and say whether Logto now answers with the
 * minted infra credential — the seed the poller applies on the first
 * deploy (deploy/update.sh). The workflow uses the answer to run the IaC
 * bootstrap once more, which turns sign-in into code; no click is left.
 *
 *   node deploy/nas/after-apply.mjs --stack munni-iac-prod --stamp <sha>
 *
 * Env: SYNOLOGY_URL/USER/PASS/PATH, IAC_DOMAIN, IAC_LOGTO_INFRA_M2M_ID/SECRET.
 * Step outputs (GITHUB_OUTPUT): applied=true|false, logto=answers|silent|no-credential,
 * glitchtip=answers|silent|no-credential (the same for the GlitchTip API token).
 * Never red: what it learns is printed; the next verify shows the rest.
 */
import { appendFileSync } from 'node:fs';
import { readLiveFile, readPollerLog } from '../../infra/modules/dsm.mjs';
import { loadStack, pairProd } from '../../infra/modules/stack.mjs';
import { logtoAnswers } from '../../infra/modules/logto.mjs';
import { glitchtipAnswers } from '../../infra/modules/glitchtip.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const stackName = arg('stack', 'munni-iac-prod');
const stamp = arg('stamp', '');
const waitMs = Number(arg('wait-minutes', '15')) * 60000;
const logtoWaitMs = Number(arg('logto-wait-minutes', '10')) * 60000;
const pollMs = Number(arg('poll-seconds', '30')) * 1000;
const out = (name, value) => { console.log(`${name}=${value}`); if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { SYNOLOGY_URL, SYNOLOGY_USER, SYNOLOGY_PASS, SYNOLOGY_PATH } = process.env;
if (!SYNOLOGY_URL || !SYNOLOGY_USER || !SYNOLOGY_PASS || !SYNOLOGY_PATH || !stamp) {
  console.log('::error::SYNOLOGY_URL/USER/PASS/PATH and --stamp are needed');
  process.exitCode = 2;
} else {
  const creds = { url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS };
  const marker = `.applied_version_${stackName.replace(/^munni-/, '').replace(/-/g, '_')}`;
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
  console.log(applied ? `poller applied ${stamp.slice(0, 8)} for ${stackName} (${Math.round((Date.now() - started) / 1000)} s)` : `::warning::the poller has not applied ${stamp.slice(0, 8)} for ${stackName} within ${waitMs / 60000} minutes (marker ${marker} holds ${lastSeen ?? 'nothing'}) — its log below says what it is doing; the next verify shows the rest`);
  out('applied', String(applied));
  try {
    const log = await readPollerLog(creds, { publishedPath: SYNOLOGY_PATH, lines: 40 });
    console.log(`poller log ${log.path} (last ${log.lines.length} lines):`);
    for (const l of log.lines) console.log(`    ${l}`);
  } catch (e) {
    console.log(`poller log not readable (${e.message})`);
  }
  // does Logto answer with the minted credential yet? (prod twin only — it runs Logto)
  const m2m = { m2mId: process.env.IAC_LOGTO_INFRA_M2M_ID, m2mSecret: process.env.IAC_LOGTO_INFRA_M2M_SECRET };
  let logto = 'no-credential';
  if (m2m.m2mId && m2m.m2mSecret && process.env.IAC_DOMAIN) {
    const pair = pairProd(loadStack(stackName));
    const until = Date.now() + (applied ? logtoWaitMs : 0);
    logto = 'silent';
    do {
      if (await logtoAnswers(pair, m2m)) { logto = 'answers'; break; }
      if (Date.now() >= until) break;
      await sleep(pollMs);
    } while (true);
    console.log(logto === 'answers' ? 'logto answers with the infra credential — the seed has landed' : `logto does not answer with the infra credential${applied ? ` after ${logtoWaitMs / 60000} more minutes` : ''} — the poller seeds it once Logto has booted; a later bootstrap picks it up`);
  } else {
    console.log('no infra credential in this environment yet (the prod twin\'s bootstrap mints it) — nothing to check');
  }
  out('logto', logto);
  // …and GlitchTip with the minted API token
  const gtToken = process.env.IAC_GLITCHTIP_API_TOKEN;
  let glitchtip = 'no-credential';
  if (gtToken && process.env.IAC_DOMAIN) {
    const pair = pairProd(loadStack(stackName));
    const until = Date.now() + (applied ? logtoWaitMs : 0);
    glitchtip = 'silent';
    do {
      if (await glitchtipAnswers(pair, gtToken)) { glitchtip = 'answers'; break; }
      if (Date.now() >= until) break;
      await sleep(pollMs);
    } while (true);
    console.log(glitchtip === 'answers' ? 'glitchtip accepts the API token — the seed has landed' : 'glitchtip does not accept the API token yet — the poller creates it once GlitchTip has migrated; a later bootstrap picks it up');
  }
  out('glitchtip', glitchtip);
}
