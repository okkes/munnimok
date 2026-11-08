import { useEffect, useRef, useState } from 'react';
import { consentState, groupBySource, sourceOf, UNATTRIBUTED } from './consents';
import type { RemoteConsent } from './consents';

/** null = still loading; 'unreachable' = the party's inventory did not answer */
type Inventory = RemoteConsent[] | 'unreachable' | null;

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '—');
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Bank consents (#571): every consent on munni's own accounts at the
 * open-banking aggregators. One aggregator account serves every
 * environment of the platform, so its inventory is the one list across all
 * of them — read here per environment, never changed: revoking stays in an
 * environment's lab, a person's connection in its admin portal.
 */
export function ConsentsScreen({
  parties,
  call,
  labUrl,
  focus,
}: Readonly<{ parties: string[]; call: (path: string) => Promise<Response>; labUrl: string; focus: string | null }>) {
  const [inventories, setInventories] = useState<Record<string, Inventory>>({});
  const focused = useRef<HTMLElement | null>(null);
  const scrolledTo = useRef<string | null>(null);
  const key = parties.join(',');

  useEffect(() => {
    let alive = true;
    setInventories({});
    for (const id of key ? key.split(',') : []) {
      void (async () => {
        const res = await call(`/control/connectors/providers/${encodeURIComponent(id)}/remote-consents`).catch(() => null);
        const value: Inventory = res?.ok ? ((await res.json()) as { consents: RemoteConsent[] }).consents : 'unreachable';
        if (alive) setInventories((all) => ({ ...all, [id]: value }));
      })();
    }
    return () => {
      alive = false;
    };
  }, [call, key]);

  // opened from a party's row: its card comes into view once, when its consents are in
  useEffect(() => {
    if (!focus || scrolledTo.current === focus || inventories[focus] === undefined) return;
    scrolledTo.current = focus;
    focused.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [focus, inventories]);

  const loaded = Object.values(inventories).filter((v): v is RemoteConsent[] => Array.isArray(v)).flat();
  const leftovers = loaded.filter((c) => consentState(c).leftover).length;
  const sources = new Set(loaded.map((c) => sourceOf(c.origin).key).filter((k) => k !== UNATTRIBUTED));

  return (
    <>
      <h1>Bank consents</h1>
      <p className="muted">
        Every consent on munni&apos;s own accounts at the open-banking aggregators. One aggregator account serves every environment of
        this platform, so this is the one list across all of them — grouped by the environment each consent was started from. Read-only.
      </p>
      <div className="tiles" data-testid="consents-tiles">
        <Tile label="Consents" value={String(loaded.length)} />
        <Tile label="In force" value={String(loaded.length - leftovers)} />
        <Tile label="Leftovers — nothing fetches with them" value={String(leftovers)} warn={leftovers > 0} />
        <Tile label="Environments" value={String(sources.size)} />
      </div>

      {parties.length === 0 && (
        <section className="card" data-testid="consents-none">
          <p className="hint">
            None of the designated environment&apos;s parties keeps an inventory — no open-banking aggregator with a list of its consents
            runs there.
          </p>
        </section>
      )}

      {parties.map((id) => (
        <section className="card" key={id} data-testid={`consents-party-${id}`} ref={id === focus ? focused : undefined}>
          <div className="card-head">
            <h2>{id}</h2>
            {labUrl && (
              <a className="sub" href={`${labUrl}/#/providers/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer" data-testid={`consents-lab-${id}`}>
                revoke in the lab ↗
              </a>
            )}
          </div>
          <PartyInventory inventory={inventories[id] ?? null} />
        </section>
      ))}

      <section className="card" data-testid="consents-howto">
        <h2>Removing one</h2>
        <p className="hint">
          A leftover — expired, rejected at the bank, a sign-in nobody finished, or a consent of an environment that no longer exists — is
          revoked in an environment&apos;s lab: Providers → the party → Inventory → revoke. Any environment&apos;s lab reaches every
          consent here, because the account is shared. A consent that is still in force belongs to someone&apos;s connection: end it where
          it lives instead — that environment&apos;s admin portal under Bank connections (Disconnect forgets the binding there too), or
          the person in the app under Settings → Connections.
        </p>
        <h2>Enable Banking</h2>
        <p className="hint" data-testid="consents-enablebanking">
          Enable Banking lists no sessions at its side, so no list across the environments exists for it. Each environment&apos;s admin
          portal lists its own under Bank connections, with a Disconnect per row and a clean-up of the stale ones; a session nobody uses
          ends on its own when the access the bank granted runs out.
        </p>
      </section>
    </>
  );
}

function Tile({ label, value, warn = false }: Readonly<{ label: string; value: string; warn?: boolean }>) {
  return (
    <div className={`tile ${warn ? 'tile-warn' : ''}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function PartyInventory({ inventory }: Readonly<{ inventory: Inventory }>) {
  if (inventory === null) return <p className="hint">loading…</p>;
  if (inventory === 'unreachable') {
    return (
      <p className="hint" data-testid="consents-unreachable">
        The party&apos;s inventory did not answer — the control plane or the aggregator is unreachable right now.
      </p>
    );
  }
  const groups = groupBySource(inventory);
  if (groups.length === 0) {
    return (
      <p className="hint" data-testid="consents-empty">
        No consents on the party&apos;s account.
      </p>
    );
  }
  return (
    <>
      {groups.map(({ source, consents }) => {
        const leftovers = consents.filter((c) => consentState(c).leftover).length;
        return (
          <div className="consent-group" key={source.key} data-testid={`consents-group-${source.key}`}>
            <h3>
              {source.label}
              {source.host && source.label !== source.host && <span className="cell-sub"> {source.host}</span>}
              <span className="sub">
                {' '}
                · {plural(consents.length, 'consent')} · {plural(consents.reduce((sum, c) => sum + c.accountCount, 0), 'account')}
                {leftovers > 0 ? ` · ${leftovers} leftover` : ''}
              </span>
            </h3>
            {source.key === UNATTRIBUTED && <p className="hint">No return address — made outside munni&apos;s connector platform, or by an older build.</p>}
            <table>
              <thead>
                <tr>
                  <th>Institution</th>
                  <th>Status</th>
                  <th>Accounts</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {consents.map((c) => {
                  const state = consentState(c);
                  return (
                    <tr key={c.id} data-testid={`consent-${c.id}`}>
                      <td>
                        <div className="cell-title">{c.institutionId ?? '—'}</div>
                        <div className="cell-sub">{c.id}</div>
                      </td>
                      <td>
                        {state.word}
                        {state.leftover && <span className="chip warn-chip">leftover</span>}
                      </td>
                      <td>{c.accountCount}</td>
                      <td>{day(c.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
