import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { Tour } from './tours';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

/**
 * ACT step (guided walkthrough): no backdrop — the user drives the real
 * form; a floating card watches for a NEW element with the prefix
 * (baseline counted on entry) and advances itself when it appears.
 */
function ActStepCard({
  tour,
  step,
  onDone,
  onEnd,
}: Readonly<{ tour: Tour; step: number; onDone: () => void; onEnd: () => void }>) {
  const { t } = useLang();
  const current = tour.steps[step];
  const [met, setMet] = useState(false);

  useEffect(() => {
    setMet(false);
    const prefix = current.act!.appearPrefix;
    const count = () => document.querySelectorAll(`[data-testid^="${prefix}"]`).length;
    const baseline = count();
    const poll = setInterval(() => {
      if (count() > baseline) {
        setMet(true);
        clearInterval(poll);
      }
    }, 400);
    return () => clearInterval(poll);
  }, [current, step]);

  useEffect(() => {
    if (!met) return;
    const timer = setTimeout(onDone, 900); // let the tick land before moving on
    return () => clearTimeout(timer);
  }, [met, onDone]);

  return createPortal(
    <div
      data-testid="walkthrough-act-card"
      className="fixed inset-x-4 bottom-20 z-[120] rounded-card border border-line bg-surface p-4 shadow-xl"
    >
      <div className="flex items-start gap-3">
        <span className="text-[26px] leading-none" aria-hidden>
          {current.illustration}
        </span>
        <span className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">{t(current.titleKey)}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{t(current.bodyKey)}</p>
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className={`flex flex-1 items-center gap-1.5 text-[12px] ${met ? 'text-accent-deep' : 'text-ink-4'}`} data-testid="walkthrough-act-state">
          <Icon name={met ? 'check-circle' : 'circle-outline'} size={15} />
          {t(met ? 'tour.welcome.stepDone' : 'tour.welcome.stepWaiting')}
        </span>
        <button data-testid="spotlight-end" onClick={onEnd} className="m-tap border-none bg-transparent text-[12px] text-ink-4">
          {t('help.end')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const FIND_TRIES = 12; // ~1.5s for screen transitions to land the anchor
const PAD = 6;

/**
 * Layer 3: the "try it yourself" walkthrough — dims the screen, cuts a
 * hole around the real element and explains it. Steps whose anchor is
 * missing (empty states) show their sample illustration instead of
 * being skipped (ruling: no empty-state tours).
 */
export function SpotlightOverlay({
  tour,
  step,
  onStep,
  onEnd,
  onComplete,
}: Readonly<{
  tour: Tour;
  step: number;
  onStep: (step: number) => void;
  onEnd: () => void;
  /** fired when the LAST step advances (walkthrough persistence) */
  onComplete?: () => void;
}>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { spaceId } = useData();
  const current = tour.steps[step];
  const [phase, setPhase] = useState<'looking' | 'found' | 'missing'>('looking');
  const [rect, setRect] = useState<Rect | null>(null);

  // guided walkthrough: some steps live on another screen — go there
  useEffect(() => {
    if (current.screen) void navigate({ to: current.screen.replace('$spaceId', spaceId) });
    // deliberately NOT on spaceId: a mid-tour space switch must not teleport
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.screen, step, navigate]);

  useEffect(() => {
    if (!current.anchor) {
      setPhase('missing');
      setRect(null);
      return;
    }
    setPhase('looking');
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const el = document.querySelector(`[data-testid="${current.anchor}"]`);
      if (el) {
        el.scrollIntoView?.({ block: 'center' });
        const r = el.getBoundingClientRect();
        setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
        setPhase('found');
        return;
      }
      tries += 1;
      if (tries >= FIND_TRIES) setPhase('missing');
      else timer = setTimeout(look, 125);
    };
    look();
    return () => clearTimeout(timer);
  }, [current.anchor, step]);

  const advance = () => {
    if (step + 1 >= tour.steps.length) {
      onComplete?.();
      onEnd();
    } else {
      onStep(step + 1);
    }
  };

  // act steps render their own non-blocking card (branch sits AFTER
  // every hook, so the hook order stays stable across step kinds)
  if (current.act) {
    return <ActStepCard tour={tour} step={step} onDone={advance} onEnd={onEnd} />;
  }

  const tapForward = () => {
    if (current.advanceOn !== 'tap' || !current.anchor) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="${current.anchor}"]`);
    el?.click();
    advance();
  };

  const spotlight = phase === 'found' && rect !== null;
  const tooltipBelow = !rect || rect.top + rect.height < (globalThis.innerHeight || 800) / 2;

  return createPortal(
    <div className="fixed inset-0 z-[120]" data-testid="spotlight-overlay">
      {/* backdrop with a cutout (four panes when anchored, full when not) */}
      {spotlight ? (
        <>
          <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: Math.max(0, rect.top) }} />
          <div className="absolute inset-x-0 bottom-0 bg-black/55" style={{ top: rect.top + rect.height }} />
          <div className="absolute left-0 bg-black/55" style={{ top: rect.top, height: rect.height, width: Math.max(0, rect.left) }} />
          <div className="absolute right-0 bg-black/55" style={{ top: rect.top, height: rect.height, left: rect.left + rect.width }} />
          <button
            aria-label={t(current.titleKey)}
            data-testid="spotlight-target"
            onClick={tapForward}
            className="absolute rounded-xl border-2 border-accent bg-transparent"
            style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, cursor: current.advanceOn === 'tap' ? 'pointer' : 'default' }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}

      {/* the step card */}
      <div
        data-testid="spotlight-card"
        className="absolute inset-x-4 rounded-card border border-line bg-surface p-4 shadow-xl"
        style={tooltipBelow ? { top: spotlight ? rect.top + rect.height + 12 : '30%' } : { bottom: (globalThis.innerHeight || 800) - (rect?.top ?? 0) + 12 }}
      >
        {phase === 'missing' && (
          <div className="pb-1 text-center text-[34px] leading-none" aria-hidden>
            {current.illustration}
          </div>
        )}
        <p className="text-[14px] font-semibold text-ink" data-testid="spotlight-title">
          {t(current.titleKey)}
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{t(current.bodyKey)}</p>
        {phase === 'missing' && current.anchor && (
          <p className="mt-1 text-[11px] text-ink-4" data-testid="spotlight-sample-note">
            {t('help.sample')}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex flex-1 gap-1.5" data-testid="spotlight-dots">
            {tour.steps.map((s, i) => (
              <span key={s.titleKey} className={`h-1.5 w-1.5 rounded-full ${i === step ? 'bg-accent' : 'bg-bg-2'}`} />
            ))}
          </div>
          <button data-testid="spotlight-end" onClick={onEnd} className="m-tap border-none bg-transparent text-[12px] text-ink-4">
            {t('help.end')}
          </button>
          {!(spotlight && current.advanceOn === 'tap') && (
            <Button size="sm" data-testid="spotlight-next" onClick={advance}>
              {t(step + 1 >= tour.steps.length ? 'help.done' : 'help.next')}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
