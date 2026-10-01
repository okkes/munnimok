// Sizing the pooled browser agents (#420, A1): the recommendation from the host's memory, the environment's agents block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_BASE_MB, DEFAULT_CONCURRENCY, ENV_MB, HEADROOM, JOB_MB, MAX_PRIVATE_SLOTS, MAX_REPLICAS, SHARED_MB, normalizeAgents, recommendAgents, replicaMb } from '../modules/agents.mjs';

test('the recommendation keeps a quarter free, subtracts the stacks, and fits replicas of two jobs into what is left per environment', () => {
  // a 16 GB NAS with two environments
  const r = recommendAgents({ totalMb: 16384, environments: 2 });
  assert.equal(r.headroomMb, Math.round(16384 * HEADROOM));
  assert.equal(r.reservedMb, SHARED_MB + ENV_MB * 2);
  assert.equal(r.freeMb, 16384 - r.headroomMb - r.reservedMb);
  assert.equal(r.perReplicaMb, AGENT_BASE_MB + JOB_MB * DEFAULT_CONCURRENCY);
  assert.equal(r.perEnvMb, Math.floor(r.freeMb / 2));
  assert.equal(r.pooled, Math.min(MAX_REPLICAS, Math.floor(r.perEnvMb / r.perReplicaMb)));
  assert.equal(r.concurrency, 2);
  assert.equal(r.fits, true);
  assert.ok(r.pooled >= 1 && r.pooled <= 3, `a 16 GB host with two environments affords a couple of replicas each (${r.pooled})`);
});

test('a small host still gets one replica, honestly marked as not fitting; a big one is capped', () => {
  const small = recommendAgents({ totalMb: 4096, environments: 2 });
  assert.equal(small.pooled, 1);
  assert.equal(small.fits, false);
  const big = recommendAgents({ totalMb: 131072, environments: 1 });
  assert.equal(big.pooled, MAX_REPLICAS);
  assert.equal(big.fits, true);
  const nothing = recommendAgents({ totalMb: 0, environments: 1 });
  assert.equal(nothing.freeMb, 0);
  assert.equal(nothing.pooled, 1);
  assert.equal(nothing.fits, false);
});

test('more jobs per replica cost a browser each; the inputs are clamped to sense', () => {
  assert.equal(replicaMb(1), AGENT_BASE_MB + JOB_MB);
  assert.equal(replicaMb(3), AGENT_BASE_MB + JOB_MB * 3);
  const r = recommendAgents({ totalMb: 16384, environments: 0, concurrency: 99 });
  assert.equal(r.environments, 1, 'at least the environment being sized');
  assert.equal(r.concurrency, 8);
  assert.equal(recommendAgents({ totalMb: 'x', environments: 'y' }).totalMb, 0);
});

test('private slots (#420 A2) take one browser each off the environment\'s share before the pooled count is offered; the count is clamped', () => {
  const without = recommendAgents({ totalMb: 16384, environments: 2 });
  const r = recommendAgents({ totalMb: 16384, environments: 2, privateSlots: 2 });
  assert.equal(r.privateSlots, 2);
  assert.equal(r.slotsMb, 2 * replicaMb(1));
  assert.equal(r.perEnvMb, Math.floor(without.freeMb / 2) - r.slotsMb);
  assert.ok(r.pooled <= without.pooled);
  assert.equal(recommendAgents({ totalMb: 16384, environments: 2, privateSlots: 99 }).privateSlots, MAX_PRIVATE_SLOTS);
  assert.equal(recommendAgents({ totalMb: 16384, environments: 2, privateSlots: -3 }).privateSlots, 0);
  const crowded = recommendAgents({ totalMb: 8192, environments: 2, privateSlots: 4 });
  assert.equal(crowded.pooled, 1);
  assert.equal(crowded.fits, false, 'four private browsers on a small host leave no room for a pooled replica, and the hint says so');
});

test('normalizeAgents: defaults one replica, two jobs, no private slots; integers inside their bounds stick, anything else falls back', () => {
  assert.deepEqual(normalizeAgents(undefined), { pooled: 1, concurrency: 2, privateSlots: 0 });
  assert.deepEqual(normalizeAgents({ pooled: 3, concurrency: 1, privateSlots: 2 }), { pooled: 3, concurrency: 1, privateSlots: 2 });
  assert.deepEqual(normalizeAgents({ pooled: 0 }), { pooled: 0, concurrency: 2, privateSlots: 0 }, 'zero replicas is a choice');
  assert.deepEqual(normalizeAgents({ pooled: 99, concurrency: 0, privateSlots: -1 }), { pooled: 1, concurrency: 2, privateSlots: 0 });
  assert.deepEqual(normalizeAgents({ pooled: '2', concurrency: 2.5 }), { pooled: 2, concurrency: 2, privateSlots: 0 });
});
