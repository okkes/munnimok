#!/usr/bin/env node
/**
 * The platform config from GitHub into the files the modules read (#416):
 * every `MUNNI_PLATFORM_<ID>` variable the workflow hands this job as an
 * environment variable becomes `infra/platforms/<id>/platform.json` +
 * `envs/<env>.json`. Runs first in every job that reads the config.
 *
 *   node infra/ci/materialize.mjs
 *
 * Nothing published yet (a fresh repository, the wizard not connected):
 * prints a notice and exits 0 — the matrix is then empty and the jobs do
 * nothing, which is the honest outcome.
 */
import { materializeFromEnv } from '../modules/config.mjs';

const ids = materializeFromEnv();
if (!ids.length) {
  console.log('::notice::no MUNNI_PLATFORM_* variable reached this job — nothing published by the wizard yet, nothing to do');
} else {
  console.log(`platform config materialized from GitHub: ${ids.join(', ')}`);
}
