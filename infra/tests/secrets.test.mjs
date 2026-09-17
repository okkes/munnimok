// minted values and the pair rule: one value per pair, minted by the prod twin into every environment of the pair
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateValue, pairEnvironments } from '../modules/secrets.mjs';
import { loadStack } from '../modules/stack.mjs';

test('generateValue: Logto machine credentials take Logto\'s shapes (21-char id with its tenant prefix, 48-hex secret); everything else stays a 32-byte token', () => {
  const infra = generateValue('LOGTO_INFRA_M2M_ID');
  const admin = generateValue('LOGTO_ADMIN_M2M_ID');
  assert.match(infra, /^infra[0-9a-f]{16}$/);
  assert.match(admin, /^admin[0-9a-f]{16}$/);
  assert.equal(infra.length, 21, 'Logto stores application ids in a 21-character column');
  assert.match(generateValue('LOGTO_INFRA_M2M_SECRET'), /^[0-9a-f]{48}$/);
  assert.match(generateValue('GLITCHTIP_API_TOKEN'), /^[0-9a-f]{40}$/, 'GlitchTip tokens are 40 hex characters');
  assert.match(generateValue('GLITCHTIP_SECRET_KEY'), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(generateValue('LOGTO_INFRA_M2M_ID'), infra, 'random every time');
  assert.throws(() => generateValue('PUSH_VAPID_PUBLIC_KEY'), /pair/);
});

test('pairEnvironments: both twins of an iac pair, each once', () => {
  process.env.PLATFORM_DOMAIN ??= 'nas.example';
  const prod = loadStack('munni-iac-prod');
  const staging = loadStack('munni-iac-staging');
  assert.deepEqual(pairEnvironments(prod).sort(), ['iac-production', 'iac-staging']);
  assert.deepEqual(pairEnvironments(staging).sort(), ['iac-production', 'iac-staging'], 'the staging twin sees the same pair');
});
