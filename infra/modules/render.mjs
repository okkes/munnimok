import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStack, platformEnvStacks } from './stack.mjs';

/** the docker network a platform's environment stacks share with its shared stack */
export const sharedNet = (platform) => `munni-${platform}-shared-net`;

// MUNNI_RENDER_DIR: test override so specs never touch a real rendered/
const OUT_DIR = () => process.env.MUNNI_RENDER_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'rendered');

/**
 * Render docker-compose.<stack>.yml + .env.<stack> for ONE stack of any
 * platform. The env file is a TEMPLATE of ${NAME} placeholders (the
 * manifest's names plus the VITE_* variables the modules write back);
 * `values` substitutes them right here (the lcl platform renders with
 * real values), CI substitutes them from the GitHub environment at
 * bundle time (deploy/nas/render-env.sh). Output: infra/rendered/<stack>/.
 */
export function renderStack(stack, values) {
  const dir = join(OUT_DIR(), stack.stack);
  mkdirSync(join(dir, 'initdb'), { recursive: true });
  if (stack.role === 'shared') {
    writeFileSync(join(dir, `docker-compose.${stack.stack}.yml`), sharedCompose(stack));
    writeFileSync(join(dir, `.env.${stack.stack}`), substitute(sharedTemplate(stack), values));
    writeFileSync(join(dir, 'pgadmin-servers.json'), `${pgadminServers(stack)}\n`);
    if (stack.delivery === 'docker') writeFileSync(join(dir, 'Caddyfile'), familyCaddyfile(stack));
    writeFileSync(join(dir, 'initdb', '01-create-databases.sql'), '-- glitchtip-db is initialised by POSTGRES_DB\n');
    return dir;
  }
  writeFileSync(join(dir, `docker-compose.${stack.stack}.yml`), envCompose(stack));
  writeFileSync(join(dir, `.env.${stack.stack}`), substitute(envTemplate(stack), values));
  // the connector control plane keeps its own database on the environment's server (#367)
  writeFileSync(join(dir, 'initdb', '01-create-databases.sql'), `CREATE DATABASE logto;\n${stack.features.connectors ? 'CREATE DATABASE connector;\n' : ''}`);
  return dir;
}

const substitute = (text, values) =>
  values ? text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => String(values[name] ?? '').replaceAll("'", '')) : text;

/** the names a stack's env template references, in template order */
export function templatePlaceholders(stack) {
  const text = stack.role === 'shared' ? sharedTemplate(stack) : envTemplate(stack);
  return [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]))];
}

const header = (s) => `# ${s.stack} — RENDERED by infra/bootstrap.mjs from infra/platforms/${s.platform}, do not edit by hand.`;

/* ── the shared stack: one per platform ──────────────────────────────── */

function sharedCompose(s) {
  const p = s.ports;
  const local = s.delivery === 'docker';
  let control = null;
  try { control = s.controlApi ? loadStack(s.controlApi) : null; } catch { /* the control environment does not exist yet */ }
  const publish = (port) => `    ports:\n      - "${port}:${port === p.vault ? 80 : port === p.glitchtip ? 8000 : 80}"`;
  return `${header(s)}
# The platform's cross-environment services: GlitchTip (own database),
# Vaultwarden, OCR, valkey, the control cockpit, pgAdmin${local ? ' — and the family\n# Caddy that gives every service a real https hostname' : ' (DSM\'s reverse\n# proxy fronts the published ports on the platform\'s domain)'}. Environment
# stacks join "${sharedNet(s.platform)}" to reach glitchtip/ocr by name.
name: ${s.stack}

networks:
  shared:
    name: ${sharedNet(s.platform)}

services:
  glitchtip-db:
    image: postgres:18.6-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: munni
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: glitchtip
    volumes:
      - glitchtipdb:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U munni"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [shared]

  # migrations run INSIDE the web service; the worker waits until they are applied
  glitchtip:
    image: glitchtip/glitchtip:latest
    restart: unless-stopped
    command: sh -c "./manage.py migrate && ./bin/start.sh"
    environment: &glitchtip_env
      DATABASE_URL: postgres://munni:\${POSTGRES_PASSWORD}@glitchtip-db:5432/glitchtip
      REDIS_URL: redis://valkey:6379/0
      SECRET_KEY: \${GLITCHTIP_SECRET_KEY}
      GLITCHTIP_DOMAIN: ${s.urls.glitchtip}
      EMAIL_URL: \${GLITCHTIP_EMAIL_URL:-consolemail://}
      CELERY_WORKER_AUTOSCALE: "1,3"
${publish(p.glitchtip)}
    depends_on:
      glitchtip-db:
        condition: service_healthy
      valkey:
        condition: service_started
    networks: [shared]

  glitchtip-worker:
    image: glitchtip/glitchtip:latest
    restart: unless-stopped
    command: sh -c "until ./manage.py migrate --check >/dev/null 2>&1; do sleep 3; done; ./bin/run-celery-with-beat.sh"
    environment: *glitchtip_env
    depends_on:
      glitchtip-db:
        condition: service_healthy
    networks: [shared]

  valkey:
    image: valkey/valkey:9-alpine
    restart: unless-stopped
    networks: [shared]

  ocr:
    image: hertzg/tesseract-server:latest
    restart: unless-stopped
    networks: [shared]

  # the platform's vault: the HUMAN copy of every credential the setup mints
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    environment:
      DOMAIN: ${s.urls.vault}
      SIGNUPS_ALLOWED: \${VAULT_SIGNUPS_ALLOWED:-true}
    volumes:
      - vaultdata:/data${local ? '' : `\n${publish(p.vault)}`}
${local ? `
  # ONE Caddy for the family's https (local CA, persisted so the one-time
  # trust sticks): always the vault, and in LAN mode every service as a
  # real hostname (<name>.<ip-dashed>.sslip.io on 443)
  family-tls:
    image: caddy:2-alpine
    restart: unless-stopped
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - vaulttls:/data
    ports:
      - "${p.vault}:${p.vault}"${s.lan ? '\n      - "443:443"\n      - "80:80"' : ''}
    networks: [default, shared]
` : ''}
  # the control cockpit: its OWN app, signed in through ${s.controlApi ?? 'the control environment'}'s Logto + API
  control:
    image: \${REGISTRY}/munni-control:\${TAG}
    restart: unless-stopped
    environment:
      MUNNI_API_URL: ${control?.urls.api ?? ''}
      MUNNI_LOGTO_ENDPOINT: ${control?.urls.logto ?? ''}
      MUNNI_LOGTO_APP_ID: \${CONTROL_LOGTO_APP_ID}
      MUNNI_LOGTO_RESOURCE: ${control?.urls.api ?? ''}
    ports:
      - "${p.control}:80"

  # ONE console over every database of the platform (each environment's postgres + glitchtip-db)
  pgadmin:
    image: dpage/pgadmin4:latest
    restart: unless-stopped
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@munni.dev
      PGADMIN_DEFAULT_PASSWORD: \${PGADMIN_PASSWORD}
      PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED: "False"
    volumes:
      - pgadmindata:/var/lib/pgadmin
      - ./pgadmin-servers.json:/pgadmin4/servers.json:ro
    ports:
      - "${p.pgadmin}:80"
    depends_on:
      glitchtip-db:
        condition: service_healthy
    networks: [shared]

volumes:
  glitchtipdb:
  vaultdata:${local ? '\n  vaulttls:' : ''}
  pgadmindata:
`;
}

/**
 * The environment's pooled browser agents (#420, A1): every provider pack,
 * headed under Xvfb, one container per replica beside the environment's own
 * control plane on its default network — nothing dials in. Each replica
 * enrolls with the ENVIRONMENT's fleet code (a per-environment secret) and
 * takes `concurrency` jobs at once; the egress is the platform's claim (a
 * home line is residential) and the control plane believes it. Zero
 * replicas is a choice (a platform that only runs household agents).
 */
function pooledAgents(s) {
  const n = s.agents?.pooled ?? 0;
  if (!n) return '';
  const e = s.env;
  return Array.from({ length: n }, (_, i) => i + 1).map((i) => `  # pooled browser agent ${i} of ${n} (#420): every provider pack, headed under Xvfb, dialling the control plane beside it
  connector-agent-${e}-${i}:
    image: \${REGISTRY}/munni-connector-agent:\${TAG}
    restart: unless-stopped
    shm_size: 1gb
    init: true
    stop_grace_period: 45s
    environment:
      DOTNET_ENVIRONMENT: Production
      ConnectorAgent__Class: pooled
      ConnectorAgent__AgentName: munni ${e} pooled agent ${i}
      ConnectorAgent__Egress__Country: ${s.agents.egress.country}
      ConnectorAgent__Egress__Kind: ${s.agents.egress.kind}
      ConnectorAgent__BrowserLocale: nl-NL
      ConnectorAgent__BrowserTimezoneId: Europe/Amsterdam
      ConnectorAgent__MaxConcurrency: "${s.agents.concurrency}"
      ConnectorAgent__Headless: "false"
      ConnectorAgent__StateFilePath: /state/agent-state.json
      ConnectorAgent__ProfileRootDirectory: /profiles
      ConnectorAgent__Connections__0__Name: ${e}
      ConnectorAgent__Connections__0__ControlPlaneBaseUrl: http://connector:8080/
      ConnectorAgent__Connections__0__EnrollmentCode: \${CONNECTOR_FLEET_CODE}
      Sentry__Dsn: \${CONNECTOR_SENTRY_DSN:-}
      Sentry__TracesSampleRate: "${s.tracing.sampleRate}"
    depends_on:
      connector-${e}:
        condition: service_healthy
    volumes:
      - agentstate${i}:/state
      - agentprofiles${i}:/profiles
    networks: [default]

`).join('');
}

/** the volumes the environment's pooled agents keep (their enrollment and their browser profiles) */
const agentVolumes = (s) => Array.from({ length: s.agents?.pooled ?? 0 }, (_, i) => `\n  agentstate${i + 1}:\n  agentprofiles${i + 1}:`).join('');

/**
 * The environment's hosted private slots (#420 A2): one container per
 * slot in the household agent's shape — Class byo, one job at a time,
 * browser profiles kept — on munni's hardware, enrolled with the
 * ENVIRONMENT's private-slot code under a subject that is nobody's until
 * the operator binds the slot to the person who asked for it (the admin
 * portal). Giving it back wipes its profiles before the next person.
 * Zero is the default: a platform offers these on purpose.
 */
function privateAgents(s) {
  const n = s.agents?.privateSlots ?? 0;
  if (!n) return '';
  const e = s.env;
  return Array.from({ length: n }, (_, i) => i + 1).map((i) => `  # hosted private slot ${i} of ${n} (#420 A2): one person's own browser on munni's hardware, bound by the operator
  connector-private-${e}-${i}:
    image: \${REGISTRY}/munni-connector-agent:\${TAG}
    restart: unless-stopped
    shm_size: 1gb
    init: true
    stop_grace_period: 45s
    environment:
      DOTNET_ENVIRONMENT: Production
      ConnectorAgent__Class: byo
      ConnectorAgent__AgentName: munni ${e} private agent ${i}
      ConnectorAgent__Egress__Country: ${s.agents.egress.country}
      ConnectorAgent__Egress__Kind: ${s.agents.egress.kind}
      ConnectorAgent__BrowserLocale: nl-NL
      ConnectorAgent__BrowserTimezoneId: Europe/Amsterdam
      ConnectorAgent__MaxConcurrency: "1"
      ConnectorAgent__Headless: "false"
      ConnectorAgent__StateFilePath: /state/agent-state.json
      ConnectorAgent__ProfileRootDirectory: /profiles
      ConnectorAgent__Connections__0__Name: ${e}
      ConnectorAgent__Connections__0__ControlPlaneBaseUrl: http://connector:8080/
      ConnectorAgent__Connections__0__EnrollmentCode: \${CONNECTOR_PRIVATE_CODE}
      Sentry__Dsn: \${CONNECTOR_SENTRY_DSN:-}
      Sentry__TracesSampleRate: "${s.tracing.sampleRate}"
    depends_on:
      connector-${e}:
        condition: service_healthy
    volumes:
      - privatestate${i}:/state
      - privateprofiles${i}:/profiles
    networks: [default]

`).join('');
}

/** the volumes the environment's private slots keep */
const privateVolumes = (s) => Array.from({ length: s.agents?.privateSlots ?? 0 }, (_, i) => `\n  privatestate${i + 1}:\n  privateprofiles${i + 1}:`).join('');

function sharedTemplate(s) {
  return `# ${s.stack} env${s.delivery === 'docker' ? ' (real values — never commit this file)' : ' TEMPLATE — CI fills the placeholders from the GitHub environment "' + s.githubEnvironment + '"'}
REGISTRY=${s.registry}
TAG=${s.channel}
GHCR_USER=okkes
GHCR_PAT=\${GHCR_PAT}

# glitchtip-db ONLY — each environment's postgres has its own password
POSTGRES_PASSWORD=\${POSTGRES_PASSWORD}
GLITCHTIP_SECRET_KEY=\${GLITCHTIP_SECRET_KEY}
GLITCHTIP_EMAIL_URL=\${GLITCHTIP_EMAIL_URL}
PGADMIN_PASSWORD=\${PGADMIN_PASSWORD}

# GlitchTip seed — the deploy creates this admin and this API token inside
# the container once (idempotent); the bootstrap writes every DSN back
GLITCHTIP_SEED_EMAIL=admin@munni.${s.platform}
GLITCHTIP_SEED_PASSWORD=\${GLITCHTIP_ADMIN_PASSWORD}
GLITCHTIP_SEED_TOKEN=\${GLITCHTIP_API_TOKEN}

# empty = registration OPEN (first account); false once the platform's account exists
VAULT_SIGNUPS_ALLOWED=\${VAULT_SIGNUPS_ALLOWED}

# the control cockpit's Logto app (registered in the control environment's Logto)
CONTROL_LOGTO_APP_ID=\${CONTROL_LOGTO_APP_ID}
`;
}

/** the family Caddy (lcl): local-CA https for the vault always, and for every service as a real sslip.io hostname in LAN mode */
function familyCaddyfile(shared) {
  const site = (address, proxy) => `${address} {\n\treverse_proxy ${proxy}\n}\n`;
  let sites = site(`https://localhost:${shared.ports.vault}`, 'vaultwarden:80');
  if (shared.lan) {
    const envSites = platformEnvStacks(shared.platform).map((env) => [
      site(`https://${env.host('web')}`, `web-${env.env}:80`),
      site(`https://${env.host('admin')}`, `admin-${env.env}:80`),
      site(`https://${env.host('lab')}`, `lab-${env.env}:80`),
      site(`https://${env.host('api')}`, `api-${env.env}:8080`),
      // household agents dial the control plane from outside (#367); only an environment that runs connectors has the host
      env.hosts.connector ? site(`https://${env.host('connector')}`, `connector-${env.env}:8080`) : '',
      site(`https://${env.host('logto')}`, `logto-${env.env}:${env.ports.logto}`),
      site(`https://${env.host('logtoAdmin')}`, `logto-${env.env}:${env.ports.logtoAdmin}`),
    ].join('')).join('');
    sites += envSites
      + site(`https://${shared.host('glitchtip')}`, 'glitchtip:8000')
      + site(`https://${shared.host('control')}`, 'control:80')
      + site(`https://${shared.host('pgadmin')}`, 'pgadmin:80')
      + site(`https://${shared.host('vault')}`, 'vaultwarden:80')
      // the root certificate stays downloadable over plain http for the one-time trust on phones/browsers
      + `http://ca.${shared.domain} {\n\troot * /data/caddy/pki/authorities/local\n\theader /root.crt Content-Type application/x-x509-ca-cert\n\theader /root.crt Content-Disposition "attachment; filename=munni-family-ca.crt"\n\tfile_server browse\n}\n`;
  }
  return `{\n\tlocal_certs\n}\n${sites}`;
}

/** pgAdmin's preregistered servers: one per environment (postgres-<env> on the shared net) + glitchtip-db */
function pgadminServers(shared) {
  const server = (name, host, db = 'munni') => ({ Name: name, Group: `munni ${shared.platform}`, Host: host, Port: 5432, MaintenanceDB: db, Username: 'munni', SSLMode: 'prefer' });
  const servers = {};
  let i = 1;
  for (const env of platformEnvStacks(shared.platform)) { servers[i] = server(env.env, `postgres-${env.env}`); i += 1; }
  servers[i] = server('glitchtip (shared)', 'glitchtip-db', 'glitchtip');
  return JSON.stringify({ Servers: servers }, null, 2);
}

/* ── an environment stack ─────────────────────────────────────────────── */

/** browser origins the api accepts: its own web/admin/lab, the localhost twins in LAN mode, the control cockpit when this env powers it */
function corsOrigins(s) {
  const origins = [s.urls.web, s.urls.admin, s.urls.lab];
  if (s.delivery === 'docker' && s.lan) origins.push(`http://localhost:${s.ports.web}`, `http://localhost:${s.ports.admin}`, `http://localhost:${s.ports.lab}`);
  try {
    const shared = loadStack(s.sharedStack);
    if (shared.controlApi === s.stack) {
      origins.push(shared.urls.control);
      if (shared.delivery === 'docker' && shared.lan) origins.push(`http://localhost:${shared.ports.control}`);
    }
  } catch { /* no shared stack yet */ }
  origins.push('https://localhost', 'capacitor://localhost');
  return [...new Set(origins)];
}

function envCompose(s) {
  const p = s.ports;
  const e = s.env;
  const local = s.delivery === 'docker';
  return `${header(s)}
# A complete environment: own web/admin/lab/api, OWN Logto and OWN postgres
# (deleting this stack never touches another environment), riding
# ${s.sharedStack} only for glitchtip/ocr over "${sharedNet(s.platform)}".
# Service names carry the environment (web-${e}, …): a compose service
# registers on EVERY network it joins, so plain names would collide on
# the shared network; in-stack aliases keep the plain names working here.
name: ${s.stack}

networks:
  default: {}
  shared:
    external: true
    name: ${sharedNet(s.platform)}

services:
  postgres-${e}:
    image: postgres:18.6-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: munni
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: munni
    volumes:
      - pgdata:/var/lib/postgresql
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U munni"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks:
      default:
        aliases: [postgres]
      shared: {}

  web-${e}:
    image: \${REGISTRY}/munni-web:\${TAG}
    restart: unless-stopped
    # runtime-config overlay: the image is stack-agnostic; these MUNNI_* vars become /runtime-config.js at start
    environment:
      MUNNI_API_URL: ${s.urls.api}
      MUNNI_LOGTO_ENDPOINT: ${s.urls.logto}
      MUNNI_LOGTO_APP_ID: \${WEB_LOGTO_APP_ID}
      MUNNI_LOGTO_RESOURCE: ${s.urls.api}
      MUNNI_GLITCHTIP_DSN: \${WEB_GLITCHTIP_DSN}
      # performance tracing (user 2026-10-09): the environment's share of traces, the same value the api and connector get
      MUNNI_TRACES_SAMPLE_RATE: "${s.tracing.sampleRate}"
      MUNNI_CHANNEL: ${s.appChannel}
      MUNNI_NATIVE_SCHEME: ${s.native.scheme}
      MUNNI_PUBLIC_ORIGIN: ${s.urls.web}
      # app links: the start script renders /.well-known/assetlinks.json + apple-app-site-association from these
      MUNNI_ANDROID_PACKAGE: ${s.store.androidPackage}
      MUNNI_ANDROID_CERT_SHA256: ${s.store.androidCertSha256 ?? ''}
      MUNNI_IOS_BUNDLE_ID: ${s.store.iosBundleId}
      MUNNI_APPLE_TEAM_ID: \${APPLE_TEAM_ID}
    ports:
      - "${p.web}:80"
    networks:
      default:
        aliases: [web]
      shared: {}

  admin-${e}:
    image: \${REGISTRY}/munni-admin:\${TAG}
    restart: unless-stopped
    environment:
      MUNNI_API_URL: ${s.urls.api}
      MUNNI_LOGTO_ENDPOINT: ${s.urls.logto}
      MUNNI_LOGTO_APP_ID: \${ADMIN_LOGTO_APP_ID}
      MUNNI_LOGTO_RESOURCE: ${s.urls.api}
      MUNNI_GLITCHTIP_DSN: \${ADMIN_GLITCHTIP_DSN}
      # the portal's Connectors tab hands over to the lab (#441)
      MUNNI_LAB_URL: ${s.urls.lab}
    ports:
      - "${p.admin}:80"
    networks:
      default:
        aliases: [admin]
      shared: {}

  lab-${e}:
    image: \${REGISTRY}/munni-lab:\${TAG}
    restart: unless-stopped
    environment:
      MUNNI_API_URL: ${s.urls.api}
      MUNNI_LOGTO_ENDPOINT: ${s.urls.logto}
      MUNNI_LOGTO_APP_ID: \${LAB_LOGTO_APP_ID}
      MUNNI_LOGTO_RESOURCE: ${s.urls.api}
      MUNNI_GLITCHTIP_DSN: \${LAB_GLITCHTIP_DSN}
    ports:
      - "${p.lab}:80"
    networks:
      default:
        aliases: [lab]
      shared: {}

  api-${e}:
    image: \${REGISTRY}/munni-api:\${TAG}
    restart: unless-stopped
    environment:
      ASPNETCORE_URLS: http://+:8080
      ConnectionStrings__Db: Host=postgres;Database=munni;Username=munni;Password=\${POSTGRES_PASSWORD}
      Db__AutoMigrate: "true"
      Auth__Authority: ${s.urls.logto}/oidc${local ? `
      # the issuer stays the browser-facing url; metadata is fetched in-network over http
      Auth__MetadataAddress: http://logto:${p.logto}/oidc/.well-known/openid-configuration
      Auth__RequireHttps: "false"` : ''}
      Auth__Audience: ${s.urls.api}
      # invitation-only sign-up (features.inviteOnly, user 2026-10-07): the api reports it in /health capabilities; the policy itself lives in Logto (Bootstrap)
      Auth__InviteOnly: "${s.features.inviteOnly ? 'true' : 'false'}"
      Web__Url: ${s.urls.web}
${corsOrigins(s).map((o, i) => `      Cors__Origins__${i}: ${o}`).join('\n')}
      Push__VapidPublicKey: \${PUSH_VAPID_PUBLIC_KEY:-}
      Push__VapidPrivateKey: \${PUSH_VAPID_PRIVATE_KEY:-}
      Push__Subject: \${PUSH_VAPID_SUBJECT:-mailto:admin@localhost}
      Fcm__ServiceAccountJson: \${FCM_SERVICE_ACCOUNT_JSON:-}
      Logos__SecretKey: \${LOGODEV_SECRET_KEY:-}
      Logos__PublicToken: \${LOGODEV_PUBLIC_TOKEN:-}
      Sentry__Dsn: \${API_SENTRY_DSN:-}
      Sentry__TracesSampleRate: "${s.tracing.sampleRate}"
      Logto__M2mAppId: \${LOGTO_M2M_APP_ID:-}
      Logto__M2mAppSecret: \${LOGTO_M2M_APP_SECRET:-}
      BUILD_NUMBER: \${TAG}
      Ocr__BaseUrl: http://ocr:8884${s.features.connectors ? `
      # the connector relay (#367): the control plane in-network, its audience, the machine app the logto module
      # writes back (until then the relay stays off and the api says why), the subject salt, the address household agents dial
      Connectors__BaseUrl: http://connector:8080/
      Connectors__Audience: ${s.urls.connector}
      Connectors__M2mAppId: \${CONNECTOR_M2M_APP_ID:-}
      Connectors__M2mAppSecret: \${CONNECTOR_M2M_APP_SECRET:-}
      Connectors__SubjectSalt: \${CONNECTOR_SUBJECT_SALT}
      Connectors__AgentPublicUrl: ${s.urls.connector}/` : ''}
    ports:
      - "${p.api}:8080"
    depends_on:
      postgres-${e}:
        condition: service_healthy
      logto-${e}:
        condition: service_started
    networks:
      default:
        aliases: [api]
      shared: {}
${s.features.connectors ? connectorService(s) : ''}${s.features.connectors ? pooledAgents(s) : ''}${s.features.connectors ? privateAgents(s) : ''}
  logto-${e}:
    image: svhd/logto:1.43
    restart: unless-stopped
    # SEED FIRST: alteration-before-seed on an empty db half-creates tables and seed --swe then skips forever
    entrypoint: ["sh", "-c", "npm run cli db seed -- --swe && npm run alteration deploy latest && npm start"]
    environment:
      TRUST_PROXY_HEADER: "${local && !s.lan ? 0 : 1}"
      DB_URL: postgres://munni:\${POSTGRES_PASSWORD}@postgres:5432/logto
      ENDPOINT: ${s.urls.logto}
      ADMIN_ENDPOINT: ${s.urls.logtoAdmin}
      PORT: "${p.logto}"
      ADMIN_PORT: "${p.logtoAdmin}"${local ? '' : `
    # Logto fetches its own ADMIN_ENDPOINT: resolve the public hostnames to this host
    extra_hosts:
      - "${s.host('logto')}:host-gateway"
      - "${s.host('logtoAdmin')}:host-gateway"`}
    ports:
      - "${p.logto}:${p.logto}"
      - "${p.logtoAdmin}:${p.logtoAdmin}"
    depends_on:
      postgres-${e}:
        condition: service_healthy
    networks:
      default:
        aliases: [logto]
      shared: {}

volumes:
  pgdata:${s.features.connectors ? agentVolumes(s) + privateVolumes(s) : ''}
`;
}

/**
 * The environment's connector control plane (#367): every provider pack under
 * one catalogue, in Production mode against its own database on the
 * environment's Postgres, the machine token of the environment's Logto as
 * its only consumer credential. The api reaches it in-network; household
 * agents dial its published host from outside (token-protected: nothing
 * answers without a machine token or an agent's own token).
 */
function connectorService(s) {
  const e = s.env;
  const local = s.delivery === 'docker';
  return `
  connector-${e}:
    image: \${REGISTRY}/munni-connector-api:\${TAG}
    restart: unless-stopped
    environment:
      ASPNETCORE_URLS: http://+:8080
      Connector__Mode: Production
      Connector__Database__Provider: Postgres
      Connector__Database__ConnectionString: Host=postgres;Database=connector;Username=munni;Password=\${POSTGRES_PASSWORD}
      Connector__Auth__Authority: ${s.urls.logto}/oidc${local ? `
      # the issuer stays the browser-facing url; the discovery document is fetched in-network over http
      Connector__Auth__MetadataAddress: http://logto:${s.ports.logto}/oidc/.well-known/openid-configuration
      Connector__Auth__RequireHttpsMetadata: "false"` : ''}
      Connector__Auth__Audience: ${s.urls.connector}
      Connector__Bundle__CurrentKid: k1
      Connector__Bundle__Keys__k1: \${CONNECTOR_SEAL_KEY_K1}
      Connector__EnrollmentHmacKey: \${CONNECTOR_ENROLLMENT_HMAC}
      # the environment's pooled browser agents enroll with this standing code
      Connector__FleetEnrollmentCode: \${CONNECTOR_FLEET_CODE}
      # and its hosted private slots with this one (#420 A2) — never the fleet's: a slot serves nobody until bound
      Connector__PrivateEnrollmentCode: \${CONNECTOR_PRIVATE_CODE}
      # the operator's aggregator accounts (#414): a party exists on the control plane when its keys do; never handed to an agent
      BankAdapters__GoCardless__SecretId: \${GOCARDLESS_SECRET_ID:-}
      BankAdapters__GoCardless__SecretKey: \${GOCARDLESS_SECRET_KEY:-}
      BankAdapters__EnableBanking__ApplicationId: \${ENABLEBANKING_APPLICATION_ID:-}
      BankAdapters__EnableBanking__PrivateKeyPem: \${ENABLEBANKING_PRIVATE_KEY_PEM:-}
      # crash reports (2026-10-05): the connector project of this environment, shared with its agents
      Sentry__Dsn: \${CONNECTOR_SENTRY_DSN:-}
      Sentry__TracesSampleRate: "${s.tracing.sampleRate}"
      BUILD_NUMBER: \${TAG}
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/v1/health >/dev/null || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 12
    ports:
      - "${s.ports.connector}:8080"
    depends_on:
      postgres-${e}:
        condition: service_healthy
    networks:
      default:
        aliases: [connector]
      shared:
        aliases: [connector-${e}]
`;
}

function envTemplate(s) {
  const local = s.delivery === 'docker';
  return `# ${s.stack} env${local ? ' (real values — never commit this file)' : ' TEMPLATE — CI fills the placeholders from the GitHub environment "' + s.githubEnvironment + '"'}
REGISTRY=${s.registry}
TAG=${s.channel}
GHCR_USER=okkes
GHCR_PAT=\${GHCR_PAT}

POSTGRES_PASSWORD=\${POSTGRES_PASSWORD}

# app links: the web container serves /.well-known/apple-app-site-association from the Apple team id + the bundle id
APPLE_TEAM_ID=\${APPLE_TEAM_ID}

# Logto seed — the deploy inserts these machine credentials into Logto's own
# database once (idempotent), so sign-in needs no console visit: infra = the
# Management API (apps, connectors, users, the admin role), admin = the console's first admin
LOGTO_SEED_INFRA_ID=\${LOGTO_INFRA_M2M_ID}
LOGTO_SEED_INFRA_SECRET=\${LOGTO_INFRA_M2M_SECRET}
LOGTO_SEED_ADMIN_ID=\${LOGTO_ADMIN_M2M_ID}
LOGTO_SEED_ADMIN_SECRET=\${LOGTO_ADMIN_M2M_SECRET}

# the api's own machine credential + the frontends' app ids (written back by the logto module)
LOGTO_M2M_APP_ID=\${LOGTO_M2M_APP_ID}
LOGTO_M2M_APP_SECRET=\${LOGTO_M2M_APP_SECRET}
WEB_LOGTO_APP_ID=\${VITE_LOGTO_APP_ID}
ADMIN_LOGTO_APP_ID=\${VITE_LOGTO_APP_ID_ADMIN}
LAB_LOGTO_APP_ID=\${VITE_LOGTO_APP_ID_LAB}

# crash reports (written back by the glitchtip module)
WEB_GLITCHTIP_DSN=\${VITE_GLITCHTIP_DSN}
ADMIN_GLITCHTIP_DSN=\${VITE_GLITCHTIP_DSN_ADMIN}
LAB_GLITCHTIP_DSN=\${VITE_GLITCHTIP_DSN_LAB}
API_SENTRY_DSN=\${API_SENTRY_DSN}

GOCARDLESS_SECRET_ID=\${GOCARDLESS_SECRET_ID}
GOCARDLESS_SECRET_KEY=\${GOCARDLESS_SECRET_KEY}
ENABLEBANKING_APPLICATION_ID=\${ENABLEBANKING_APPLICATION_ID}
ENABLEBANKING_PRIVATE_KEY_PEM='\${ENABLEBANKING_PRIVATE_KEY_PEM}'

PUSH_VAPID_PUBLIC_KEY=\${PUSH_VAPID_PUBLIC_KEY}
PUSH_VAPID_PRIVATE_KEY=\${PUSH_VAPID_PRIVATE_KEY}
PUSH_VAPID_SUBJECT=mailto:admin@${s.domain ?? 'localhost'}

FCM_SERVICE_ACCOUNT_JSON='\${FCM_SERVICE_ACCOUNT_JSON}'

LOGODEV_SECRET_KEY=\${LOGODEV_SECRET_KEY}
LOGODEV_PUBLIC_TOKEN=\${LOGODEV_PUBLIC_TOKEN}
${s.features.connectors ? `
# the connector control plane (#367): its bundle seal key and enrollment HMAC, the api's subject
# salt and machine app (written back by the logto module), the environment's fleet enrollment code (its pooled agents enroll
# with it) and its private-slot code (its hosted private slots do, #420 A2)
CONNECTOR_SEAL_KEY_K1=\${CONNECTOR_SEAL_KEY_K1}
CONNECTOR_ENROLLMENT_HMAC=\${CONNECTOR_ENROLLMENT_HMAC}
CONNECTOR_SUBJECT_SALT=\${CONNECTOR_SUBJECT_SALT}
CONNECTOR_M2M_APP_ID=\${CONNECTOR_M2M_APP_ID}
CONNECTOR_M2M_APP_SECRET=\${CONNECTOR_M2M_APP_SECRET}
# its crash-report DSN (written back by the glitchtip module), shared with its agents
CONNECTOR_SENTRY_DSN=\${CONNECTOR_SENTRY_DSN}
CONNECTOR_FLEET_CODE=\${CONNECTOR_FLEET_CODE}
CONNECTOR_PRIVATE_CODE=\${CONNECTOR_PRIVATE_CODE}
` : ''}`;
}
