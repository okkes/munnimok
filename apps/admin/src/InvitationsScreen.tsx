import { useRef, useState } from 'react';

/** an invitation as the API lists it — the magic link signs the person up; after that any sign-in method works */
export interface Invitation {
  id: string;
  email: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  link: string;
}
/** GET /admin/invitations: whether this environment admits anyone, and the invitations that are out */
export interface InvitationsDoc {
  inviteOnly: boolean;
  invitations: Invitation[];
}
/** POST /admin/invitations: the link the operator hands to the person */
export interface InviteResult {
  id: string;
  email: string;
  expiresAt: string;
  link: string;
}

/** enough shape to spare the API a pointless round trip — the API stays the judge */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const looksLikeEmail = (s: string): boolean => EMAIL_SHAPE.test(s.trim());

const when = (iso: string) => new Date(iso).toLocaleString();

type CopyState = 'idle' | 'copied' | 'selected';
const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy link',
  copied: 'Copied',
  selected: 'Selected — press Ctrl+C',
};

/**
 * The link in a read-only box with its Copy button: the clipboard API where
 * the browser grants it (a secure origin, the permission), else the text is
 * selected for a manual Ctrl+C — the operator never ends up empty-handed.
 */
function LinkCopy({ link, linkTestId, copyTestId }: Readonly<{ link: string; linkTestId: string; copyTestId: string }>) {
  const box = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<CopyState>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setState('copied');
    } catch {
      box.current?.focus();
      box.current?.select();
      setState('selected');
    }
  };
  return (
    <span className="card-tools">
      <input
        data-testid={linkTestId}
        readOnly
        value={link}
        ref={box}
        style={{ flex: 1, minWidth: 0 }}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button data-testid={copyTestId} type="button" onClick={() => void copy()}>
        {COPY_LABEL[state]}
      </button>
    </span>
  );
}

/**
 * Invitations: sign-up by magic link. The operator mints a link for an
 * e-mail address and hands it over personally (WhatsApp, e-mail) — the
 * API sends nothing itself. On an invite-only environment this is the
 * only door in; elsewhere the link merely spares the person the form.
 */
export function InvitationsScreen({
  doc,
  inviteOnlyFallback,
  busy,
  onInvite,
  onRevoke,
}: Readonly<{
  /** the list as last loaded — a string is the one line that says why it could not be listed; null = not in yet */
  doc: InvitationsDoc | string | null;
  /** what /health says about sign-up while the list is not in */
  inviteOnlyFallback: boolean;
  busy: boolean;
  /** resolves to what the API minted, or null when it refused (the error shows above the screen) */
  onInvite: (email: string) => Promise<InviteResult | null>;
  onRevoke: (id: string) => void;
}>) {
  const [email, setEmail] = useState('');
  const [minted, setMinted] = useState<InviteResult | null>(null);
  const loaded = typeof doc === 'string' ? null : doc;
  const inviteOnly = loaded ? loaded.inviteOnly : inviteOnlyFallback;

  const submit = async () => {
    const address = email.trim().toLowerCase();
    if (busy || !looksLikeEmail(address)) return;
    const result = await onInvite(address);
    if (!result) return; // the address stays in the box for a retry
    setMinted(result);
    setEmail('');
  };

  return (
    <div data-testid="invitations-screen">
      <h1>Invitations</h1>
      <p className="hint" data-testid="invite-mode">
        {inviteOnly ? 'Sign-up is by invitation on this environment.' : 'Registration is open here — invitations still work.'}
      </p>

      <section className="card">
        <h2>Invite someone</h2>
        <form
          className="form-row"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            data-testid="invite-email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button data-testid="invite-send" className="btn" type="submit" disabled={busy || !looksLikeEmail(email)}>
            Invite
          </button>
        </form>
        {minted && (
          <div className="editor" data-testid="invite-result" style={{ marginTop: 14, marginBottom: 0 }}>
            <div className="cell-title">{minted.email}</div>
            <div className="sub">valid until {when(minted.expiresAt)}</div>
            <div style={{ marginTop: 8 }}>
              <LinkCopy key={minted.id} link={minted.link} linkTestId="invite-link" copyTestId="invite-copy" />
            </div>
            <p className="hint" style={{ margin: '10px 0 0' }}>
              Send this link to the person yourself (WhatsApp, e-mail): it signs them up, then any sign-in method works.
            </p>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Active invitations</h2>
        {doc === null && <span className="sub">loading…</span>}
        {typeof doc === 'string' && (
          <p className="error" data-testid="invitations-unavailable">
            The invitations could not be listed: {doc}
          </p>
        )}
        {loaded && (
          <table data-testid="invitations-table">
            <thead>
              <tr>
                <th>Invited</th>
                <th>Expires</th>
                <th>Link</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loaded.invitations.map((inv) => (
                <tr key={inv.id} data-testid={`invite-row-${inv.id}`}>
                  <td>
                    <div className="cell-title">{inv.email}</div>
                    <div className="cell-sub">
                      {when(inv.createdAt)} · {inv.status}
                    </div>
                  </td>
                  <td>{when(inv.expiresAt)}</td>
                  <td>
                    <LinkCopy link={inv.link} linkTestId={`invite-link-${inv.id}`} copyTestId={`invite-copy-${inv.id}`} />
                  </td>
                  <td className="cell-actions">
                    <button data-testid={`invite-revoke-${inv.id}`} type="button" disabled={busy} onClick={() => onRevoke(inv.id)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
              {loaded.invitations.length === 0 && (
                <tr>
                  <td colSpan={4}>—</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
