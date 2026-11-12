import { useState } from 'react';
import { parseDailyLimit } from './ImageSearchScreen';

/** GET /admin/receipt-reading: whether this environment reads receipt photos, with which model, and how far reads may go */
export interface ReceiptReadingDoc {
  enabled: boolean;
  provider: string | null;
  /** the model a read runs on when none is chosen */
  defaultModel: string | null;
  /** the operator's choice; null = the default */
  model: string | null;
  /** receipts one person may have read a day; null = no limit */
  dailyPerUser: number | null;
  /** receipts the whole environment may have read a month; null = no cap */
  monthlyCap: number | null;
  readThisMonth: number;
}

export interface ReceiptReadingSettings {
  dailyPerUser: number | null;
  monthlyCap: number | null;
  model: string | null;
}

/** the models offered by name; what each costs is the operator's call, so both ends of the range are named */
const MODELS: { id: string; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — reads best, roughly 3 cents a receipt' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — in between, roughly 1.5 cents a receipt' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest, roughly a tenth of a cent a receipt' },
];

const limitText = (limit: number | null): string => (limit === null ? '' : String(limit));

/**
 * #567: the receipt reader's settings. The key lives in the setup wizard;
 * here the operator chooses the model — every read is paid for — and how
 * many receipts one person and the whole environment may have read.
 */
export function ReceiptReadingScreen({
  doc,
  busy,
  onSave,
}: Readonly<{
  /** null while loading; a string says why it could not be read */
  doc: ReceiptReadingDoc | string | null;
  busy: boolean;
  onSave: (settings: ReceiptReadingSettings) => void;
}>) {
  const [draft, setDraft] = useState<{ daily?: string; cap?: string; model?: string }>({});
  if (doc === null) return <p className="hint">Loading…</p>;
  if (typeof doc === 'string') {
    return (
      <p className="error" data-testid="receipt-reading-unreadable">
        {doc}
      </p>
    );
  }
  const daily = draft.daily ?? limitText(doc.dailyPerUser);
  const cap = draft.cap ?? limitText(doc.monthlyCap);
  const model = draft.model ?? doc.model ?? '';
  const parsedDaily = parseDailyLimit(daily);
  const parsedCap = parseDailyLimit(cap, 1_000_000);
  const invalid = parsedDaily === 'invalid' || parsedCap === 'invalid';
  const changed = daily.trim() !== limitText(doc.dailyPerUser) || cap.trim() !== limitText(doc.monthlyCap) || model !== (doc.model ?? '');
  // a model chosen before this list knew it stays selectable
  const known = MODELS.some((m) => m.id === model);

  return (
    <div data-testid="receipt-reading-screen">
      <h1>Receipt reading</h1>
      <p className="hint">
        A vision model reads receipt photos into lines the app can categorise. The key lives in the setup wizard (the Claude API tile); here you choose the
        model and how many receipts may be read.
      </p>
      {!doc.enabled && (
        <p className="notice" data-testid="receipt-reading-off">
          This environment has no key for the receipt reader, so the app does not offer it. Add the key in the setup wizard and deploy. What you set here
          applies from then on.
        </p>
      )}
      {doc.enabled && (
        <p className="hint" data-testid="receipt-reading-month">
          {doc.readThisMonth.toLocaleString()} receipts read this month
          {doc.monthlyCap === null ? '' : ` of ${doc.monthlyCap.toLocaleString()}`} · provider: {doc.provider ?? 'unknown'}.
        </p>
      )}
      <section className="card" style={{ maxWidth: 560 }}>
        <label htmlFor="receipt-reading-model">
          <strong>Model</strong>
        </label>
        <p className="hint" style={{ marginTop: 4 }}>
          Every read is paid for through the API key. The figures are estimates for one photo.
        </p>
        <select id="receipt-reading-model" data-testid="receipt-reading-model" value={model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
          <option value="">Default ({doc.defaultModel ?? 'the provider’s own'})</option>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {model !== '' && !known && <option value={model}>{model}</option>}
        </select>

        <label htmlFor="receipt-reading-daily" style={{ display: 'block', marginTop: 16 }}>
          <strong>Receipts per person per day</strong>
        </label>
        <input
          id="receipt-reading-daily"
          data-testid="receipt-reading-daily"
          inputMode="numeric"
          placeholder="no limit"
          value={daily}
          onChange={(e) => setDraft({ ...draft, daily: e.target.value })}
          style={{ width: 140 }}
        />

        <label htmlFor="receipt-reading-cap" style={{ display: 'block', marginTop: 16 }}>
          <strong>Receipts per month, everybody together</strong>
        </label>
        <input
          id="receipt-reading-cap"
          data-testid="receipt-reading-cap"
          inputMode="numeric"
          placeholder="no cap"
          value={cap}
          onChange={(e) => setDraft({ ...draft, cap: e.target.value })}
          style={{ width: 140 }}
        />
        <p className="hint" style={{ marginTop: 8 }}>
          Leave a field empty for no limit. At a limit the app says when reading is back; typing the lines by hand keeps working.
        </p>
        {invalid && (
          <p className="error" data-testid="receipt-reading-invalid">
            Whole numbers from 1 up, or empty for no limit.
          </p>
        )}
        <button
          className="btn"
          data-testid="receipt-reading-save"
          disabled={busy || !changed || invalid}
          onClick={() => {
            if (parsedDaily === 'invalid' || parsedCap === 'invalid') return;
            onSave({ dailyPerUser: parsedDaily, monthlyCap: parsedCap, model: model === '' ? null : model });
            setDraft({});
          }}
        >
          Save
        </button>
      </section>
    </div>
  );
}
