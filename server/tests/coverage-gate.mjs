#!/usr/bin/env node
// connector platform's coverage gate (#367): 85 % line floor per assembly over the union of all cobertura reports
// (covered = any suite hit it); Munni.Api keeps the MSBuild gate in server/tests/Directory.Build.props
// usage: node server/tests/coverage-gate.mjs [results-dir] [--floor 85]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const floorAt = args.indexOf('--floor');
const FLOOR = floorAt >= 0 ? Number(args[floorAt + 1]) : 85;
const root = resolve(args.find((a, i) => !a.startsWith('--') && (i === 0 || args[i - 1] !== '--floor')) ?? 'coverage');

// the assemblies this gate owns — an assembly missing from every report fails too (nothing measured is not "covered")
const GATED = new Set([
  'Connector.Kit',
  'Connector.Kit.Hosting',
  'Connector.Kit.Agent',
  'Connector.Api',
  'BankConnector.Adapters',
  'ShopConnector.Adapters',
  'RegistryConnector.Adapters',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === 'coverage.cobertura.xml') out.push(p);
  }
  return out;
}

const reports = walk(root);
if (reports.length === 0) {
  console.error(`coverage gate: no coverage.cobertura.xml under ${root}`);
  process.exit(1);
}

const lines = new Map();
for (const file of reports) {
  const xml = readFileSync(file, 'utf8');
  // report <source> roots differ per run (common parent of what it touched): the same file would be two keys
  // and counted twice, so paths are made absolute
  const source = /<source>([^<]+)<\/source>/.exec(xml)?.[1] ?? '';
  for (const pkg of xml.split('<package name="').slice(1)) {
    const name = pkg.slice(0, pkg.indexOf('"'));
    const map = lines.get(name) ?? new Map();
    lines.set(name, map);
    for (const cls of pkg.split('<class name="').slice(1)) {
      const fileName = /filename="([^"]+)"/.exec(cls)?.[1] ?? '?';
      const absolute = resolve(source, fileName).replaceAll('\\', '/').toLowerCase();
      const body = cls.slice(0, cls.indexOf('</class>'));
      for (const m of body.matchAll(/<line number="(\d+)" hits="(\d+)"/g)) {
        const key = `${absolute}:${m[1]}`;
        map.set(key, (map.get(key) ?? 0) + Number(m[2]));
      }
    }
  }
}

// reported for the summary, gated elsewhere (Munni.Api: the MSBuild gate)
const REPORTED = ['Munni.Api'];

function verdictFor(gated, pct) {
  if (!gated) return '(gated by MSBuild)';
  return pct >= FLOOR ? 'ok' : 'UNDER THE FLOOR';
}

let failed = false;
for (const name of [...GATED, ...REPORTED]) {
  const gated = GATED.has(name);
  const map = lines.get(name);
  if (!map || map.size === 0) {
    if (!gated) continue;
    console.error(`coverage gate: ${name} appears in no report — its tests did not run`);
    failed = true;
    continue;
  }
  let hit = 0;
  for (const h of map.values()) if (h > 0) hit += 1;
  const pct = (hit / map.size) * 100;
  console.log(`coverage gate: ${name} ${pct.toFixed(2)} % (${hit}/${map.size} lines, floor ${FLOOR} %) ${verdictFor(gated, pct)}`);
  if (gated && pct < FLOOR) failed = true;
}
process.exit(failed ? 1 : 0);
