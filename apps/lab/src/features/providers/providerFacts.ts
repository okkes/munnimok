import type { ProviderEntry, ProviderQuota } from '../../types';
import { when } from '../../lib/format';

export function quotaLine(quota: ProviderQuota | null | undefined): string {
  if (!quota || (quota.limit == null && quota.remaining == null)) return '—';
  const left = `${quota.remaining ?? '?'} / ${quota.limit ?? '?'}`;
  return quota.resetAt ? `${left} · resets ${when(quota.resetAt)}` : left;
}

export const quotaLow = (quota: ProviderQuota | null | undefined): boolean =>
  quota?.remaining != null && quota.limit != null && quota.limit > 0 && quota.remaining <= quota.limit / 5;

export function agentLine(p: ProviderEntry): string {
  if (!p.agent?.required) return 'inline (no browser)';
  const parts = [p.agent.class ?? 'pooled'];
  if (p.agent.egress?.country) parts.push(`${p.agent.egress.country} ${p.agent.egress.kind ?? ''}`.trim());
  if (p.agent.desktopBrowser) parts.push('desktop browser');
  if (p.loginNeedsHeadedAgent) parts.push('headed login');
  return parts.join(' · ');
}

export function sessionLine(p: ProviderEntry): string {
  const s = p.auth?.session;
  if (!s) return '—';
  const parts: string[] = [];
  if (s.ttlSeconds != null) parts.push(s.ttlSeconds >= 3600 ? `${Math.round(s.ttlSeconds / 3600)} h` : `${s.ttlSeconds} s`);
  parts.push(s.refreshable ? 'refreshable' : 'not refreshable');
  if (s.rotatesOnUse) parts.push('rotates on use');
  return parts.join(' · ');
}

export function allFields(p: ProviderEntry): { step: string; key: string; type: string; secret: boolean; required: boolean }[] {
  const config = (p.auth?.config ?? []).map((f) => ({ step: 'config', key: f.key, type: f.type, secret: Boolean(f.secret), required: Boolean(f.required) }));
  const steps = (p.auth?.steps ?? []).flatMap((s) =>
    s.fields.map((f) => ({ step: s.id, key: f.key, type: f.type, secret: Boolean(f.secret), required: Boolean(f.required) })),
  );
  return [...config, ...steps];
}
