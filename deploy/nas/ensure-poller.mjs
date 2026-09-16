#!/usr/bin/env node
/**
 * Ensure the NAS poller of ONE live dir through the DSM API — the legacy
 * live pipeline's counterpart of what the IaC prod twin's bootstrap does
 * for its own dir (infra/modules/dsm.mjs): apply.sh uploaded into the
 * live dir (the PARENT of SYNOLOGY_PATH), the published folder present,
 * and a root Task Scheduler entry running a throwaway copy of apply.sh
 * every five minutes. Idempotent; a hand-made task for the same dir is
 * adopted, a task for another dir is left alone.
 *
 *   node deploy/nas/ensure-poller.mjs --name "munni deploy poller (live)"
 *
 * Reads SYNOLOGY_URL / SYNOLOGY_USER / SYNOLOGY_PASS / SYNOLOGY_PATH.
 * The account needs DSM administrator rights (Control Panel APIs): a
 * refusal (402/105) is a WARNING, never a failed deploy — the bundle is
 * already uploaded, and the task may well exist by hand — while any
 * other failure is an error (2026-09-16: the first real IaC run adopted
 * and re-pointed the legacy poller; this step gives the legacy pipeline
 * its own, on every deploy).
 */
import { readFileSync } from 'node:fs';
import { ensureLiveDir, ensurePollerTask, dsmAdvice, isPermissionError } from '../../infra/modules/dsm.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--name');
const name = at >= 0 ? args[at + 1] : 'munni deploy poller (live)';
const { SYNOLOGY_URL, SYNOLOGY_USER, SYNOLOGY_PASS, SYNOLOGY_PATH } = process.env;
if (!SYNOLOGY_URL || !SYNOLOGY_USER || !SYNOLOGY_PASS || !SYNOLOGY_PATH) {
  console.log('::error::SYNOLOGY_URL/USER/PASS/PATH must be set');
  process.exitCode = 2;
} else {
  const creds = { url: SYNOLOGY_URL, user: SYNOLOGY_USER, pass: SYNOLOGY_PASS };
  const applyScript = readFileSync(new URL('./apply.sh', import.meta.url), 'utf8');
  let failed = 0;
  for (const [label, fn] of [
    ['live dir', () => ensureLiveDir(creds, { publishedPath: SYNOLOGY_PATH, applyScript })],
    ['poller task', () => ensurePollerTask(creds, { publishedPath: SYNOLOGY_PATH, name })],
  ]) {
    try {
      const r = await fn();
      console.log(`dsm: ${label} ${r.state} — ${r.detail}`);
    } catch (e) {
      if (isPermissionError(e)) {
        console.log(`::warning::dsm: ${label} skipped — DSM refused the deploy account (${e.message})${dsmAdvice(e)}; the task must then exist by hand (deploy/nas/README.md)`);
        break;
      }
      failed++;
      console.log(`::error::dsm: ${label} failed (${e.message})${dsmAdvice(e)}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
