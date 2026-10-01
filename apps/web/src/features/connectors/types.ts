import type { ConnectorSessionState } from '@/db/types';

/**
 * The relay's documents as the app receives them (docs/connectors/relay.md,
 * docs/connectors/contract.md): field names in this API's camelCase, enum
 * values in the connector's own snake_case. Nothing here is invented by the
 * client — every shape is what `server/src/Munni.Api/Connectors` renders.
 */

export type ProviderKind = 'bank' | 'store' | 'registry';
export type ProviderState = 'healthy' | 'degraded' | 'paused' | 'retired';
export type AgentClass = 'inline' | 'pooled' | 'byo';
export type WebSupport = 'ephemeral' | 'none';
export type AuthFlow =
  | 'password'
  | 'password_sms'
  | 'password_totp'
  | 'two_step'
  | 'mobile_approval'
  | 'challenge_response'
  | 'qr_scan'
  | 'oauth_redirect'
  | 'device_persistent'
  | 'remote_browser';
export type ChallengeType =
  | 'mfa_code'
  | 'code_display'
  | 'qr_display'
  | 'app_approval'
  | 'image'
  | 'select_option'
  | 'redirect'
  | 'live_view';
/** `lookup`: a value the party lists at connect time (an aggregator's institutions) — the app asks the relay's options route */
export type FieldType = 'text' | 'password' | 'number' | 'date' | 'select' | 'iban' | 'phone' | 'lookup';

/** one value a `lookup` field offers, as the relay lists it */
export interface LookupOption {
  value: string;
  label: string;
  hasLogo: boolean;
}
export type JobStep =
  | 'queued'
  | 'agent_assigned'
  | 'opening_provider'
  | 'authenticating'
  | 'awaiting_human'
  | 'selecting_accounts'
  | 'downloading'
  | 'parsing'
  | 'normalizing'
  | 'finalizing'
  | 'logging_out';
export type JobState = 'queued' | 'leased' | 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'expired';
export type UserAction = 'none' | 'retry' | 'reauth' | 'reconnect' | 'wait' | 'start_your_agent';
export type ResourceShape = 'account' | 'transaction' | 'receipt' | 'credit_registration' | 'student_debt';

export interface FieldSpec {
  key: string;
  type: FieldType;
  secret: boolean;
  required: boolean;
  labelKey?: string;
  pattern?: string;
  options?: string[];
  autofill?: string;
}

export interface AuthStep {
  id: string;
  labelKey?: string;
  fields: FieldSpec[];
}

export interface AgentRequirement {
  required: boolean;
  class: AgentClass;
  egress?: { country: string; kind: string };
  desktopBrowser: boolean;
}

export interface ProviderStatus {
  providerId: string;
  state: ProviderState;
  since: string;
  reasonKey?: string;
}

export interface ResourceSpec {
  id: string;
  returns: ResourceShape;
  maxHistoryDays?: number;
  typicalDurationSeconds: number;
  maxRecordsPerFetch: number;
  notesKey?: string;
}

export interface ProviderManifest {
  id: string;
  name: string;
  kind: ProviderKind;
  country: string;
  manifestVersion: number;
  runtime: 'http' | 'browser_once' | 'browser_interactive' | 'browser_persistent';
  agent: AgentRequirement;
  unattendedFetch: boolean;
  loginNeedsHeadedAgent: boolean;
  logout: 'none' | 'session' | 'account';
  offersCredentialStore: boolean;
  secretCustody: 'client' | 'server' | 'agent';
  webSupport: WebSupport;
  auth: {
    flow: AuthFlow;
    config: FieldSpec[];
    steps: AuthStep[];
    challenges: ChallengeType[];
    session: { ttlSeconds: number; refreshable: boolean; rotatesOnUse: boolean };
    reauth: { cheap: boolean; triggerCodes: string[] };
  };
  resources: ResourceSpec[];
  limits: {
    minIntervalSeconds: number;
    concurrency: number;
    minRequestGapMs: number;
    maxHistoryDays: number;
    settlementLagDays: number;
  };
  notesKey?: string;
  logoRef?: string;
  status: ProviderStatus;
}

export interface ServiceInfo {
  kinds: string[];
  version: string;
  manifestDigest: string;
}

export interface Catalogue {
  providers: ProviderManifest[];
  service: ServiceInfo;
}

/** `GET /connectors` — what this environment runs */
export interface RelayInfo {
  service: ServiceInfo;
  providers: number;
  householdAgents: boolean;
}

export interface ChallengeView {
  id: string;
  type: ChallengeType;
  answerKind: 'text' | 'taps';
  promptKey?: string;
  /** a control-plane path — the app never fetches it; it builds the relay's image route itself */
  imageUrl?: string;
  expiresAt: string;
  code?: string;
  delivery?: string;
  length?: number;
  options?: { value: string; label: string }[];
  url?: string;
  /** e.g. `appie://login-exit*` */
  returnPattern?: string;
}

export interface ProgressView {
  step: JobStep;
  stepsDone: JobStep[];
}

/** `{ error: { … } }` — the connector's envelope, kept by the relay */
export interface ErrorEnvelope {
  code: string;
  retriable: boolean;
  userAction: UserAction;
  messageKey: string;
  detailId?: string | null;
  retryAfterSeconds?: number | null;
}

export interface SessionView {
  sessionId: string;
  state: ConnectorSessionState;
  /** handed over exactly once — persist it the moment it appears */
  bundle?: string;
  credentialBundle?: string;
  expiresAt?: string;
  providerAccount?: { displayName: string; externalId?: string };
  challenge?: ChallengeView;
  progress?: ProgressView;
  custody?: 'ephemeral';
  label?: string;
  config?: Record<string, string>;
  notes?: string[];
  error?: ErrorEnvelope;
}

export interface IngestedCounts {
  records: number;
  receipts: number;
  accounts: number;
  transactions: number;
  positions: number;
  dropped: number;
}

export interface RotatedSession {
  bundle: string;
  rotated: boolean;
}

export interface JobView {
  jobId: string;
  sessionId: string;
  state: JobState;
  resource?: string;
  progress?: ProgressView;
  challenge?: ChallengeView;
  cursor?: string;
  complete: boolean;
  /** the rotated bundle — a poll that shows it CONSUMES it, so persist it */
  session?: RotatedSession;
  notes?: string[];
  error?: ErrorEnvelope;
  /** on a collect that ingested */
  ingested?: IngestedCounts;
}

/** `POST …/sync` 200 */
export interface SyncOutcome {
  sessionId: string;
  state: ConnectorSessionState;
  ingested: IngestedCounts;
  session?: RotatedSession;
}

/** `GET /connectors/sessions` — one row per binding the relay holds for the caller */
export interface BindingView {
  sessionId: string;
  provider: string;
  connectionId: string;
  state: ConnectorSessionState;
  label?: string;
  createdAt: string;
  lastSeenAt: string;
  /** the relay keeps a household-agent bundle for it and syncs it by itself (§5.5) */
  scheduled: boolean;
  lastScheduledSyncAt?: string | null;
  lastScheduleError?: string | null;
}

/** a household agent the caller enrolled, as the relay lists it */
export interface AgentView {
  id: string;
  name: string;
  class: string;
  revoked: boolean;
  lastHeartbeatAt?: string | null;
  online: boolean;
  stale: boolean;
  profiles: { id: string; provider: string; healthy: boolean; lastOkAt?: string | null }[];
}

/** `POST /connectors/agents/enrollment` — the code and the line that starts the agent */
export interface EnrollmentView {
  code: string;
  expiresAt: string;
  controlPlaneUrl?: string | null;
  composeCommand?: string | null;
}

/** a `{ kind: "connector" }` frame on `/sync/events`: the view without secrets or data */
export interface ConnectorFrame {
  kind: 'connector';
  provider: string;
  sessionId: string;
  jobId?: string;
  state: string;
  challenge?: ChallengeView;
  progress?: ProgressView;
  error?: ErrorEnvelope;
  complete?: boolean;
}

export interface LiveFrame {
  sequence: number;
  width: number;
  height: number;
  origin?: string;
  blob: Blob;
}

export interface LiveInputEvent {
  kind: 'move' | 'down' | 'up' | 'scroll' | 'text' | 'key';
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
  sequence: number;
}
