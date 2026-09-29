import { en } from '@/i18n/en';
import type { TranslationKey } from '@/i18n';
import type { ChallengeType, FieldSpec, ProviderManifest } from './types';

/**
 * A manifest becomes a form (docs/connector-integration-plan.md §10.2):
 * pure functions from the catalogue's declarations to steps, fields,
 * validation, the split into `inputs` and `config`, and the copy keys
 * munni renders them with. Nothing here knows a provider by name — the
 * mock store and Amazon go through the same functions.
 */

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

/** a key the connector emits, or the fallback when munni has no copy for it */
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
};

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

/**
 * The steps a login asks: the manifest's own, each with its fields, and
 * the non-secret `config` fields (country, language …) as one leading
 * step of their own when there are any. A remote-browser login has no
 * steps at all — the human signs in on the party's page.
 */
export function formSteps(manifest: ProviderManifest): FormStep[] {
  const steps: FormStep[] = [];
  if (manifest.auth.config.length > 0) {
    steps.push({ id: 'config', labelKey: 'connect.step.settings', fields: manifest.auth.config.map(toField) });
  }
  for (const step of manifest.auth.steps) {
    steps.push({ id: step.id, labelKey: copyKey(step.labelKey, 'connect.step.credentials'), fields: step.fields.map(toField) });
  }
  return steps;
}

/** every field of every step, in order */
export const allFields = (manifest: ProviderManifest): FormField[] => formSteps(manifest).flatMap((s) => s.fields);

/** what stops the values from being sent, per field key */
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
): { inputs: Record<string, string>; config: Record<string, string> } {
  const inputs: Record<string, string> = {};
  const config: Record<string, string> = {};
  for (const spec of manifest.auth.config) {
    const value = values[spec.key]?.trim();
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

/**
 * Whether a connect can start from this device at all: a retired party
 * is gone, a party without web support wants the app, a paused one is
 * shown but not offered.
 */
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

/** the party's sync interval in ms, as the catalogue states it */
export const minIntervalMs = (manifest: ProviderManifest | undefined): number =>
  (manifest?.limits.minIntervalSeconds ?? 0) * 1000;
