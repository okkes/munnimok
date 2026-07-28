import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useQuery } from '@/db/useQuery';
import { v7 as uuidv7 } from 'uuid';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import { useLang } from '@/i18n';
import { revealInScroller } from '@/lib/viewport';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { closeAllSheets, hasOpenSheet } from '@/ui/Sheet';
import { MINA_ART, MINA_EXPR } from './assets';
import { MINA_DONE_KEY, MINA_STATE_KEY, MINA_STEPS, minaSuggestedAccountName, minaSuggestedSpaceName, minaSuggestedTx, setMinaSuggestions } from './steps';
import type { MinaLedgerEntry, MinaRunState } from './steps';
import { revertMinaRun } from './revert';

const PAD = 6;

/**
 * Barely-there dim + a breathing mint glow on the target (user design
 * ruling: the heavy gray made it hard to place the button in the whole
 * picture). Four real shade rectangles still physically swallow every
 * outside tap, and they TRANSITION between targets — the shade visibly
 * travels toward the next thing to press instead of snapping.
 */
function GateShade({ rect, blockHole }: Readonly<{ rect: DOMRect | null; blockHole: boolean }>) {
  // interactive targets BREATHE; info-only highlights glow softly and
  // steadily — attention without an invitation to press (user ruling)
  const glowClass = blockHole ? 'm-mina-glow-soft' : 'm-mina-glow';
  // no resolved target: EVERYTHING is covered — a collapsed shade left
  // the whole screen tappable and the step felt lost (user ss). The
  // bubble's own Continue/skip still work above the shade.
  if (!rect) return <div className="fixed inset-0 z-[130] bg-black/15" data-testid="mina-gate-cover" />;
  const top = Math.max(0, rect.top - PAD);
  const left = Math.max(0, rect.left - PAD);
  const right = Math.min(window.innerWidth, rect.right + PAD);
  const bottom = Math.min(window.innerHeight, rect.bottom + PAD);
  // tap-swallowing happens on four INVISIBLE rects; the dim itself is a
  // single ROUNDED cutout (giant box-shadow) so the shade edge and the
  // glow share one shape — and it moves INSTANTLY: the glow is the
  // guide now, the travelling shade animation retired (user rulings)
  const blocker = 'fixed z-[130]';
  return (
    <>
      <div className={blocker} style={{ top: 0, left: 0, right: 0, height: top }} />
      <div className={blocker} style={{ top: bottom, left: 0, right: 0, bottom: 0 }} />
      <div className={blocker} style={{ top, left: 0, width: left, height: bottom - top }} />
      <div className={blocker} style={{ top, left: right, right: 0, height: bottom - top }} />
      {/* the dim cutout (separate element: the glow's animation owns its
          own box-shadow and would override an inline one) */}
      <div
        className="pointer-events-none fixed z-[129] rounded-2xl"
        style={{ top, left, width: right - left, height: bottom - top, boxShadow: '0 0 0 200vmax rgba(0,0,0,0.15)' }}
      />
      <div
        className={`${glowClass} pointer-events-none fixed z-[130] rounded-2xl`}
        style={{ top, left, width: right - left, height: bottom - top }}
        data-testid="mina-gate-ring"
      />
      {/* info steps: the anchor is shown but must not be pressed */}
      {blockHole && <div className="fixed z-[130]" style={{ top, left, width: right - left, height: bottom - top }} />}
    </>
  );
}

/** the bubble takes whichever half the target does NOT occupy; with no
 *  target it dodges open sheets (they rise from the bottom — user ss:
 *  the bubble kept sitting exactly on the form it talked about) */
const bubblePlacement = (rect: DOMRect | null, sheetOpen: boolean): 'top' | 'bottom' => {
  if (rect) return rect.top + rect.height / 2 > window.innerHeight / 2 ? 'top' : 'bottom';
  return sheetOpen ? 'top' : 'bottom';
};

/** the target's own wording, so tutorial copy can quote it verbatim and
 *  survive future label changes (user ruling). Only the first LEAF text
 *  counts — reading a whole row glued title+subtitle together (user ss:
 *  “Add a manual accountTyped by hand · …”). */
function elementLabel(el: HTMLElement | null): string {
  if (!el) return '';
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  for (const node of el.querySelectorAll('span, p, div')) {
    // length > 1 skips single-glyph icon spans
    const text = node.childElementCount === 0 ? (node.textContent?.trim() ?? '') : '';
    if (text.length > 1) return text.slice(0, 40);
  }
  return (el.textContent ?? '').trim().slice(0, 40);
}

export function MinaTutorial() {
  const { t, lang } = useLang();
  const { store, repo, spaceId, setActiveSpace } = useData();
  const identity = useSession((s) => s.identity);
  const navigate = useNavigate();
  const [run, setRun] = useState<MinaRunState | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipRevert, setSkipRevert] = useState(true);
  // user ruling: Mina can be tucked away into a glowing corner bubble
  // when she'd sit in the way — tap to bring her back
  const [minimized, setMinimized] = useState(false);
  const [targetLabel, setTargetLabel] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  // per-act baseline: ids that existed when the act step became current
  const baselineRef = useRef<{ step: number; ids: Set<string> } | null>(null);

  // load persisted state (resume after kill); demo identities never run
  useEffect(() => {
    if (!identity || identity.kind === 'demo') return;
    let cancelled = false;
    void (async () => {
      const state = (await store.metaGet(MINA_STATE_KEY))?.value as MinaRunState | undefined;
      if (cancelled || !state?.active) return;
      // killed MID-ONBOARDING: the tutorial stays dormant — resuming
      // dropped its bubble onto the profile form (user ss); finishing
      // onboarding re-dispatches mina:start and the run restarts clean
      if ((await store.metaGet('needsOnboarding'))?.value) return;
      // a killed app resumes at the nearest CHECKPOINT (mid-sheet steps
      // can't reconstruct their transient UI) and asks first instead of
      // dropping a mid-flow bubble onto whatever screen loaded (user ss)
      let rewound = state.step;
      while (rewound > 0 && !MINA_STEPS[rewound]?.checkpoint) rewound--;
      setRun({ ...state, step: rewound });
      if (state.step > 0) setResumePending(true);
    })().catch(() => undefined);
    const onStart = () => {
      const fresh: MinaRunState = { active: true, step: 0, ledger: [] };
      void store.metaPut(MINA_STATE_KEY, fresh);
      setMinimized(false);
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
      // a stale ledger must never leave a $s-anchored step targetless
      // (user ss: no glow, tutorial felt stuck/lost) — fall back to any
      // row of the same FAMILY, and for switch rows never the space that
      // is already active (the lesson is switching AWAY, user ss)
      for (const raw of candidates ?? []) {
        const tokenAt = raw.indexOf('$s');
        if (tokenAt < 0) continue;
        const prefix = raw.slice(0, tokenAt);
        const rows = [...document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)].filter(
          (el) => el.dataset.testid !== 'space-pick-manage' && el.offsetParent !== null,
        );
        const notActive = rows.find((el) => el.dataset.testid !== `${prefix}${spaceId}`);
        const pick = prefix === 'space-pick-' ? (notActive ?? rows[0]) : rows[0];
        if (pick) return pick;
      }
      return null;
    },
    [createdSpaces, spaceId],
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

  // a fresh dialogue always shows itself — leaving Mina minimized after
  // the user completed a step read as the tutorial dying (user request)
  useEffect(() => {
    setMinimized(false);
  }, [run?.step]);

  // the switching lesson advances on the SWITCH ITSELF, not the row tap:
  // picking a space closes the switcher sheet before the gate listener
  // can match the tap, which stranded the step (user ss 2026-07-28) —
  // and any switch teaches the lesson, whichever row it came from
  const lastSpaceRef = useRef(spaceId);
  useEffect(() => {
    const changed = spaceId !== lastSpaceRef.current;
    lastSpaceRef.current = spaceId;
    if (changed && (step?.id === 'pickPrivate' || step?.id === 'pickFamily' || step?.id === 'pickPrivateCleanup')) {
      setTimeout(advance, 400);
    }
  }, [spaceId, step?.id, advance]);

  // navigate to the step's screen (never mid-act — acts follow the user)
  const screen = step?.screen;
  useEffect(() => {
    if (screen) void navigate({ to: screen });
  }, [screen, navigate]);

  // publish form suggestions for the live step — AND the upcoming one:
  // the form usually opens during the preceding gate step (the + click),
  // before the act step is current. Suggested SPACE names dedupe against
  // what already exists (user ss: replaying suggested the taken name
  // "Private" and the form refused the duplicate).
  useEffect(() => {
    if (!run?.active) return;
    const source = [MINA_STEPS[run.step], MINA_STEPS[run.step + 1]].find((s) => s?.suggestKey);
    if (!source?.suggestKey) return;
    const value = t(source.suggestKey);
    let cancelled = false;
    if (source.act?.entity === 'space') {
      // the base name lands SYNCHRONOUSLY — the + can be tapped before
      // the async dedupe read returns (slow CI proved a user could win
      // that race and get an empty prefill); the deduped name upgrades it
      setMinaSuggestions({ spaceName: value });
      void (async () => {
        const taken = new Set(
          (await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => s.name.toLowerCase()),
        );
        let name = value;
        let n = 2;
        while (taken.has(name.toLowerCase())) {
          name = `${value}${n}`;
          n++;
        }
        if (!cancelled) setMinaSuggestions({ spaceName: name });
      })().catch(() => undefined);
    } else if (source.act?.entity === 'account') setMinaSuggestions({ accountName: value });
    else if (source.act?.entity === 'transaction') setMinaSuggestions({ txMerchant: value, txAmount: '12,34', txCatId: 'groceries' });
    return () => {
      cancelled = true;
      setMinaSuggestions({});
    };
  }, [run?.active, run?.step, t, lang, store]);

  // anchor + label + sheet tracking: rAF-driven re-measure (scroll,
  // resize, sheet motion — and the quoted target label appearing late)
  const anchorKey = step?.anchor?.join(',') ?? '';
  const labelKey = step?.labelFrom?.join(',') ?? '';
  const revealedStepRef = useRef(-1);
  useEffect(() => {
    if (!run?.active) return;
    let raf = 0;
    const tick = () => {
      const el = resolveAnchor(step?.anchor);
      // a target hiding behind the tab bar (or above the fold) scrolls
      // itself into the visible band, once per step (user ss: the
      // Financial Accounts row sat under the navigation)
      if (el && run && revealedStepRef.current !== run.step) {
        const r = el.getBoundingClientRect();
        if (r.top < 70 || r.bottom > window.innerHeight - 96) {
          revealedStepRef.current = run.step;
          revealInScroller(el);
        } else if (r.width > 0) {
          revealedStepRef.current = run.step; // visible — settled, no scroll
        }
      }
      const next = el?.getBoundingClientRect() ?? null;
      setRect((prev) => {
        if (!prev && !next) return prev;
        if (prev && next && Math.abs(prev.top - next.top) < 1 && Math.abs(prev.left - next.left) < 1 && Math.abs(prev.width - next.width) < 1) return prev;
        return next;
      });
      setTargetLabel(elementLabel(resolveAnchor(step?.labelFrom ?? step?.anchor)));
      setSheetOpen(hasOpenSheet());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.active, run?.step, anchorKey, labelKey, resolveAnchor]);

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

  // replay detection for the Home copy (a lived-in account is not empty)
  const spacesLive = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0).length, [run?.step]);
  const hasSpaces = (spacesLive ?? 0) > 0;

  // act detection on the STORE (approval remark 2): live emissions, row
  // EXISTENCE diff — any name, any amount satisfies the step
  const actEntity = step?.act?.entity;
  const actRows = useQuery(
    store,
    async () => (actEntity ? (await store.allRows(actEntity)).filter((r) => r.deleted === 0) : []),
    [actEntity, run?.step],
  );
  // the baseline comes from a DIRECT store read at step entry — the live
  // query's first emission after a step change can be a STALE snapshot
  // of the previous step, which made pre-existing rows read as "fresh"
  // and completed the act instantly (user bug: the create-space step
  // skipped itself on replays and on the second space)
  useEffect(() => {
    baselineRef.current = null;
    if (!run?.active || !step?.act || step.act.absent) return;
    const entity = step.act.entity;
    const stepIndex = run.step;
    let cancelled = false;
    void (async () => {
      const rows = (await store.allRows(entity)).filter((r) => r.deleted === 0);
      if (!cancelled) baselineRef.current = { step: stepIndex, ids: new Set(rows.map((r) => r.id)) };
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.active, run?.step]);
  useEffect(() => {
    if (!run || !step?.act || !actRows) return;
    const live = new Set(actRows.map((r) => r.id));
    // non-absent acts wait for THEIR OWN baseline — never one inferred
    // from a possibly-stale emission
    if (!step.act.absent && baselineRef.current?.step !== run.step) return;
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
        !run.ledger.some((e) => e.id === r.id) &&
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

  // welcome-back prompt before any step UI (user ruling: ask, then
  // land the user exactly where the tour continues)
  if (resumePending) {
    return createPortal(
      <div className="fixed inset-0 z-[150] flex items-end justify-center bg-black/50 lg:items-center" data-testid="mina-resume-sheet">
        <div className="w-full max-w-[480px] rounded-t-[20px] bg-bg p-5 lg:rounded-[20px]">
          <div className="flex items-start gap-3">
            <img src={MINA_EXPR.smile} alt="Mina" className="h-16 w-auto max-w-[64px] shrink-0 rounded-lg object-contain" />
            <span className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-ink">{t('mina.resume.t')}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{t('mina.resume.b')}</p>
            </span>
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <Button data-testid="mina-resume-continue" onClick={() => setResumePending(false)}>
              {t('mina.resume.continue')}
            </Button>
            <Button
              variant="outline"
              data-testid="mina-resume-skip"
              onClick={() => {
                setResumePending(false);
                setSkipOpen(true);
              }}
            >
              {t('mina.skip')}
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const bubbleSide = bubblePlacement(rect, sheetOpen);
  const showShade = !!step.anchor || step.gate || step.info;
  // copy quotes the live target and the (deduped) suggested name
  const bodyParams = {
    target: targetLabel,
    name: minaSuggestedSpaceName() ?? minaSuggestedAccountName() ?? minaSuggestedTx()?.merchant ?? '',
  };
  // replay on a lived-in account: "it looks empty" would be nonsense
  const bodyKey = step.id === 'home' && hasSpaces ? 'mina.home.bReplay' : step.bodyKey;

  return createPortal(
    <div data-testid="mina-tutorial" data-step={step.id}>
      {step.kind === 'fullscreen' && (
        <div
          className="fixed inset-0 z-[130] flex flex-col items-center overflow-y-auto bg-bg"
          data-testid="mina-fullscreen"
          // the art must start BELOW the status bar (user ss: the
          // camera/notch cut Mina's head off on tall pictures)
          style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}
        >
          <div className="flex w-full max-w-[420px] flex-1 flex-col items-center px-6 pb-8 lg:max-w-[860px] lg:flex-row lg:items-center lg:gap-10">
            <img src={MINA_ART[step.art!]} alt="Mina" className="mt-4 max-h-[42dvh] w-auto max-w-full rounded-2xl object-contain lg:mt-0 lg:max-h-[70dvh] lg:flex-1" />
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
          {minimized ? (
            // tucked away: a glowing corner orb brings Mina back (user
            // ruling — sometimes she simply IS in the way)
            <button
              data-testid="mina-restore"
              onClick={() => setMinimized(false)}
              className="m-mina-glow fixed bottom-24 left-4 z-[140] flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-accent bg-surface"
            >
              <img src={MINA_EXPR[step.expr ?? 'smile']} alt="Mina" className="h-full w-full object-cover" />
            </button>
          ) : (
            <div
              data-testid="mina-bubble"
              className={`fixed inset-x-4 z-[140] mx-auto max-w-[480px] rounded-card border border-line bg-surface p-4 shadow-2xl ${
                bubbleSide === 'top' ? 'top-[max(16px,env(safe-area-inset-top))]' : 'bottom-24'
              }`}
            >
              <button
                aria-label={t('mina.minimize')}
                data-testid="mina-minimize"
                onClick={() => setMinimized(true)}
                className="m-tap absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full border-none bg-transparent text-ink-4"
              >
                <Icon name="arrow-collapse" size={15} />
              </button>
              <div className="flex items-start gap-3">
                {/* Mina talks from the LEFT — full picture, no circle crop
                    (user request) */}
                <img src={MINA_EXPR[step.expr ?? 'smile']} alt="Mina" className="h-16 w-auto max-w-[64px] shrink-0 rounded-lg object-contain" />
                <span className="min-w-0 flex-1 pr-6">
                  <p className="text-[14px] font-semibold text-ink">{t(step.titleKey)}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{t(bodyKey, bodyParams)}</p>
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
          )}
        </>
      )}

      {/* skip confirm — a FULL SCREEN with Mina's shock front and center
          (user redesign 2026-07-28); with a non-empty ledger the revert
          question rides along */}
      {skipOpen && (
        <div
          className="fixed inset-0 z-[150] flex flex-col items-center justify-center overflow-y-auto bg-bg px-6"
          style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}
          data-testid="mina-skip-sheet"
        >
          <div className="flex w-full max-w-[420px] flex-col items-center text-center">
            <img src={MINA_EXPR.surprised} alt="Mina" className="max-h-[38dvh] w-auto max-w-[240px] rounded-2xl object-contain" />
            <p className="mt-5 text-[19px] font-semibold text-ink">{t('mina.skipConfirm.t')}</p>
            <p className="mt-2 max-w-[360px] text-[14px] leading-relaxed text-ink-2">{t('mina.skipConfirm.b')}</p>
            {run.ledger.length > 0 && (
              <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" data-testid="mina-skip-revert" checked={skipRevert} onChange={(e) => setSkipRevert(e.target.checked)} />
                {t('mina.skipConfirm.revert')}
              </label>
            )}
            <div className="mt-6 flex w-full max-w-[360px] flex-col gap-2">
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
