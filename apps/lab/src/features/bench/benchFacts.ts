import type { ParamSpec, ProviderEntry, ResourceSpec } from '../../types';

export const TERMINAL = new Set(['active', 'failed', 'expired', 'blocked', 'disabled', 'succeeded']);

/** sign-in still under way: its run (an explore run's live view too) can still be picked up (#576) */
export const SIGNING_IN = new Set(['queued', 'running', 'awaiting_input']);

export function signInFields(p: ProviderEntry): { step: string; key: string; type: string; secret: boolean; required: boolean }[] {
  return (p.auth?.steps ?? []).flatMap((step) =>
    step.fields.map((f) => ({ step: step.id, key: f.key, type: f.type, secret: !!f.secret, required: !!f.required })),
  );
}

export const fetchParams = (resource: ResourceSpec | undefined): ParamSpec[] => (resource?.params ?? []).filter((p) => !p.internal);

export function paramsBody(specs: readonly ParamSpec[], values: Readonly<Record<string, string | string[]>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const spec of specs) {
    const value = values[spec.key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) body[spec.key] = value;
    } else if (value.trim()) {
      body[spec.key] = value.trim();
    }
  }
  return body;
}

export function columnsOf(records: readonly Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const record of records.slice(0, 25)) for (const key of Object.keys(record)) keys.add(key);
  const first = ['externalId', 'id', 'displayName', 'merchant', 'bookedAt', 'purchasedAt', 'amount', 'total', 'currency', 'balance'];
  return [...keys].sort((a, b) => {
    const ai = first.indexOf(a);
    const bi = first.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return a.localeCompare(b);
  });
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'object') {
    const v = value as { amount?: unknown; currency?: unknown };
    const money = (typeof v.amount === 'string' || typeof v.amount === 'number') && typeof v.currency === 'string';
    text = money ? `${v.amount} ${v.currency}` : JSON.stringify(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    text = JSON.stringify(value) ?? '';
  }
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** `tap.v1:x,y;x,y;submit` — the picture challenge's taps as the control plane reads them (fractions of the picture); no taps = `tap.v1:` */
export function encodeTaps(points: readonly { x: number; y: number }[]): string {
  const clamp = (n: number) => Math.min(1, Math.max(0, n)).toFixed(4);
  const body = points.map((p) => `${clamp(p.x)},${clamp(p.y)}`).join(';');
  return body ? `tap.v1:${body};submit` : 'tap.v1:';
}
