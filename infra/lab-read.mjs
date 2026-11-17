#!/usr/bin/env node
// Reads an environment's lab with its machine account (#635): runs, recordings, states. Nothing here acts.
//   node infra/lab-read.mjs <env> jobs [key=value …]       the runs (provider=bol kind=login state=failed)
//   node infra/lab-read.mjs <env> job <jobId>
//   node infra/lab-read.mjs <env> recording <jobId> <dir>   trace.json, digest.md and screenshot.png into <dir>
//   node infra/lab-read.mjs <env> get <path>                any route the reader may read, e.g. /lab/providers/bol
// --platform <id> names another platform than nas. The account comes from the platform vault, opened with the
// wizard's values on this computer. No address is printed: the platform's domain is not for a log
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labQuery, labReaderAccount, openLab } from './modules/labReader.mjs';
import { wizardValues } from './modules/localstore.mjs';
import { loadStack, stackName } from './modules/stack.mjs';

const USAGE = 'usage: node infra/lab-read.mjs <env> jobs [key=value …] | job <jobId> | recording <jobId> <dir> | get <path>   [--platform <id>]';

const pretty = (answer) => (answer.type.includes('json') ? JSON.stringify(JSON.parse(answer.bytes.toString('utf8')), null, 2) : answer.bytes.toString('utf8'));

async function main(argv) {
  const args = [...argv];
  const flag = args.indexOf('--platform');
  const platform = flag >= 0 ? args.splice(flag, 2)[1] : 'nas';
  const [env, command, ...rest] = args;
  if (!env || !command) throw new Error(USAGE);

  const values = wizardValues(platform);
  process.env.PLATFORM_DOMAIN ??= values.PLATFORM_DOMAIN;
  const stack = loadStack(stackName(platform, env));
  const shared = loadStack(stackName(platform));
  if (!values.VAULT_ADMIN_EMAIL || !values.VAULT_MASTER_PASSWORD) throw new Error(`the wizard holds no vault account for ${platform} on this computer`);

  const account = await labReaderAccount(shared, stack, { email: values.VAULT_ADMIN_EMAIL, password: values.VAULT_MASTER_PASSWORD });
  if (!account) throw new Error(`the vault folder ${stack.stack} holds no lab reader yet — Bootstrap ${env} once (the wizard): that makes the account and files it`);
  const read = await openLab(stack, account);
  const wanted = async (path) => {
    const answer = await read(path);
    if (answer.status !== 200) throw new Error(`${path} -> ${answer.status} ${answer.bytes.toString('utf8').slice(0, 300)}`);
    return answer;
  };

  if (command === 'jobs') return console.log(pretty(await wanted(`/lab/jobs${labQuery(rest)}`)));
  if (command === 'job') return console.log(pretty(await wanted(`/lab/jobs/${encodeURIComponent(rest[0])}`)));
  if (command === 'get') return console.log(pretty(await wanted(rest[0])));
  if (command !== 'recording') throw new Error(`unknown command "${command}"\n${USAGE}`);

  const [jobId, dir] = rest;
  if (!jobId || !dir) throw new Error('recording needs a job id and a directory');
  const id = encodeURIComponent(jobId);
  mkdirSync(dir, { recursive: true });
  const trace = await wanted(`/lab/jobs/${id}/trace`);
  writeFileSync(join(dir, 'trace.json'), pretty(trace));
  const digest = await wanted(`/lab/jobs/${id}/trace/digest.md`);
  writeFileSync(join(dir, 'digest.md'), digest.bytes);
  // a run that ended well left no picture: its absence is not a failure
  const shot = await read(`/lab/jobs/${id}/artifacts/screenshot`);
  if (shot.status === 200) writeFileSync(join(dir, 'screenshot.png'), shot.bytes);
  return console.log(`trace.json ${trace.bytes.length} bytes, digest.md ${digest.bytes.length} bytes${shot.status === 200 ? `, screenshot.png ${shot.bytes.length} bytes` : `, no screenshot (${shot.status})`} -> ${dir}`);
}

// the message alone: a failed connection's cause names the host
main(process.argv.slice(2)).catch((e) => {
  console.error(`${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
  process.exitCode = 1;
});
