#!/usr/bin/env node
// the workflows' matrices from the platform config (#416); `environment` is the GitHub environment the job must run in
// --existing names the GitHub environments that exist: a stack without one was never bootstrapped, so pushes and
// image builds skip it; a dispatch that names its --stack is the Bootstrap that creates it, and is never filtered
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
      // the branch the job checks out for its templates and tools (#416): the platform's, else by channel
      ref: s.branch,
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
