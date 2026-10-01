#!/usr/bin/env node
/**
 * Record what a Deploy applied (#416): the config the run rendered, on the
 * stack's GitHub environment as `MUNNI_APPLIED`, so the wizard's pending
 * strip knows the fingerprint it just published is live.
 *
 *   node infra/ci/applied.mjs --stack munni-nas-prod --by deploy
 *
 * Env: GH_TOKEN (a token that may write environment variables — the
 * wizard's GH_PAT; GITHUB_TOKEN cannot), GITHUB_RUN_ID. Never red: a
 * refused write is a warning, the next run records again.
 */
import { loadStack } from '../modules/stack.mjs';
import { writeApplied } from '../modules/config.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const stackName = arg('stack', '');
const by = arg('by', 'deploy');
if (!stackName) { console.error('usage: applied.mjs --stack <name> [--by deploy|bootstrap]'); process.exit(2); }

try {
  const record = writeApplied(loadStack(stackName, { lenient: true }), { by, run: process.env.GITHUB_RUN_ID ?? null });
  console.log(`applied: ${record.stack} by ${record.by} at ${record.at} → MUNNI_APPLIED on its GitHub environment`);
} catch (e) {
  console.log(`::warning::${stackName}: what this run applied was not recorded (${e.message}) — the wizard's strip may keep showing it until the next run`);
}
