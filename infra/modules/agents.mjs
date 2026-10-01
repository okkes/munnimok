/**
 * Sizing the environment's pooled browser agents (#420, slice A1).
 *
 * A pooled agent is a headed Chromium under Xvfb; every job it runs at once
 * is roughly one more browser. The wizard asks the host how much memory it
 * has, keeps a quarter of it free for the operating system and the file
 * services, subtracts what the stacks themselves take, and offers a count
 * of replicas (two jobs each) that fits — with the arithmetic shown, and
 * every number overridable.
 */

/** keep this share of the host's memory free, whatever the stacks want (user ruling 2026-10-01) */
export const HEADROOM = 0.25;
/** the shared stack (crash reports, the vault, pgAdmin, the cockpit, valkey, OCR) at rest */
export const SHARED_MB = 1024;
/** one environment (web, admin, api, Logto, Postgres, the control plane) at rest */
export const ENV_MB = 1536;
/** a pooled agent with no job running: the runtime, Xvfb, an idle browser */
export const AGENT_BASE_MB = 600;
/** one headed Chromium job */
export const JOB_MB = 1024;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_REPLICAS = 8;
/** hosted private slots per environment (#420 A2): one person each */
export const MAX_PRIVATE_SLOTS = 16;

/** memory one replica needs for its jobs at once */
export const replicaMb = (concurrency) => AGENT_BASE_MB + JOB_MB * Math.max(1, concurrency);

/**
 * The recommendation for one platform: how many pooled replicas its
 * environments can afford between them, from the host's memory. Returns
 * the arithmetic as well, so the page can show it.
 */
export function recommendAgents({ totalMb, environments, concurrency = DEFAULT_CONCURRENCY, privateSlots = 0 }) {
  const total = Math.max(0, Math.round(Number(totalMb) || 0));
  const envs = Math.max(1, Math.round(Number(environments) || 1));
  const jobs = Math.min(8, Math.max(1, Math.round(Number(concurrency) || DEFAULT_CONCURRENCY)));
  const slots = Math.min(MAX_PRIVATE_SLOTS, Math.max(0, Math.round(Number(privateSlots) || 0)));
  const headroomMb = Math.round(total * HEADROOM);
  const reservedMb = SHARED_MB + ENV_MB * envs;
  const freeMb = Math.max(0, total - headroomMb - reservedMb);
  const perReplicaMb = replicaMb(jobs);
  // a private slot (#420 A2) is one browser for one person, taken off this environment's share first
  const slotsMb = slots * replicaMb(1);
  const perEnvMb = Math.max(0, Math.floor(freeMb / envs) - slotsMb);
  const fits = perEnvMb >= perReplicaMb;
  const pooled = Math.min(MAX_REPLICAS, Math.max(1, Math.floor(perEnvMb / perReplicaMb)));
  return { totalMb: total, headroomMb, reservedMb, freeMb, environments: envs, perEnvMb, perReplicaMb, concurrency: jobs, privateSlots: slots, slotsMb, pooled, fits };
}

/** the agents block of an environment file, validated — absent or wrong → the defaults (one replica, two jobs, no private slots) */
export function normalizeAgents(raw) {
  const int = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    pooled: int(raw?.pooled, 0, MAX_REPLICAS, 1),
    concurrency: int(raw?.concurrency, 1, 8, DEFAULT_CONCURRENCY),
    privateSlots: int(raw?.privateSlots, 0, MAX_PRIVATE_SLOTS, 0),
  };
}
