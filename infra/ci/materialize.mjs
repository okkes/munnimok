#!/usr/bin/env node
// #416: turns the MUNNI_PLATFORM_<ID> variables into platform.json + envs/<env>.json, first in every job that reads config;
// with none published it prints a notice and exits 0 (the matrix is empty, the jobs do nothing)
import { materializeFromEnv } from '../modules/config.mjs';

const ids = materializeFromEnv();
if (!ids.length) {
  console.log('::notice::no MUNNI_PLATFORM_* variable reached this job — nothing published by the wizard yet, nothing to do');
} else {
  console.log(`platform config materialized from GitHub: ${ids.join(', ')}`);
}
