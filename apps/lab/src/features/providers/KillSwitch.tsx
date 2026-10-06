import { useState } from 'react';
import type { ScreenProps } from '../../app/LabApp';

/**
 * The kill switch of one party: pause / resume / mark healthy / retire
 * behind a typed id. The reason key is optional and reaches users as copy
 * when the app has it. `compact` hides the reason box (the table) — the
 * party's own page shows it.
 */
export function KillSwitch({
  providerId,
  state,
  busy,
  act,
  call,
  onChanged,
  compact = false,
}: Readonly<{ providerId: string; state: string | undefined; onChanged: () => Promise<void>; compact?: boolean } & ScreenProps>) {
  const [reason, setReason] = useState('');
  const [retire, setRetire] = useState<string | null>(null);

  const setState = async (next: string) => {
    const ok = await act(() =>
      call(`/lab/providers/${encodeURIComponent(providerId)}/status`, {
        method: 'POST',
        body: JSON.stringify({ state: next, reasonKey: reason.trim() || null }),
      }),
    );
    setRetire(null);
    if (ok) await onChanged();
  };

  if (!state) return <span className="sub">—</span>;
  return (
    <>
      {!compact && state !== 'retired' && (
        <input
          data-testid={`provider-reason-${providerId}`}
          placeholder="reason key (optional)"
          value={reason}
          maxLength={120}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      {state !== 'retired' && state !== 'paused' && (
        <button data-testid={`provider-pause-${providerId}`} disabled={busy} onClick={() => void setState('paused')}>
          pause
        </button>
      )}
      {state === 'paused' && (
        <button data-testid={`provider-resume-${providerId}`} disabled={busy} onClick={() => void setState('healthy')}>
          resume
        </button>
      )}
      {state === 'degraded' && (
        <button data-testid={`provider-heal-${providerId}`} disabled={busy} onClick={() => void setState('healthy')}>
          mark healthy
        </button>
      )}
      {state !== 'retired' && retire === null && (
        <button data-testid={`provider-retire-${providerId}`} className="btn danger" disabled={busy} onClick={() => setRetire('')}>
          retire…
        </button>
      )}
      {retire !== null && (
        <span className="confirm-delete">
          <input data-testid="provider-retire-typed" placeholder={`type ${providerId}`} value={retire} onChange={(e) => setRetire(e.target.value)} />
          <button data-testid="provider-retire-confirm" className="btn danger" disabled={busy || retire !== providerId} onClick={() => void setState('retired')}>
            retire
          </button>
          <button onClick={() => setRetire(null)}>cancel</button>
        </span>
      )}
    </>
  );
}
