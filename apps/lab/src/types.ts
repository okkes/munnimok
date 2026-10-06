/**
 * The relay's documents as the lab reads them (camelCase renderings of
 * the control plane's wire, docs/connectors/contract.md). Optional
 * fields are optional on the wire too: the lab renders what is there and
 * never invents a value.
 */
export interface ProviderQuota {
  limit?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  seenAt?: string | null;
}

export interface ProviderStatus {
  providerId: string;
  state: string;
  since: string;
  reasonKey?: string | null;
  acceptsWork: boolean;
  quota?: ProviderQuota | null;
}

export interface ConnectorStatus {
  service: { kinds: string[]; version: string; manifestDigest: string };
  providers: ProviderStatus[];
  agents: { total: number; online: number; revoked: number };
  queue: { queued: number; running: number; awaitingInput: number };
  relay?: { openStreams: number };
}

export interface FieldSpec {
  key: string;
  type: string;
  secret?: boolean;
  required?: boolean;
  labelKey?: string;
  pattern?: string | null;
}
export interface AuthStep {
  id: string;
  labelKey?: string;
  fields: FieldSpec[];
}
export interface ParamSpec {
  key: string;
  type: string;
  required?: boolean;
  multi?: boolean;
  values?: string[] | null;
  internal?: boolean;
}
export interface ResourceSpec {
  id: string;
  returns: string;
  params?: ParamSpec[];
  maxHistoryDays?: number | null;
  typicalDurationSeconds?: number | null;
  maxRecordsPerFetch?: number | null;
  notesKey?: string | null;
}

/** a provider as the catalogue lists it: its manifest with its status beside it */
export interface ProviderEntry {
  id: string;
  name: string;
  kind: string;
  country?: string;
  manifestVersion?: number | string;
  runtime?: string;
  agent?: { required?: boolean; class?: string; egress?: { country?: string; kind?: string } | null; desktopBrowser?: boolean } | null;
  unattendedFetch?: boolean;
  loginNeedsHeadedAgent?: boolean;
  logout?: string;
  offersCredentialStore?: boolean;
  secretCustody?: string;
  webSupport?: string;
  auth?: {
    flow?: string;
    config?: FieldSpec[];
    steps?: AuthStep[];
    challenges?: string[];
    session?: { ttlSeconds?: number | null; refreshable?: boolean; rotatesOnUse?: boolean } | null;
    loginOrigins?: string[];
  } | null;
  resources?: ResourceSpec[];
  limits?: { minIntervalSeconds?: number | null; maxHistoryDays?: number | null; minRequestGapMs?: number | null; preferredFetchHourLocal?: number | null } | null;
  status?: { state: string; since?: string; reasonKey?: string | null; acceptsWork?: boolean; quota?: ProviderQuota | null } | null;
}

export interface Catalogue {
  providers: ProviderEntry[];
  service?: { kinds: string[]; version: string; manifestDigest: string };
}

export interface ProfileView {
  id: string;
  provider: string;
  healthy: boolean;
  lastOkAt?: string | null;
}

export interface AgentView {
  id: string;
  name: string;
  class: string;
  revoked: boolean;
  lastHeartbeatAt?: string | null;
  online: boolean;
  stale: boolean;
  profiles: ProfileView[];
  /** a hosted private slot (#420 A2): munni's own container for one person at a time */
  hosted?: boolean;
  bound?: boolean;
  boundAt?: string | null;
  resetting?: boolean;
}

export interface PrivateAgents {
  total: number;
  free: number;
  slots: { agent: AgentView; subject?: string | null; who?: string | null }[];
  requests: { id: string; subject: string; who?: string | null; state: string; createdAt: string; decidedAt?: string | null; agentId?: string | null }[];
}

export interface Canary {
  providerId: string;
  resource: string;
  intervalMinutes: number;
  lastRunAt?: string | null;
  lastJobId?: string | null;
  intact?: boolean | null;
  verdict?: string | null;
}

export interface RemoteConsent {
  id: string;
  status: string;
  createdAt?: string | null;
  reference?: string | null;
  institutionId?: string | null;
  origin?: string | null;
  accountCount: number;
}

export interface Enrollment {
  code: string;
  expiresAt: string;
  controlPlaneUrl?: string | null;
  composeCommand?: string | null;
}

/** who the lab is to the control plane: the operator's own lab subject (never the app's) */
export interface LabMe {
  subject: string;
  name?: string | null;
  email?: string | null;
}

export interface HealthInfo {
  status?: string;
  build?: string;
  protocol?: number;
  capabilities?: Record<string, unknown>;
}

/** a run as the operator reads it (#441 L1): what happened, never what was typed */
export interface OperatorJob {
  jobId: string;
  sessionId: string;
  subject: string;
  /** the relay's name for the subject; null for the lab's own runs and for people it cannot place */
  who?: string | null;
  providerId: string;
  kind: string;
  state: string;
  resource?: string | null;
  trigger?: string | null;
  progress?: { step: string; stepsDone: string[]; found?: number | null; ahead?: number | null } | null;
  attempts: number;
  credentialSubmitted: boolean;
  complete: boolean;
  agentId?: string | null;
  profileId?: string | null;
  fleetOnly: boolean;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; retriable: boolean; userAction: string; messageKey: string } | null;
  errorDetail?: string | null;
  notes: string[];
  params?: unknown;
  config?: Record<string, string> | null;
  artifacts: 'none' | 'pending' | 'retained';
  domDigest?: string | null;
  hasScreenshot: boolean;
  artifactsExpireAt?: string | null;
}

export interface JobList {
  jobs: OperatorJob[];
  truncated: boolean;
}

export interface HealthWindow {
  total: number;
  succeeded: number;
  failed: number;
  expired: number;
  open: number;
  byCode: Record<string, number>;
  byTrigger: Record<string, number>;
  peopleAffected: number;
}

export interface ProviderHealth {
  providerId: string;
  status: ProviderStatus;
  windows: Record<string, HealthWindow>;
  lastSuccessAt?: string | null;
  lastFailure?: { jobId: string; code: string; trigger?: string | null; at: string } | null;
  sessions: Record<string, number>;
  canary?: Canary | null;
  reports: number;
  pendingReports: number;
}

export interface HealthReport {
  generatedAt: string;
  providers: ProviderHealth[];
}
