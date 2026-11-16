import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { localAwareFetch } from './insecure-fetch.mjs';
import { loadStack } from './stack.mjs';

// every environment runs its own Logto, reached through the machine credential its first deploy seeded
// (LOGTO_INFRA_M2M_ID/SECRET); everything is an idempotent upsert by name

const MGMT_RESOURCE = 'https://default.logto.app/api';
export const ADMIN_RESOURCE = 'https://admin.logto.app/api';
export const ADMIN_SCOPE = 'admin';
export const ADMIN_ROLE = 'munni admin';

/** LAN mode (lcl): the plain-http localhost twin of every https sslip origin stays registered too */
const originVariants = (stack, url, twinPort) => (stack.delivery === 'docker' && stack.lan && url?.startsWith('https://') && twinPort ? [url, `http://localhost:${twinPort}`] : [url]);

async function mgmtToken(logtoUrl, m2mId, m2mSecret, fetchImpl = localAwareFetch, resource = MGMT_RESOURCE) {
  const res = await fetchImpl(`${logtoUrl}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${m2mId}:${m2mSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', resource, scope: 'all' }),
  });
  if (!res.ok) throw new Error(`logto token failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function api(logtoUrl, token, path, init = {}, fetchImpl = localAwareFetch) {
  const res = await fetchImpl(`${logtoUrl}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers } });
  if (!res.ok) throw new Error(`logto ${init.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
  // some writes answer a bare word ("Created" on POST /roles/{id}/users): only JSON is parsed
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function client(stack, { m2mId, m2mSecret }, fetchImpl = localAwareFetch) {
  const base = stack.urls.logto;
  const token = await mgmtToken(base, m2mId, m2mSecret, fetchImpl);
  return (path, init) => api(base, token, path, init, fetchImpl);
}

/** redirect URIs mirror what the apps send (origin + /auth-callback); the native shell returns on its own scheme */
export function appDefinitions(stack) {
  const spa = (name, url, twinPort) => {
    const origins = originVariants(stack, url, twinPort);
    return { name, type: 'SPA', oidcClientMetadata: { redirectUris: origins.map((o) => `${o}/auth-callback`), postLogoutRedirectUris: origins }, customClientMetadata: { corsAllowedOrigins: origins } };
  };
  const defs = {
    web: spa(`${stack.stack} web`, stack.urls.web, stack.ports.web),
    admin: spa(`${stack.stack} admin`, stack.urls.admin, stack.ports.admin),
    // the connector lab (#441): the same admin scope, its own app id
    lab: spa(`${stack.stack} lab`, stack.urls.lab, stack.ports.lab),
    native: {
      name: `${stack.stack} native`,
      type: 'Native',
      oidcClientMetadata: {
        redirectUris: [`${stack.native.scheme}://auth-callback`],
        postLogoutRedirectUris: [`${stack.native.scheme}://signed-out`],
      },
      customClientMetadata: {
        corsAllowedOrigins: ['capacitor://localhost', 'https://localhost'],
        // Logto 1.43 rotates a public client's refresh token on EVERY refresh; the webview can lose the rotated one
        // (iOS kills the app before storage flushes) and reuse detection destroys the grant: no rotation for the phone
        rotateRefreshToken: false,
        // 90 days is Logto's maximum; the SPAs keep rotation (localStorage + the cross-tab lock serialise refreshes, authToken.ts)
        refreshTokenTtlInDays: 90,
      },
    },
    m2m: { name: `${stack.stack} api m2m`, type: 'MachineToMachine' },
  };
  try {
    const shared = loadStack(stack.sharedStack);
    if (shared.controlApi === stack.stack) defs.control = spa(`${stack.stack} control`, shared.urls.control, shared.ports.control);
  } catch { /* no shared stack yet */ }
  return defs;
}

/** the application secret this module owns on every machine app it creates — read back on every run, minted once */
export const MACHINE_SECRET_NAME = 'munni bootstrap';

// Logto keeps application secrets in their own table and its endpoints carry none (1.43): the module's named secret
// is read back or minted once; a write-back once stored "undefined" and the api's token mint answered 401
async function machineSecret(call, appId) {
  const secrets = await call(`/applications/${appId}/secrets`);
  const mine = (Array.isArray(secrets) ? secrets : []).find((s) => s.name === MACHINE_SECRET_NAME);
  if (typeof mine?.value === 'string' && mine.value) return mine.value;
  const made = await call(`/applications/${appId}/secrets`, { method: 'POST', body: JSON.stringify({ name: MACHINE_SECRET_NAME }) });
  if (typeof made?.value !== 'string' || !made.value) throw new Error(`Logto answered without a value for the application secret "${MACHINE_SECRET_NAME}" of ${appId}`);
  return made.value;
}

/** a value the write-back may store — never missing, never empty (the string "undefined" once reached GitHub) */
const credential = (name, value) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}: no value to write back`);
  return value;
};

// PATCHes an existing app with its WHOLE definition (Logto replaces the jsonb column), so a policy change
// reaches every environment's next Bootstrap
export async function applyApps(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const existing = await call('/applications?page_size=100');
  const out = {};
  for (const [key, def] of Object.entries(appDefinitions(stack))) {
    const match = existing.find((a) => a.name === def.name);
    out[key] = match ? await call(`/applications/${match.id}`, { method: 'PATCH', body: JSON.stringify(def) }) : await call('/applications', { method: 'POST', body: JSON.stringify(def) });
  }
  out.m2m.secret = await machineSecret(call, out.m2m.id);
  out.resource = await ensureResource(call, stack);
  return out;
}

async function ensureResource(call, stack) {
  const resources = await call('/resources?page_size=100');
  const indicator = stack.urls.api;
  return resources.find((r) => r.indicator === indicator) ?? (await call('/resources', { method: 'POST', body: JSON.stringify({ name: `${stack.stack} api`, indicator }) }));
}

/** the `admin` scope on the API resource, granted by the `munni admin` role; the wizard's Access tab toggles it per user */
export async function ensureAdminRole(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const resource = await ensureResource(call, stack);
  const scopes = await call(`/resources/${resource.id}/scopes?page_size=100`);
  const scope = scopes.find((s) => s.name === ADMIN_SCOPE) ?? (await call(`/resources/${resource.id}/scopes`, { method: 'POST', body: JSON.stringify({ name: ADMIN_SCOPE, description: 'munni admin portal + control cockpit' }) }));
  const roles = await call('/roles?page_size=100');
  let role = roles.find((r) => r.name === ADMIN_ROLE);
  if (!role) {
    role = await call('/roles', { method: 'POST', body: JSON.stringify({ name: ADMIN_ROLE, description: 'may use the admin portal and the control cockpit', type: 'User', scopeIds: [scope.id] }) });
  } else {
    const has = await call(`/roles/${role.id}/scopes?page_size=100`);
    if (!has.some((s) => s.id === scope.id)) await call(`/roles/${role.id}/scopes`, { method: 'POST', body: JSON.stringify({ scopeIds: [scope.id] }) });
  }
  return { resourceId: resource.id, scopeId: scope.id, roleId: role.id };
}

export async function listUsers(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const users = await call('/users?page_size=100');
  const roles = await call('/roles?page_size=100');
  const role = roles.find((r) => r.name === ADMIN_ROLE);
  const admins = new Set(role ? (await call(`/roles/${role.id}/users?page_size=100`)).map((u) => u.id) : []);
  // Logto's timestamps are epoch milliseconds — handed on as ISO strings, the shape every other date on the page has
  return users.map((u) => ({ id: u.id, username: u.username ?? null, name: u.name ?? null, email: u.primaryEmail ?? null, avatar: u.avatar ?? null, admin: admins.has(u.id), lastSignInAt: u.lastSignInAt ? new Date(u.lastSignInAt).toISOString() : null }));
}

export async function setAdmin(stack, creds, userId, on, { fetchImpl = localAwareFetch } = {}) {
  const { roleId } = await ensureAdminRole(stack, creds, { fetchImpl });
  const call = await client(stack, creds, fetchImpl);
  const members = await call(`/roles/${roleId}/users?page_size=100`);
  const has = members.some((u) => u.id === userId);
  if (on && !has) await call(`/roles/${roleId}/users`, { method: 'POST', body: JSON.stringify({ userIds: [userId] }) });
  if (!on && has) await call(`/roles/${roleId}/users/${userId}`, { method: 'DELETE' });
  return { userId, admin: on };
}

/** connectors live under FIXED ids (google-universal, apple-universal) so the callbacks the wizard shows are exact */
export async function applySocialConnectors(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const wanted = [];
  const { LOGTO_GOOGLE_CLIENT_ID, LOGTO_GOOGLE_CLIENT_SECRET, LOGTO_APPLE_CLIENT_ID, LOGTO_APPLE_TEAM_ID, LOGTO_APPLE_KEY_ID, LOGTO_APPLE_PRIVATE_KEY } = process.env;
  // prompt=select_account: Google's own session otherwise continued the same account after "Use another account"
  if (LOGTO_GOOGLE_CLIENT_ID && LOGTO_GOOGLE_CLIENT_SECRET) wanted.push({ target: 'google', connectorId: 'google-universal', config: { clientId: LOGTO_GOOGLE_CLIENT_ID, clientSecret: LOGTO_GOOGLE_CLIENT_SECRET, scope: 'openid profile email', prompts: ['select_account'] } });
  if (LOGTO_APPLE_CLIENT_ID && LOGTO_APPLE_TEAM_ID && LOGTO_APPLE_KEY_ID && LOGTO_APPLE_PRIVATE_KEY) wanted.push({ target: 'apple', connectorId: 'apple-universal', config: { clientId: LOGTO_APPLE_CLIENT_ID, teamId: LOGTO_APPLE_TEAM_ID, keyId: LOGTO_APPLE_KEY_ID, privateKey: LOGTO_APPLE_PRIVATE_KEY, scope: 'name email' } });
  if (!wanted.length) return { applied: [] };
  const existing = await call('/connectors?page_size=100');
  const applied = [];
  const renamed = [];
  for (const def of wanted) {
    const match = existing.find((c) => c.target === def.target);
    if (match && match.id === def.connectorId) {
      await call(`/connectors/${match.id}`, { method: 'PATCH', body: JSON.stringify({ config: def.config }) });
    } else {
      if (match) { await call(`/connectors/${match.id}`, { method: 'DELETE' }); renamed.push(`${match.id} → ${def.connectorId}`); }
      await call('/connectors', { method: 'POST', body: JSON.stringify({ id: def.connectorId, connectorId: def.connectorId, config: def.config, syncProfile: true }) });
    }
    applied.push(def.target);
  }
  await call('/sign-in-exp', { method: 'PATCH', body: JSON.stringify({ socialSignInConnectorTargets: applied }) });
  return { applied, renamed, callbacks: Object.fromEntries(wanted.map((d) => [d.target, `${stack.urls.logto}/callback/${d.connectorId}`])) };
}

export async function applyBranding(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const { logoUrl, favicon } = await brandingImages(stack, fetchImpl);
  await call('/sign-in-exp', { method: 'PATCH', body: JSON.stringify({ branding: { logoUrl, darkLogoUrl: logoUrl, favicon }, color: { primaryColor: '#08372B', darkPrimaryColor: '#8FC7B4', isDarkModeEnabled: true } }) });
  return { logoUrl };
}

/** Logto's CSP allows img-src https: — a plain-http web origin inlines the icons as data: URIs instead */
async function brandingImages(stack, fetchImpl) {
  const web = stack.urls.web;
  if (web.startsWith('https://')) return { logoUrl: `${web}/icon-512.png`, favicon: `${web}/icon-192.png` };
  const res = await fetchImpl(`${web}/icon-192.png`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`icon fetch ${web}/icon-192.png failed (${res.status})`);
  const logo = `data:${res.headers.get('content-type') ?? 'image/png'};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  return { logoUrl: logo, favicon: logo };
}

/** Logto's built-in machine role over its own Management API — the seed makes it per tenant (the wizard's seed SQL links the infra credential to it the same way) */
export const MANAGEMENT_ROLE = 'Logto Management API access';

// account deletion removes the Logto user and invite-only mints one-time tokens: both need the api's machine app
// on the built-in role; role and app are found by name, never created here (the seed makes the role, applyApps the app)
export async function ensureManagementAccess(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const roles = await call('/roles?page_size=100');
  const role = roles.find((r) => r.name === MANAGEMENT_ROLE);
  if (!role) throw new Error(`Logto carries no role "${MANAGEMENT_ROLE}" — its seed makes it; nothing to grant`);
  const name = appDefinitions(stack).m2m.name;
  const apps = await call('/applications?page_size=100');
  const app = apps.find((a) => a.name === name);
  if (!app) throw new Error(`Logto carries no application "${name}" yet — applyApps makes it`);
  const held = await call(`/roles/${role.id}/applications?page_size=100`);
  const granted = !held.some((a) => a.id === app.id);
  if (granted) await call(`/roles/${role.id}/applications`, { method: 'POST', body: JSON.stringify({ applicationIds: [app.id] }) });
  return { role: role.name, roleId: role.id, appId: app.id, granted };
}

// invite-only: sign-in only; the admin portal mints an invitation link (a Logto one-time token); off reopens registration
// sign-up identifiers and sign-in methods stay EXACTLY as they are: no e-mail connector (enabled_connector_not_found)
export async function applySignUpPolicy(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const exp = (await call('/sign-in-exp')) ?? {};
  const inviteOnly = Boolean(stack.features?.inviteOnly);
  if (!inviteOnly) {
    if (exp.signInMode !== 'SignIn') return { inviteOnly, changed: false };
    await call('/sign-in-exp', { method: 'PATCH', body: JSON.stringify({ signInMode: 'SignInAndRegister' }) });
    return { inviteOnly, changed: true };
  }
  if (exp.signInMode === 'SignIn' && exp.socialSignIn?.automaticAccountLinking === true) return { inviteOnly, changed: false };
  await call('/sign-in-exp', { method: 'PATCH', body: JSON.stringify({ signInMode: 'SignIn', socialSignIn: { ...(exp.socialSignIn ?? {}), automaticAccountLinking: true } }) });
  return { inviteOnly, changed: true };
}

export const CONNECTOR_SCOPE = 'connector:admin';

export function connectorDefinitions(stack) {
  return {
    resource: { name: `${stack.stack} connector`, indicator: stack.urls.connector },
    role: { name: `${stack.stack} connector admin`, description: 'the api reaches the connector control plane as its operator', type: 'MachineToMachine' },
    app: { name: `${stack.stack} api connector m2m`, type: 'MachineToMachine' },
  };
}

// the connector control plane is an API resource (its public address is the audience it validates), scope connector:admin
// a machine role grants it to the api's m2m app: one token opens the consumer routes and the operator's
export async function ensureConnectorAccess(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  if (!stack.urls.connector) throw new Error(`${stack.stack} runs no connectors — nothing to grant`);
  const call = await client(stack, creds, fetchImpl);
  const defs = connectorDefinitions(stack);

  const resources = await call('/resources?page_size=100');
  const resource = resources.find((r) => r.indicator === defs.resource.indicator)
    ?? (await call('/resources', { method: 'POST', body: JSON.stringify(defs.resource) }));
  const scopes = await call(`/resources/${resource.id}/scopes?page_size=100`);
  const scope = scopes.find((s) => s.name === CONNECTOR_SCOPE)
    ?? (await call(`/resources/${resource.id}/scopes`, { method: 'POST', body: JSON.stringify({ name: CONNECTOR_SCOPE, description: 'the control plane\'s operator routes (kill switch, fleet, canaries)' }) }));

  const roles = await call('/roles?page_size=100');
  let role = roles.find((r) => r.name === defs.role.name);
  if (!role) {
    role = await call('/roles', { method: 'POST', body: JSON.stringify({ ...defs.role, scopeIds: [scope.id] }) });
  } else {
    const has = await call(`/roles/${role.id}/scopes?page_size=100`);
    if (!has.some((s) => s.id === scope.id)) await call(`/roles/${role.id}/scopes`, { method: 'POST', body: JSON.stringify({ scopeIds: [scope.id] }) });
  }

  const apps = await call('/applications?page_size=100');
  const app = apps.find((a) => a.name === defs.app.name)
    ?? (await call('/applications', { method: 'POST', body: JSON.stringify(defs.app) }));
  const held = await call(`/roles/${role.id}/applications?page_size=100`);
  if (!held.some((a) => a.id === app.id)) await call(`/roles/${role.id}/applications`, { method: 'POST', body: JSON.stringify({ applicationIds: [app.id] }) });

  return { appId: app.id, secret: await machineSecret(call, app.id), resourceId: resource.id, scopeId: scope.id, roleId: role.id };
}

export function writeBackConnector(stack, access) {
  const env = stack.githubEnvironment;
  const appId = credential('CONNECTOR_M2M_APP_ID', access.appId);
  const secret = credential('CONNECTOR_M2M_APP_SECRET', access.secret);
  execFileSync('gh', ['secret', 'set', 'CONNECTOR_M2M_APP_ID', '--env', env, '--body', appId]);
  execFileSync('gh', ['secret', 'set', 'CONNECTOR_M2M_APP_SECRET', '--env', env, '--body', secret]);
}

export function writeBack(stack, apps) {
  const env = stack.githubEnvironment;
  const m2mId = credential('LOGTO_M2M_APP_ID', apps.m2m.id);
  const m2mSecret = credential('LOGTO_M2M_APP_SECRET', apps.m2m.secret);
  const setVar = (name, value) => execFileSync('gh', ['variable', 'set', name, '--env', env, '--body', value]);
  setVar('VITE_LOGTO_APP_ID', apps.web.id);
  setVar('VITE_LOGTO_APP_ID_ADMIN', apps.admin.id);
  setVar('VITE_LOGTO_APP_ID_LAB', apps.lab.id);
  setVar('VITE_LOGTO_ENDPOINT', stack.urls.logto);
  setVar('NATIVE_LOGTO_APP_ID', apps.native.id);
  setVar('NATIVE_API_URL', stack.urls.api);
  setVar('NATIVE_PUBLIC_ORIGIN', stack.urls.web);
  setVar('NATIVE_LOGTO_ENDPOINT', stack.urls.logto);
  setVar('NATIVE_LOGTO_RESOURCE', stack.urls.api);
  execFileSync('gh', ['secret', 'set', 'LOGTO_M2M_APP_ID', '--env', env, '--body', m2mId]);
  execFileSync('gh', ['secret', 'set', 'LOGTO_M2M_APP_SECRET', '--env', env, '--body', m2mSecret]);
}

export async function claimConsole(stack, { adminId, adminSecret }, { fetchImpl = localAwareFetch, password = null } = {}) {
  const base = stack.urls.logtoAdmin;
  const token = await mgmtToken(base, adminId, adminSecret, fetchImpl, ADMIN_RESOURCE);
  const users = await api(base, token, '/users?page_size=20', {}, fetchImpl);
  let created = null;
  let userId = users.find((u) => u.username === 'admin')?.id ?? users[0]?.id ?? null;
  if (!users.length) {
    const pw = password ?? randomBytes(12).toString('base64url');
    const user = await api(base, token, '/users', { method: 'POST', body: JSON.stringify({ username: 'admin', password: pw }) }, fetchImpl);
    const roles = await api(base, token, '/roles?page_size=50', {}, fetchImpl);
    const roleIds = roles.filter((r) => ['user', 'default:admin'].includes(r.name)).map((r) => r.id);
    if (roleIds.length) await api(base, token, `/users/${user.id}/roles`, { method: 'POST', body: JSON.stringify({ roleIds }) }, fetchImpl);
    created = { username: 'admin', password: pw, id: user.id };
    userId = user.id;
  }
  // the console admits a user through the TENANT ORGANIZATION (t-<tenant>) role "admin": legacy roles give "Access denied"
  const membership = userId ? await ensureConsoleMembership(base, token, userId, fetchImpl) : null;
  const exp = await api(base, token, '/sign-in-exp', {}, fetchImpl);
  let modeSet = false;
  if (exp?.signInMode !== 'SignIn') {
    await api(base, token, '/sign-in-exp', { method: 'PATCH', body: JSON.stringify({ signInMode: 'SignIn' }) }, fetchImpl);
    modeSet = true;
  }
  return { created, existing: users.length > 0, modeSet, membership };
}

// Logto OSS has two tenant organizations (t-default, t-admin): joining only the first left the console on "Access denied"
async function ensureConsoleMembership(base, token, userId, fetchImpl) {
  const list = (x) => (Array.isArray(x) ? x : []);
  const orgs = list(await api(base, token, '/organizations?page_size=20', {}, fetchImpl)).filter((o) => String(o.id).startsWith('t-'));
  if (!orgs.length) return { organizations: [], role: null, joined: [], granted: [] };
  const roles = list(await api(base, token, '/organization-roles?page_size=50', {}, fetchImpl));
  const admin = roles.find((r) => r.name === 'admin') ?? roles[0];
  const joined = [];
  const granted = [];
  for (const org of orgs) {
    const members = list(await api(base, token, `/organizations/${org.id}/users?page_size=100`, {}, fetchImpl));
    if (!members.some((u) => u.id === userId)) {
      await api(base, token, `/organizations/${org.id}/users`, { method: 'POST', body: JSON.stringify({ userIds: [userId] }) }, fetchImpl);
      joined.push(org.id);
    }
    if (!admin) continue;
    const have = list(await api(base, token, `/organizations/${org.id}/users/${userId}/roles?page_size=50`, {}, fetchImpl));
    if (!have.some((r) => r.id === admin.id)) {
      await api(base, token, `/organizations/${org.id}/users/${userId}/roles`, { method: 'POST', body: JSON.stringify({ organizationRoleIds: [admin.id] }) }, fetchImpl);
      granted.push(org.id);
    }
  }
  return { organizations: orgs.map((o) => o.id), role: admin?.name ?? null, joined, granted };
}

export async function logtoAnswers(stack, { m2mId, m2mSecret }, fetchImpl = localAwareFetch) {
  try {
    await mgmtToken(stack.urls.logto, m2mId, m2mSecret, fetchImpl);
    return true;
  } catch {
    return false;
  }
}

export async function removeApps(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const existing = await call('/applications?page_size=100');
  const removed = [];
  const absent = [];
  for (const def of Object.values(appDefinitions(stack))) {
    const match = existing.find((a) => a.name === def.name);
    if (!match) { absent.push(def.name); continue; }
    await call(`/applications/${match.id}`, { method: 'DELETE' });
    removed.push(def.name);
  }
  // the connector's pieces go with the environment too, whether or not it still runs connectors
  const connector = connectorDefinitions({ ...stack, urls: { ...stack.urls, connector: stack.urls.connector ?? `${stack.urls.api}/connector` } });
  const connectorApp = existing.find((a) => a.name === connector.app.name);
  if (connectorApp) { await call(`/applications/${connectorApp.id}`, { method: 'DELETE' }); removed.push(connector.app.name); }
  const roles = await call('/roles?page_size=100');
  const connectorRole = roles.find((r) => r.name === connector.role.name);
  if (connectorRole) { await call(`/roles/${connectorRole.id}`, { method: 'DELETE' }); removed.push(connector.role.name); }
  const resources = await call('/resources?page_size=100');
  for (const indicator of [stack.urls.api, stack.urls.connector].filter(Boolean)) {
    const res = resources.find((r) => r.indicator === indicator);
    if (res) { await call(`/resources/${res.id}`, { method: 'DELETE' }); removed.push(`resource ${indicator}`); }
  }
  return { removed, absent };
}
