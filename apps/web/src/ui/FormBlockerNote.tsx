import { useEffect, useRef } from 'react';

// #195: primary buttons stay enabled; an invalid click shows this note under the offending field
// and scrolls it into view
export function FormBlockerNote({
  show,
  text,
  testId,
  className = '',
}: {
  readonly show: boolean;
  readonly text: string;
  readonly testId: string;
  readonly className?: string;
}) {
  const el = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (show && text) el.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [show, text]);
  if (!show || !text) return null;
  return (
    <p ref={el} className={`text-[12px] text-negative ${className}`.trim()} data-testid={testId}>
      {text}
    </p>
  );
}

export const blockerRing = (bad: boolean): string => (bad ? ' ring-1 ring-negative' : '');
