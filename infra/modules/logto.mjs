import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { localAwareFetch } from './insecure-fetch.mjs';
import { loadStack } from './stack.mjs';

/**
 * Logto as code for ONE environment: every environment runs its own
 * Logto (infra/platforms/README.md), reached through the machine
 * credential the environment's first deploy seeded into Logto's database
 * (LOGTO_INFRA_M2M_ID/SECRET). Apps, the API resource with its `admin`
 * scope, the `munni admin` role, social connectors, branding, the sign-up
 * policy (invitation-only), the api's Management API access, the
 * console's first admin — all idempotent upserts by name.
 */

const MGMT_RESOURCE = 'https://default.logto.app/api';
/** the admin tenant's Management API — the console's users live there */
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
  // some writes answer a bare word ("Created" on POST /roles/{id}/users, 201) — only JSON is parsed; the wizard's admin
  // switch showed "Unexpected token 'C'" on it although the role had been granted (2026-09-28)
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** a logged-in Management API client for the environment's own Logto */
async function client(stack, { m2mId, m2mSecret }, fetchImpl = localAwareFetch) {
  const base = stack.urls.logto;
  const token = await mgmtToken(base, m2mId, m2mSecret, fetchImpl);
  return (path, init) => api(base, token, path, init, fetchImpl);
}

/**
 * the app definitions one environment needs: SPA web + admin + lab (+ the
 * control cockpit when this environment powers it), native, m2m. Redirect
 * URIs mirror what the apps really send (origin + /auth-callback; the
 * native shell returns via /native-auth or its scheme).
 */
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
        redirectUris: [`${stack.urls.web}/native-auth`, `${stack.native.scheme}://auth-callback`],
        postLogoutRedirectUris: [`${stack.urls.web}/native-signed-out`, `${stack.native.scheme}://signed-out`],
      },
      customClientMetadata: { corsAllowedOrigins: ['capacitor://localhost', 'https://localhost'] },
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

/**
 * The machine credential's secret. Logto keeps an application's secrets in
 * their own table and its application endpoints carry none (svhd/logto
 * 1.43; found live 2026-10-01 — the write-back had stored the string
 * "undefined" and the api's token mint answered 401): the module's own
 * named secret is read back when it is there and minted when it is not,
 * so every bootstrap writes back the same value and a run without a
 * deploy never desyncs the running api from Logto.
 */
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

/** upsert-by-name; returns {web, admin, lab, native, m2m, control?, resource} */
export async function applyApps(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const existing = await call('/applications?page_size=100');
  const out = {};
  for (const [key, def] of Object.entries(appDefinitions(stack))) {
    const match = existing.find((a) => a.name === def.name);
    out[key] = match ? await call(`/applications/${match.id}`, { method: 'PATCH', body: JSON.stringify(def) }) : await call('/applications', { method: 'POST', body: JSON.stringify(def) });
  }
  // the api's machine credential: the module's own application secret on its m2m app
  out.m2m.secret = await machineSecret(call, out.m2m.id);
  out.resource = await ensureResource(call, stack);
  return out;
}

async function ensureResource(call, stack) {
  const resources = await call('/resources?page_size=100');
  const indicator = stack.urls.api;
  return resources.find((r) => r.indicator === indicator) ?? (await call('/resources', { method: 'POST', body: JSON.stringify({ name: `${stack.stack} api`, indicator }) }));
}

/**
 * Admin access as code (user ruling 2026-09-17): the API resource carries
 * an `admin` scope, the user role `munni admin` grants it, and the api
 * lets a token with that scope into /admin and /control. Nobody's subject
 * is typed anywhere — the wizard's Access tab lists the users and toggles
 * the role. Returns {resourceId, scopeId, roleId}.
 */
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

/** every user of the environment's Logto, with whether they hold the admin role */
export async function listUsers(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const users = await call('/users?page_size=100');
  const roles = await call('/roles?page_size=100');
  const role = roles.find((r) => r.name === ADMIN_ROLE);
  const admins = new Set(role ? (await call(`/roles/${role.id}/users?page_size=100`)).map((u) => u.id) : []);
  // Logto's timestamps are epoch milliseconds — handed on as ISO strings, the shape every other date on the page has
  return users.map((u) => ({ id: u.id, username: u.username ?? null, name: u.name ?? null, email: u.primaryEmail ?? null, avatar: u.avatar ?? null, admin: admins.has(u.id), lastSignInAt: u.lastSignInAt ? new Date(u.lastSignInAt).toISOString() : null }));
}

/** grant or revoke the admin role for one user (the role is ensured first) */
export async function setAdmin(stack, creds, userId, on, { fetchImpl = localAwareFetch } = {}) {
  const { roleId } = await ensureAdminRole(stack, creds, { fetchImpl });
  const call = await client(stack, creds, fetchImpl);
  const members = await call(`/roles/${roleId}/users?page_size=100`);
  const has = members.some((u) => u.id === userId);
  if (on && !has) await call(`/roles/${roleId}/users`, { method: 'POST', body: JSON.stringify({ userIds: [userId] }) });
  if (!on && has) await call(`/roles/${roleId}/users/${userId}`, { method: 'DELETE' });
  return { userId, admin: on };
}

/**
 * Social sign-in as code: Google + Apple connectors from the operator's
 * OAuth credentials in the environment; absent credentials skip that
 * provider. Connectors live under their FIXED ids (google-universal,
 * apple-universal) so the callbacks the wizard shows are exact.
 */
export async function applySocialConnectors(stack, creds, { fetchImpl = localAwareFetch } = {}) {
  const call = await client(stack, creds, fetchImpl);
  const wanted = [];
  const { LOGTO_GOOGLE_CLIENT_ID, LOGTO_GOOGLE_CLIENT_SECRET, LOGTO_APPLE_CLIENT_ID, LOGTO_APPLE_TEAM_ID, LOGTO_APPLE_KEY_ID, LOGTO_APPLE_PRIVATE_KEY } = process.env;
  if (LOGTO_GOOGLE_CLIENT_ID && LOGTO_GOOGLE_CLIENT_SECRET) wanted.push({ target: 'google', connectorId: 'google-universal', config: { clientId: LOGTO_GOOGLE_CLIENT_ID, clientSecret: LOGTO_GOOGLE_CLIENT_SECRET, scope: 'openid profile email' } });
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

/** sign-in screen branding: the munni logo (served by the environment's own web app) + brand colors */
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

/**
 * The api reaches the Management API as code (user 2026-10-07): account
 * deletion removes the Logto user, and an invitation-only environment
 * mints its invitation links (one-time tokens) — both need the api's
 * machine app behind Logto's built-in role above. The role and the app
 * are found by name, never created here (the seed makes the role,
 * applyApps the app); the grant happens once. Returns
 * {role, roleId, appId, granted}.
 */
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

/**
 * Invitation-only sign-up as code (user 2026-10-07): with
 * features.inviteOnly the environment's sign-in experience is sign-in
 * only — nobody registers at the door; the admin portal mints an
 * invitation link (a Logto one-time token) that registers the invitee,
 * whom Logto's own "complete your profile" screens then ask for whatever
 * the tenant's sign-up wants (a username tenant stays a username
 * tenant), and social sign-in links itself to the matching verified
 * e-mail afterwards. The sign-up identifiers and sign-in methods are
 * left EXACTLY as they are: the tenants carry no e-mail connector, and
 * Logto's validator refuses an e-mail identifier or e-mail code method
 * without one (enabled_connector_not_found) — that connector is a later
 * step. Off: registration opens again (SignInAndRegister). One PATCH,
 * only when something differs. Returns {inviteOnly, changed}.
 */
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

/** the connector's API resource, machine role and the api's machine app, named per environment */
export function connectorDefinitions(stack) {
  return {
    resource: { name: `${stack.stack} connector`, indicator: stack.urls.connector },
    role: { name: `${stack.stack} connector admin`, description: 'the api reaches the connector control plane as its operator', type: 'MachineToMachine' },
    app: { name: `${stack.stack} api connector m2m`, type: 'MachineToMachine' },
  };
}

/**
 * The relay's credential as code (#367, slice M2): the connector control
 * plane is an API resource of the environment's Logto (its public address
 * as the indicator, which is the audience the control plane validates),
 * carrying the `connector:admin` scope; a machine role grants that scope;
 * the api's own machine app holds the role. The api mints client
 * credentials for the resource and every scope its roles carry comes along
 * — so the same token opens the consumer routes and the operator's. Upsert
 * by name, like the apps. Returns {appId, secret, resourceId, scopeId, roleId}.
 */
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

/** GitHub write-back (nas) of the relay's machine credential */
export function writeBackConnector(stack, access) {
  const env = stack.githubEnvironment;
  const appId = credential('CONNECTOR_M2M_APP_ID', access.appId);
  const secret = credential('CONNECTOR_M2M_APP_SECRET', access.secret);
  execFileSync('gh', ['secret', 'set', 'CONNECTOR_M2M_APP_ID', '--env', env, '--body', appId]);
  execFileSync('gh', ['secret', 'set', 'CONNECTOR_M2M_APP_SECRET', '--env', env, '--body', secret]);
}

/** GitHub write-back (nas): app ids as variables, the api's m2m credential as secrets */
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

/**
 * The console's first admin, as code: with the admin-tenant machine
 * credential the deploy seeded, create the console user `admin` with a
 * generated password once, give it the console's roles, and switch the
 * console from Register to SignIn. Idempotent. Returns {created, existing, modeSet}.
 */
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
  // the console admits a user through the TENANT ORGANIZATION (t-<tenant>): a member holding the organization role
  // "admin" — the legacy roles alone open on "Oops! Access denied" (getOrganizationTokenClaims), nas prod 2026-09-28
  const membership = userId ? await ensureConsoleMembership(base, token, userId, fetchImpl) : null;
  const exp = await api(base, token, '/sign-in-exp', {}, fetchImpl);
  let modeSet = false;
  if (exp?.signInMode !== 'SignIn') {
    await api(base, token, '/sign-in-exp', { method: 'PATCH', body: JSON.stringify({ signInMode: 'SignIn' }) }, fetchImpl);
    modeSet = true;
  }
  return { created, existing: users.length > 0, modeSet, membership };
}

/**
 * every TENANT organization of the admin tenant takes the user with the "admin" organization role — Logto OSS has two
 * (t-default = the default tenant the console manages, t-admin = the admin tenant itself; a first run that joined only
 * the first one listed left the console on "Access denied", nas prod 2026-09-28). Idempotent.
 */
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

/** true once Logto issues a token for the infra credential — the seed has landed */
export async function logtoAnswers(stack, { m2mId, m2mSecret }, fetchImpl = localAwareFetch) {
  try {
    await mgmtToken(stack.urls.logto, m2mId, m2mSecret, fetchImpl);
    return true;
  } catch {
    return false;
  }
}

/** delete the environment's apps (by their code names) and its API resource; returns {removed, absent} */
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
