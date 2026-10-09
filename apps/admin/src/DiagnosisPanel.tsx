import { IdChip, SessionsTable, relativeText, shortId, whenText } from './sessionBits';
import type { SessionRow } from './sessionBits';

/** GET /admin/users/{sub}/diagnosis — the whole account→app chain of one user, labelled where the rows are readable */
export interface UserDiagnosis {
  userId: string;
  memberSpaces: string[];
  /** the member spaces named, with the role — absent from an older API: the ids above stand in */
  spaces?: { id: string; name: string | null; role: string; feed: boolean }[] | null;
  ownedFeeds: { feedSpaceId: string; maxSeq: number; lastOpAt?: string | null; attachedTo?: { id: string; name: string | null }[] | null }[];
  attachments: {
    spaceId: string;
    feedSpaceId: string;
    accountId: string;
    spaceName?: string | null;
    accountName?: string | null;
    ibanTail?: string | null;
    attachedByName?: string | null;
    archived?: boolean;
  }[];
  /** #367: the user's connector sessions as the relay binds them — absent where the environment runs no connectors */
  connectorSessions?: SessionRow[] | null;
}

const spaceName = (name: string | null | undefined, id: string): string => name ?? `unnamed space ${shortId(id, 8)}`;

/**
 * The diagnosis as cards (user 2026-10-09: "hard to understand" as bare
 * ids): spaces by name and role, feeds with where they show and when data
 * last landed, attachments by account and space, and the connector
 * sessions as the shared table — ids kept one click away, never leading.
 */
export function DiagnosisPanel({
  data,
  busy,
  onDisconnect,
}: Readonly<{ data: UserDiagnosis; busy: boolean; onDisconnect: (row: SessionRow) => void }>) {
  const spaces = (data.spaces ?? data.memberSpaces.map((id) => ({ id, name: null, role: '—', feed: false }))).filter((s) => !s.feed);
  const now = Date.now();
  return (
    <div className="diag" data-testid="user-diagnosis-panel">
      <section className="diag-section" data-testid="user-diagnosis-spaces">
        <h3>
          Spaces <span className="count">{spaces.length}</span>
        </h3>
        <p className="hint">The budget spaces the person belongs to, with their role. A bank feed is not a space — those are under Feeds.</p>
        {spaces.length === 0 ? (
          <p className="sub">No spaces — the person never finished onboarding, or left every space.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Space</th>
                <th>Role</th>
                <th>Id</th>
              </tr>
            </thead>
            <tbody>
              {spaces.map((space) => (
                <tr key={space.id} data-testid={`diag-space-${space.id}`}>
                  <td className="cell-title">{spaceName(space.name, space.id)}</td>
                  <td>{space.role}</td>
                  <td>
                    <IdChip id={space.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="diag-section" data-testid="user-diagnosis-feeds">
        <h3>
          Feeds <span className="count">{data.ownedFeeds.length}</span>
        </h3>
        <p className="hint">
          One feed per bank account the person connected or imported, keyed by its IBAN (not shown here). Ops = sync operations stored for it;
          the newest op says when data last landed. A feed attached to no space shows nowhere in the app yet.
        </p>
        {data.ownedFeeds.length === 0 ? (
          <p className="sub">No feeds — nothing was connected or imported by this person.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Feed</th>
                <th>Attached to</th>
                <th>Ops</th>
                <th>Newest op</th>
              </tr>
            </thead>
            <tbody>
              {data.ownedFeeds.map((feed) => (
                <tr key={feed.feedSpaceId} data-testid={`diag-feed-${feed.feedSpaceId}`}>
                  <td>
                    <IdChip id={feed.feedSpaceId} />
                  </td>
                  <td>
                    {feed.attachedTo && feed.attachedTo.length > 0
                      ? feed.attachedTo.map((space) => spaceName(space.name, space.id)).join(', ')
                      : 'not attached to a space'}
                  </td>
                  <td>{feed.maxSeq}</td>
                  <td>
                    {feed.lastOpAt ? relativeText(feed.lastOpAt, now) : 'never'}
                    {feed.lastOpAt && <div className="cell-sub">{whenText(feed.lastOpAt)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="diag-section" data-testid="user-diagnosis-attachments">
        <h3>
          Attachments <span className="count">{data.attachments.length}</span>
        </h3>
        <p className="hint">Which account each space shows — the attachment is what makes a feed&apos;s transactions visible in a space.</p>
        {data.attachments.length === 0 ? (
          <p className="sub">No attachments — no space shows a feed account yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Space</th>
                <th>Attached by</th>
                <th>Ids</th>
              </tr>
            </thead>
            <tbody>
              {data.attachments.map((link) => (
                <tr key={`${link.spaceId}:${link.feedSpaceId}:${link.accountId}`} className={link.archived ? 'stale' : ''}>
                  <td>
                    <div className="cell-title">{link.accountName ?? 'account'}</div>
                    <div className="cell-sub">
                      {link.ibanTail ?? ''}
                      {link.archived ? ' · archived (the attacher left the space)' : ''}
                    </div>
                  </td>
                  <td>{spaceName(link.spaceName, link.spaceId)}</td>
                  <td>{link.attachedByName ?? '—'}</td>
                  <td>
                    <IdChip id={link.feedSpaceId} /> <IdChip id={link.accountId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* #367: what the connector relay binds for this user — the session ids, never a bundle */}
      <section className="diag-section" data-testid="user-diagnosis-connectors">
        <h3>
          Connector sessions <span className="count">{data.connectorSessions?.length ?? 0}</span>
        </h3>
        <p className="hint">
          What the connector platform binds for this person — a bank consent is one of them. Stale = nothing fetches it any more (not
          active, no bundle kept): safe to disconnect. Disconnect ends it at the party and forgets it here; the accounts and their history
          stay in the app.
        </p>
        {data.connectorSessions ? (
          <SessionsTable rows={data.connectorSessions} busy={busy} testId="user-diagnosis-sessions" onDisconnect={onDisconnect} />
        ) : (
          <span className="sub">not offered here</span>
        )}
      </section>
    </div>
  );
}
