/** one consent on an aggregator's account as the party lists it (§15.6), attributed by the environment it was started from */
export interface RemoteConsent {
  id: string;
  status: string;
  createdAt?: string | null;
  institutionId?: string | null;
  origin?: string | null;
  accountCount: number;
}

/** grouping key for consents whose return carried no usable origin */
export const UNATTRIBUTED = 'unattributed';

/** where a consent came from, as the operator reads it: munni's own hosts name their environment */
export interface ConsentSource {
  key: string;
  label: string;
  host: string | null;
}

// munni's hosts are munni-<env>-<platform>[-<service>] (infra/modules/stack.mjs hostsFor)
const MUNNI_HOST = /^munni-([a-z][a-z0-9]{1,11})-([a-z]{2,5})(?:-[a-z-]+)?$/;

/** the environment a return origin names: `prod · nas` for munni's hosts, this computer for localhost, else the host itself */
export function sourceOf(origin: string | null | undefined): ConsentSource {
  if (!origin) return { key: UNATTRIBUTED, label: UNATTRIBUTED, host: null };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { key: origin, label: origin, host: null };
  }
  const name = url.hostname.split('.')[0] ?? '';
  const munni = MUNNI_HOST.exec(name);
  if (munni) return { key: origin, label: `${munni[1]} · ${munni[2]}`, host: url.host };
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return { key: origin, label: 'this computer', host: url.host };
  return { key: origin, label: url.host, host: url.host };
}

/** consents per return origin, munni's named environments first, unattributed last */
export function groupBySource(consents: readonly RemoteConsent[]): { source: ConsentSource; consents: RemoteConsent[] }[] {
  const groups = new Map<string, { source: ConsentSource; consents: RemoteConsent[] }>();
  for (const c of consents) {
    const source = sourceOf(c.origin);
    const group = groups.get(source.key) ?? { source, consents: [] };
    if (group.consents.length === 0) groups.set(source.key, group);
    group.consents.push(c);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.source.key === UNATTRIBUTED) - Number(b.source.key === UNATTRIBUTED) || a.source.label.localeCompare(b.source.label),
  );
}

const DAY_MS = 86_400_000;

// GoCardless's requisition codes — the consent mock speaks the same words
const FINISHED: Record<string, { word: string; leftover: boolean }> = {
  LN: { word: 'linked — in force', leftover: false },
  EX: { word: 'expired', leftover: true },
  RJ: { word: 'rejected at the bank', leftover: true },
  SU: { word: 'suspended', leftover: true },
};

/**
 * What a consent's status means for the clean-up: in force, or a leftover
 * nothing can fetch with (expired, rejected, or a sign-in at the bank that
 * was never finished — after a day nobody is still in the middle of one).
 */
export function consentState(consent: Pick<RemoteConsent, 'status' | 'createdAt'>, now = Date.now()): { word: string; leftover: boolean } {
  const known = FINISHED[consent.status];
  if (known) return known;
  const created = consent.createdAt ? Date.parse(consent.createdAt) : Number.NaN;
  if (Number.isFinite(created) && now - created < DAY_MS) return { word: `${consent.status} — being given right now`, leftover: false };
  return { word: `${consent.status} — never finished at the bank`, leftover: true };
}
