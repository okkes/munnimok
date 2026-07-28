import { useState } from 'react';
import { MINA_EXPR } from './assets';
import { Icon } from '@/ui/Icon';

/**
 * Mina outside the tutorial: a small contextual note she can drop on a
 * screen (first use: explaining why a structural cost is better off as
 * a DEBT than a recurring, user design 2026-07-28). Closable — this is
 * advice, not a gate — with a CLOSE button where the tutorial bubble
 * has minimize.
 */
export function MinaNote({
  expr = 'thinking',
  text,
  testId,
}: Readonly<{ expr?: keyof typeof MINA_EXPR; text: string; testId: string }>) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  return (
    <div className="mb-3 flex items-start gap-3 rounded-card border border-line bg-surface p-3 shadow-sm" data-testid={testId}>
      <img src={MINA_EXPR[expr]} alt="Mina" className="h-12 w-auto max-w-[48px] shrink-0 rounded-lg object-contain" />
      <p className="min-w-0 flex-1 pt-0.5 text-[13px] leading-relaxed text-ink-2">{text}</p>
      <button
        aria-label="close"
        data-testid={`${testId}-close`}
        onClick={() => setClosed(true)}
        className="m-tap shrink-0 border-none bg-transparent p-1 text-ink-4"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
