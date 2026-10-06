import { useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import type { LabConfig } from '../../config';
import type { HealthInfo, LabMe } from '../../types';

/** who the lab is here: the operator, the lab subject the control plane knows them as, the environment it talks to */
export function SettingsScreen({ call, config, testAuth }: Readonly<{ config: LabConfig; testAuth: boolean } & ScreenProps>) {
  const [me, setMe] = useState<LabMe | null | 'unreachable' | 'loading'>('loading');
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    void (async () => {
      const [m, h] = await Promise.all([getJson<LabMe>(call, '/lab/me'), getJson<HealthInfo>(call, '/health')]);
      setMe(m);
      setHealth(h && h !== 'unreachable' ? h : null);
    })();
  }, [call]);

  return (
    <>
      <h1>Settings</h1>
      <section className="card" data-testid="settings-identity">
        <h2>Who the lab is</h2>
        <p className="hint">
          Every lab run belongs to a subject of its own, minted per operator: the control plane knows the lab as this pseudonym, never
          as the person, and nothing the lab fetches ever reaches a space in the app.
        </p>
        <div className="facts">
          <div className="fact">
            <span className="fact-label">Operator</span>
            <span className="fact-value">{me !== 'loading' && me !== null && me !== 'unreachable' ? (me.name ?? me.email ?? '—') : '—'}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Lab subject</span>
            <span className="fact-value mono" data-testid="settings-subject">
              {me === 'loading' ? '…' : me === null ? 'none — this environment runs no connectors' : me === 'unreachable' ? 'not answering' : me.subject}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Sign-in</span>
            <span className="fact-value">{testAuth ? 'test subject (X-User-Sub)' : 'Logto, admin scope'}</span>
          </div>
        </div>
      </section>
      <section className="card" data-testid="settings-environment">
        <h2>Environment</h2>
        <div className="facts">
          <div className="fact">
            <span className="fact-label">API</span>
            <span className="fact-value mono">{config.apiUrl}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Build</span>
            <span className="fact-value">{health?.build ?? '—'}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Protocol</span>
            <span className="fact-value">{health?.protocol ?? '—'}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Identity provider</span>
            <span className="fact-value mono">{config.logtoEndpoint || '—'}</span>
          </div>
        </div>
      </section>
    </>
  );
}
