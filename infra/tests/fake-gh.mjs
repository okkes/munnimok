// The fake `gh` CLI (see fixture.mjs fakeGh): loaded through NODE_OPTIONS
// --import into a node binary named gh, so `gh <args>` lands here with
// the subcommand as argv[1]. Mirrors the calls the modules make — GitHub
// environments, their secrets and variables — against a JSON state file,
// and exits before node would look for a script named "api".
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const stateFile = process.env.FAKE_GH_STATE;
const args = process.argv.slice(1);
if (stateFile && ['api', 'secret', 'variable'].includes(basename(args[0] ?? ''))) {
  args[0] = basename(args[0]);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.calls.push(args);
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  const fail = (msg, code = 1) => { save(); process.stderr.write(`gh: ${msg}\n`); process.exit(code); };
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const envOf = (path) => /environments\/([^/?]+)/.exec(path)?.[1];
  const envs = state.environments;
  let out = '';
  if (args[0] === 'api') {
    const method = opt('-X') ?? 'GET';
    const path = args.find((a, i) => i > 0 && a.startsWith('repos/'));
    const env = decodeURIComponent(envOf(path) ?? '');
    if (method === 'PUT') {
      envs[env] ??= { secrets: {}, variables: {} };
    } else if (method === 'DELETE') {
      if (!envs[env]) fail('Not Found (HTTP 404)');
      delete envs[env];
    } else if (path.includes('/secrets')) {
      if (!envs[env]) fail('Not Found (HTTP 404)');
      out = `${Object.keys(envs[env].secrets).join('\n')}\n`;
    } else if (path.includes('/variables')) {
      if (!envs[env]) fail('Not Found (HTTP 404)');
      out = `${Object.entries(envs[env].variables).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
    } else fail(`fake gh: unsupported api call ${args.join(' ')}`, 2);
  } else if (args[1] === 'set') {
    const kind = args[0] === 'secret' ? 'secrets' : 'variables';
    const env = opt('--env');
    const value = opt('--body');
    if (env) {
      if (!envs[env]) fail(`Not Found (HTTP 404) — no environment ${env}`);
      envs[env][kind][args[2]] = value;
    } else state.repoVariables[args[2]] = value;
  } else fail(`fake gh: unsupported call ${args.join(' ')}`, 2);
  save();
  process.stdout.write(out);
  process.exit(0);
}
