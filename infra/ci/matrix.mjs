#!/usr/bin/env node
/**
 * The workflows' matrices from the committed platform config
 * (infra/platforms): which stacks to bootstrap, deploy or build.
 *
 *   node infra/ci/matrix.mjs --platform nas [--channel dev|latest] [--role env|shared] [--feature ios|android] [--stack munni-nas-prod] [--env prod|shared|all] [--existing nas-shared,nas-prod]
 *
 * --existing names the GitHub environments that exist: a stack whose
 * environment is missing was never bootstrapped, so pushes and image builds
 * skip it (with a note on stderr) — a dispatch that names its --stack is the
 * Bootstrap that creates the environment, and is never filtered.
 *
 * Prints a JSON array of {stack, platform, env, role, environment, channel,
 * appChannel, androidPackage, iosBundleId, scheme, label} — `environment` is
 * the GitHub environment the job must run in. With GITHUB_OUTPUT set the
 * array also lands in the step output `include` (fromJSON-ready) and its
 * length in `count`.
 */
import { appendFileSync } from 'node:fs';
import { listPlatforms, loadStack, platformEnvs, stackName } from '../modules/stack.mjs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const platform = arg('platform');
const channel = arg('channel');
const role = arg('role');
const feature = arg('feature');
const only = arg('stack');
const env = arg('env');
const existing = arg('existing');
const known = existing === undefined ? null : new Set(existing.split(',').map((s) => s.trim()).filter(Boolean));
const skipped = [];

const platforms = listPlatforms().filter((p) => !platform || p.platform === platform);
const rows = [];
for (const p of platforms) {
  const names = [stackName(p.platform), ...platformEnvs(p.platform).map((e) => stackName(p.platform, e.env))];
  for (const name of names) {
    // lenient: the matrix job runs outside any GitHub environment, so the
    // platform's domain secret is not there — rows never carry a host
    const s = loadStack(name, { lenient: true });
    if (only && s.stack !== only) continue;
    if (env && env !== 'all' && (env === 'shared' ? s.role !== 'shared' : s.env !== env)) continue;
    if (role && role !== 'all' && s.role !== role) continue;
    if (channel && channel !== 'all' && s.channel !== channel) continue;
    if (feature && !(s.features?.[feature])) continue;
    if (known && !only && !known.has(s.githubEnvironment)) { skipped.push(s); continue; }
    rows.push({
      stack: s.stack,
      platform: s.platform,
      env: s.env ?? 'shared',
      role: s.role,
      environment: s.githubEnvironment,
      channel: s.channel,
      appChannel: s.appChannel ?? 'production',
      androidPackage: s.native?.appId ?? '',
      iosBundleId: s.native?.iosAppId ?? '',
      scheme: s.native?.scheme ?? '',
      label: s.label,
      webHost: s.hosts.web ? s.hosts.web : '',
    });
  }
}
for (const s of skipped) console.error(`skip ${s.stack}: GitHub environment ${s.githubEnvironment} does not exist — not bootstrapped yet (the wizard's Bootstrap creates it)`);
const json = JSON.stringify(rows);
console.log(json);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `include=${json}\ncount=${rows.length}\n`);
}
