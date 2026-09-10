/**
 * DSM 7 as code (IAC4): the same webapi the deploy pipeline already
 * drives for FileStation. Everything here is idempotent — re-runs
 * converge instead of duplicating:
 *   - reverse-proxy rules (matched by source FQDN)
 *   - the wildcard Let's Encrypt certificate the https hosts need
 *     (DSM's DDNS default covers only <domain> itself — found live
 *     2026-09-10; the wildcard rides in domain_name as "host;*.host",
 *     which is what DSM's own wizard sends)
 *   - the Task Scheduler entry that applies uploaded bundles (the
 *     poller, root-owned: a password-confirm token stands in for the
 *     dialog DSM shows for root scripts)
 * Auth: SYNOLOGY_URL/USER/PASS env (the deploy account). Every call
 * here is administrator-only on DSM — a non-admin account gets 105/119,
 * an account whose DSM application is denied gets 402 at login; both
 * are named by dsmAdvice(). Nothing below can grant an account those
 * rights: that is the ONE manual step (Control Panel → User & Group).
 *
 * Firewall rules stay manual (the DSM firewall API is undocumented and
 * fragile) — `--verify` probes the outcome instead.
 *
 * API shapes (DSM publishes none) come from open-source clients that
 * captured DSM 7's own UI: N4S4/synology-api, acme.sh's synology_dsm
 * hook, KastnerRG/krg-infra, phoeluga/synology-proxy-operator,
 * RROrg/rr-addons, 007revad (researched + cross-checked 2026-09-10).
 */

/** DSM error codes as the operator meets them */
export const DSM_CODE_ADVICE = {
  402: 'DSM application denied for this account — Control Panel → User & Group → the deploy user → Applications → DSM: Allow (a group Deny beats Allow); File Station too',
  105: 'the account is not in the administrators group — Control Panel APIs are admin-only: User & Group → the deploy user → User groups → administrators',
  119: 'DSM refused the session for this API — the account is not in the administrators group (User & Group → the deploy user → User groups → administrators)',
  103: 'DSM wants its CSRF token beside the sid (SynoToken) — the login must use enable_syno_token=yes',
  4800: 'DSM rejected the task parameters (4800) — the message only shows in /var/log/synoscgi.log on the NAS',
  5524: 'Let’s Encrypt’s rate limit for this name is used up (5 certificates per exact name set per week) — wait a week; never delete and re-request',
  5503: 'Let’s Encrypt could not validate the domain — with a Synology DDNS name the validation runs through Synology; otherwise port 80 must reach the NAS',
};
export function dsmAdvice(err) {
  const code = Number(/"code":\s*(\d+)/.exec(String(err?.message ?? err ?? ''))?.[1]);
  return DSM_CODE_ADVICE[code] ? ` — ${DSM_CODE_ADVICE[code]}` : '';
}

async function dsmCall(base, path, params, fetchImpl = fetch, { timeoutMs = 30000 } = {}) {
  const res = await fetchImpl(`${base}/webapi/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`DSM ${params.api}.${params.method} failed: ${JSON.stringify(body.error)}`);
  return body.data;
}

export async function dsmLogin(base, account, passwd, fetchImpl = fetch) {
  // enable_syno_token: DSM 7 wants the CSRF token beside the sid on
  // state-changing entry.cgi calls (per the documented v7 auth flow)
  const data = await dsmCall(base, 'auth.cgi', {
    api: 'SYNO.API.Auth',
    version: '7',
    method: 'login',
    account,
    passwd,
    session: 'Core',
    format: 'sid',
    enable_syno_token: 'yes',
  }, fetchImpl);
  return { sid: data.sid, token: data.synotoken };
}

export async function dsmLogout(base, sid, fetchImpl = fetch) {
  await dsmCall(base, 'auth.cgi', { api: 'SYNO.API.Auth', version: '7', method: 'logout', session: 'Core', _sid: sid }, fetchImpl).catch(() => undefined);
}

/** one logged-in session: call(api, version, method, params) with sid + token, and a logout */
export async function dsmSession({ url, user, pass }, fetchImpl = fetch) {
  const base = url.replace(/\/$/, '');
  const { sid, token } = await dsmLogin(base, user, pass, fetchImpl);
  const auth = { _sid: sid, ...(token ? { SynoToken: token } : {}) };
  return {
    base,
    call: (api, version, method, params = {}, opts) => dsmCall(base, 'entry.cgi', { api, version: String(version), method, ...params, ...auth }, fetchImpl, opts),
    logout: () => dsmLogout(base, sid, fetchImpl),
  };
}

/** the reverse-proxy rules a stack needs: source https host -> local port */
export function proxyRules(stack) {
  const rules = [
    { host: stack.host('web'), port: stack.ports.web },
    { host: stack.host('api'), port: stack.ports.api },
    { host: stack.host('admin'), port: stack.ports.admin },
  ];
  if (stack.sharedServices) {
    rules.push(
      { host: stack.host('logto'), port: stack.ports.logto },
      { host: stack.host('logtoAdmin'), port: stack.ports.logtoAdmin },
      { host: stack.host('glitchtip'), port: stack.ports.glitchtip },
      // the pair's Vaultwarden (secrets-access plan SA1) — LAN-restrict
      // it in the DSM firewall like the *-admin hosts
      { host: stack.host('vault'), port: stack.ports.vault },
    );
  }
  return rules;
}

/** upsert the stack's rules; returns {created, updated, unchanged} */
export async function applyReverseProxy(stack, creds, fetchImpl = fetch) {
  const s = await dsmSession(creds, fetchImpl);
  try {
    const existing = (await s.call('SYNO.Core.AppPortal.ReverseProxy', 1, 'list')).entries ?? [];
    const out = { created: [], updated: [], unchanged: [] };
    for (const rule of proxyRules(stack)) {
      const desired = {
        description: `${stack.stack}: ${rule.host}`,
        frontend: { protocol: 1, fqdn: rule.host, port: 443, acl_id: null, https_hsts: false, https_http2: true },
        backend: { protocol: 0, fqdn: 'localhost', port: rule.port },
        customize_headers: [],
        proxy_connect_timeout: 60,
        proxy_read_timeout: 60,
        proxy_send_timeout: 60,
        proxy_intercept_errors: false,
        proxy_http_version: 1,
      };
      const match = existing.find((e) => e.frontend?.fqdn === rule.host);
      if (!match) {
        await s.call('SYNO.Core.AppPortal.ReverseProxy', 1, 'create', { entry: JSON.stringify(desired) });
        out.created.push(rule.host);
      } else if (match.backend?.port !== rule.port) {
        await s.call('SYNO.Core.AppPortal.ReverseProxy', 1, 'update', { entry: JSON.stringify({ ...desired, uuid: match.uuid }) });
        out.updated.push(rule.host);
      } else {
        out.unchanged.push(rule.host);
      }
    }
    return out;
  } finally {
    await s.logout();
  }
}

/* ── the wildcard certificate ────────────────────────────────────────── */

/** does the certificate DSM serves cover this host? true / false / null (cannot tell) */
export async function tlsCovers(host, fetchImpl = fetch) {
  try {
    await fetchImpl(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) });
    return { covers: true };
  } catch (e) {
    const code = e.cause?.code ?? e.code ?? e.name;
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return { covers: false, code };
    if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED'].includes(code)) return { covers: false, code };
    return { covers: null, code };
  }
}

const certHasWildcard = (c, domain) => {
  const sans = c.subject?.sub_alt_name ?? [];
  // DSM 7.2 may list the CN only: our own request's description names the wildcard too
  return sans.includes(`*.${domain}`) || String(c.desc ?? '').includes(`*.${domain}`);
};
const newest = (certs) => [...certs].sort((a, b) => new Date(b.valid_till ?? 0).getTime() - new Date(a.valid_till ?? 0).getTime())[0];

/**
 * Make DSM serve a certificate that covers *.<domain>. Probe first (a
 * covered host means nothing to do — never spends a Let's Encrypt
 * request), then reuse a wildcard certificate DSM already holds (set it
 * default), else request one through DSM's own Let's Encrypt wizard
 * call. Returns {state, ...}: covered | set-default | created | pending.
 */
export async function ensureWildcardCertificate(creds, { domain, probeHost, email, fetchImpl = fetch, probeImpl = null } = {}) {
  const probe = await (probeImpl ?? ((h) => tlsCovers(h, fetchImpl)))(probeHost ?? domain);
  if (probe.covers === true) return { state: 'covered', detail: `the certificate DSM serves covers ${probeHost ?? domain}` };
  if (probe.covers === null) return { state: 'unknown', detail: `could not probe ${probeHost ?? domain} (${probe.code}) — the certificate is neither confirmed nor requested` };
  const s = await dsmSession(creds, fetchImpl);
  try {
    const list = async () => (await s.call('SYNO.Core.Certificate.CRT', 1, 'list')).certificates ?? [];
    const have = (await list()).filter((c) => certHasWildcard(c, domain));
    if (have.length) {
      const c = newest(have);
      if (c.is_default) return { state: 'present', id: c.id, detail: `DSM already holds a wildcard certificate (${c.id}, default) — if hosts still fail TLS, DSM has not reloaded yet` };
      await s.call('SYNO.Core.Certificate.CRT', 1, 'set', { as_default: 'true', desc: JSON.stringify(c.desc ?? ''), id: JSON.stringify(c.id) });
      return { state: 'set-default', id: c.id, detail: `DSM already held a wildcard certificate (${c.id}) — set as the default` };
    }
    const names = `${domain};*.${domain}`;
    try {
      // DSM's wizard call is synchronous and slow (its own UI waits six minutes)
      await s.call('SYNO.Core.Certificate.LetsEncrypt', 1, 'create', {
        desc: JSON.stringify(names),
        domain_name: JSON.stringify(names),
        email: JSON.stringify(email),
        as_default: 'true',
      }, { timeoutMs: 360000 });
      return { state: 'created', detail: `Let's Encrypt certificate for ${names} requested through DSM and set as default` };
    } catch (e) {
      // a timeout must NOT be retried (every request counts against the
      // rate limit): look whether the certificate arrived after all
      if (/TimeoutError|aborted/i.test(e.name ?? '') || /abort|timeout/i.test(e.message)) {
        const later = (await list().catch(() => [])).filter((c) => certHasWildcard(c, domain));
        if (later.length) return { state: 'created', id: newest(later).id, detail: `Let's Encrypt certificate for ${names} arrived (the request outlived the wait)` };
        return { state: 'pending', detail: `the Let's Encrypt request for ${names} is still running on the NAS — check Control Panel → Security → Certificate in a few minutes; do not re-request` };
      }
      throw e;
    }
  } finally {
    await s.logout();
  }
}

/* ── the poller task ─────────────────────────────────────────────────── */

export const POLLER_TASK_NAME = 'munni deploy poller';
/** the command the task runs: a throwaway copy of apply.sh, told where the live dir is */
export const pollerScript = (liveDir) => `cd ${liveDir} && cp apply.sh .apply.run && MUNNI_LIVE_DIR="${liveDir}" sh .apply.run`;

/** daily, every 5 minutes, all day — what DSM's own UI stores for that choice */
export const POLLER_SCHEDULE = {
  date_type: 0,
  week_day: '0,1,2,3,4,5,6',
  repeat_date: 1001,
  monthly_week: [],
  hour: 0,
  minute: 0,
  repeat_hour: 0,
  repeat_min: 5,
  last_work_hour: 23,
  repeat_min_store_config: [1, 5, 10, 15, 20, 30],
  repeat_hour_store_config: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
};

/** the FileStation share path (…/docker/munni/published) → the live dir on disk (/volume1/docker/munni) */
export async function resolveLiveDir(session, publishedPath) {
  const p = `/${String(publishedPath ?? '').replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const live = p.replace(/\/published$/, '') || p;
  const [, share, ...rest] = live.split('/');
  let realShare = null;
  try {
    const shares = (await session.call('SYNO.FileStation.List', 2, 'list_share', { additional: JSON.stringify(['real_path']) })).shares ?? [];
    realShare = shares.find((x) => x.name === share)?.additional?.real_path ?? null;
  } catch { /* FileStation may refuse the Core session — fall back to the usual volume */ }
  return { sharePath: live, liveDir: `${realShare ?? `/volume1/${share}`}${rest.length ? `/${rest.join('/')}` : ''}` };
}

/**
 * Ensure the Task Scheduler entry that applies uploaded bundles exists
 * (root, every 5 minutes, all day). Returns {state, id, liveDir}:
 * present | updated | created.
 */
export async function ensurePollerTask(creds, { publishedPath, fetchImpl = fetch, name = POLLER_TASK_NAME } = {}) {
  const s = await dsmSession(creds, fetchImpl);
  try {
    const { liveDir } = await resolveLiveDir(s, publishedPath);
    const script = pollerScript(liveDir);
    const tasks = (await s.call('SYNO.Core.TaskScheduler', 3, 'list', { sort_by: 'name', sort_direction: 'ASC', offset: '0', limit: '500' })).tasks ?? [];
    const found = tasks.find((t) => t.name === name);
    const confirm = async () => (await s.call('SYNO.Core.User.PasswordConfirm', 2, 'auth', { password: creds.pass })).SynoConfirmPWToken;
    const payload = (token, schedule = POLLER_SCHEDULE) => ({
      name,
      real_owner: 'root',
      owner: 'root',
      enable: 'true',
      type: 'script',
      schedule: JSON.stringify(schedule),
      extra: JSON.stringify({ script, notify_enable: false, notify_mail: '', notify_if_error: false }),
      SynoConfirmPWToken: token,
    });
    // DSM 7.3 rejects monthly_week on a daily task (4800) while 7.2 accepts it — try both shapes once
    const withRetry = async (method, extra) => {
      const token = await confirm();
      try {
        return await s.call('SYNO.Core.TaskScheduler.Root', 4, method, { ...payload(token), ...extra });
      } catch (e) {
        if (!/"code":\s*4800/.test(e.message)) throw e;
        const { monthly_week: _mw, ...slim } = POLLER_SCHEDULE;
        return s.call('SYNO.Core.TaskScheduler.Root', 4, method, { ...payload(await confirm(), slim), ...extra });
      }
    };
    if (found) {
      const real = found.real_owner || found.owner || 'root';
      const current = await s.call('SYNO.Core.TaskScheduler', 4, 'get', { id: String(found.id), real_owner: real }).catch(() => null);
      if (current?.extra?.script === script && (current.enable ?? true)) return { state: 'present', id: found.id, liveDir, detail: `Task Scheduler already runs "${name}" every 5 minutes in ${liveDir}` };
      await withRetry('set', { id: String(found.id), real_owner: real });
      return { state: 'updated', id: found.id, liveDir, detail: `Task Scheduler entry "${name}" updated to run in ${liveDir}` };
    }
    const created = await withRetry('create', {});
    return { state: 'created', id: created?.id ?? null, liveDir, detail: `Task Scheduler entry "${name}" created (root, every 5 minutes, all day) — bundles apply within five minutes from now` };
  } finally {
    await s.logout();
  }
}

/** read-only: what the NAS holds (for --verify) */
export async function inspectNas(creds, { domain, publishedPath, fetchImpl = fetch, name = POLLER_TASK_NAME } = {}) {
  const s = await dsmSession(creds, fetchImpl);
  try {
    const certs = (await s.call('SYNO.Core.Certificate.CRT', 1, 'list')).certificates ?? [];
    const wildcard = certs.filter((c) => certHasWildcard(c, domain));
    const tasks = (await s.call('SYNO.Core.TaskScheduler', 3, 'list', { sort_by: 'name', sort_direction: 'ASC', offset: '0', limit: '500' })).tasks ?? [];
    const task = tasks.find((t) => t.name === name) ?? null;
    const { liveDir } = await resolveLiveDir(s, publishedPath);
    return {
      wildcard: wildcard.length ? { id: newest(wildcard).id, isDefault: Boolean(newest(wildcard).is_default) } : null,
      task: task ? { id: task.id, enabled: task.enable !== false } : null,
      liveDir,
    };
  } finally {
    await s.logout();
  }
}
