// @vitest-environment node
/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/i18n/en';
import { nl } from '@/i18n/nl';
import { tr } from '@/i18n/tr';

/**
 * §10.8: every key the connectors can emit has copy in all three
 * languages. The connector sources are the truth — the manifests' label
 * and notes keys, the adapters' challenge prompts, and the enums the wire
 * spells in snake_case (error codes, job steps, session states, user
 * actions, challenge types) — so a new adapter or code fails here before
 * a user ever sees a raw key.
 */
const ROOT = path.resolve(__dirname, '../../../../../server/src/connectors');

function csFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'bin' || entry === 'obj' || entry.endsWith('.Tests')) continue;
    if (statSync(full).isDirectory()) csFiles(full, out);
    else if (entry.endsWith('.cs')) out.push(full);
  }
  return out;
}

const snake = (member: string): string => member.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** the members of one C# enum, as the wire spells them */
function enumMembers(sources: readonly string[], name: string): string[] {
  for (const source of sources) {
    const m = new RegExp(`enum ${name}\\s*\\{([^}]*)\\}`).exec(source);
    if (!m) continue;
    return m[1]
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter((line) => /^[A-Z][A-Za-z0-9]*\s*,?$/.test(line))
      .map((line) => snake(line.replace(',', '').trim()));
  }
  throw new Error(`enum ${name} not found`);
}

describe('connector copy coverage (EN/NL/TR)', () => {
  const files = csFiles(ROOT);
  const sources = files.map((f) => readFileSync(f, 'utf8'));

  const literal = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(/"(connect\.[a-z0-9_.]+)"/g)) literal.add(m[1]);
  }
  const derived = [
    ...enumMembers(sources, 'ErrorCode').map((c) => `connect.error.${c}`),
    ...enumMembers(sources, 'JobStep').map((s) => `connect.progress.${s}`),
    ...enumMembers(sources, 'SessionState').map((s) => `connect.state.${s}`),
    ...enumMembers(sources, 'UserAction')
      .filter((a) => a !== 'none')
      .map((a) => `connect.action.${a}`),
    ...enumMembers(sources, 'ChallengeType').map((t) => `connect.challenge.${t}`),
  ];
  const keys = [...new Set([...literal, ...derived])].sort((a, b) => a.localeCompare(b));

  it('reads a real catalogue of keys out of the connector sources', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(literal.has('connect.step.credentials')).toBe(true);
    expect(derived).toContain('connect.error.blocked_by_provider');
    expect(derived).toContain('connect.progress.opening_provider');
    expect(derived).toContain('connect.challenge.live_view');
    expect(keys.length).toBeGreaterThan(80);
  });

  it.each([
    ['en', en],
    ['nl', nl],
    ['tr', tr],
  ] as const)('%s carries every key the connectors emit', (_lang, dict) => {
    const missing = keys.filter((key) => !(dict as Record<string, string>)[key]);
    expect(missing).toEqual([]);
  });
});
