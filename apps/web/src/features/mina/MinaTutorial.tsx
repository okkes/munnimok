import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useQuery } from '@/db/useQuery';
import { v7 as uuidv7 } from 'uuid';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { closeAllSheets } from '@/ui/Sheet';
import { MINA_ART, MINA_EXPR } from './assets';
import { MINA_DONE_KEY, MINA_STATE_KEY, MINA_STEPS, setMinaSuggestions } from './steps';
import type { MinaLedgerEntry, MinaRunState } from './steps';
import { revertMinaRun } from './revert';

const PAD = 6;

/** rectangles that dim everything EXCEPT the anchor hole — four real
 *  elements (not a box-shadow trick) so every outside tap is physically
 *  swallowed: the "forcefully click" rule of the tutorial */
function GateShade({ rect, blockHole }: Readonly<{ rect: DOMRect | null; blockHole: boolean }>) {
  const r = rect ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0);
  const top = Math.max(0, r.top - PAD);
  const left = Math.max(0, r.left - PAD);
  const right = Math.min(window.innerWidth, r.right + PAD);
  const bottom = Math.min(window.innerHeight, r.bottom + PAD);
  const shade = 'fixed bg-black/55 z-[130]';
  return (
    <>
      <div className={shade} style={{ top: 0, left: 0, right: 0, height: top }} />
      <div className={shade} style={{ top: bottom, left: 0, right: 0, bottom: 0 }} />
      <div className={shade} style={{ top, left: 0, width: left, height: bottom - top }} />
      <div className={shade} style={{ top, left: right, right: 0, height: bottom - top }} />
      {rect && (
        <div
          className="pointer-events-none fixed z-[130] rounded-xl border-2 border-accent"
          style={{ top, left, width: right - left, height: bottom - top }}
          data-testid="mina-gate-ring"
        />
      )}
      {/* info steps: the anchor is shown but must not be pressed */}
      {rect && blockHole && <div className="fixed z-[130]" style={{ top, left, width: right - left, height: bottom - top }} />}
    </>
  );
}

/** where the bubble goes: the OPPOSITE half of the anchor (approval
 *  remark 1 — the old walkthrough covered the very button it pointed at) */
const bubblePlacement = (rect: DOMRect | null): 'top' | 'bottom' =>
  rect && rect.top + rect.height / 2 > window.innerHeight / 2 ? 'top' : 'bottom';

export function MinaTutorial() {
  const { t, lang } = useLang();
  const { store, repo, spaceId, setActiveSpace } = useData();
  const identity = useSession((s) => s.identity);
  const navigate = useNavigate();
  const [run, setRun] = useState<MinaRunState | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipRevert, setSkipRevert] = useState(true);
  // per-act baseline: ids that existed when the act step became current
  const baselineRef = useRef<{ step: number; ids: Set<string> } | null>(null);

  // load persisted state (resume after kill); demo identities never run
  useEffect(() => {
    if (!identity || identity.kind === 'demo') return;
    let cancelled = false;
    void (async () => {
      const state = (await store.metaGet(MINA_STATE_KEY))?.value as MinaRunState | undefined;
      if (!cancelled && state?.active) setRun(state);
    })().catch(() => undefined);
    const onStart = () => {
      const fresh: MinaRunState = { active: true, step: 0, ledger: [] };
      void store.metaPut(MINA_STATE_KEY, fresh);
      setRun(fresh);
    };
    window.addEventListener('mina:start', onStart);
    return () => {
      cancelled = true;
      window.removeEventListener('mina:start', onStart);
    };
  }, [store, identity]);

  const step = run?.active ? MINA_STEPS[run.step] : undefined;

  const persist = useCallback(
    (next: MinaRunState | null) => {
      setRun(next);
      if (next) void store.metaPut(MINA_STATE_KEY, next);
      else void store.metaPut(MINA_STATE_KEY, { active: false, step: 0, ledger: [] });
    },
    [store],
  );

  const finish = useCallback(
    async (revert: boolean) => {
      setMinaSuggestions({});
      closeAllSheets();
      if (revert && run) await revertMinaRun(store, repo, run.ledger);
      // the ≥1-space rule re-asserts itself: never exit space-less
      const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
      if (spaces.length === 0) {
        const id = uuidv7();
        await repo.upsert('space', id, id, {
          name: t('mina.suggest.private'),
          kind: 'personal',
          currency: 'EUR',
          periodType: 'month',
          periodDay: 1,
          historyStartDate: isoMonthsAgo(DEFAULT_HISTORY_MONTHS),
        });
        await setActiveSpace(id);
      } else if (!spaces.some((s) => s.id === spaceId)) {
        await setActiveSpace(spaces[0].id);
      }
      await store.metaPut(MINA_DONE_KEY, true);
      persist(null);
      setSkipOpen(false);
      void navigate({ to: '/home' });
    },
    [run, store, repo, spaceId, setActiveSpace, persist, navigate, t],
  );

  // ledger tokens: $s1/$s2 = first/second space created this run
  const createdSpaces = useMemo(() => (run?.ledger ?? []).filter((e) => e.entity === 'space').map((e) => e.id), [run?.ledger]);
  const resolveAnchor = useCallback(
    (candidates: readonly string[] | undefined): HTMLElement | null => {
      for (const raw of candidates ?? []) {
        const id = raw.replace('$s1', createdSpaces[0] ?? '').replace('$s2', createdSpaces[1] ?? '');
        for (const el of document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)) {
          if (el.offsetParent !== null) return el; // the VISIBLE candidate (mobile vs desktop nav)
        }
      }
      return null;
    },
    [createdSpaces],
  );

  const advance = useCallback(() => {
    if (!run) return;
    setMinaSuggestions({});
    if (run.step + 1 >= MINA_STEPS.length) {
      void finish(false);
      return;
    }
    const nextStep = MINA_STEPS[run.step + 1];
    // steps that play OUTSIDE any sheet close leftovers (the no-account
    // form, the switcher…) — UI control, not a data write
    if (nextStep.kind === 'fullscreen' || nextStep.anchor?.some((a) => a.startsWith('tab-') || a.startsWith('side-tab-'))) closeAllSheets();
    persist({ ...run, step: run.step + 1 });
  }, [run, persist, finish]);

  // navigate to the step's screen (never mid-act — acts follow the user)
  const screen = step?.screen;
  useEffect(() => {
    if (screen) void navigate({ to: screen });
  }, [screen, navigate]);

  // publish form suggestions for the live step
  useEffect(() => {
    if (!step?.suggestKey) return;
    const value = t(step.suggestKey);
    if (step.act?.entity === 'space') setMinaSuggestions({ spaceName: value });
    else if (step.act?.entity === 'account') setMinaSuggestions({ accountName: value });
    else if (step.act?.entity === 'transaction') setMinaSuggestions({ txMerchant: value, txAmount: '12,34' });
    return () => setMinaSuggestions({});
  }, [step, t, lang]);

  // anchor tracking: rAF-driven re-measure (scroll/resize/sheet motion)
  const anchorKey = step?.anchor?.join(',') ?? '';
  useEffect(() => {
    if (!run?.active) return;
    let raf = 0;
    const tick = () => {
      const el = resolveAnchor(step?.anchor);
      const next = el?.getBoundingClientRect() ?? null;
      setRect((prev) => {
        if (!prev && !next) return prev;
        if (prev && next && Math.abs(prev.top - next.top) < 1 && Math.abs(prev.left - next.left) < 1 && Math.abs(prev.width - next.width) < 1) return prev;
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.active, run?.step, anchorKey, resolveAnchor]);

  // gate advance: the tap lands on the REAL element; we advance alongside
  useEffect(() => {
    if (!step?.gate) return;
    const onTap = (event: Event) => {
      const el = resolveAnchor(step.anchor);
      if (el && event.target instanceof Node && el.contains(event.target)) setTimeout(advance, 50);
    };
    document.addEventListener('click', onTap, { capture: true });
    return () => document.removeEventListener('click', onTap, { capture: true });
  }, [step, resolveAnchor, advance]);

  // act detection on the STORE (approval remark 2): live emissions, row
  // EXISTENCE diff — any name, any amount satisfies the step
  const actEntity = step?.act?.entity;
  const actRows = useQuery(
    store,
    async () => (actEntity ? (await store.allRows(actEntity)).filter((r) => r.deleted === 0) : []),
    [actEntity, run?.step],
  );
  useEffect(() => {
    if (!run || !step?.act || !actRows) return;
    const live = new Set(actRows.map((r) => r.id));
    if (baselineRef.current?.step !== run.step) {
      // absent-acts watch a ledgered row disappear — no baseline needed
      if (!step.act.absent) {
        baselineRef.current = { step: run.step, ids: live };
        return;
      }
    }
    if (step.act.absent) {
      const family = createdSpaces[1];
      if (family && !live.has(family)) {
        persist({ ...run, step: run.step, ledger: run.ledger.filter((e) => e.id !== family && e.spaceId !== family) });
        setTimeout(advance, 400);
        baselineRef.current = null;
      }
      return;
    }
    const fresh = actRows.filter(
      (r) => !baselineRef.current!.ids.has(r.id) &&
        // bank-fed rows are NEVER ledgered (a sync mid-replay must not
        // get swept into a revert)
        !(r as { importRef?: string }).importRef && !(r as { feedSpaceId?: string }).feedSpaceId,
    );
    if (fresh.length === 0) return;
    const entries: MinaLedgerEntry[] = fresh.map((r) => ({ entity: step.act!.entity, spaceId: (r as { spaceId: string }).spaceId, id: r.id }));
    const nextRun: MinaRunState = { ...run, ledger: [...run.ledger, ...entries] };
    // the FIRST space of the run becomes the active one immediately
    if (step.act.entity === 'space' && createdSpaces.length === 0) void setActiveSpace(entries[0].id);
    persist(nextRun);
    baselineRef.current = null;
    setTimeout(advance, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actRows, run?.step]);

  if (!run?.active || !step) return null;

  const bubbleSide = bubblePlacement(rect);
  const showShade = !!step.anchor || step.gate || step.info;

  return createPortal(
    <div data-testid="mina-tutorial" data-step={step.id}>
      {step.kind === 'fullscreen' && (
        <div className="fixed inset-0 z-[130] flex flex-col items-center overflow-y-auto bg-bg" data-testid="mina-fullscreen">
          <div className="flex w-full max-w-[420px] flex-1 flex-col items-center px-6 pb-8 lg:max-w-[860px] lg:flex-row lg:items-center lg:gap-10">
            <img src={MINA_ART[step.art!]} alt="Mina" className="mt-6 max-h-[46dvh] w-auto max-w-full rounded-2xl object-contain lg:mt-0 lg:max-h-[70dvh] lg:flex-1" />
            <div className="flex w-full flex-col items-center text-center lg:items-start lg:text-left">
              <h1 className="m-h2 mt-5 text-ink">{t(step.titleKey)}</h1>
              <p className="mt-2 max-w-[360px] text-[14px] leading-relaxed text-ink-2">{t(step.bodyKey)}</p>
              {step.id === 'sharing' && identity?.kind === 'offline' && (
                <p className="mt-2 max-w-[360px] text-[12px] text-ink-4">{t('mina.sharing.offlineNote')}</p>
              )}
              {step.id === 'wrap' ? (
                <div className="mt-6 flex w-full max-w-[360px] flex-col gap-2">
                  <Button data-testid="mina-wrap-keep" onClick={() => void finish(false)}>{t('mina.wrap.keep')}</Button>
                  {run.ledger.length > 0 && (
                    <Button variant="outline" data-testid="mina-wrap-revert" onClick={() => void finish(true)}>
                      {t('mina.wrap.revert')}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="mt-6 flex w-full max-w-[360px] flex-col gap-2">
                  <Button data-testid="mina-next" onClick={advance}>
                    {step.id === 'welcome' ? t('mina.start') : t('mina.continue')}
                  </Button>
                  <button data-testid="mina-skip" onClick={() => setSkipOpen(true)} className="m-tap border-none bg-transparent py-2 text-[13px] text-ink-4">
                    {t('mina.skip')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {step.kind === 'bubble' && (
        <>
          {showShade && <GateShade rect={rect} blockHole={!!step.info} />}
          <div
            data-testid="mina-bubble"
            className={`fixed inset-x-4 z-[140] mx-auto max-w-[480px] rounded-card border border-line bg-surface p-4 shadow-2xl ${
              bubbleSide === 'top' ? 'top-[max(16px,env(safe-area-inset-top))]' : 'bottom-24'
            }`}
          >
            <div className="flex items-start gap-3">
              {/* Mina talks from the LEFT (user request) */}
              <img src={MINA_EXPR[step.expr ?? 'smile']} alt="Mina" className="h-12 w-12 shrink-0 rounded-full border border-line object-cover" />
              <span className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-ink">{t(step.titleKey)}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{t(step.bodyKey)}</p>
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <button data-testid="mina-skip" onClick={() => setSkipOpen(true)} className="m-tap border-none bg-transparent text-[12px] text-ink-4">
                {t('mina.skip')}
              </button>
              {!step.gate && !step.act && (
                <Button data-testid="mina-next" className="px-5 py-1.5 text-[13px]" onClick={advance}>
                  {t('mina.continue')}
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      {/* skip confirm — Mina is SHOCKED (user spec); with a non-empty
          ledger the revert question rides along */}
      {skipOpen && (
        <div className="fixed inset-0 z-[150] flex items-end justify-center bg-black/50 lg:items-center" data-testid="mina-skip-sheet">
          <div className="w-full max-w-[480px] rounded-t-[20px] bg-bg p-5 lg:rounded-[20px]">
            <div className="flex items-start gap-3">
              <img src={MINA_EXPR.surprised} alt="Mina" className="h-14 w-14 shrink-0 rounded-full border border-line object-cover" />
              <span className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold text-ink">{t('mina.skipConfirm.t')}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{t('mina.skipConfirm.b')}</p>
              </span>
            </div>
            {run.ledger.length > 0 && (
              <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" data-testid="mina-skip-revert" checked={skipRevert} onChange={(e) => setSkipRevert(e.target.checked)} />
                {t('mina.skipConfirm.revert')}
              </label>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <Button data-testid="mina-skip-confirm" onClick={() => void finish(run.ledger.length > 0 && skipRevert)}>
                {t('mina.skipConfirm.yes')}
              </Button>
              <Button variant="outline" data-testid="mina-skip-cancel" onClick={() => setSkipOpen(false)}>
                {t('mina.skipConfirm.stay')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
