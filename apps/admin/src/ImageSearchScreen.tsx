import { useState } from 'react';

/** GET /admin/image-search: whether this environment searches the web for pictures, the limit, and how the month stands */
export interface ImageSearchDoc {
  enabled: boolean;
  /** searches a person gets a day; null = no limit */
  dailyPerUser: number | null;
  /** what the search service last said is left this month; null before the first search since the API started */
  remainingThisMonth: number | null;
  /** the month's searches are used up until then */
  pausedUntil: string | null;
}

export const MAX_DAILY_SEARCHES = 10_000;

/** what the field holds as a limit: empty is no limit, a whole number from 1 up is one, anything else is not an answer */
export function parseDailyLimit(text: string): number | null | 'invalid' {
  const value = text.trim();
  if (value === '') return null;
  if (!/^\d{1,5}$/.test(value)) return 'invalid';
  const limit = Number(value);
  return limit >= 1 && limit <= MAX_DAILY_SEARCHES ? limit : 'invalid';
}

function monthLine(doc: ImageSearchDoc): string {
  if (doc.pausedUntil) return `Paused until ${new Date(doc.pausedUntil).toLocaleString()} — this month's searches are used up. The app says so to everybody.`;
  if (doc.remainingThisMonth === null) return 'No search since the API last started — the count shows after the next one.';
  return `${doc.remainingThisMonth.toLocaleString()} searches left this month, by the search service's own count.`;
}

/**
 * #521 (user 2026-11-11: "configurable … by default infinite"): how many
 * web searches for a picture one person gets a day. Every search is paid
 * beyond the month's credit, so the operator can cap one person without
 * closing the feature; the same words searched again cost nothing.
 */
export function ImageSearchScreen({
  doc,
  busy,
  onSave,
}: Readonly<{
  /** null while loading; a string says why it could not be read */
  doc: ImageSearchDoc | string | null;
  busy: boolean;
  onSave: (dailyPerUser: number | null) => void;
}>) {
  const [draft, setDraft] = useState<string | null>(null);
  if (doc === null) return <p className="hint">Loading…</p>;
  if (typeof doc === 'string') {
    return (
      <p className="error" data-testid="image-search-unreadable">
        {doc}
      </p>
    );
  }
  const stored = doc.dailyPerUser === null ? '' : String(doc.dailyPerUser);
  const text = draft ?? stored;
  const parsed = parseDailyLimit(text);
  const changed = text.trim() !== stored;

  return (
    <div data-testid="image-search-screen">
      <h1>Picture search</h1>
      <p className="hint">
        Wherever the app takes a picture — a logo, a cover, a profile picture — a person can search the web for one (Brave Search). The key lives in the
        setup wizard; here you set how far one person can go.
      </p>
      {!doc.enabled && (
        <p className="notice" data-testid="image-search-off">
          This environment has no Brave Search key, so the app does not offer the search. Add the key in the setup wizard (the Brave Search tile) and deploy.
          A limit set here applies from then on.
        </p>
      )}
      {doc.enabled && (
        <p className={doc.pausedUntil ? 'error' : 'hint'} data-testid="image-search-month">
          {monthLine(doc)}
        </p>
      )}
      <section className="card" style={{ maxWidth: 520 }}>
        <label htmlFor="image-search-limit">
          <strong>Searches per person per day</strong>
        </label>
        <p className="hint" style={{ marginTop: 4 }}>
          Leave empty for no limit. A person at the limit is told the search is back tomorrow; logos, icons and uploads keep working.
        </p>
        <div className="form-row">
          <input
            id="image-search-limit"
            data-testid="image-search-limit"
            inputMode="numeric"
            placeholder="no limit"
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            style={{ width: 140 }}
          />
          <button
            className="btn"
            data-testid="image-search-save"
            disabled={busy || !changed || parsed === 'invalid'}
            onClick={() => {
              if (parsed === 'invalid') return;
              onSave(parsed);
              setDraft(null);
            }}
          >
            Save
          </button>
        </div>
        {parsed === 'invalid' && (
          <p className="error" data-testid="image-search-invalid">
            A whole number from 1 to {MAX_DAILY_SEARCHES.toLocaleString()}, or empty for no limit.
          </p>
        )}
        <p className="hint" data-testid="image-search-current">
          Now: {doc.dailyPerUser === null ? 'no limit' : `${doc.dailyPerUser} a day`}.
        </p>
      </section>
    </div>
  );
}
