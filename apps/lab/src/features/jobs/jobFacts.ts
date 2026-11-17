import type { OperatorJob } from '../../types';

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

const TRIGGER_WORD: Record<string, string> = {
  user: 'a person',
  schedule: 'the schedule',
  backfill: "the schedule's older-history pass",
  lab: 'the lab',
  canary: 'a canary',
};
export const triggerWord = (trigger: string | null | undefined): string => (trigger ? (TRIGGER_WORD[trigger] ?? trigger) : 'nobody in particular');

export function whoLine(job: Pick<OperatorJob, 'who' | 'subject' | 'trigger'>): string {
  if (job.who) return job.who;
  if (job.trigger === 'lab') return 'the lab';
  if (job.trigger === 'canary') return 'the canary';
  return job.subject;
}

export function artifactsLine(job: Pick<OperatorJob, 'artifacts' | 'hasScreenshot'> & { trace?: unknown }): string {
  const parts: string[] = [];
  if (job.artifacts === 'pending') parts.push('awaiting the person');
  if (job.artifacts === 'retained') parts.push(job.hasScreenshot ? 'picture' : 'digest');
  if (job.trace) parts.push('recording');
  return parts.join(' · ');
}

export function outcomeLine(job: Pick<OperatorJob, 'error' | 'progress' | 'state' | 'complete'>): string {
  if (job.error) return job.error.code;
  if (job.progress?.found != null) return `${job.progress.found} found`;
  if (job.state === 'succeeded') return job.complete ? 'complete' : 'partial';
  return '';
}

export function jobsQuery(filters: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim()) params.set(key, value.trim());
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
