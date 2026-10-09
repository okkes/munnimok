import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminConfig } from './config';
import bundledCatalog from './generated/bundledCatalog.json';
import { InvitationsScreen, type InvitationsDoc, type InviteResult } from './InvitationsScreen';
import { BankConnectionsScreen, type BankConnectionRow, type BankConnectionsDoc } from './BankConnectionsScreen';
import { DiagnosisPanel, type UserDiagnosis } from './DiagnosisPanel';
import { outcomeLine, type DisconnectOutcome, type SessionRow } from './sessionBits';

interface AdminUser {
  id: string;
  sub: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
  /** spaces the user is a member of — the IBAN-keyed bank feeds are counted apart */
  spaceCount: number;
  feedCount?: number;
}
interface HealthInfo {
  build?: string;
  capabilities?: Record<string, unknown>;
}

/** "1 space · 2 bank feeds" — the IBAN-keyed feeds a bank connection adds are counted apart from the spaces */
function membershipLabel(u: AdminUser): string {
  const spaces = `${u.spaceCount} space${u.spaceCount === 1 ? '' : 's'}`;
  if (!u.feedCount) return spaces;
  return `${spaces} · ${u.feedCount} bank feed${u.feedCount === 1 ? '' : 's'}`;
}

/** the invitations as the API lists them, or the one line that says why it could not (Logto down, an older API) */
async function readInvitations(res: Response | null): Promise<InvitationsDoc | string> {
  if (res?.ok) return (await res.json()) as InvitationsDoc;
  return failureLine(res);
}

/** user 2026-10-09: the bank connections as the API lists them, or why it could not (an older API answers 404) */
async function readBankConnections(res: Response | null): Promise<BankConnectionsDoc | string> {
  if (res?.ok) return (await res.json()) as BankConnectionsDoc;
  return failureLine(res);
}

/** a plain string from this api, else the status, else the network */
async function failureLine(res: Response | null): Promise<string> {
  const body = (await res?.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? (res ? `HTTP ${res.status}` : 'network');
}

type Screen = 'overview' | 'users' | 'invitations' | 'connectors' | 'bank-connections' | 'catalog';
const SCREENS: Screen[] = ['overview', 'users', 'invitations', 'connectors', 'bank-connections', 'catalog'];

/** the operator-published catalog document (admin-catalog design AC2) */
interface CatalogCategory {
  id: string;
  parentId?: string;
  names: { en: string; nl: string; tr: string };
  icon: string;
  txTypes?: string[];
  deleted?: boolean;
}
interface CatalogKeywordRule {
  catId: string;
  keywords: string[];
}
/** receipts v3 R9: operator-curated merchant patterns per store — the
 *  receipt auto-matcher improves without an app release */
interface CatalogStoreRule {
  id: string;
  patterns: string[];
}
interface CatalogDoc {
  version: number;
  categories: CatalogCategory[];
  keywords: CatalogKeywordRule[];
  stores?: CatalogStoreRule[];
}
const EMPTY_CATALOG: CatalogDoc = { version: 0, categories: [], keywords: [], stores: [] };

/** the connectable + coming-soon stores the matcher knows about */
const STORE_IDS = ['ah', 'jumbo', 'bol', 'coolblue', 'mediamarkt', 'amazon'] as const;

interface BundledCategory {
  id: string;
  parentId?: string;
  nameKey: string;
  icon: string;
  isParent?: boolean;
  hidden?: boolean;
  txTypes: string[];
}
interface BundledKeywordRule {
  lang: string;
  catId: string;
  keywords: string[];
}

/**
 * This browser's stable device id: the API stamps every authenticated
 * request's device (X-Munni-Device) and refuses requests that name none,
 * so the account's Logged-in devices screen can list and disconnect it.
 */
const DEVICE_KEY = 'munni_admin_device';
function deviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const minted = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, minted);
    return minted;
  } catch {
    return 'admin-console';
  }
}
function forgetDevice(): void {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // storage unavailable — nothing was remembered
  }
}

interface AdminAppProps {
  config: AdminConfig;
  /** null = test-auth mode (X-User-Sub header from the sub box) */
  getToken: (() => Promise<string | undefined>) | null;
  /** ends the Logto session (absent in test-auth mode) — a freshly granted admin role rides on the next token */
  signOut?: () => void;
  /** the OIDC session's state (absent in test-auth mode): a dead refresh grant, and the way back in */
  session?: { expired: boolean; signIn: () => void };
}

/**
 * munni admin console (admin-redesign): a desktop-first operator tool —
 * overview, user management, and bank-connection
 * upkeep. Talks to the same API (/admin/* gated server-side); it
 * deliberately shares no code with the member app.
 */
export function AdminApp({ config, getToken, signOut, session }: Readonly<AdminAppProps>) {
  // survives the full page reload a Logto re-auth causes (else every token
  // hiccup dumps the operator back on Overview mid-task)
  const [screen, setScreen] = useState<Screen>(() => {
    const saved = sessionStorage.getItem('munni_admin_screen');
    return saved && (SCREENS as readonly string[]).includes(saved) ? (saved as Screen) : 'overview';
  });
  const openScreen = (next: Screen) => {
    sessionStorage.setItem('munni_admin_screen', next);
    setScreen(next);
  };
  const [sub, setSub] = useState(() => localStorage.getItem('munni_admin_sub') ?? '');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [catalog, setCatalog] = useState<CatalogDoc | null>(null);
  // the invitations as last listed; a string says why they could not be (the screen shows it, never an empty table)
  const [invitations, setInvitations] = useState<InvitationsDoc | string | null>(null);
  // user 2026-10-09: the bank connections as last listed (every party on request), the same way
  const [bankConnections, setBankConnections] = useState<BankConnectionsDoc | string | null>(null);
  const [bankAll, setBankAll] = useState(false);
  // what the last act came to, where it has something to say (a disconnect's outcome at the party)
  const [notice, setNotice] = useState<string | null>(null);
  // 'denied' = the api really said 403; 'unreachable' = the ping never
  // got an answer (network/CORS/5xx) — one shared message made a blocked
  // request read as "not an admin" (found live 2026-08-28, control twin)
  const [denied, setDenied] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  // 'disconnected' = the api said 410: this browser's device was revoked
  // from the account (Logged-in devices) — the next load registers anew
  const [disconnected, setDisconnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Content-Type', 'application/json');
      headers.set('X-Munni-Device', deviceId());
      headers.set('X-Munni-Platform', 'web');
      if (getToken) {
        const token = await getToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);
      } else if (sub) {
        headers.set('X-User-Sub', sub);
      }
      return fetch(`${config.apiUrl}${path}`, { ...init, headers });
    },
    [config.apiUrl, getToken, sub],
  );

  const sessionExpired = session?.expired === true;
  // blocked: nothing loaded — the empty screens would only mislead (a dead session included)
  const blocked = denied || unreachable || disconnected || sessionExpired;
  const reload = useCallback(async () => {
    // a dead refresh grant (prod Logto logs 2026-10-08): no call would carry a
    // bearer, so none goes out — the note below says why instead of "did not
    // answer", and nothing hammers the api with 401s meanwhile
    if (sessionExpired) return;
    const ping = await call('/admin/ping').catch(() => null);
    if (ping?.status === 410) {
      forgetDevice();
      setDisconnected(true);
      return;
    }
    setDenied(ping?.status === 403);
    setUnreachable(!ping || (!ping.ok && ping.status !== 403));
    if (!ping?.ok) return;
    const [usersRes, healthRes] = await Promise.all([
      call('/admin/users'),
      fetch(`${config.apiUrl}/health`).catch(() => null),
    ]);
    if (usersRes.ok) setUsers((await usersRes.json()) as AdminUser[]);
    if (healthRes?.ok) setHealth((await healthRes.json()) as HealthInfo);
    const [catalogRes, invitesRes, bankRes] = await Promise.all([
      call('/catalog').catch(() => null),
      call('/admin/invitations').catch(() => null),
      call(`/admin/bank-connections${bankAll ? '?all=true' : ''}`).catch(() => null),
    ]);
    if (catalogRes?.status === 204) setCatalog(EMPTY_CATALOG);
    else if (catalogRes?.ok) setCatalog((await catalogRes.json()) as CatalogDoc);
    setInvitations(await readInvitations(invitesRes));
    setBankConnections(await readBankConnections(bankRes));
  }, [call, config.apiUrl, sessionExpired, bankAll]);

  useEffect(() => {
    if (getToken || sub) void reload();
  }, [reload, getToken, sub]);

  const act = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    const res = await fn().catch(() => null);
    if (!res?.ok) {
      // a plain string from this api, the connector's envelope ({ code, … }) from the relay
      const body = (await res?.json().catch(() => null)) as { error?: string | { code?: string } } | null;
      const reason = typeof body?.error === 'string' ? body.error : body?.error?.code;
      setError(reason ?? 'request failed');
    }
    await reload();
    setBusy(false);
    // the answer rides along for the few acts that mint something (an invitation's link)
    return res;
  };

  // pickProvider retired (#175): both providers are offered to the END
  // USER at connect time — there is no admin-selected "active" one.
  const publishCatalog = (categories: CatalogCategory[], keywords: CatalogKeywordRule[], stores: CatalogStoreRule[]) =>
    act(() => call('/admin/catalog', { method: 'PUT', body: JSON.stringify({ categories, keywords, stores }) }));

  // user 2026-10-09: a session ended from the portal — at the party, then forgotten here; the strip says what the party did
  const disconnectSession = async (row: SessionRow): Promise<DisconnectOutcome | null> => {
    setNotice(null);
    const res = await act(() => call(`/admin/bank-connections/${encodeURIComponent(row.sessionId)}`, { method: 'DELETE' }));
    if (!res?.ok) return null;
    const outcome = (await res.json()) as DisconnectOutcome;
    setNotice(outcomeLine(outcome));
    return outcome;
  };

  // every stale row of one person after one confirm: one call each, one reload, one line
  const cleanUpSessions = async (rows: BankConnectionRow[]) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    let ended = 0;
    for (const row of rows) {
      const res = await call(`/admin/bank-connections/${encodeURIComponent(row.sessionId)}`, { method: 'DELETE' }).catch(() => null);
      if (res?.ok) ended += 1;
    }
    await reload();
    setBusy(false);
    const failed = rows.length - ended;
    const tail = failed > 0 ? `, ${failed} could not be` : '';
    setNotice(`${ended} stale connection${ended === 1 ? '' : 's'} disconnected${tail}.`);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          munni<span className="dot">.</span> <span className="brand-sub">admin</span>
        </div>
        <nav>
          {(
            [
              ['overview', 'Overview'],
              ['users', 'Users'],
              ['invitations', 'Invitations'],
              ['connectors', 'Connectors'],
              ['bank-connections', 'Bank connections'],
              ['catalog', 'Catalog'],
            ] as [Screen, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              data-testid={`nav-${id}`}
              className={screen === id ? 'active' : ''}
              onClick={() => openScreen(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {signOut && (
            <button className="btn" data-testid="admin-signout" onClick={signOut}>
              Sign out
            </button>
          )}
          {!getToken && (
            <input
              data-testid="admin-sub"
              value={sub}
              placeholder="test subject (X-User-Sub)"
              onChange={(e) => {
                setSub(e.target.value);
                localStorage.setItem('munni_admin_sub', e.target.value);
              }}
            />
          )}
        </div>
      </aside>

      <main className="content">
        {session?.expired && (
          <p className="denied" data-testid="admin-session-expired">
            Your session expired — sign in again.{' '}
            <button className="btn" data-testid="admin-session-signin" style={{ marginLeft: 12 }} onClick={session.signIn}>
              Sign in
            </button>
          </p>
        )}
        {denied && (
          <p className="denied">
            This account has no admin access yet — its sign-in carries no admin scope. An operator switches admin on for it in the setup wizard
            (the environment&apos;s Access tab); then sign out and in again — the role rides on the next token.
            {signOut && (
              <button className="btn" data-testid="admin-denied-signout" style={{ marginLeft: 12 }} onClick={signOut}>
                Sign out
              </button>
            )}
          </p>
        )}
        {unreachable && <p className="denied">The admin API did not answer — is the environment running (and this origin allowed)?</p>}
        {disconnected && <p className="denied">This browser was disconnected from the account — reload to register it again.</p>}
        {/* blocked: no data loaded — the empty screens would only mislead */}
        {error && (
          <p className="error" data-testid="admin-error">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" data-testid="admin-notice">
            {notice}
          </p>
        )}
        {!blocked && screen === 'overview' && (
          <OverviewScreen users={users} health={health} />
        )}
        {!blocked && screen === 'catalog' && catalog && (
          <CatalogScreen key={catalog.version} doc={catalog} busy={busy} onPublish={publishCatalog} />
        )}
        {!blocked && screen === 'connectors' && (
          <LabHandoverScreen labUrl={config.labUrl} onOpenBankConnections={() => openScreen('bank-connections')} />
        )}
        {!blocked && screen === 'bank-connections' && (
          <BankConnectionsScreen
            doc={bankConnections}
            busy={busy}
            onToggleAll={(all) => {
              setBankConnections(null);
              setBankAll(all);
            }}
            onDisconnect={(row) => void disconnectSession(row)}
            onCleanUp={(rows) => void cleanUpSessions(rows)}
          />
        )}
        {!blocked && screen === 'invitations' && (
          <InvitationsScreen
            doc={invitations}
            inviteOnlyFallback={health?.capabilities?.inviteOnly === true}
            busy={busy}
            onInvite={async (email) => {
              const res = await act(() => call('/admin/invitations', { method: 'POST', body: JSON.stringify({ email }) }));
              return res?.ok ? ((await res.json()) as InviteResult) : null;
            }}
            onRevoke={(id) => void act(() => call(`/admin/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }))}
          />
        )}
        {!blocked && screen === 'users' && (
          <UsersScreen
            users={users}
            busy={busy}
            onDisconnect={disconnectSession}
            onDiagnose={async (sub) => {
              const res = await call(`/admin/users/${encodeURIComponent(sub)}/diagnosis`).catch(() => null);
              if (!res?.ok) {
                const reason = res ? `HTTP ${res.status}` : 'network';
                return `request failed (${reason}) — reload and retry`;
              }
              return (await res.json()) as UserDiagnosis;
            }}
          />
        )}
      </main>
    </div>
  );
}

/** #441: the connectors are the lab's now — every operator act on a party, an agent or a slot lives there */
function LabHandoverScreen({ labUrl, onOpenBankConnections }: Readonly<{ labUrl: string; onOpenBankConnections: () => void }>) {
  return (
    <>
      <h1>Connectors</h1>
      <section className="card" data-testid="connectors-handover">
        <p className="hint">
          The connectors moved to the lab: the parties with the kill switch, the fleet and the private slots, the canaries and an
          aggregator&apos;s inventory — and from there the test bench and the recorder. Same account, same admin role.
        </p>
        <a className="btn" data-testid="connectors-open-lab" href={labUrl} target="_blank" rel="noreferrer">
          Open the lab
        </a>
      </section>
      {/* user 2026-10-09: the people's own consents stay in this portal — the lab is about the parties, not the persons */}
      <section className="card">
        <p className="hint">
          The bank consents of the users — every GoCardless and Enable Banking connection, with a disconnect per row and a clean-up of the
          stale ones — have their own page here: Bank connections.
        </p>
        <button className="btn" data-testid="connectors-open-bank-connections" type="button" onClick={onOpenBankConnections}>
          Open Bank connections
        </button>
      </section>
    </>
  );
}

function OverviewScreen({ users, health }: Readonly<{ users: AdminUser[]; health: HealthInfo | null }>) {
  const caps = Object.entries(health?.capabilities ?? {}).filter(([, v]) => typeof v === 'boolean');

  return (
    <>
      <h1>Overview</h1>
      <div className="tiles" data-testid="overview-tiles">
        <Tile label="Users" value={String(users.length)} />
        <Tile label="Space memberships" value={String(users.reduce((sum, u) => sum + u.spaceCount, 0))} />
        <Tile label="Bank feeds" value={String(users.reduce((sum, u) => sum + (u.feedCount ?? 0), 0))} />
      </div>

      {/* the parties — banks included since #414 — live under Connectors: their state, their budget, their inventory */}
      {health && (
        <section className="card">
          <h2>Server</h2>
          <div className="chips" data-testid="overview-capabilities">
            <span className="chip on">build {health.build ?? '—'}</span>
            {caps.map(([name, on]) => (
              <span key={name} className={`chip ${on ? 'on' : ''}`}>
                {name}
              </span>
            ))}
          </div>
        </section>
      )}
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

function UsersScreen({
  users,
  busy,
  onDiagnose,
  onDisconnect,
}: Readonly<{
  users: AdminUser[];
  busy: boolean;
  /** resolves to the diagnosis, or a human-readable failure line */
  onDiagnose: (sub: string) => Promise<UserDiagnosis | string>;
  /** user 2026-10-09: a session row's Disconnect — the diagnosis is read again once it settles */
  onDisconnect: (row: SessionRow) => Promise<unknown>;
}>) {
  const [query, setQuery] = useState('');
  const [diag, setDiag] = useState<{ sub: string; data: UserDiagnosis | string | null } | null>(null);
  const loadDiagnosis = (sub: string) => {
    setDiag({ sub, data: null });
    void onDiagnose(sub).then((data) => setDiag((prev) => (prev?.sub === sub ? { sub, data } : prev)));
  };
  const toggleDiagnosis = (sub: string) => {
    if (diag?.sub === sub) {
      setDiag(null);
      return;
    }
    loadDiagnosis(sub);
  };
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      [u.displayName, u.email, u.sub].some((field) => field?.toLowerCase().includes(q)),
    );
  }, [users, query]);

  return (
    <>
      <h1>Users</h1>
      <input
        data-testid="users-search"
        className="search"
        value={query}
        placeholder="Search name, email or sub…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <section className="card">
        <table data-testid="admin-users">
          <thead>
            <tr>
              <th>User</th>
              <th>Joined</th>
              <th>Spaces</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="cell-title">{u.displayName ?? u.sub}</div>
                  <div className="cell-sub">
                    {u.email ? `${u.email} · ` : ''}
                    {u.sub}
                  </div>
                </td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>{membershipLabel(u)}</td>
                <td className="cell-actions">
                  <button
                    data-testid={`diagnose-${u.sub}`}
                    className="btn"
                    onClick={() => toggleDiagnosis(u.sub)}
                  >
                    {diag?.sub === u.sub ? 'Hide' : 'Diagnose'}
                  </button>
                </td>
              </tr>
            ))}
            {diag && (
              <tr data-testid="user-diagnosis">
                <td colSpan={4}>
                  {!diag.data && <span className="sub">loading…</span>}
                  {typeof diag.data === 'string' && <span className="sub">{diag.data}</span>}
                  {diag.data && typeof diag.data !== 'string' && (
                    <DiagnosisPanel
                      data={diag.data}
                      busy={busy}
                      onDisconnect={(row) => {
                        const { sub } = diag;
                        void onDisconnect(row).then(() => loadDiagnosis(sub));
                      }}
                    />
                  )}
                </td>
              </tr>
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

const TX_TYPES = ['expense', 'income', 'saving', 'transfer', 'debtPayment', 'investment', 'adjustment'];

/**
 * Catalog editor (AC2): edits the OVERLAY document, not the app bundle —
 * entries here rename, add or retire built-in categories and extend the
 * prediction keywords. Publishing bumps the server-owned version; every
 * client picks it up on its next sync.
 */
/** what every app ships with — the baseline the overlay edits against */
const BUNDLED = bundledCatalog as { categories: BundledCategory[]; keywords: BundledKeywordRule[] };

/** one merged row of the tree: what ships + what the overlay says */
interface TreeRow {
  id: string;
  parentId?: string;
  icon?: string;
  txTypes: string[];
  bundled: boolean;
  overlay?: CatalogCategory;
}

/** synthesized tombstones mark themselves by naming all languages the id */
const isSyntheticTombstone = (c: CatalogCategory) =>
  !!c.deleted && c.names.en === c.id && c.names.nl === c.id && c.names.tr === c.id;

function buildTree(categories: CatalogCategory[]): { mains: TreeRow[]; childrenOf: (id: string) => TreeRow[] } {
  const rows = new Map<string, TreeRow>();
  for (const b of BUNDLED.categories) {
    rows.set(b.id, { id: b.id, parentId: b.parentId, icon: b.icon, txTypes: b.txTypes, bundled: true });
  }
  for (const o of categories) {
    const existing = rows.get(o.id);
    if (existing) existing.overlay = o;
    else rows.set(o.id, { id: o.id, parentId: o.parentId, icon: o.icon, txTypes: o.txTypes ?? [], bundled: false, overlay: o });
  }
  const all = [...rows.values()];
  return {
    mains: all.filter((r) => !r.parentId),
    childrenOf: (id: string) => all.filter((r) => r.parentId === id),
  };
}

const rowLabel = (row: TreeRow) =>
  row.overlay && !isSyntheticTombstone(row.overlay) ? row.overlay.names.en : row.id;

function rowBadge(row: TreeRow): { text: string; cls: string } | null {
  if (row.overlay?.deleted) return { text: 'retired', cls: 'chip danger-chip' };
  if (row.overlay && !row.bundled) return { text: 'new', cls: 'chip ok-chip' };
  if (row.overlay) return { text: 'renamed', cls: 'chip warn-chip' };
  return null;
}

function CatalogScreen({
  doc,
  busy,
  onPublish,
}: Readonly<{
  doc: CatalogDoc;
  busy: boolean;
  onPublish: (categories: CatalogCategory[], keywords: CatalogKeywordRule[], stores: CatalogStoreRule[]) => void;
}>) {
  const [categories, setCategories] = useState<CatalogCategory[]>(doc.categories);
  const [keywords, setKeywords] = useState<CatalogKeywordRule[]>(doc.keywords);
  // raw text per store (parsing on publish — a controlled parse-on-type
  // input would swallow the comma the operator just typed)
  const [storeText, setStoreText] = useState<Record<string, string>>(() =>
    Object.fromEntries((doc.stores ?? []).map((s) => [s.id, s.patterns.join(', ')])),
  );
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; typed: string } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState({ id: '', parentId: '', en: '', nl: '', tr: '', icon: '', txType: 'expense' });
  const [keywordDraft, setKeywordDraft] = useState({ catId: '', words: '' });
  const storeRules = (): CatalogStoreRule[] =>
    STORE_IDS.flatMap((id) => {
      const patterns = (storeText[id] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
      return patterns.length > 0 ? [{ id, patterns }] : [];
    });
  const dirty =
    JSON.stringify(categories) !== JSON.stringify(doc.categories) ||
    JSON.stringify(keywords) !== JSON.stringify(doc.keywords) ||
    JSON.stringify(storeRules()) !== JSON.stringify(doc.stores ?? []);

  const tree = buildTree(categories);
  const matches = (row: TreeRow) => {
    const q = search.trim().toLowerCase();
    return !q || row.id.toLowerCase().includes(q) || rowLabel(row).toLowerCase().includes(q);
  };

  // keyword UX: humans pick and read category NAMES, ids stay subtitles
  const pretty = (id: string) => id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  const catLabel = (id: string) => {
    const overlay = categories.find((c) => c.id === id && !isSyntheticTombstone(c));
    return overlay ? overlay.names.en : pretty(id);
  };
  const selectableCats = tree.mains
    .filter((m) => !m.overlay?.deleted)
    .flatMap((m) => [
      { row: m, sub: false },
      ...tree
        .childrenOf(m.id)
        .filter((s) => !s.overlay?.deleted)
        .flatMap((s) => [{ row: s, sub: true }, ...tree.childrenOf(s.id).filter((l) => !l.overlay?.deleted).map((l) => ({ row: l, sub: true }))]),
    ]);

  const openForm = (prefill: Partial<typeof draft>) => {
    setDraft({ id: '', parentId: '', en: '', nl: '', tr: '', icon: '', txType: 'expense', ...prefill });
    setFormOpen(true);
  };

  const addCategory = () => {
    const id = draft.id.trim();
    if (!id || !draft.en.trim() || !draft.nl.trim() || !draft.tr.trim() || !draft.icon.trim()) return;
    setCategories([
      ...categories.filter((c) => c.id !== id), // re-editing an override replaces it
      {
        id,
        parentId: draft.parentId.trim() || undefined,
        names: { en: draft.en.trim(), nl: draft.nl.trim(), tr: draft.tr.trim() },
        icon: draft.icon.trim(),
        txTypes: [draft.txType],
      },
    ]);
    setFormOpen(false);
  };

  /** retire/restore straight from the tree: bundled rows without an
   *  overlay get a synthesized tombstone; restoring one removes it again */
  const toggleRow = (row: TreeRow) => {
    setConfirmDelete(null);
    if (!row.overlay) {
      setCategories([
        ...categories,
        {
          id: row.id,
          parentId: row.parentId,
          names: { en: row.id, nl: row.id, tr: row.id },
          icon: row.icon ?? 'shape',
          txTypes: row.txTypes,
          deleted: true,
        },
      ]);
      return;
    }
    if (isSyntheticTombstone(row.overlay)) {
      setCategories(categories.filter((c) => c.id !== row.id));
      return;
    }
    setCategories(categories.map((c) => (c.id === row.id ? { ...c, deleted: !c.deleted } : c)));
  };

  const addKeywordRule = () => {
    const catId = keywordDraft.catId.trim();
    const words = keywordDraft.words
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean);
    if (!catId || words.length === 0) return;
    setKeywords([...keywords, { catId, keywords: words }]);
    setKeywordDraft({ catId: '', words: '' });
  };

  const renderRow = (row: TreeRow, sub: boolean) => {
    const badge = rowBadge(row);
    return (
      <div
        key={row.id}
        className={'tree-row' + (sub ? ' tree-sub' : '') + (row.overlay?.deleted ? ' retired' : '')}
        data-testid={row.overlay ? 'catalog-cat-' + row.id : 'catalog-row-' + row.id}
      >
        <span className="tree-label">
          <span className="tree-name">{rowLabel(row)}</span>
          <code className="tree-id">{row.id}</code>
          {row.icon && <code className="tree-icon">{row.icon}</code>}
          {badge && <span className={badge.cls}>{badge.text}</span>}
        </span>
        <span className="tree-actions">
          {!sub && !row.overlay?.deleted && (
            <button
              data-testid={'catalog-addsub-' + row.id}
              disabled={busy}
              onClick={() => openForm({ parentId: row.id, txType: row.txTypes[0] ?? 'expense' })}
            >
              + sub
            </button>
          )}
          {!row.overlay?.deleted && (
            <button
              data-testid={'catalog-prefill-' + row.id}
              disabled={busy}
              onClick={() =>
                openForm({
                  id: row.id,
                  parentId: row.parentId ?? '',
                  icon: row.overlay?.icon ?? row.icon ?? '',
                  txType: row.overlay?.txTypes?.[0] ?? row.txTypes[0] ?? 'expense',
                  en: row.overlay && !isSyntheticTombstone(row.overlay) ? row.overlay.names.en : '',
                  nl: row.overlay && !isSyntheticTombstone(row.overlay) ? row.overlay.names.nl : '',
                  tr: row.overlay && !isSyntheticTombstone(row.overlay) ? row.overlay.names.tr : '',
                })
              }
            >
              rename
            </button>
          )}
          <CatalogRowAction
            cat={row.overlay ?? { id: row.id, names: { en: row.id, nl: row.id, tr: row.id }, icon: row.icon ?? '', txTypes: row.txTypes }}
            busy={busy}
            confirm={confirmDelete?.id === row.id ? confirmDelete : null}
            onArm={() => setConfirmDelete({ id: row.id, typed: '' })}
            onType={(typed) => setConfirmDelete({ id: row.id, typed })}
            onToggle={() => toggleRow(row)}
          />
        </span>
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Catalog</h1>
          <p className="sub">
            The category tree every device ships with, plus this overlay on top — rename, add or retire here and
            publish; clients apply the new version on their next sync. Retired categories detach their
            transactions to Uncategorized; user-created categories are never touched.
          </p>
        </div>
        <span className="chip">v{doc.version}</span>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Categories</h2>
          <span className="card-tools">
            <input
              data-testid="catalog-search"
              className="search"
              placeholder="filter…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button data-testid="catalog-add-main" disabled={busy} onClick={() => openForm({})}>
              + main category
            </button>
          </span>
        </div>

        {formOpen && (
          <div className="editor" data-testid="catalog-editor">
            <div className="editor-grid">
              <input data-testid="catalog-new-id" placeholder="id" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
              <input data-testid="catalog-new-parent" placeholder="parentId (empty = main)" value={draft.parentId} onChange={(e) => setDraft({ ...draft, parentId: e.target.value })} />
              <input data-testid="catalog-new-en" placeholder="EN" value={draft.en} onChange={(e) => setDraft({ ...draft, en: e.target.value })} />
              <input data-testid="catalog-new-nl" placeholder="NL" value={draft.nl} onChange={(e) => setDraft({ ...draft, nl: e.target.value })} />
              <input data-testid="catalog-new-tr" placeholder="TR" value={draft.tr} onChange={(e) => setDraft({ ...draft, tr: e.target.value })} />
              <input data-testid="catalog-new-icon" placeholder="mdi icon" value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} />
              <select data-testid="catalog-new-type" value={draft.txType} onChange={(e) => setDraft({ ...draft, txType: e.target.value })}>
                {TX_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="editor-actions">
              <span className="sub">An EXISTING id renames/overrides; a new id adds. All three languages required.</span>
              <span>
                <button data-testid="catalog-editor-cancel" onClick={() => setFormOpen(false)}>
                  cancel
                </button>
                <button data-testid="catalog-add-category" className="primary" disabled={busy} onClick={addCategory}>
                  Save entry
                </button>
              </span>
            </div>
          </div>
        )}

        <div className="tree" data-testid="catalog-categories">
          {tree.mains.map((main) => {
            const subs = tree.childrenOf(main.id);
            const visible = matches(main) || subs.some(matches);
            if (!visible) return null;
            return (
              <div key={main.id} className="tree-group">
                {renderRow(main, false)}
                {subs
                  .filter((row) => matches(row) || matches(main))
                  .map((row) => (
                    <Fragment key={row.id}>
                      {renderRow(row, true)}
                      {/* overlay additions may nest under a sub (padel
                          under hobby) — render that third level too */}
                      {tree.childrenOf(row.id).map((leaf) => renderRow(leaf, true))}
                    </Fragment>
                  ))}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Prediction keywords</h2>
          <span className="sub">published rules win ties against the bundled set</span>
        </div>
        {keywords.length > 0 && (
          <table data-testid="catalog-keywords">
            <thead>
              <tr>
                <th>category</th><th>keywords</th><th></th>
              </tr>
            </thead>
            <tbody>
              {keywords.map((rule, i) => (
                <tr key={rule.catId + '-' + i}>
                  <td>
                    <span className="cell-title">{catLabel(rule.catId)}</span>
                    <div className="cell-sub">{rule.catId}</div>
                  </td>
                  <td className="kw-words">{rule.keywords.join(', ')}</td>
                  <td className="cell-actions">
                    <button data-testid={'catalog-kw-remove-' + i} disabled={busy} onClick={() => setKeywords(keywords.filter((_, j) => j !== i))}>
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="form-row">
          <select data-testid="catalog-kw-cat" value={keywordDraft.catId} onChange={(e) => setKeywordDraft({ ...keywordDraft, catId: e.target.value })}>
            <option value="">Category…</option>
            {selectableCats.map(({ row, sub }) => {
              const label = rowLabel(row) === row.id ? pretty(row.id) : rowLabel(row);
              return (
                <option key={row.id} value={row.id}>
                  {sub ? `— ${label}` : label}
                </option>
              );
            })}
          </select>
          <input data-testid="catalog-kw-words" placeholder="keywords, comma, separated" value={keywordDraft.words} onChange={(e) => setKeywordDraft({ ...keywordDraft, words: e.target.value })} />
          <button data-testid="catalog-add-keyword" className="btn" disabled={busy} onClick={addKeywordRule}>
            Add rule
          </button>
        </div>
        <details>
          <summary className="sub" style={{ cursor: 'pointer' }}>
            Bundled baseline: {BUNDLED.keywords.length} keyword rules — click to browse
          </summary>
          <table>
            <thead><tr><th>lang</th><th>category</th><th>keywords</th></tr></thead>
            <tbody>
              {BUNDLED.keywords.map((rule, i) => (
                <tr key={rule.catId + '-' + i}>
                  <td>{rule.lang}</td>
                  <td>
                    <span className="cell-title">{catLabel(rule.catId)}</span>
                    <div className="cell-sub">{rule.catId}</div>
                  </td>
                  <td className="kw-words">{rule.keywords.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      {/* receipts v3 R9: merchant fingerprints per store — the receipt
          auto-matcher tests these against transaction merchants */}
      <section className="card">
        <div className="card-head">
          <h2>Store matching</h2>
          <span className="sub">comma-separated patterns (regex allowed); empty = the bundled fingerprint</span>
        </div>
        <table data-testid="catalog-stores">
          <thead>
            <tr>
              <th>store</th><th>merchant patterns</th>
            </tr>
          </thead>
          <tbody>
            {STORE_IDS.map((id) => (
              <tr key={id}>
                <td><span className="cell-title">{id}</span></td>
                <td>
                  <input
                    data-testid={'catalog-store-' + id}
                    placeholder="albert heijn, \bah\b"
                    value={storeText[id] ?? ''}
                    onChange={(e) => setStoreText((current) => ({ ...current, [id]: e.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className={'pubbar' + (dirty ? ' show' : '')}>
        <span className="sub">{dirty ? 'Unpublished changes' : 'Everything published'}</span>
        <button data-testid="catalog-publish" className="primary" disabled={busy || !dirty} onClick={() => onPublish(categories, keywords, storeRules())}>
          Publish version {doc.version + 1}
        </button>
      </div>
    </>
  );
}

/** retire flow: typing the exact id arms the button (mistake-proof) */
function CatalogRowAction({
  cat,
  busy,
  confirm,
  onArm,
  onType,
  onToggle,
}: Readonly<{
  cat: CatalogCategory;
  busy: boolean;
  confirm: { id: string; typed: string } | null;
  onArm: () => void;
  onType: (typed: string) => void;
  onToggle: () => void;
}>) {
  if (cat.deleted) {
    return (
      <button data-testid={'catalog-restore-' + cat.id} disabled={busy} onClick={onToggle}>
        restore
      </button>
    );
  }
  if (confirm) {
    return (
      <span className="confirm-delete">
        <input
          data-testid="catalog-delete-typed"
          placeholder={'type ' + cat.id}
          value={confirm.typed}
          onChange={(e) => onType(e.target.value)}
        />
        <button data-testid="catalog-delete-confirm" disabled={confirm.typed !== cat.id} onClick={onToggle}>
          retire
        </button>
      </span>
    );
  }
  return (
    <button data-testid={'catalog-delete-' + cat.id} disabled={busy} onClick={onArm}>
      retire…
    </button>
  );
}
