#!/usr/bin/env node
// Fails closed (#587): only the word `passed` on stdout lets a production deploy go on. A red, cancelled or
// missing Web CI holds it, and so does one still running at the deadline or a GitHub that cannot be asked.
import { pathToFileURL } from 'node:url';

const WORKFLOW = 'deploy.yml'; // Web CI

/** what the commit's Web CI says: a re-run keeps its run and moves the conclusion, so the newest run decides */
export function verdictOf(runs, sha) {
  const mine = runs.filter((r) => r.head_sha === sha).sort((a, b) => b.id - a.id);
  if (mine.length === 0) return 'missing';
  if (mine[0].status !== 'completed') return 'running';
  return mine[0].conclusion === 'success' ? 'passed' : 'failed';
}

async function ask(fetchImpl, url, token) {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  return res.json();
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** asks until the run has an end or the wait is over; the last word is the answer */
export async function waitForCi({ api, repo, token, sha, waitMs, everyMs = 30_000, fetchImpl = fetch, sleep = pause, now = Date.now }) {
  const given = { GITHUB_REPOSITORY: repo, GH_TOKEN: token, '--sha': sha };
  const missing = Object.keys(given).filter((name) => !given[name]);
  if (missing.length > 0) return `unknown (${missing.join(', ')} not given)`;
  const deadline = now() + waitMs;
  for (;;) {
    let verdict;
    try {
      const runs = (await ask(fetchImpl, `${api}/repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&per_page=20`, token))?.workflow_runs;
      if (!Array.isArray(runs)) throw new Error('the runs list carries no workflow_runs');
      verdict = verdictOf(runs, sha);
    } catch (e) {
      verdict = `unknown (${e instanceof Error ? e.message : String(e)})`;
    }
    if (verdict === 'passed' || verdict === 'failed' || now() >= deadline) return verdict;
    await sleep(everyMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const minutes = Number.parseInt(arg('wait-minutes') ?? '30', 10);
  console.log(
    await waitForCi({
      api: process.env.GITHUB_API_URL || 'https://api.github.com',
      repo: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      sha: arg('sha'),
      waitMs: (Number.isFinite(minutes) ? minutes : 30) * 60_000,
    }),
  );
}
