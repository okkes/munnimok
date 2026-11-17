import { en } from '@/i18n/en';
import type { TranslationKey } from '@/i18n';
import type { ChallengeType, ErrorEnvelope, FieldSpec, ProviderManifest } from './types';

// docs/connectors/client.md: nothing here knows a provider by name

export type DeviceClass = 'native' | 'web';

export interface FormField {
  key: string;
  type: FieldSpec['type'];
  secret: boolean;
  required: boolean;
  labelKey: TranslationKey;
  pattern?: RegExp;
  options?: string[];
  autofill?: string;
  /** the manifest's own label key, kept for the copy-coverage test */
  rawLabelKey?: string;
}

export interface FormStep {
  id: string;
  labelKey: TranslationKey;
  fields: FormField[];
}

export type FieldProblem = 'required' | 'pattern';

export function copyKey(key: string | undefined, fallback: TranslationKey): TranslationKey {
  return key && key in en ? (key as TranslationKey) : fallback;
}

const FIELD_FALLBACK: Record<FieldSpec['type'], TranslationKey> = {
  text: 'connect.field.text',
  password: 'connect.field.password', // NOSONAR(S2068) a copy key, not a credential
  number: 'connect.field.number',
  date: 'connect.field.date',
  select: 'connect.field.select',
  iban: 'connect.field.iban',
  phone: 'connect.field.phone',
  lookup: 'connect.field.lookup',
};

// config the app answers itself (§15): a party that wants to know where to bring the person back declares `return_url`,
// and the app's own return page is the only right answer; these keys are hidden from the form, merged into `config`
export type ProvidedConfig = Readonly<Record<string, string>>;

/** the return page every own-origin redirect lands on (kept at the path the banks were registered with) */
export const RETURN_PATH = '/gc-callback';

export const appProvidedConfig = (origin: string): ProvidedConfig => ({ return_url: `${origin}${RETURN_PATH}` });

/** a redirect that comes back to the app's own page, rather than to a party's scheme */
export const ownReturn = (returnPattern: string | undefined, origin: string): boolean =>
  !!returnPattern && returnPattern.startsWith(`${origin}${RETURN_PATH}`);

function toField(spec: FieldSpec): FormField {
  let pattern: RegExp | undefined;
  if (spec.pattern) {
    try {
      pattern = new RegExp(spec.pattern);
    } catch {
      // a manifest pattern the browser cannot compile must not block the login
    }
  }
  return {
    key: spec.key,
    type: spec.type,
    secret: spec.secret,
    required: spec.required,
    labelKey: copyKey(spec.labelKey, FIELD_FALLBACK[spec.type]),
    pattern,
    options: spec.options,
    autofill: spec.autofill,
    rawLabelKey: spec.labelKey,
  };
}

// non-secret `config` fields form one leading step; a remote-browser login has no steps
// (the human signs in on the party's page)
export function formSteps(manifest: ProviderManifest, provided: ProvidedConfig = {}): FormStep[] {
  const steps: FormStep[] = [];
  const asked = manifest.auth.config.filter((spec) => !(spec.key in provided));
  if (asked.length > 0) {
    steps.push({ id: 'config', labelKey: 'connect.step.settings', fields: asked.map(toField) });
  }
  for (const step of manifest.auth.steps) {
    steps.push({ id: step.id, labelKey: copyKey(step.labelKey, 'connect.step.credentials'), fields: step.fields.map(toField) });
  }
  return steps;
}

export const allFields = (manifest: ProviderManifest): FormField[] => formSteps(manifest).flatMap((s) => s.fields);

export function validateValues(fields: readonly FormField[], values: Readonly<Record<string, string>>): Record<string, FieldProblem> {
  const problems: Record<string, FieldProblem> = {};
  for (const field of fields) {
    const value = (values[field.key] ?? '').trim();
    if (!value) {
      if (field.required) problems[field.key] = 'required';
      continue;
    }
    if (field.pattern && !field.pattern.test(value)) problems[field.key] = 'pattern';
  }
  return problems;
}

/** the login body's two maps: `inputs` (the manifest's step fields, secrets included) and `config` (its non-secret settings) */
export function splitValues(
  manifest: ProviderManifest,
  values: Readonly<Record<string, string>>,
  provided: ProvidedConfig = {},
): { inputs: Record<string, string>; config: Record<string, string> } {
  const inputs: Record<string, string> = {};
  const config: Record<string, string> = {};
  for (const spec of manifest.auth.config) {
    const value = spec.key in provided ? provided[spec.key] : values[spec.key]?.trim();
    if (value) config[spec.key] = value;
  }
  for (const step of manifest.auth.steps) {
    for (const spec of step.fields) {
      const value = spec.secret ? values[spec.key] : values[spec.key]?.trim();
      if (value) inputs[spec.key] = value;
    }
  }
  return { inputs, config };
}

/** the party needs the user's own computer (a household agent) */
export const needsOwnComputer = (manifest: ProviderManifest): boolean =>
  manifest.agent.required && manifest.agent.class === 'byo';

// a retired or paused party cannot start; a party without web support wants the app
export function connectableHere(manifest: ProviderManifest, deviceClass: DeviceClass): boolean {
  if (manifest.status.state === 'retired' || manifest.status.state === 'paused') return false;
  if (deviceClass === 'web' && manifest.webSupport === 'none') return false;
  return true;
}

/** the catalogue's document type, never a control-plane path */
export const PASSIVE_CHALLENGES: ReadonlySet<ChallengeType> = new Set(['app_approval', 'qr_display', 'live_view']);

/** the wire's snake_case words (a JobStep, a UserAction, a state, a code) → munni copy */
export const progressKey = (step: string): TranslationKey => copyKey(`connect.progress.${step}`, 'connect.progress.queued');
export const stateKey = (state: string): TranslationKey => copyKey(`connect.state.${state}`, 'connect.state.failed');
export const errorKey = (code: string | undefined): TranslationKey => copyKey(code ? `connect.error.${code}` : undefined, 'connect.error.internal');
export const actionKey = (action: string | undefined): TranslationKey | null =>
  action && action !== 'none' ? copyKey(`connect.action.${action}`, 'connect.action.retry') : null;
export const challengeKey = (type: ChallengeType, promptKey: string | undefined): TranslationKey =>
  copyKey(promptKey, copyKey(`connect.challenge.${type}`, 'connect.challenge.image'));

/** the taps answer the connector reads: ordered fractions, four decimals, `submit` last */
export function encodeTaps(points: readonly { x: number; y: number }[]): string {
  const clamp = (n: number) => Math.min(1, Math.max(0, n)).toFixed(4);
  const body = points.map((p) => `${clamp(p.x)},${clamp(p.y)}`).join(';');
  const marked = body ? `${body};` : '';
  return `tap.v1:${marked}submit`;
}

/** `appie://login-exit*` → `appie`: the scheme the auth session waits for */
export function callbackSchemeOf(returnPattern: string | undefined): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(returnPattern ?? '');
  return m ? m[1].toLowerCase() : null;
}

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['failed', 'expired', 'disabled', 'blocked', 'needs_reauth']);

/** a terminal view without an envelope still gets one, in the connector's own words */
const FAILED_CODE: Record<string, string> = { blocked: 'blocked_by_provider', expired: 'session_expired' };

export const failedWith = (state: string): ErrorEnvelope => {
  const code = FAILED_CODE[state] ?? 'internal';
  return {
    code,
    retriable: state !== 'blocked',
    userAction: state === 'blocked' ? 'wait' : 'retry',
    messageKey: `connect.error.${code}`,
  };
};

export const minIntervalMs = (manifest: ProviderManifest | undefined): number =>
  (manifest?.limits.minIntervalSeconds ?? 0) * 1000;
