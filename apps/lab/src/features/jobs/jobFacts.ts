import type { OperatorJob } from '../../types';

/** a job's state as a chip: the connector's word, coloured by what it means */
const STATE_CHIP: Record<string, string> = {
  succeeded: 'ok-chip',
  failed: 'danger-chip',
  expired: 'danger-chip',
  awaiting_input: 'warn-chip',
  running: 'warn-chip',
  leased: 'warn-chip',
  queued: '',
};
export const stateChip = (state: string): string => STATE_CHIP[state] ?? '';

/** who asked for the run, as the operator reads it */
const TRIGGER_WORD: Record<string, string> = {
  user: 'a person',
  schedule: 'the schedule',
  lab: 'the lab',
  canary: 'a canary',
};
export const triggerWord = (trigger: string | null | undefined): string => (trigger ? (TRIGGER_WORD[trigger] ?? trigger) : 'nobody in particular');

/** the person behind a run: the relay's name for the subject, the lab for its own runs, else the pseudonym */
export function whoLine(job: Pick<OperatorJob, 'who' | 'subject' | 'trigger'>): string {
  if (job.who) return job.who;
  if (job.trigger === 'lab') return 'the lab';
  if (job.trigger === 'canary') return 'the canary';
  return job.subject;
}

/** what a failed run left behind, in one word */
export function artifactsLine(job: Pick<OperatorJob, 'artifacts' | 'hasScreenshot'>): string {
  if (job.artifacts === 'pending') return 'awaiting the person';
  if (job.artifacts === 'retained') return job.hasScreenshot ? 'picture' : 'digest';
  return '';
}

/** how the run ended, in a few words: the code, the count it gathered, or whether the party holds more */
export function outcomeLine(job: Pick<OperatorJob, 'error' | 'progress' | 'state' | 'complete'>): string {
  if (job.error) return job.error.code;
  if (job.progress?.found != null) return `${job.progress.found} found`;
  if (job.state === 'succeeded') return job.complete ? 'complete' : 'partial';
  return '';
}

/** the query string the jobs route takes, from the filter form's values; empty values are left out */
export function jobsQuery(filters: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim()) params.set(key, value.trim());
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
