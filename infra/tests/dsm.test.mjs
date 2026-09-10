// DSM as code: the calls are shaped exactly like DSM's own UI's (captured by
// open-source clients); a fetch stub reads the form body back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReverseProxy, ensureWildcardCertificate, ensurePollerTask, inspectNas, resolveLiveDir, dsmAdvice, pollerScript, POLLER_TASK_NAME, tlsCovers,
} from '../modules/dsm.mjs';

const CREDS = { url: 'https://nas.example:5001/', user: 'deploy', pass: 'pw' };

/** a DSM stub: routes by api+method, records every call's params */
function dsm(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const p = Object.fromEntries(new URLSearchParams(init?.body ?? ''));
    const key = `${p.api}.${p.method}`;
    calls.push({ url, key, params: p, init });
    if (p.api === 'SYNO.API.Auth' && p.method === 'login') return { json: async () => ({ success: true, data: { sid: 'SID', synotoken: 'TOK' } }) };
    if (p.api === 'SYNO.API.Auth' && p.method === 'logout') return { json: async () => ({ success: true }) };
    const r = routes[key];
    if (!r) return { json: async () => ({ success: false, error: { code: 103 } }) };
    const out = typeof r === 'function' ? await r(p, calls) : r;
    if (out instanceof Error) throw out;
    return { json: async () => out };
  };
  return { calls, fetchImpl };
}
const ok = (data = {}) => ({ success: true, data });
const fail = (code) => ({ success: false, error: { code } });
const stack = { stack: 'munni-iac-prod', sharedServices: false, host: (k) => `${k}.nas.example`, ports: { web: 8290, api: 8292, admin: 8291 } };

test('dsm: every call rides the sid AND the SynoToken; error codes come with the operator advice', async () => {
  const { calls, fetchImpl } = dsm({ 'SYNO.Core.AppPortal.ReverseProxy.list': ok({ entries: [] }), 'SYNO.Core.AppPortal.ReverseProxy.create': ok({}) });
  const out = await applyReverseProxy(stack, CREDS, fetchImpl);
  assert.deepEqual(out.created, ['web.nas.example', 'api.nas.example', 'admin.nas.example']);
  const list = calls.find((c) => c.key === 'SYNO.Core.AppPortal.ReverseProxy.list');
  assert.equal(list.params._sid, 'SID');
  assert.equal(list.params.SynoToken, 'TOK');
  assert.equal(calls[0].params.enable_syno_token, 'yes');
  assert.match(dsmAdvice(new Error('DSM SYNO.API.Auth.login failed: {"code":402}')), /DSM application denied/);
  assert.match(dsmAdvice(new Error('DSM x failed: {"code":119}')), /administrators group/);
  assert.match(dsmAdvice(new Error('DSM x failed: {"code":5524}')), /rate limit/);
  assert.equal(dsmAdvice(new Error('nothing')), '');
});

test('certificate: a covered host costs nothing; an uncovered one reuses a held wildcard (set default) or requests one the way the wizard does', async () => {
  // covered → not even a login
  const a = dsm({});
  const covered = await ensureWildcardCertificate(CREDS, { domain: 'nas.example', probeHost: 'web.nas.example', email: 'x@y.z', fetchImpl: a.fetchImpl, probeImpl: async () => ({ covers: true }) });
  assert.equal(covered.state, 'covered');
  assert.equal(a.calls.length, 0);

  // uncovered, a wildcard certificate exists but is not the default → CRT set as_default (JSON-quoted strings)
  const b = dsm({
    'SYNO.Core.Certificate.CRT.list': ok({ certificates: [
      { id: 'old1', desc: 'nas.example', is_default: true, subject: { common_name: 'nas.example', sub_alt_name: ['nas.example'] }, valid_till: 'Oct 20 17:39:26 2026 GMT' },
      { id: 'wild1', desc: 'nas.example;*.nas.example', is_default: false, subject: { common_name: 'nas.example', sub_alt_name: ['nas.example', '*.nas.example'] }, valid_till: 'Dec  9 00:00:00 2026 GMT' },
    ] }),
    'SYNO.Core.Certificate.CRT.set': ok({}),
  });
  const reused = await ensureWildcardCertificate(CREDS, { domain: 'nas.example', probeHost: 'web.nas.example', email: 'x@y.z', fetchImpl: b.fetchImpl, probeImpl: async () => ({ covers: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  assert.equal(reused.state, 'set-default');
  const set = b.calls.find((c) => c.key === 'SYNO.Core.Certificate.CRT.set');
  assert.equal(set.params.as_default, 'true');
  assert.equal(set.params.id, '"wild1"');
  assert.ok(!b.calls.some((c) => c.key === 'SYNO.Core.Certificate.LetsEncrypt.create'), 'no new request when one is held');

  // uncovered, nothing held → LetsEncrypt create with "host;*.host" in domain_name (the wizard's shape), as default
  const c = dsm({
    'SYNO.Core.Certificate.CRT.list': ok({ certificates: [{ id: 'old1', desc: 'nas.example', is_default: true, subject: { common_name: 'nas.example' }, valid_till: 'Oct 20 17:39:26 2026 GMT' }] }),
    'SYNO.Core.Certificate.LetsEncrypt.create': ok({}),
  });
  const created = await ensureWildcardCertificate(CREDS, { domain: 'nas.example', probeHost: 'web.nas.example', email: 'ops@nas.example', fetchImpl: c.fetchImpl, probeImpl: async () => ({ covers: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  assert.equal(created.state, 'created');
  const create = c.calls.find((x) => x.key === 'SYNO.Core.Certificate.LetsEncrypt.create');
  assert.equal(create.params.domain_name, '"nas.example;*.nas.example"');
  assert.equal(create.params.email, '"ops@nas.example"');
  assert.equal(create.params.as_default, 'true');
  assert.equal(create.params.version, '1');
  assert.equal(create.init.signal.constructor.name, 'AbortSignal', 'the six-minute wait rides an abort signal');

  // a wizard call that outlives the wait is NOT retried: the list decides
  let listed = 0;
  const d = dsm({
    'SYNO.Core.Certificate.CRT.list': () => ok({ certificates: listed++ === 0 ? [] : [{ id: 'late', desc: 'nas.example;*.nas.example', is_default: true, subject: { common_name: 'nas.example' }, valid_till: 'Dec  9 00:00:00 2026 GMT' }] }),
    'SYNO.Core.Certificate.LetsEncrypt.create': () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; },
  });
  const late = await ensureWildcardCertificate(CREDS, { domain: 'nas.example', probeHost: 'web.nas.example', email: 'x@y.z', fetchImpl: d.fetchImpl, probeImpl: async () => ({ covers: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  assert.equal(late.state, 'created');
  assert.equal(d.calls.filter((x) => x.key === 'SYNO.Core.Certificate.LetsEncrypt.create').length, 1);

  // a probe that cannot tell (DNS down) never spends a request either
  const e = dsm({});
  const unknown = await ensureWildcardCertificate(CREDS, { domain: 'nas.example', probeHost: 'web.nas.example', email: 'x@y.z', fetchImpl: e.fetchImpl, probeImpl: async () => ({ covers: null, code: 'ENOTFOUND' }) });
  assert.equal(unknown.state, 'unknown');
  assert.equal(e.calls.length, 0);
});

test('poller task: created root-owned behind a password-confirm token, every 5 minutes all day, in the live dir next to published; present → untouched; 4800 → retried without monthly_week', async () => {
  const shares = ok({ shares: [{ name: 'docker', additional: { real_path: '/volume2/docker' } }] });
  const a = dsm({
    'SYNO.FileStation.List.list_share': shares,
    'SYNO.Core.TaskScheduler.list': ok({ tasks: [{ id: 3, name: 'other', owner: 'root', real_owner: 'root' }] }),
    'SYNO.Core.User.PasswordConfirm.auth': ok({ SynoConfirmPWToken: 'CONFIRM' }),
    'SYNO.Core.TaskScheduler.Root.create': ok({ id: 42 }),
  });
  const created = await ensurePollerTask(CREDS, { publishedPath: 'docker/munni-iac/published', fetchImpl: a.fetchImpl });
  assert.equal(created.state, 'created');
  assert.equal(created.id, 42);
  assert.equal(created.liveDir, '/volume2/docker/munni-iac', 'the share’s real path replaces the FileStation share name');
  const create = a.calls.find((c) => c.key === 'SYNO.Core.TaskScheduler.Root.create');
  assert.equal(create.params.name, POLLER_TASK_NAME);
  assert.equal(create.params.real_owner, 'root');
  assert.equal(create.params.type, 'script');
  assert.equal(create.params.SynoConfirmPWToken, 'CONFIRM');
  assert.equal(create.params.version, '4');
  const schedule = JSON.parse(create.params.schedule);
  assert.equal(schedule.repeat_min, 5);
  assert.equal(schedule.last_work_hour, 23);
  assert.equal(schedule.repeat_date, 1001);
  assert.equal(schedule.week_day, '0,1,2,3,4,5,6');
  const extra = JSON.parse(create.params.extra);
  assert.equal(extra.script, pollerScript('/volume2/docker/munni-iac'));
  assert.match(extra.script, /cp apply\.sh \.apply\.run && MUNNI_LIVE_DIR="\/volume2\/docker\/munni-iac" sh \.apply\.run/);
  const confirm = a.calls.find((c) => c.key === 'SYNO.Core.User.PasswordConfirm.auth');
  assert.equal(confirm.params.password, 'pw');

  // present with the right script → no write at all
  const b = dsm({
    'SYNO.FileStation.List.list_share': shares,
    'SYNO.Core.TaskScheduler.list': ok({ tasks: [{ id: 42, name: POLLER_TASK_NAME, owner: 'root', real_owner: 'root', enable: true }] }),
    'SYNO.Core.TaskScheduler.get': ok({ id: 42, enable: true, extra: { script: pollerScript('/volume2/docker/munni-iac') } }),
  });
  const present = await ensurePollerTask(CREDS, { publishedPath: '/docker/munni-iac/published', fetchImpl: b.fetchImpl });
  assert.equal(present.state, 'present');
  assert.ok(!b.calls.some((c) => c.key.startsWith('SYNO.Core.TaskScheduler.Root')));

  // present with a stale command → set
  const c = dsm({
    'SYNO.FileStation.List.list_share': shares,
    'SYNO.Core.TaskScheduler.list': ok({ tasks: [{ id: 42, name: POLLER_TASK_NAME, owner: 'root', real_owner: 'root' }] }),
    'SYNO.Core.TaskScheduler.get': ok({ id: 42, extra: { script: 'old' } }),
    'SYNO.Core.User.PasswordConfirm.auth': ok({ SynoConfirmPWToken: 'CONFIRM' }),
    'SYNO.Core.TaskScheduler.Root.set': ok({}),
  });
  const updated = await ensurePollerTask(CREDS, { publishedPath: '/docker/munni-iac/published', fetchImpl: c.fetchImpl });
  assert.equal(updated.state, 'updated');
  assert.equal(c.calls.find((x) => x.key === 'SYNO.Core.TaskScheduler.Root.set').params.id, '42');

  // 4800 on the first shape → the same create without monthly_week, with a fresh token
  let attempts = 0;
  const d = dsm({
    'SYNO.FileStation.List.list_share': fail(119),
    'SYNO.Core.TaskScheduler.list': ok({ tasks: [] }),
    'SYNO.Core.User.PasswordConfirm.auth': ok({ SynoConfirmPWToken: 'CONFIRM' }),
    'SYNO.Core.TaskScheduler.Root.create': (p) => { attempts++; return JSON.parse(p.schedule).monthly_week ? fail(4800) : ok({ id: 7 }); },
  });
  const retried = await ensurePollerTask(CREDS, { publishedPath: 'docker/munni/published', fetchImpl: d.fetchImpl });
  assert.equal(retried.state, 'created');
  assert.equal(attempts, 2);
  assert.equal(retried.liveDir, '/volume1/docker/munni', 'no share listing → the usual volume');
});

test('inspectNas + resolveLiveDir + tlsCovers: read-only views the verify step prints', async () => {
  const a = dsm({
    'SYNO.Core.Certificate.CRT.list': ok({ certificates: [{ id: 'w', desc: 'd;*.d', is_default: true, subject: { common_name: 'd' }, valid_till: 'Dec  9 00:00:00 2026 GMT' }] }),
    'SYNO.Core.TaskScheduler.list': ok({ tasks: [{ id: 9, name: POLLER_TASK_NAME, enable: true }] }),
    'SYNO.FileStation.List.list_share': fail(119),
  });
  const view = await inspectNas(CREDS, { domain: 'd', publishedPath: '/docker/munni/published', fetchImpl: a.fetchImpl });
  assert.deepEqual(view, { wildcard: { id: 'w', isDefault: true }, task: { id: 9, enabled: true }, liveDir: '/volume1/docker/munni' });
  const s = { call: async () => ({ shares: [{ name: 'docker', additional: { real_path: '/volume1/docker' } }] }) };
  assert.deepEqual(await resolveLiveDir(s, 'docker/munni/published'), { sharePath: '/docker/munni', liveDir: '/volume1/docker/munni' });
  assert.deepEqual(await resolveLiveDir(s, '/docker/munni/'), { sharePath: '/docker/munni', liveDir: '/volume1/docker/munni' });
  const bad = await tlsCovers('x.example', async () => { const e = new Error('fetch failed'); e.cause = { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }; throw e; });
  assert.deepEqual(bad, { covers: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const good = await tlsCovers('x.example', async () => ({ status: 200 }));
  assert.deepEqual(good, { covers: true });
  const dns = await tlsCovers('x.example', async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; });
  assert.equal(dns.covers, null);
});
