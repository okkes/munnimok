import { useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate } from '../../app/router';
import { when } from '../../lib/format';
import type { OperatorJob } from '../../types';
import { stateChip, triggerWord, whoLine } from './jobFacts';

/** the picture a retained report holds, fetched with the lab's credentials and shown in place */
function useScreenshot(call: ScreenProps['call'], jobId: string, wanted: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || typeof URL.createObjectURL !== 'function') return undefined;
    let revoke: string | null = null;
    void (async () => {
      const res = await call(`/lab/jobs/${encodeURIComponent(jobId)}/artifacts/screenshot`).catch(() => null);
      if (!res?.ok) return;
      revoke = URL.createObjectURL(await res.blob());
      setUrl(revoke);
    })();
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [call, jobId, wanted]);
  return url;
}

/** one run in full: the facts, how it ended, what the adapter said, what it asked for, and what it left behind */
export function JobScreen({ id, call }: Readonly<{ id: string } & ScreenProps>) {
  const [job, setJob] = useState<OperatorJob | null | 'unreachable' | 'loading'>('loading');
  const retained = job !== 'loading' && job !== null && job !== 'unreachable' && job.artifacts === 'retained' && job.hasScreenshot;
  const screenshot = useScreenshot(call, id, retained);

  useEffect(() => {
    void (async () => setJob(await getJson<OperatorJob>(call, `/lab/jobs/${encodeURIComponent(id)}`)))();
  }, [call, id]);

  if (job === 'loading') return <p className="hint">loading…</p>;
  const entriesText = job && job !== 'unreachable' && job.trace ? `${job.trace.entries}${job.trace.truncated ? ` (${job.trace.dropped} dropped — the book ran out of room)` : ''}` : '';
  if (job === null || job === 'unreachable') {
    return (
      <>
        <p>
          <a href={hrefOf('jobs')}>← Jobs</a>
        </p>
        <section className="card" data-testid="job-missing">
          <p className="hint">{job === null ? `No run named ${id} on this control plane.` : 'The control plane did not answer.'}</p>
        </section>
      </>
    );
  }

  return (
    <>
      <p>
        <a href={hrefOf('jobs')}>← Jobs</a>
      </p>
      <div className="head-row">
        <h1 data-testid="job-title">
          {job.kind}
          {job.resource ? ` · ${job.resource}` : ''}
        </h1>
        <span className={`chip ${stateChip(job.state)}`} data-testid="job-state">
          {job.state}
        </span>
        <span className="sub mono">{job.jobId}</span>
        <span className="spacer" />
      </div>

      <section className="card" data-testid="job-facts">
        <h2>The run</h2>
        <div className="facts">
          <Fact label="Party" value={<a href={hrefOf(`providers/${encodeURIComponent(job.providerId)}`)}>{job.providerId}</a>} />
          <Fact label="Asked by" value={triggerWord(job.trigger)} />
          <Fact label="Who" value={<span className="mono">{whoLine(job)}</span>} />
          <Fact label="Session" value={<span className="mono">{job.sessionId}</span>} />
          <Fact label="Agent" value={job.agentId ?? '—'} />
          <Fact label="Profile" value={job.profileId ?? '—'} />
          <Fact label="Fleet only" value={job.fleetOnly ? 'yes' : 'no'} />
          <Fact label="Attempts" value={String(job.attempts)} />
          <Fact label="Credential submitted" value={job.credentialSubmitted ? 'yes' : 'no'} />
          <Fact label="Found" value={job.progress?.found != null ? String(job.progress.found) : '—'} />
          <Fact label="Complete" value={job.complete ? 'yes' : 'no — the party holds more'} />
          <Fact label="Step" value={`${job.progress?.step ?? '—'} · done: ${(job.progress?.stepsDone ?? []).join(', ') || '—'}`} />
          <Fact label="Created" value={when(job.createdAt)} />
          <Fact label="Updated" value={when(job.updatedAt)} />
        </div>
      </section>

      {job.error && (
        <section className="card" data-testid="job-error">
          <h2>How it ended</h2>
          <div className="facts">
            <Fact label="Code" value={<span className="mono">{job.error.code}</span>} />
            <Fact label="The person is told to" value={job.error.userAction} />
            <Fact label="Retriable" value={job.error.retriable ? 'yes' : 'no'} />
          </div>
          {job.errorDetail && <pre className="code">{job.errorDetail}</pre>}
        </section>
      )}

      <section className="card" data-testid="job-notes">
        <h2>What the adapter said</h2>
        {job.notes.length === 0 ? <p className="hint">Nothing.</p> : <pre className="code">{job.notes.join('\n')}</pre>}
      </section>

      <section className="card" data-testid="job-request">
        <h2>What it asked for</h2>
        <pre className="code">{JSON.stringify({ params: job.params ?? null, config: job.config ?? {} }, null, 2)}</pre>
      </section>

      {job.trace && (
        <section className="card" data-testid="job-trace">
          <div className="card-head">
            <h2>The recording</h2>
            <button className="btn" data-testid="job-trace-open" onClick={() => navigate(`jobs/${encodeURIComponent(job.jobId)}/trace`)}>
              open the recording
            </button>
          </div>
          <div className="facts">
            <Fact label="Entries" value={entriesText} />
            <Fact label="Size" value={`${(job.trace.bytes / 1024).toFixed(1)} KB packed`} />
            <Fact label="Ran" value={`${when(job.trace.startedAt)} → ${when(job.trace.endedAt)}`} />
            <Fact label="Kept until" value={when(job.trace.expiresAt)} />
          </div>
        </section>
      )}

      <section className="card" data-testid="job-artifacts">
        <h2>What it left behind</h2>
        {job.artifacts === 'none' && <p className="hint">Nothing — no browser ran, or the run did not fail.</p>}
        {job.artifacts === 'pending' && (
          <p className="hint" data-testid="job-artifacts-pending">
            A picture of the page waits on the person&apos;s answer (the app asks &quot;report this failure?&quot;). Until they say yes nobody can
            see it; unanswered, it deletes itself {job.artifactsExpireAt ? `by ${when(job.artifactsExpireAt)}` : 'after two days'}.
          </p>
        )}
        {job.artifacts === 'retained' && (
          <>
            <div className="facts">
              <Fact label="Page shape" value={<span className="mono">{job.domDigest ?? '—'}</span>} />
              <Fact label="Kept until" value={when(job.artifactsExpireAt)} />
            </div>
            {!job.hasScreenshot && <p className="hint">No picture — the digest alone, or the picture outgrew the cap.</p>}
            {job.hasScreenshot && screenshot && <img data-testid="job-screenshot" src={screenshot} alt="the page where the run stopped" style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid var(--line)' }} />}
            {job.hasScreenshot && !screenshot && (
              <p className="hint" data-testid="job-screenshot-loading">
                A picture is on file; it is being fetched.
              </p>
            )}
          </>
        )}
      </section>
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
