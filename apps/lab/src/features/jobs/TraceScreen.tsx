import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate } from '../../app/router';
import { when } from '../../lib/format';
import type { JobTrace, TraceEntry } from '../../types';
import { clock, entryLine, filterEntries, hostOf, isNoise, kb, pathOf, pretty } from './traceFacts';

const KINDS = ['navigation', 'request', 'response', 'console', 'dom', 'note'] as const;

const PRODUCTS = ['shop', 'bank', 'registry'] as const;

/** a provider id as a type name: kebab to Pascal */
export const pascalOf = (id: string): string =>
  id
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

/** the scaffold's query, or null while the names are not usable */
export function scaffoldQuery(provider: string, name: string, product: string, country: string): string | null {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(provider) || !/^[A-Z][A-Za-z0-9]{1,63}$/.test(name) || !/^[A-Z]{2}$/.test(country)) return null;
  return `?provider=${encodeURIComponent(provider)}&name=${encodeURIComponent(name)}&product=${encodeURIComponent(product)}&country=${encodeURIComponent(country)}`;
}

/** hands the browser a file to save, where it can (a blob URL); a no-op in a test runtime */
function download(name: string, text: string | Blob, type: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * A run's recording (#441 L3): the timeline of what the browser and the
 * HTTP client did, filtered by kind and text, with the noise (scripts,
 * pictures, fonts) folded away by default; an entry opens to its headers
 * and its body; the cookie jar at the end; the digest an adapter author
 * reads first, and the raw trace, as downloads. Secrets were taken out
 * before any of it was written down.
 */
export function TraceScreen({ id, call, busy, act }: Readonly<{ id: string } & ScreenProps>) {
  const [trace, setTrace] = useState<JobTrace | null | 'unreachable' | 'loading'>('loading');
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [worthReading, setWorthReading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    void (async () => setTrace(await getJson<JobTrace>(call, `/lab/jobs/${encodeURIComponent(id)}/trace`)))();
  }, [call, id]);

  const entries = useMemo(() => (trace && trace !== 'unreachable' && trace !== 'loading' ? filterEntries(trace.entries, { kind, text, worthReading }) : []), [trace, kind, text, worthReading]);

  if (trace === 'loading') return <p className="hint">loading…</p>;
  if (trace === null || trace === 'unreachable') {
    return (
      <>
        <p>
          <a href={hrefOf(`jobs/${encodeURIComponent(id)}`)}>← Job</a>
        </p>
        <section className="card" data-testid="trace-missing">
          <p className="hint">{trace === null ? `No recording for ${id} — it was never asked for, or it expired.` : 'The control plane did not answer.'}</p>
        </section>
      </>
    );
  }

  const noise = trace.entries.filter(isNoise).length;
  const noiseText = noise ? ` (${noise} scripts, pictures and fonts)` : '';
  const entriesText = `${trace.entries.length}${noiseText}`;

  const saveDigest = async () => {
    const res = await call(`/lab/jobs/${encodeURIComponent(id)}/trace/digest.md`).catch(() => null);
    if (!res?.ok) return;
    download(`${id}-digest.md`, await res.text(), 'text/markdown');
  };

  const saveTrace = () => download(`${id}-trace.json`, JSON.stringify(trace, null, 2), 'application/json');

  const remove = async () => {
    if (!globalThis.confirm('Delete this recording? The job stays in the history; the trace and its digest go.')) return;
    const ok = await act(() => call(`/lab/jobs/${encodeURIComponent(id)}/trace`, { method: 'DELETE' }));
    if (ok) navigate(`jobs/${encodeURIComponent(id)}`);
  };

  return (
    <>
      <p>
        <a href={hrefOf(`jobs/${encodeURIComponent(id)}`)}>← Job</a>
      </p>
      <div className="head-row">
        <h1 data-testid="trace-title">Recording · {trace.provider}</h1>
        <span className="sub mono">{trace.jobId}</span>
        <span className="spacer" />
        <button className="btn quiet" data-testid="trace-digest" onClick={() => void saveDigest()}>
          digest.md
        </button>
        <button className="btn quiet" data-testid="trace-json" onClick={saveTrace}>
          trace.json
        </button>
        <button className="btn danger" data-testid="trace-delete" disabled={busy} onClick={() => void remove()}>
          delete
        </button>
      </div>

      <section className="card" data-testid="trace-facts">
        <div className="facts">
          <Fact label="Started" value={when(trace.startedAt)} />
          <Fact label="Ended" value={when(trace.endedAt)} />
          <Fact label="Entries" value={entriesText} />
          <Fact label="Cookies at the end" value={String(trace.cookies.length)} />
          <Fact label="Complete" value={trace.truncated ? `no — ${trace.dropped} dropped when the book ran out of room` : 'yes'} />
        </div>
        <p className="hint">
          Secrets were taken out before anything was written down: a header, field or query value whose name says secret reads «redacted:n», a
          cookie value is a length and a hash, and whatever the run was handed as a credential is masked wherever it appeared.
        </p>
      </section>

      <section className="card">
        <div className="row">
          <select data-testid="trace-filter-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">every kind</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input data-testid="trace-filter-text" value={text} placeholder="address, text, status…" onChange={(e) => setText(e.target.value)} />
          <button type="button" role="switch" aria-checked={worthReading} className={`btn quiet${worthReading ? ' on' : ''}`} data-testid="trace-filter-noise" onClick={() => setWorthReading((v) => !v)}>
            {worthReading ? 'hiding scripts, pictures and fonts' : 'showing everything'}
          </button>
          <span className="sub" data-testid="trace-count">
            {entries.length} of {trace.entries.length}
          </span>
        </div>
        <table data-testid="trace-entries">
          <thead>
            <tr>
              <th>At</th>
              <th>Kind</th>
              <th>What</th>
              <th>Type</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <Row key={e.seq} entry={e} open={open === e.seq} onToggle={() => setOpen((o) => (o === e.seq ? null : e.seq))} />
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <ScaffoldCard jobId={id} provider={trace.provider} call={call} />

      <section className="card" data-testid="trace-cookies">
        <h2>Cookies at the end</h2>
        {trace.cookies.length === 0 ? (
          <p className="hint">None.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Domain</th>
                <th>Path</th>
                <th>Flags</th>
                <th>Expires</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {trace.cookies.map((c) => (
                <tr key={`${c.domain}${c.path}${c.name}`} data-testid={`trace-cookie-${c.name}`}>
                  <td className="mono">{c.name}</td>
                  <td className="mono">{c.domain}</td>
                  <td className="mono">{c.path}</td>
                  <td>{[c.httpOnly ? 'httpOnly' : null, c.secure ? 'secure' : null, c.sameSite ? `sameSite=${c.sameSite}` : null].filter(Boolean).join(' ') || '—'}</td>
                  <td>{c.expires ? when(c.expires) : 'session'}</td>
                  <td className="mono">
                    {c.valueLength} chars · sha256 {c.valueHash}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/**
 * The new-service scaffold (#441 L5): from this recording, the files an adapter
 * author starts from — a manifest stub, the OBSERVED options, an adapter stub
 * with a to-do per call, the JSON answers as redacted fixtures, a test skeleton,
 * a README and the digest — zipped at their repo paths.
 */
function ScaffoldCard({ jobId, provider, call }: Readonly<{ jobId: string; provider: string; call: ScreenProps['call'] }>) {
  const [id, setId] = useState(provider === 'explore' ? '' : provider);
  const [name, setName] = useState(provider === 'explore' ? '' : pascalOf(provider));
  const [product, setProduct] = useState<string>('shop');
  const [country, setCountry] = useState('NL');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const query = scaffoldQuery(id, name, product, country);

  const fetchZip = async () => {
    if (!query) return;
    setBusy(true);
    setError(null);
    const res = await call(`/lab/jobs/${encodeURIComponent(jobId)}/scaffold${query}`).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(res ? `HTTP ${res.status}` : 'network');
      return;
    }
    download(`${id}-scaffold.zip`, await res.blob(), 'application/zip');
  };

  return (
    <section className="card" data-testid="trace-scaffold">
      <h2>Scaffold an adapter</h2>
      <p className="hint">
        From this recording: a manifest stub, the OBSERVED options (every host and path seen, with what was observed), an adapter stub with a
        TODO per call, the JSON answers as redacted fixtures, a test skeleton, a README that says where to register it, and the digest — zipped
        at their repo paths, to unpack at the repository root.
      </p>
      <div className="facts">
        <label className="fact">
          <span className="fact-label">provider id</span>
          <input
            data-testid="scaffold-provider"
            value={id}
            placeholder="kebab-case, e.g. example-shop"
            onChange={(e) => {
              setId(e.target.value.trim().toLowerCase());
              if (!name) setName(pascalOf(e.target.value));
            }}
          />
        </label>
        <label className="fact">
          <span className="fact-label">type name</span>
          <input data-testid="scaffold-name" value={name} placeholder="PascalCase, e.g. ExampleShop" onChange={(e) => setName(e.target.value.trim())} />
        </label>
        <label className="fact">
          <span className="fact-label">product</span>
          <select data-testid="scaffold-product" value={product} onChange={(e) => setProduct(e.target.value)}>
            {PRODUCTS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="fact">
          <span className="fact-label">country</span>
          <input data-testid="scaffold-country" value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
        </label>
      </div>
      {error && (
        <p className="error" data-testid="scaffold-error">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn" data-testid="scaffold-download" disabled={!query || busy} onClick={() => void fetchZip()}>
          {busy ? 'building…' : 'download the scaffold'}
        </button>
      </div>
    </section>
  );
}

function Row({ entry, open, onToggle }: Readonly<{ entry: TraceEntry; open: boolean; onToggle: () => void }>) {
  const what = entry.kind === 'request' || entry.kind === 'response' ? `${entry.method ?? 'GET'} ${hostOf(entry.url)}${pathOf(entry.url)}` : entryLine(entry);
  return (
    <>
      <tr className="clickable" data-testid={`trace-entry-${entry.seq}`} onClick={onToggle}>
        <td className="mono">{clock(entry.atMs)}</td>
        <td>
          <span className={`chip ${entry.kind === 'console' && (entry.level === 'error' || entry.level === 'pageerror') ? 'danger-chip' : ''}`}>{entry.kind}</span>
          {entry.via === 'http' && <span className="cell-sub"> http client</span>}
        </td>
        <td className="mono" style={{ wordBreak: 'break-all' }}>
          {entry.kind === 'response' && <span>{entry.status} · </span>}
          {what.length > 160 ? `${what.slice(0, 160)}…` : what}
        </td>
        <td>{entry.resourceType ?? ''}{entry.contentType ? ` · ${entry.contentType.split(';')[0]}` : ''}</td>
        <td>{kb(entry.size)}</td>
      </tr>
      {open && (
        <tr data-testid={`trace-detail-${entry.seq}`}>
          <td colSpan={5}>
            {entry.url && (
              <p className="mono" style={{ wordBreak: 'break-all' }}>
                {entry.url}
              </p>
            )}
            {entry.headers && entry.headers.length > 0 && (
              <pre className="code">{entry.headers.map((h) => `${h.name}: ${h.value}`).join('\n')}</pre>
            )}
            {entry.body && (
              <pre className="code" data-testid={`trace-body-${entry.seq}`}>
                {pretty(entry.body)}
                {entry.bodyTruncated ? '\n… (cut at the cap)' : ''}
              </pre>
            )}
            {entry.html && (
              <pre className="code">
                {entry.html}
                {entry.htmlTruncated ? '\n… (cut at the cap)' : ''}
              </pre>
            )}
            {entry.kind === 'console' && <pre className="code">{entry.text}</pre>}
          </td>
        </tr>
      )}
    </>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{value}</span>
    </div>
  );
}
