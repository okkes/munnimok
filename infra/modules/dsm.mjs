// the prod twin owns the NAS-wide resources (certificate, live dir, poller); the staging twin only binds its rules
// the login names NO session: an unknown one ("Core") is refused with 402 for every account (DSM 7.3.2)
// a rule keeps the certificate it was created with; Let's Encrypt allows 5 requests per name set per week

/** the ONE text per DSM error code; validate.mjs reuses the 402 one */
export const DSM_CODE_ADVICE = {
  402: 'DSM refused the login for the application it names (its password is right): either the account may not use it — Control Panel → User & Group → the deploy user → Applications → DSM: Allow, File Station: Allow (a group Deny beats Allow), and the administrators group (User groups tab) for the Control Panel APIs — or the login named a session DSM does not know (found live 2026-09-16: "Core" is refused for every account; the bootstrap names none, like DSM\'s own UI); --verify prints which login shapes DSM accepts',
  105: 'DSM treats this session as a non-administrator (its own init data says is_admin=false — verify prints it): Control Panel APIs are admin-only. Check User & Group → the deploy user → Edit → User groups → the administrators group is ticked AND saved, then sign in to DSM as this account once in a browser on the LAN: an administrator\'s desktop there but not here means Adaptive MFA (Control Panel → Security → Account; on by default for administrators without 2FA — a sign-in from GitHub\'s runners is "risky" and, with no e-mail on the account, gets a plain user\'s session): switch it off for administrators, or enroll the account in 2FA and give the pipeline its OTP secret (not supported yet)',
  119: 'DSM did not recognise the session for this call (119 = "SID not found"): the sid and the SynoToken must ride the query string / the X-SYNO-TOKEN header (DSM 7.3 does not read them from a POST body — found live 2026-09-16), or the session expired, or DSM handed out a sid it does not know (about one login in fifty: a session is checked and asked for again, so this one was lost several times in a row); --verify prints which call shapes DSM accepts',
  103: 'the API method does not exist in this form (103) — the version or the method name is wrong for this DSM',
  4800: 'DSM rejected the task parameters (4800) — the message only shows in /var/log/synoscgi.log on the NAS',
  5524: 'Let’s Encrypt’s rate limit for this name is used up (5 certificates per exact name set per week) — wait a week; never delete and re-request',
  5503: 'Let’s Encrypt could not validate the domain — with a Synology DDNS name the validation runs through Synology; otherwise port 80 must reach the NAS',
};
/** the codes that mean "fix the account", not "the step failed" */
export const DSM_PERMISSION_CODES = [402, 105];
export const dsmCode = (err) => Number(/"code":\s*(\d+)/.exec(String(err?.message ?? err ?? ''))?.[1]);
export function dsmAdvice(err) {
  const code = dsmCode(err);
  return DSM_CODE_ADVICE[code] ? ` — ${DSM_CODE_ADVICE[code]}` : '';
}
export const isPermissionError = (err) => DSM_PERMISSION_CODES.includes(dsmCode(err));

/** a failure BEFORE DSM answered (no connection, timeout, 5xx from its front nginx, non-JSON): only this kind is retried */
export class DsmTransportError extends Error {
  constructor(message, { cause, status = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DsmTransportError';
    this.status = status;
  }
}
export const isTransport = (e) => e?.name === 'DsmTransportError';
/** ≈ one minute of patience: what a DSM web-server restart (after a certificate change) costs */
export const DSM_RETRY = [2000, 4000, 8000, 15000, 15000, 15000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dsmRequest(url, init, label, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new DsmTransportError(`DSM ${label}: no answer (${e.cause?.code ?? e.name ?? e.message})`, { cause: e });
  }
  if (typeof res.status === 'number' && res.status >= 500) throw new DsmTransportError(`DSM ${label}: HTTP ${res.status} from the NAS front end`, { status: res.status });
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new DsmTransportError(`DSM ${label}: not a JSON answer${typeof res.status === 'number' ? ` (HTTP ${res.status})` : ''}`, { cause: e, status: typeof res.status === 'number' ? res.status : null });
  }
  if (!body.success) throw new Error(`DSM ${label} failed: ${JSON.stringify(body.error)}`);
  return body.data;
}

/** one form-encoded call; `retry` = delays (ms) between attempts, spent only on transport errors */
async function dsmCall(base, path, params, fetchImpl = fetch, { timeoutMs = 30000, retry = [], sleepImpl = sleep, query = null, headers = null } = {}) {
  const label = `${params.api}.${params.method}`;
  const url = `${base}/webapi/${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  for (let attempt = 0; ; attempt++) {
    try {
      return await dsmRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(headers ?? {}) },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(timeoutMs),
      }, label, fetchImpl);
    } catch (e) {
      if (!isTransport(e) || attempt >= retry.length) throw e;
      await sleepImpl(retry[attempt]);
    }
  }
}

// _sid in the QUERY (as a field DSM answers 119), file last; a session with a SynoToken must carry it here too
async function dsmUpload(base, sid, path, content, name, fetchImpl = fetch, { timeoutMs = 60000, token = null } = {}) {
  const form = new FormData();
  form.append('api', 'SYNO.FileStation.Upload');
  form.append('version', '2');
  form.append('method', 'upload');
  form.append('path', path);
  form.append('create_parents', 'true');
  form.append('overwrite', 'true');
  form.append('file', new Blob([content]), name);
  const query = new URLSearchParams({ _sid: sid, ...(token ? { SynoToken: token } : {}) });
  return dsmRequest(`${base}/webapi/entry.cgi?${query}`, { method: 'POST', body: form, ...(token ? { headers: { 'X-SYNO-TOKEN': token } } : {}), signal: AbortSignal.timeout(timeoutMs) }, 'SYNO.FileStation.Upload.upload', fetchImpl);
}

export async function dsmLogin(base, account, passwd, fetchImpl = fetch, { session = null, retry = [], sleepImpl = sleep } = {}) {
  // session only for a real DSM application (FileStation); the Control Panel APIs log in without one (an unknown name: 402)
  // enable_syno_token rides URL and body (acme.sh does both); entry.cgi, not auth.cgi: SYNO.API.Info names it
  // the DSM 7 path of SYNO.API.Auth
  const data = await dsmCall(base, 'entry.cgi', {
    api: 'SYNO.API.Auth',
    version: '7',
    method: 'login',
    account,
    passwd,
    ...(session ? { session } : {}),
    format: 'sid',
    enable_syno_token: 'yes',
  }, fetchImpl, { retry, sleepImpl, query: { enable_syno_token: 'yes' } });
  return { sid: data.sid, token: data.synotoken };
}

export async function dsmLogout(base, sid, fetchImpl = fetch, session = null) {
  await dsmCall(base, 'entry.cgi', { api: 'SYNO.API.Auth', version: '7', method: 'logout', ...(session ? { session } : {}), _sid: sid }, fetchImpl, { query: { _sid: sid } }).catch(() => undefined);
}

// read() adds the restart-proof retry: safe for reads only, a repeated create duplicates
// `session` names a DSM application (FileStation for files); none for the Control Panel APIs
// sid and token ride the QUERY STRING and X-SYNO-TOKEN header: DSM 7.3 does not read them from a POST body
// (a body-only sid answered 119 "SID not found")
const carried = ({ sid, token }) => ({ auth: { _sid: sid, ...(token ? { SynoToken: token } : {}) }, headers: token ? { 'X-SYNO-TOKEN': token } : null });

export const DSM_LOGIN_ATTEMPTS = 4;

// DSM 7.3 answers about one login in fifty with a sid it does not know itself: the first call with it is refused
// with 119 and so is every later one (measured with nothing else signed in, #638). A login counts once DSM answers
// a call with it; only 119 says "unknown", any other answer (a refusal for rights too) proves the session
async function knownLogin(base, user, pass, fetchImpl, { session, retry, sleepImpl }) {
  for (let attempt = 1; ; attempt++) {
    const login = await dsmLogin(base, user, pass, fetchImpl, { session, retry, sleepImpl });
    const { auth, headers } = carried(login);
    const refusal = await dsmCall(base, 'entry.cgi', { api: 'SYNO.FileStation.Info', version: '2', method: 'get', ...auth }, fetchImpl, { query: auth, headers, sleepImpl })
      .then(() => null, (e) => e);
    if (dsmCode(refusal) !== 119 || attempt >= DSM_LOGIN_ATTEMPTS) return login;
  }
}

export async function dsmSession({ url, user, pass }, fetchImpl = fetch, { session = null, retry = DSM_RETRY, sleepImpl = sleep } = {}) {
  const base = url.replace(/\/$/, '');
  const { sid, token } = await knownLogin(base, user, pass, fetchImpl, { session, retry, sleepImpl });
  const { auth, headers } = carried({ sid, token });
  const carry = { query: auth, headers };
  const call = (api, version, method, params = {}, opts = {}) => dsmCall(base, 'entry.cgi', { api, version: String(version), method, ...params, ...auth }, fetchImpl, { sleepImpl, ...carry, ...opts });
  return {
    base,
    sid,
    token,
    session,
    call,
    read: (api, version, method, params = {}, opts = {}) => call(api, version, method, params, { retry, ...opts }),
    upload: (path, content, name, opts) => dsmUpload(base, sid, path, content, name, fetchImpl, { token, ...opts }),
    logout: () => dsmLogout(base, sid, fetchImpl, session),
  };
}

/** DSM 7.3 lists a rule's id as `UUID`, older captures `uuid`: only the lowercase collapsed every rule onto one key */
const ruleId = (e) => e?.UUID ?? e?.uuid ?? null;

export function proxyRules(stack) {
  // LAN-restrict the admin, console, vault, control and pgadmin hosts in the DSM firewall (rules stay manual)
  return Object.keys(stack.hosts).map((key) => ({ key, host: stack.host(key), port: stack.ports[key] }));
}

export async function applyReverseProxy(stack, creds, fetchImpl = fetch, opts = {}) {
  const s = await dsmSession(creds, fetchImpl, opts);
  try {
    const existing = (await s.read('SYNO.Core.AppPortal.ReverseProxy', 1, 'list')).entries ?? [];
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
        // keep an access-control profile the operator set by hand (LAN-only admin hosts)
        await s.call('SYNO.Core.AppPortal.ReverseProxy', 1, 'update', { entry: JSON.stringify({ ...desired, frontend: { ...desired.frontend, acl_id: match.frontend?.acl_id ?? null }, UUID: ruleId(match) }) });
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
/** DSM prints valid_till like "Nov  1 23:59:59 2026 GMT"; unparseable stays valid (conservative) */
export const certValid = (c, now = Date.now()) => {
  const t = Date.parse(String(c.valid_till ?? ''));
  return Number.isNaN(t) || t > now;
};
const newest = (certs) => [...certs].sort((a, b) => new Date(b.valid_till ?? 0).getTime() - new Date(a.valid_till ?? 0).getTime())[0];
const listCerts = async (s) => (await s.read('SYNO.Core.Certificate.CRT', 1, 'list')).certificates ?? [];

// DSM's default certificate only decides what NEW services get: move a rule with SYNO.Core.Certificate.Service set,
// sending the descriptor DSM lists under the old certificate verbatim
export async function bindRulesToCertificate(s, { certId, hosts }) {
  if (!hosts?.length) return { bound: 0, migrated: [], unbound: [] };
  const entries = (await s.read('SYNO.Core.AppPortal.ReverseProxy', 1, 'list')).entries ?? [];
  const uuidHost = new Map(entries.filter((e) => hosts.includes(e.frontend?.fqdn) && ruleId(e)).map((e) => [ruleId(e), e.frontend.fqdn]));
  const settings = [];
  const seen = new Set();
  for (const c of await listCerts(s)) {
    for (const svc of c.services ?? []) {
      if (svc.subscriber !== 'ReverseProxy' || !uuidHost.has(svc.service)) continue;
      seen.add(svc.service);
      if (c.id !== certId) settings.push({ service: svc, old_id: c.id, id: certId });
    }
  }
  // a rule DSM lists under no certificate: bind it the way the wizard's first assignment does
  for (const [uuid, host] of uuidHost) {
    if (!seen.has(uuid)) settings.push({ service: { display_name: host, isPkg: false, multiple_cert: true, owner: 'root', service: uuid, subscriber: 'ReverseProxy', user_setable: true }, old_id: '', id: certId });
  }
  if (settings.length) {
    try {
      await s.call('SYNO.Core.Certificate.Service', 1, 'set', { settings: JSON.stringify(settings) });
    } catch (e) {
      // a binding change answers restart_httpd too: the answer may be lost
      // to the web-server restart — the (retried) list says whether it landed
      if (!isTransport(e)) throw e;
      const onTarget = new Set(((await listCerts(s)).find((c) => c.id === certId)?.services ?? []).filter((x) => x.subscriber === 'ReverseProxy').map((x) => x.service));
      if (!settings.every((x) => onTarget.has(x.service.service))) throw e;
    }
  }
  const known = [...uuidHost.values()];
  return { bound: uuidHost.size, migrated: settings.map((x) => uuidHost.get(x.service.service)), unbound: hosts.filter((h) => !known.includes(h)), listed: entries.length };
}

/** what DSM's own wizard waits for its Let's Encrypt call (its UI: six minutes) */
export const LE_WAIT_MS = 360000;

// a covered set requests nothing (never spends a Let's Encrypt request); rules are bound either way;
// a non-owner waits for the prod twin's request
export async function ensureWildcardCertificate(creds, { domain, probeHost, email, hosts = [], owner = true, fetchImpl = fetch, probeImpl = null, sleepImpl = sleep, pollMs = 15000, pollTries = 24 } = {}) {
  const probeOne = probeImpl ?? ((h) => tlsCovers(h, fetchImpl));
  const targets = [...new Set([probeHost ?? domain, ...hosts])];
  const probes = await Promise.all(targets.map(async (h) => [h, await probeOne(h)]));
  const allCovered = probes.every(([, p]) => p.covers === true);
  if (allCovered && !hosts.length) return { state: 'covered', detail: `the certificate DSM serves covers ${targets.join(', ')}` };
  const [target, probe] = probes.find(([, p]) => p.covers === false) ?? probes.find(([, p]) => p.covers !== true) ?? probes[0];
  const why = allCovered
    ? `the certificate DSM serves covers all ${targets.length} host${targets.length === 1 ? '' : 's'}`
    : (probe.covers === null ? `could not probe ${target} (${probe.code}) — DSM's certificate list decides` : `${target} is not covered (${probe.code})`);
  const s = await dsmSession(creds, fetchImpl, { sleepImpl });
  try {
    const names = `${domain};*.${domain}`;
    const bindNote = async (id) => {
      if (!hosts.length) return '';
      const b = await bindRulesToCertificate(s, { certId: id, hosts });
      const moved = b.migrated.length ? `; ${b.migrated.length} rule${b.migrated.length === 1 ? '' : 's'} moved onto it (${b.migrated.join(', ')})` : `; the ${b.bound} rule${b.bound === 1 ? '' : 's'} already use it`;
      return `${moved}${b.unbound.length ? `; no rule yet for ${b.unbound.join(', ')} (DSM listed ${b.listed} rule${b.listed === 1 ? '' : 's'} — the next run binds what it lists then)` : ''}`;
    };
    const wild = (certs) => certs.filter((c) => certHasWildcard(c, domain));
    const certs = await listCerts(s);
    const valid = wild(certs).filter((c) => certValid(c));
    const expired = wild(certs).filter((c) => !certValid(c));
    if (valid.length) {
      const c = newest(valid);
      if (!c.is_default) {
        try {
          await s.call('SYNO.Core.Certificate.CRT', 1, 'set', { as_default: 'true', desc: JSON.stringify(c.desc ?? ''), id: JSON.stringify(c.id) });
        } catch (e) {
          // DSM restarts its web server on a default change — the answer may not arrive; the list tells
          if (!isTransport(e)) throw e;
          const now = (await listCerts(s)).find((x) => x.id === c.id);
          if (!now?.is_default) throw e;
        }
        return { state: 'set-default', id: c.id, detail: `${why}; DSM already held a wildcard certificate (${c.id}) — set as the default${await bindNote(c.id)}; DSM restarts its web server, the hosts serve it within a minute` };
      }
      return { state: 'present', id: c.id, detail: `${why}; DSM holds a valid wildcard certificate (${c.id}, default)${await bindNote(c.id)}${probe.covers === false ? '; if the hosts still fail TLS in a minute, DSM has not reloaded yet' : ''}` };
    }
    // every host is served a certificate that covers it (an own-domain
    // multi-SAN one, say): a request would spend a Let's Encrypt slot for nothing
    if (allCovered) return { state: 'covered', detail: `${why}; DSM lists no wildcard certificate, so the rules stay on the one that covers them` };
    if (!owner) return { state: 'absent', detail: `${why}; no valid wildcard certificate on DSM yet — the prod twin's bootstrap requests it (one per NAS); this twin binds its rules on its next run` };
    const gone = expired.length ? ` (the wildcard DSM held, ${newest(expired).id}, expired ${newest(expired).valid_till})` : '';
    const started = Date.now();
    // DSM's wizard call is synchronous and slow (its UI waits six minutes): only a request DSM never answered is waited out
    // a refused one (rate limit 5524, validation 5503) is final and must NOT be repeated: every request counts
    let outlived = null;
    try {
      await s.call('SYNO.Core.Certificate.LetsEncrypt', 1, 'create', {
        desc: JSON.stringify(names),
        domain_name: JSON.stringify(names),
        email: JSON.stringify(email),
        as_default: 'true',
      }, { timeoutMs: LE_WAIT_MS });
    } catch (e) {
      if (!isTransport(e)) throw e;
      outlived = e;
    }
    // a 504 means the request is STILL RUNNING, and a created certificate may list a moment later: poll the list
    // "created" without the binding would chain Deploy over rules still on the old certificate
    let later = [];
    for (let i = 0; ; i++) {
      later = wild(await listCerts(s).catch(() => [])).filter((c) => certValid(c));
      if (later.length || i >= pollTries || Date.now() - started >= LE_WAIT_MS) break;
      await sleepImpl(pollMs);
    }
    if (!later.length) {
      throw new Error(`the Let's Encrypt request for ${names} is still running on the NAS after the wait (${outlived ? outlived.message : 'DSM answered, but its list holds no wildcard certificate yet'}) — check Control Panel → Security → Certificate; the next bootstrap run adopts it and binds the rules, so never re-request by hand (5 requests per name set per week)`);
    }
    const c = newest(later);
    const how = outlived ? `arrived (the request outlived the wait: ${outlived.message})` : 'requested through DSM and set as default';
    return { state: 'created', id: c.id, detail: `${why}; Let's Encrypt certificate for ${names} ${how}${gone}${await bindNote(c.id)}; DSM restarts its web server, the hosts serve it within a minute` };
  } finally {
    await s.logout();
  }
}

export const POLLER_TASK_NAME = 'munni deploy poller';
export const pollerScript = (liveDir, publishedDir = `${liveDir}/published`) =>
  `cd "${liveDir}" && cp apply.sh .apply.run && MUNNI_LIVE_DIR="${liveDir}" MUNNI_PUBLISHED_DIR="${publishedDir}" sh .apply.run`;

/** daily, every 5 minutes, all day — what DSM's own UI stores for that choice */
export const POLLER_SCHEDULE = {
  version: 4, // what DSM's own get returns for a v4 task; one client reports create wants it too
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

/** the live dir is the PARENT of SYNOLOGY_PATH, as deploy-nas.yml and nas-diag.yml also take it; throws without one */
export function publishedPathParts(publishedPath) {
  const segments = String(publishedPath ?? '').split('/').filter(Boolean);
  if (segments.length < 2) throw new Error(`SYNOLOGY_PATH must be a folder inside a shared folder (the live dir is its parent), e.g. /docker/munni/published — yours: ${segments.length ? `/${segments.join('/')}` : '(empty)'}`);
  return { share: segments[0], publishedSharePath: `/${segments.join('/')}`, liveSharePath: `/${segments.slice(0, -1).join('/')}`, rest: segments.slice(1, -1), leaf: segments[segments.length - 1] };
}

// FileStation share path → dirs on disk via the share's real path (never guess a volume)
// a Core session may be refused, so a FileStation session is tried
export async function resolveLiveDir(session, publishedPath, { creds = null, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const parts = publishedPathParts(publishedPath);
  const shareOf = async (s) => ((await s.call('SYNO.FileStation.List', 2, 'list_share', { additional: JSON.stringify(['real_path']) })).shares ?? []).find((x) => x.name === parts.share)?.additional?.real_path ?? null;
  let realShare = null;
  let cause = null;
  try {
    realShare = await shareOf(session);
  } catch (e) {
    cause = e;
    if (creds) {
      const fs = await dsmSession(creds, fetchImpl, { session: 'FileStation', sleepImpl });
      try {
        realShare = await shareOf(fs);
        cause = null;
      } catch (e2) {
        cause = e2;
      } finally {
        await fs.logout();
      }
    }
  }
  if (cause) throw new Error(`could not resolve the real path of the shared folder "${parts.share}" (${cause.message})${dsmAdvice(cause)} — the poller task is not touched`);
  if (!realShare) throw new Error(`no shared folder named "${parts.share}" on the NAS (SYNOLOGY_PATH ${parts.publishedSharePath}) — create it in Control Panel → Shared Folder, or fix the path`);
  const liveDir = `${realShare}${parts.rest.length ? `/${parts.rest.join('/')}` : ''}`;
  return { ...parts, liveDir, publishedDir: `${liveDir}/${parts.leaf}` };
}

// the published folder must exist before the first Deploy
// the task runs a throwaway copy of apply.sh, so overwriting it is safe
export async function ensureLiveDir(creds, { publishedPath, applyScript, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const parts = publishedPathParts(publishedPath);
  const s = await dsmSession(creds, fetchImpl, { session: 'FileStation', sleepImpl });
  try {
    await s.upload(parts.liveSharePath, applyScript, 'apply.sh');
    // force_parent: no error when the folder exists, parents made as needed
    await s.call('SYNO.FileStation.CreateFolder', 2, 'create', { folder_path: JSON.stringify([parts.liveSharePath]), name: JSON.stringify([parts.leaf]), force_parent: 'true' });
    return { state: 'ready', liveSharePath: parts.liveSharePath, detail: `apply.sh uploaded to ${parts.liveSharePath}, ${parts.publishedSharePath} exists` };
  } finally {
    await s.logout();
  }
}

const liveDirOf = (script) => /MUNNI_LIVE_DIR="([^"]*)"/.exec(String(script ?? ''))?.[1] ?? null;

// an existing task is left alone when the live dir cannot be resolved: never rewritten onto a guess
export async function ensurePollerTask(creds, { publishedPath, fetchImpl = fetch, name = POLLER_TASK_NAME, sleepImpl = sleep } = {}) {
  const s = await dsmSession(creds, fetchImpl, { sleepImpl });
  try {
    const tasks = (await s.read('SYNO.Core.TaskScheduler', 3, 'list', { sort_by: 'name', sort_direction: 'ASC', offset: '0', limit: '500' })).tasks ?? [];
    let found = tasks.find((t) => t.name === name);
    const ownerOf = (t) => t.real_owner || t.owner || 'root';
    let dirs;
    let dirsError = null;
    try {
      dirs = await resolveLiveDir(s, publishedPath, { creds, fetchImpl, sleepImpl });
    } catch (e) {
      dirsError = e;
    }
    // a hand-made poller for THIS live dir (any name) is adopted, never doubled: two tasks would take turns on one dir
    // a poller for ANOTHER dir belongs to another pipeline (the legacy live app) and stays untouched
    if (!found && dirs) {
      for (const t of tasks) {
        if (t.type && t.type !== 'script') continue;
        const cur = await s.read('SYNO.Core.TaskScheduler', 4, 'get', { id: String(t.id), real_owner: ownerOf(t) }).catch(() => null);
        const script = String(cur?.extra?.script ?? '');
        if (!/cp apply\.sh \.apply\.run/.test(script)) continue;
        const itsDir = liveDirOf(script) ?? /cd\s+"?([^\s"&;]+)"?/.exec(script)?.[1] ?? null;
        if (itsDir && itsDir.replace(/\/+$/, '') !== dirs.liveDir) continue;
        found = { ...t, adopted: true };
        break;
      }
    }
    const real = found ? ownerOf(found) : 'root';
    const currentOf = async () => (found ? s.read('SYNO.Core.TaskScheduler', 4, 'get', { id: String(found.id), real_owner: real }).catch(() => null) : null);
    if (dirsError) {
      if (!found) throw dirsError;
      const current = await currentOf();
      const dir = liveDirOf(current?.extra?.script);
      return { state: 'present', id: found.id, liveDir: dir, untouched: true, detail: `Task Scheduler entry "${name}" left as it is (runs in ${dir ?? 'an unknown dir'}) — ${dirsError.message}` };
    }
    const { liveDir, publishedDir } = dirs;
    const script = pollerScript(liveDir, publishedDir);
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
        if (dsmCode(e) !== 4800) throw e;
        const { monthly_week: _mw, ...slim } = POLLER_SCHEDULE;
        return s.call('SYNO.Core.TaskScheduler.Root', 4, method, { ...payload(await confirm(), slim), ...extra });
      }
    };
    if (found) {
      const current = await currentOf();
      if (!found.adopted && current?.extra?.script === script && (current.enable ?? true)) return { state: 'present', id: found.id, liveDir, detail: `Task Scheduler already runs "${name}" every 5 minutes in ${liveDir}` };
      await withRetry('set', { id: String(found.id), real_owner: real });
      if (found.adopted) return { state: 'adopted', id: found.id, liveDir, detail: `hand-made Task Scheduler entry "${found.name}" adopted as "${name}" (root, every 5 minutes, all day) in ${liveDir} — one poller per NAS, never two` };
      return { state: 'updated', id: found.id, liveDir, detail: `Task Scheduler entry "${name}" updated to run in ${liveDir}` };
    }
    const created = await withRetry('create', {});
    return { state: 'created', id: created?.id ?? null, liveDir, detail: `Task Scheduler entry "${name}" created (root, every 5 minutes, all day) in ${liveDir} — bundles apply within five minutes from now` };
  } finally {
    await s.logout();
  }
}

/** the host as DSM describes it: its memory (MB) and model — for the wizard's agent sizing (#420) */
export async function systemInfo(creds, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const s = await dsmSession(creds, fetchImpl, { sleepImpl });
  try {
    const info = await s.read('SYNO.Core.System', 1, 'info');
    const ram = Number(info?.ram_size);
    return { ramMb: Number.isFinite(ram) && ram > 0 ? Math.round(ram) : null, model: info?.model ?? null };
  } finally {
    await s.logout();
  }
}

export async function inspectNas(creds, { domain, publishedPath, hosts = [], fetchImpl = fetch, name = POLLER_TASK_NAME, sleepImpl = sleep } = {}) {
  const s = await dsmSession(creds, fetchImpl, { sleepImpl });
  try {
    const certs = await listCerts(s);
    const wild = certs.filter((c) => certHasWildcard(c, domain));
    const valid = wild.filter((c) => certValid(c));
    const pick = valid.length ? newest(valid) : (wild.length ? newest(wild) : null);
    const tasks = (await s.read('SYNO.Core.TaskScheduler', 3, 'list', { sort_by: 'name', sort_direction: 'ASC', offset: '0', limit: '500' })).tasks ?? [];
    const task = tasks.find((t) => t.name === name) ?? null;
    let liveDir = null;
    let liveDirError = null;
    try {
      ({ liveDir } = await resolveLiveDir(s, publishedPath, { creds, fetchImpl, sleepImpl }));
    } catch (e) {
      liveDirError = e.message;
    }
    let bindings = null;
    let ruleShape = null;
    if (pick && hosts.length) {
      const entries = (await s.read('SYNO.Core.AppPortal.ReverseProxy', 1, 'list').catch(() => ({}))).entries ?? [];
      // field names only (a rule's fqdn is the domain): a rule id named otherwise collapses every rule onto one map key
      ruleShape = entries.length ? { rules: entries.length, keys: Object.keys(entries[0]).sort(), frontend: Object.keys(entries[0].frontend ?? {}).sort(), withId: entries.filter((e) => ruleId(e)).length } : { rules: 0 };
      const uuidHost = new Map(entries.filter((e) => hosts.includes(e.frontend?.fqdn) && ruleId(e)).map((e) => [ruleId(e), e.frontend.fqdn]));
      const onWildcard = new Set((pick.services ?? []).filter((x) => x.subscriber === 'ReverseProxy').map((x) => x.service));
      const known = [...uuidHost.values()];
      bindings = {
        bound: [...uuidHost].filter(([u]) => onWildcard.has(u)).map(([, h]) => h),
        elsewhere: [...uuidHost].filter(([u]) => !onWildcard.has(u)).map(([, h]) => h),
        noRule: hosts.filter((h) => !known.includes(h)),
      };
    }
    return {
      wildcard: pick ? { id: pick.id, isDefault: Boolean(pick.is_default), expired: !valid.length, validTill: pick.valid_till ?? null } : null,
      task: task ? { id: task.id, enabled: task.enable !== false } : null,
      liveDir,
      liveDirError,
      bindings,
      ruleShape,
    };
  } finally {
    await s.logout();
  }
}

// secret-free digest for the readiness card (repo variable IAC_NAS_STATE): flags and counts only, never a host name
// the domain is a secret and repository variables are not
export function summarizeNas(nas, hostsTotal = 0) {
  return {
    dsm: { ok: true },
    wildcard: nas.wildcard ? { isDefault: nas.wildcard.isDefault, expired: nas.wildcard.expired, validTill: nas.wildcard.validTill } : null,
    task: nas.task ? { enabled: nas.task.enabled } : null,
    liveDir: nas.liveDir ?? null,
    bindings: nas.bindings ? { bound: nas.bindings.bound.length, elsewhere: nas.bindings.elsewhere.length, noRule: nas.bindings.noRule.length, total: hostsTotal } : null,
  };
}

// printed when the login is refused though the account looks right: session=Core got 402 (DSM 7.3.2) while no session,
// and v6 session=FileStation, worked — the shape, not the account, was the culprit
export const LOGIN_SHAPES = [
  { label: 'v7 entry.cgi, no session (bootstrap)', path: 'entry.cgi', params: { version: '7', enable_syno_token: 'yes' }, query: { enable_syno_token: 'yes' } },
  { label: 'v7 auth.cgi, no session', params: { version: '7', enable_syno_token: 'yes' }, query: { enable_syno_token: 'yes' } },
  { label: 'v7 entry.cgi + device token asked', path: 'entry.cgi', params: { version: '7', enable_syno_token: 'yes', enable_device_token: 'yes', device_name: 'munni-bootstrap' }, query: { enable_syno_token: 'yes' } },
  { label: 'v7 entry.cgi + client=browser', path: 'entry.cgi', params: { version: '7', enable_syno_token: 'yes', client: 'browser' }, query: { enable_syno_token: 'yes' } },
  { label: 'v7 session=Core (the old bootstrap)', params: { version: '7', session: 'Core', enable_syno_token: 'yes' } },
  { label: 'v7 session=FileStation', params: { version: '7', session: 'FileStation', enable_syno_token: 'yes' } },
  { label: 'v6 session=FileStation (upload.sh)', params: { version: '6', session: 'FileStation' } },
];
export async function probeLoginShapes({ url, user, pass }, fetchImpl = fetch, shapes = LOGIN_SHAPES) {
  const base = url.replace(/\/$/, '');
  const out = [];
  for (const s of shapes) {
    try {
      const data = await dsmCall(base, s.path ?? 'auth.cgi', { api: 'SYNO.API.Auth', method: 'login', account: user, passwd: pass, format: 'sid', ...s.params }, fetchImpl, { query: s.query ?? null });
      let admin = null;
      if (data.sid) {
        const auth = { _sid: data.sid, ...(data.synotoken ? { SynoToken: data.synotoken } : {}) };
        const init = await dsmCall(base, 'entry.cgi', { api: 'SYNO.Core.Desktop.Initdata', version: '1', method: 'get', ...auth }, fetchImpl, { query: auth, headers: data.synotoken ? { 'X-SYNO-TOKEN': data.synotoken } : null }).catch(() => null);
        admin = typeof init?.Session?.is_admin === 'boolean' ? init.Session.is_admin : null;
      }
      out.push({ label: s.label, ok: true, token: Boolean(data.synotoken), admin });
      await dsmCall(base, 'auth.cgi', { api: 'SYNO.API.Auth', version: s.params.version, method: 'logout', ...(s.params.session ? { session: s.params.session } : {}), _sid: data.sid }, fetchImpl, { query: { _sid: data.sid } }).catch(() => undefined);
    } catch (e) {
      out.push({ label: s.label, ok: false, code: dsmCode(e) || null, transport: isTransport(e) });
    }
  }
  return out;
}
export const describeLoginShapes = (shapes) => shapes.map((s) => {
  if (!s.ok) return `${s.label}: ${s.transport ? 'no answer' : `refused ${s.code ?? '?'}`}`;
  const notes = [...(s.token === undefined ? [] : [s.token ? 'token' : 'NO token']), ...(typeof s.admin === 'boolean' ? [s.admin ? 'admin' : 'NOT admin'] : [])];
  return `${s.label}: ok${notes.length ? ` (${notes.join(', ')})` : ''}`;
}).join('; ');

// the session and call shapes DSM reads, tried when a read is refused (105/119) though the login was accepted
export const SESSION_SHAPES = [
  { label: 'entry.cgi format=sid (bootstrap)', path: 'entry.cgi', params: { format: 'sid' } },
  { label: 'entry.cgi format=cookie', path: 'entry.cgi', params: { format: 'cookie' } },
  { label: 'auth.cgi format=sid', path: 'auth.cgi', params: { format: 'sid' } },
  { label: 'auth.cgi format=cookie', path: 'auth.cgi', params: { format: 'cookie' } },
];
export const CALL_SHAPES = [
  { label: 'sid+token in query + X-SYNO-TOKEN (bootstrap)', build: (a) => ({ body: {}, query: a, headers: { 'X-SYNO-TOKEN': a.SynoToken ?? '' } }) },
  { label: 'sid in body + X-SYNO-TOKEN (acme.sh)', build: (a) => ({ body: { _sid: a._sid }, query: null, headers: { 'X-SYNO-TOKEN': a.SynoToken ?? '' } }) },
  { label: 'cookie id=sid + X-SYNO-TOKEN (DSM UI)', build: (a) => ({ body: {}, query: null, headers: { cookie: `id=${a._sid}`, 'X-SYNO-TOKEN': a.SynoToken ?? '' } }) },
];
export async function probeCallShapes({ url, user, pass }, fetchImpl = fetch, { sessions = SESSION_SHAPES, shapes = CALL_SHAPES } = {}) {
  const base = url.replace(/\/$/, '');
  const out = [];
  for (const ss of sessions) {
    let data;
    try {
      data = await dsmCall(base, ss.path, { api: 'SYNO.API.Auth', version: '7', method: 'login', account: user, passwd: pass, enable_syno_token: 'yes', ...ss.params }, fetchImpl, { query: { enable_syno_token: 'yes' } });
    } catch (e) {
      out.push({ label: `${ss.label} → login`, ok: false, code: dsmCode(e) || null, transport: isTransport(e) });
      continue;
    }
    out.push({ label: `${ss.label} → login`, ok: true, token: Boolean(data.synotoken) });
    const auth = { _sid: data.sid ?? '', ...(data.synotoken ? { SynoToken: data.synotoken } : {}) };
    try {
      for (const s of shapes) {
        const { body, query, headers } = s.build(auth);
        try {
          await dsmCall(base, 'entry.cgi', { api: 'SYNO.Core.Certificate.CRT', version: '1', method: 'list', ...body }, fetchImpl, { query, headers });
          out.push({ label: `${ss.label} → ${s.label}`, ok: true });
        } catch (e) {
          out.push({ label: `${ss.label} → ${s.label}`, ok: false, code: dsmCode(e) || null, transport: isTransport(e) });
        }
      }
    } finally {
      await dsmCall(base, ss.path, { api: 'SYNO.API.Auth', version: '7', method: 'logout', _sid: auth._sid }, fetchImpl, { query: { _sid: auth._sid }, headers: { cookie: `id=${auth._sid}` } }).catch(() => undefined);
    }
  }
  return out;
}
export function describeCallShapes(list) {
  const groups = new Map();
  for (const x of list) {
    const [session, call] = x.label.split(' → ');
    if (!groups.has(session)) groups.set(session, []);
    groups.get(session).push({ ...x, label: call });
  }
  return [...groups].map(([session, calls]) => `${session}: ${describeLoginShapes(calls)}`).join('\n     ');
}

// read when Control Panel APIs refuse (105) an accepted administrator login: DSM 7.3 can enforce 2FA for administrators
// and one without it gets a plain user's session; booleans, numbers and a few enum words only, never a free string
const ENUM_WORDS = /^(none|admin|admins|administrators|all|group|groups|specific|custom|user|users|enabled|disabled|on|off|yes|no|required|optional|forced|email|mail|otp|adaptive)$/i;
const facts = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && ENUM_WORDS.test(v))));
export async function probeSessionFacts({ url, user, pass }, fetchImpl = fetch, { sweepLimit = 12 } = {}) {
  const base = url.replace(/\/$/, '');
  const out = {};
  const raw = await dsmCall(base, 'entry.cgi', { api: 'SYNO.API.Auth', version: '7', method: 'login', account: user, passwd: pass, format: 'sid', enable_syno_token: 'yes' }, fetchImpl, { query: { enable_syno_token: 'yes' } });
  out.loginKeys = Object.keys(raw ?? {}).sort();
  const auth = { _sid: raw.sid, ...(raw.synotoken ? { SynoToken: raw.synotoken } : {}) };
  const carry = { query: auth, headers: raw.synotoken ? { 'X-SYNO-TOKEN': raw.synotoken } : null };
  const call = (api, version, method, params = {}) => dsmCall(base, 'entry.cgi', { api, version: String(version), method, ...params, ...auth }, fetchImpl, carry);
  const outcome = async (fn) => { try { return await fn(); } catch (e) { return { error: dsmCode(e) || (isTransport(e) ? 'no answer' : e.message) }; } };
  try {
    const init = await outcome(() => call('SYNO.Core.Desktop.Initdata', 1, 'get'));
    const session = init.Session ?? init.session ?? {};
    out.initdata = init.error ? init : { keys: Object.keys(init).sort(), sessionKeys: Object.keys(session).sort(), session: { ...facts(session), ...(typeof session.authType === 'string' && /^[a-z_]{1,24}$/i.test(session.authType) ? { authType: session.authType } : {}) }, actionPrivilege: facts(init.ActionPrivilege), appPrivilege: facts(init.AppPrivilege) };
    const wanted = ['SYNO.Core.Certificate.CRT', 'SYNO.Core.Certificate', 'SYNO.Core.Certificate.Service', 'SYNO.Core.Certificate.LetsEncrypt', 'SYNO.Core.AppPortal.ReverseProxy', 'SYNO.Core.TaskScheduler', 'SYNO.Core.TaskScheduler.Root', 'SYNO.Core.Desktop.Initdata', 'SYNO.API.Auth'];
    const info = await outcome(() => dsmCall(base, 'entry.cgi', { api: 'SYNO.API.Info', version: '1', method: 'query', query: 'all' }, fetchImpl));
    out.apis = info.error ? info : Object.fromEntries(wanted.map((k) => [k, info[k] ? `${info[k].minVersion}-${info[k].maxVersion}` : 'absent']));
    if (!info.error) {
      const names = Object.keys(info).filter((k) => /OTP|MFA|Adaptive|Enforce|TwoFactor|2FA/i.test(k)).sort().slice(0, sweepLimit);
      out.otp = {};
      for (const name of names) {
        const r = await outcome(() => call(name, info[name].maxVersion, 'get'));
        out.otp[`${name} v${info[name].maxVersion}`] = r.error ? `error ${r.error}` : facts(r);
      }
    }
  } finally {
    await dsmLogout(base, raw.sid, fetchImpl);
  }
  return out;
}

/** the last lines of <live>/deploy.log via FileStation (mode open: the raw file, no JSON envelope); a missing log is 408 */
export async function readPollerLog(creds, { publishedPath, lines = 15, fetchImpl = fetch, sleepImpl = sleep, maxBytes = 65536 } = {}) {
  const { path, text } = await readLiveFile(creds, { publishedPath, file: 'deploy.log', fetchImpl, sleepImpl });
  const tail = text.slice(-maxBytes).split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).slice(-lines);
  return { path, lines: tail, bytes: text.length };
}

/** one file of the live dir (the parent of SYNOLOGY_PATH), raw, through FileStation — {path, text}; a missing file is DSM's error (408) */
export async function readLiveFile(creds, { publishedPath, file, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const parts = publishedPathParts(publishedPath);
  const s = await dsmSession(creds, fetchImpl, { session: 'FileStation', sleepImpl });
  try {
    const path = `${parts.liveSharePath}/${file}`;
    const query = new URLSearchParams({ api: 'SYNO.FileStation.Download', version: '2', method: 'download', path: JSON.stringify([path]), mode: 'open', _sid: s.sid, ...(s.token ? { SynoToken: s.token } : {}) });
    let res;
    try {
      res = await fetchImpl(`${s.base}/webapi/entry.cgi?${query}`, { method: 'GET', headers: s.token ? { 'X-SYNO-TOKEN': s.token } : {}, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new DsmTransportError(`DSM SYNO.FileStation.Download.download: no answer (${e.cause?.code ?? e.name ?? e.message})`, { cause: e });
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* the raw file — what we want */ }
    if (parsed && typeof parsed === 'object' && parsed.success === false) throw new Error(`DSM SYNO.FileStation.Download.download failed: ${JSON.stringify(parsed.error)}`);
    // a missing file comes back as DSM's HTML error page, not as JSON (found live 2026-09-16)
    if ((typeof res.status === 'number' && res.status >= 400) || /^\s*<(!doctype|html)/i.test(text)) throw new Error(`DSM SYNO.FileStation.Download.download failed: no such file ${path}${typeof res.status === 'number' ? ` (HTTP ${res.status})` : ''}`);
    return { path, text };
  } finally {
    await s.logout();
  }
}

export async function removeReverseProxy(stack, creds, fetchImpl = fetch, opts = {}) {
  const s = await dsmSession(creds, fetchImpl, opts);
  try {
    const entries = (await s.read('SYNO.Core.AppPortal.ReverseProxy', 1, 'list')).entries ?? [];
    const removed = [];
    const absent = [];
    for (const rule of proxyRules(stack)) {
      const match = entries.find((e) => e.frontend?.fqdn === rule.host && ruleId(e));
      if (!match) { absent.push(rule.host); continue; }
      // DSM's own dialog deletes by uuid list (the shape the Go operator captured)
      await s.call('SYNO.Core.AppPortal.ReverseProxy', 1, 'delete', { uuids: JSON.stringify([ruleId(match)]) });
      removed.push(rule.host);
    }
    return { removed, absent };
  } finally {
    await s.logout();
  }
}

export async function removePollerTask(creds, { fetchImpl = fetch, name = POLLER_TASK_NAME, sleepImpl = sleep } = {}) {
  const s = await dsmSession(creds, fetchImpl, { sleepImpl });
  try {
    const tasks = (await s.read('SYNO.Core.TaskScheduler', 3, 'list', { sort_by: 'name', sort_direction: 'ASC', offset: '0', limit: '500' })).tasks ?? [];
    const found = tasks.find((t) => t.name === name);
    if (!found) return { state: 'absent', detail: `no Task Scheduler entry "${name}"` };
    const real = found.real_owner || found.owner || 'root';
    // DSM 7.3 deletes via SYNO.Core.TaskScheduler `delete` with `tasks`: [{id, real_owner}]; v4 and the Root API answer 103
    // so the version is found by sweeping downwards; root tasks need no password confirm
    const tried = [];
    for (const v of [4, 3, 2, 1]) {
      try {
        await s.call('SYNO.Core.TaskScheduler', v, 'delete', { tasks: JSON.stringify([{ id: found.id, real_owner: real }]) });
        return { state: 'removed', id: found.id, detail: `Task Scheduler entry "${name}" (${found.id}) deleted (SYNO.Core.TaskScheduler v${v})` };
      } catch (e) {
        if (isTransport(e) || dsmCode(e) !== 103) throw e;
        tried.push(`v${v}`);
      }
    }
    throw new Error(`no delete method on SYNO.Core.TaskScheduler (tried ${tried.join(', ')}) — delete "${name}" by hand in Control Panel → Task Scheduler`);
  } finally {
    await s.logout();
  }
}

export async function removeLiveDir(creds, { publishedPath, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const parts = publishedPathParts(publishedPath);
  const s = await dsmSession(creds, fetchImpl, { session: 'FileStation', sleepImpl });
  try {
    // SYNO.FileStation.Delete v2 "delete" is the blocking variant (no start/status polling)
    await s.call('SYNO.FileStation.Delete', 2, 'delete', { path: JSON.stringify([parts.liveSharePath]), recursive: 'true' }, { timeoutMs: 120000 });
    return { state: 'removed', detail: `${parts.liveSharePath} deleted (apply.sh, deploy.log, the published folder)` };
  } finally {
    await s.logout();
  }
}

/** ask the poller to remove a twin: the stamp becomes "remove" (apply.sh tears the containers and the folder down) */
export async function requestRemoval(creds, { publishedPath, stamp, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const parts = publishedPathParts(publishedPath);
  const s = await dsmSession(creds, fetchImpl, { session: 'FileStation', sleepImpl });
  try {
    await s.upload(parts.publishedSharePath, 'remove\n', stamp);
    return { state: 'requested', detail: `${parts.publishedSharePath}/${stamp} = remove — the poller removes the twin within five minutes` };
  } finally {
    await s.logout();
  }
}
