import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { globalWeekStart } from '@/lib/weekStart';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useQuery } from '@/db/useQuery';
import { v7 as uuidv7 } from 'uuid';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import { useLang } from '@/i18n';
import { isClippedFromView, revealInScroller } from '@/lib/viewport';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { closeAllSheets, elementOnTopLayer, hasOpenSheet } from '@/ui/Sheet';
import { MINA_ART, MINA_EXPR } from './assets';
import { MINA_DONE_KEY, MINA_STATE_KEY, MINA_STEPS, minaStepIndex, minaSuggestedAccountName, minaSuggestedSpaceName, minaSuggestedTx, setMinaSuggestions } from './steps';
import { setMinaSheetGuard } from './lock';
import type { MinaLedgerEntry, MinaRunState, MinaStep } from './steps';
import { revertMinaRun } from './revert';

const PAD = 6;

// the walk to Family's cog only deletes the run's own second space: with no live $s2 it is skipped ('deleteFamily' is
// excluded: its absent-act runs while the ledger empties, and a skip there would jump past the wrap screen)
const CLEANUP_STEP_IDS = new Set(['openSwitcherCleanup', 'pickPrivateCleanup', 'openSwitcherCleanup2', 'openManageCleanup', 'openFamilyCog']);

// switching lessons advance on the SPACE CHANGE alone: the gate tap listener must stay out, both scheduling an advance
// let a fast IndexedDB commit land inside the tap's 50ms window and advance twice
const PICK_STEP_IDS = new Set(['pickPrivate', 'pickFamily', 'pickPrivateCleanup']);

// steps anchored inside the switcher sheet -> the step that opens it: a pick or swipe closes the sheet, the anchor
// never resolves and the full cover blocks the switcher button; the self-heal rewinds to the opener
const SHEET_ANCHOR_OPENER: Record<string, string> = {
  openManage: 'openSwitcher',
  openManage2: 'openSwitcher2',
  pickPrivate: 'openSwitcherSwap',
  pickFamily: 'openSwitcherSwap2',
  pickPrivateCleanup: 'openSwitcherCleanup',
  openManageCleanup: 'openSwitcherCleanup2',
};

// only rows of spaces made THIS run are safe stand-ins for a $s anchor: lighting up a user's own space once
// pointed the delete lesson at the wrong cog
function fallbackAnchor(candidates: readonly string[] | undefined, createdSpaces: readonly string[], spaceId: string): HTMLElement | null {
  for (const raw of candidates ?? []) {
    const tokenAt = raw.indexOf('$s');
    if (tokenAt < 0) continue;
    const prefix = raw.slice(0, tokenAt);
    const rows = [...document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)].filter(
      (el) => el.dataset.testid !== 'space-pick-manage' && el.offsetParent !== null,
    );
    const mine = rows.filter((el) => createdSpaces.some((sid) => el.dataset.testid === `${prefix}${sid}`));
    const mineNotActive = mine.find((el) => el.dataset.testid !== `${prefix}${spaceId}`);
    if (mine.length > 0) return mineNotActive ?? mine[0];
    // any switch teaches a switching lesson, so a non-active row works; never the active one (the lesson is switching AWAY)
    if (prefix === 'space-pick-') {
      const notActive = rows.find((el) => el.dataset.testid !== `${prefix}${spaceId}`);
      if (notActive) return notActive;
    }
  }
  return null;
}

/** four invisible rects swallow every outside tap; the dim is barely there so the target stays placeable */
function GateShade({ rect, blockHole }: Readonly<{ rect: DOMRect | null; blockHole: boolean }>) {
  // interactive targets breathe; info-only highlights glow softly: attention without an invitation to press
  const glowClass = blockHole ? 'm-mina-glow-soft' : 'm-mina-glow';
  // no resolved target: everything is covered, a collapsed shade left the screen tappable
  // the bubble's own Continue/skip work above it
  if (!rect) return <div className="fixed inset-0 z-[130] bg-black/15" data-testid="mina-gate-cover" />;
  const top = Math.max(0, rect.top - PAD);
  const left = Math.max(0, rect.left - PAD);
  const right = Math.min(window.innerWidth, rect.right + PAD);
  const bottom = Math.min(window.innerHeight, rect.bottom + PAD);
  // the dim is one rounded cutout so the shade edge and the glow share a shape, and it moves instantly
  const blocker = 'fixed z-[130]';
  return (
    <>
      <div className={blocker} style={{ top: 0, left: 0, right: 0, height: top }} />
      <div className={blocker} style={{ top: bottom, left: 0, right: 0, bottom: 0 }} />
      <div className={blocker} style={{ top, left: 0, width: left, height: bottom - top }} />
      <div className={blocker} style={{ top, left: right, right: 0, height: bottom - top }} />
      {/* separate element: the glow's animation owns its box-shadow; ring and cutout glide, only the blockers stay instant */}
      <div
        className="pointer-events-none fixed z-[129] rounded-2xl transition-all duration-500"
        style={{ top, left, width: right - left, height: bottom - top, boxShadow: '0 0 0 200vmax rgba(0,0,0,0.15)' }}
      />
      <div
        className={`${glowClass} pointer-events-none fixed z-[130] rounded-2xl transition-all duration-500`}
        style={{ top, left, width: right - left, height: bottom - top }}
        data-testid="mina-gate-ring"
      />
      {blockHole && <div className="fixed z-[130]" style={{ top, left, width: right - left, height: bottom - top }} />}
    </>
  );
}

// the clip-aware reveal is a one-shot per step; at sub-lg sizes it fired while a sheet was still sliding in
// and was spent on an empty band
export const rectSettled = (prev: DOMRect | null, next: DOMRect): boolean =>
  !!prev &&
  Math.abs(prev.top - next.top) < 1 &&
  Math.abs(prev.left - next.left) < 1 &&
  Math.abs(prev.width - next.width) < 1 &&
  Math.abs(prev.height - next.height) < 1;

/** sheets float above the app bar/tab bar, so their bottom rows sit inside the default 70/96 bands: tight pads for them */
export const clipPads = (el: HTMLElement): readonly [number, number] =>
  el.closest('[data-sheet-body]') ? [12, 12] : [70, 96];

function revealOnceSettled(el: HTMLElement, next: DOMRect, prev: DOMRect | null, stepIndex: number, revealedRef: { current: number }): void {
  if (revealedRef.current === stepIndex || !rectSettled(prev, next)) return;
  const [topPad, bottomPad] = clipPads(el);
  if (isClippedFromView(el, topPad, bottomPad)) {
    revealedRef.current = stepIndex;
    revealInScroller(el);
  } else if (next.width > 0) {
    revealedRef.current = stepIndex;
  }
}

/** the bubble takes the half the target does not occupy; with no target it dodges open sheets, which rise from the bottom */
const bubblePlacement = (rect: DOMRect | null, sheetOpen: boolean): 'top' | 'bottom' => {
  if (rect) return rect.top + rect.height / 2 > window.innerHeight / 2 ? 'top' : 'bottom';
  return sheetOpen ? 'top' : 'bottom';
};

/** only the first leaf text counts: reading a whole row glued title and subtitle together; quoting survives label changes */
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

// a sheet over an off-sheet anchor owns the screen: the shade stands down (its blockers swallowed the sheet's taps)
// ACT steps only: gate taps that open a sheet flip sheetOpen a frame early, and standing down there blinked the dim
const shadeVisible = (step: MinaStep, sheetOpen: boolean, anchorInSheet: boolean): boolean =>
  (!!step.anchor || !!step.gate || !!step.info) && !(sheetOpen && !anchorInSheet && !!step.act);

export function MinaTutorial() {
  const { t, lang } = useLang();
  const { store, repo, spaceId, setActiveSpace } = useData();
  const identity = useSession((s) => s.identity);
  const navigate = useNavigate();
  const [run, setRun] = useState<MinaRunState | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipRevert, setSkipRevert] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [targetLabel, setTargetLabel] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [softRect, setSoftRect] = useState<DOMRect | null>(null);
  // a sheet open over an off-sheet anchor: the z-130 shade would swallow every tap on the sheet, so it stands down
  const [anchorInSheet, setAnchorInSheet] = useState(false);
  const [resumePending, setResumePending] = useState(false);
  const baselineRef = useRef<{ step: number; ids: Set<string> } | null>(null);

  // while the run is live, sheets refuse user dismissal; programmatic closes still work
  useEffect(() => {
    setMinaSheetGuard(!!run?.active);
    return () => setMinaSheetGuard(false);
  }, [run?.active]);

  useEffect(() => {
    if (!identity || identity.kind === 'demo') return;
    let cancelled = false;
    void (async () => {
      const state = (await store.metaGet(MINA_STATE_KEY))?.value as MinaRunState | undefined;
      if (cancelled || !state?.active) return;
      // killed mid-onboarding: stay dormant, resuming dropped the bubble onto the profile form
      // finishing onboarding re-dispatches mina:start
      if ((await store.metaGet('needsOnboarding'))?.value) return;
      // resume at the nearest checkpoint (mid-sheet steps cannot rebuild their transient UI), asking first
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

  // delayed advances must not act on the render they were scheduled in: a stale closure lost the just-ledgered space ids
  const runRef = useRef(run);
  runRef.current = run;

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
      const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
      if (spaces.length === 0) {
        const id = uuidv7();
        await repo.upsert('space', id, id, {
          name: t('mina.suggest.private'),
          kind: 'personal',
          currency: 'EUR',
          periodType: 'month',
          periodDay: 1,
          weekStart: globalWeekStart(),
          historyStartDate: isoMonthsAgo(DEFAULT_HISTORY_MONTHS),
        });
        // #546: the cash wallet exists from birth, this exit space included
        const { ensureCashWallet } = await import('@/application/defaultAccounts');
        await ensureCashWallet(store, repo, id);
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
        // defense in depth: the delete lesson only means the tutorial's second space, a wrong glow coaches deleting real data
        if (id === 'space-edit-delete') {
          const settings = document.querySelector<HTMLElement>('[data-testid="screen-space-settings"]');
          if (settings?.dataset.spaceId !== createdSpaces[1]) continue;
        }
        for (const el of document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)) {
          if (el.offsetParent !== null) return el; // the VISIBLE candidate (mobile vs desktop nav)
        }
      }
      return fallbackAnchor(candidates, createdSpaces, spaceId);
    },
    [createdSpaces, spaceId],
  );

  const advance = useCallback(() => {
    const current = runRef.current;
    if (!current) return;
    setMinaSuggestions({});
    if (current.step + 1 >= MINA_STEPS.length) {
      void finish(false);
      return;
    }
    const nextStep = MINA_STEPS[current.step + 1];
    // steps that play outside any sheet close leftovers (the no-account form, the switcher): UI control, not a data write
    if (nextStep.kind === 'fullscreen' || nextStep.anchor?.some((a) => a.startsWith('tab-') || a.startsWith('side-tab-'))) closeAllSheets();
    persist({ ...current, step: current.step + 1 });
  }, [persist, finish]);

  // a fresh dialogue always shows itself: a minimized Mina after a completed step read as the tutorial dying
  useEffect(() => {
    setMinimized(false);
  }, [run?.step]);

  // advance on the SWITCH itself: a pick closes the switcher before the gate listener can match the tap, stranding the step;
  // any switch teaches the lesson
  const lastSpaceRef = useRef(spaceId);
  useEffect(() => {
    const changed = spaceId !== lastSpaceRef.current;
    lastSpaceRef.current = spaceId;
    if (changed && step && PICK_STEP_IDS.has(step.id)) {
      setTimeout(advance, 400);
    }
  }, [spaceId, step?.id, advance]);

  // no live tutorial-made Family: jump to the wrap instead of glowing an arbitrary cog
  // (lost ledger, or the space already gone)
  const inCleanup = !!step && CLEANUP_STEP_IDS.has(step.id);
  useEffect(() => {
    if (!run?.active || !inCleanup) return;
    let cancelled = false;
    void (async () => {
      const family = createdSpaces[1];
      const alive = family ? (await store.allRows('space')).some((s) => s.id === family && s.deleted === 0) : false;
      if (cancelled || alive) return;
      const current = runRef.current;
      if (current) persist({ ...current, step: minaStepIndex('wrap') });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [run?.active, run?.step, inCleanup, createdSpaces, store, persist]);

  // never mid-act: acts follow the user
  const screen = step?.screen;
  useEffect(() => {
    if (screen) void navigate({ to: screen });
  }, [screen, navigate]);

  // suggestions cover the upcoming step too: the form usually opens during the preceding gate step;
  // space names dedupe against existing ones (the form refuses a duplicate)
  useEffect(() => {
    if (!run?.active) return;
    const source = [MINA_STEPS[run.step], MINA_STEPS[run.step + 1]].find((s) => s?.suggestKey);
    if (!source?.suggestKey) return;
    const value = t(source.suggestKey);
    let cancelled = false;
    if (source.act?.entity === 'space') {
      // the base name lands synchronously: the + can be tapped before the async dedupe read returns; the deduped name upgrades it
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

  const anchorKey = step?.anchor?.join(',') ?? '';
  const labelKey = step?.labelFrom?.join(',') ?? '';
  const revealedStepRef = useRef(-1);
  const probeRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    if (!run?.active) return;
    probeRef.current = null;
    let raf = 0;
    const tick = () => {
      const el = resolveAnchor(step?.anchor);
      const next = el?.getBoundingClientRect() ?? null;
      // scroll into view once per step, clip-aware: a row scrolled out of a sheet's list has window-plausible coordinates
      // while invisible; judged on settled geometry only, with sheet-aware pads
      if (el && next && run) revealOnceSettled(el, next, probeRef.current, run.step, revealedStepRef);
      probeRef.current = next;
      setRect((prev) => {
        if (!prev && !next) return prev;
        if (prev && next && Math.abs(prev.top - next.top) < 1 && Math.abs(prev.left - next.left) < 1 && Math.abs(prev.width - next.width) < 1) return prev;
        return next;
      });
      setTargetLabel(elementLabel(resolveAnchor(step?.labelFrom ?? step?.anchor)));
      setAnchorInSheet(!!el?.closest('[data-sheet-body]'));
      // the overlay (z-60) outranks every sheet (z-50): the soft glow stands down unless its anchor is on the top layer
      const softEl = step?.act && !step.anchor ? resolveAnchor(step.labelFrom) : null;
      // a clipped soft target stands down too; a save button at a sheet's bottom is not hidden behind the tab bar
      const softNext = softEl && elementOnTopLayer(softEl) && !isClippedFromView(softEl, ...clipPads(softEl)) ? softEl.getBoundingClientRect() : null;
      setSoftRect((prev) => {
        if (!prev && !softNext) return prev;
        if (prev && softNext && Math.abs(prev.top - softNext.top) < 1 && Math.abs(prev.left - softNext.left) < 1 && Math.abs(prev.width - softNext.width) < 1) return prev;
        return softNext;
      });
      setSheetOpen(hasOpenSheet());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.active, run?.step, anchorKey, labelKey, resolveAnchor]);

  // pick steps are excluded: they advance on the space change, and a second scheduler here double-advanced
  const gateTapArmed = !!step?.gate && !PICK_STEP_IDS.has(step.id);
  useEffect(() => {
    if (!gateTapArmed || !step) return;
    const onTap = (event: Event) => {
      const el = resolveAnchor(step.anchor);
      if (el && event.target instanceof Node && el.contains(event.target)) setTimeout(advance, 50);
    };
    document.addEventListener('click', onTap, { capture: true });
    return () => document.removeEventListener('click', onTap, { capture: true });
  }, [gateTapArmed, step, resolveAnchor, advance]);

  // sheet-anchored steps self-heal: with the sheet gone the anchor never resolves and the cover blocks the switcher
  // button; rewind to the opener once it stayed unresolved for 600ms
  const openerId = step ? SHEET_ANCHOR_OPENER[step.id] : undefined;
  useEffect(() => {
    if (!run?.active || resumePending || !openerId) return;
    if (sheetOpen || rect) return;
    const timer = setTimeout(() => {
      const current = runRef.current;
      if (!current?.active || hasOpenSheet()) return;
      persist({ ...current, step: minaStepIndex(openerId) });
    }, 600);
    return () => clearTimeout(timer);
  }, [run?.active, run?.step, openerId, sheetOpen, rect, resumePending, persist]);

  const spacesLive = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0).length, [run?.step]);
  const hasSpaces = (spacesLive ?? 0) > 0;

  // act detection on the store: row existence diff, any name or amount satisfies the step
  const actEntity = step?.act?.entity;
  const actRows = useQuery(
    store,
    async () => (actEntity ? (await store.allRows(actEntity)).filter((r) => r.deleted === 0) : []),
    [actEntity, run?.step],
  );
  // baseline from a direct store read: the live query's first emission after a step change can be a stale snapshot,
  // which read existing rows as fresh and completed the act instantly
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
    if (!step.act.absent && baselineRef.current?.step !== run.step) return;
    if (step.act.absent) {
      const family = createdSpaces[1];
      if (!family || live.has(family)) return;
      // the live query's first emission can be a stale snapshot missing the family row:
      // confirm against the store before wrapping the tour
      void (async () => {
        const reallyGone = !(await store.allRows('space')).some((s) => s.id === family && s.deleted === 0);
        if (!reallyGone) return;
        const current = runRef.current;
        if (!current?.active) return;
        persist({ ...current, ledger: current.ledger.filter((e) => e.id !== family && e.spaceId !== family) });
        setTimeout(advance, 400);
        baselineRef.current = null;
      })().catch(() => undefined);
      return;
    }
    const fresh = actRows.filter(
      (r) => !baselineRef.current!.ids.has(r.id) &&
        !run.ledger.some((e) => e.id === r.id) &&
        // bank-fed rows are never ledgered: a sync mid-replay must not be swept into a revert
        !(r as { importRef?: string }).importRef && !(r as { feedSpaceId?: string }).feedSpaceId,
    );
    if (fresh.length === 0) return;
    const entries: MinaLedgerEntry[] = fresh.map((r) => ({ entity: step.act!.entity, spaceId: (r as { spaceId: string }).spaceId, id: r.id }));
    const nextRun: MinaRunState = { ...run, ledger: [...run.ledger, ...entries] };
    if (step.act.entity === 'space' && createdSpaces.length === 0) void setActiveSpace(entries[0].id);
    persist(nextRun);
    baselineRef.current = null;
    setTimeout(advance, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actRows, run?.step]);

  if (!run?.active || !step) return null;

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
  const showShade = shadeVisible(step, sheetOpen, anchorInSheet);
  const bodyParams = {
    target: targetLabel,
    name: minaSuggestedSpaceName() ?? minaSuggestedAccountName() ?? minaSuggestedTx()?.merchant ?? '',
  };
  // replay on a lived-in account: the "it looks empty" copy would be wrong
  const bodyKey = step.id === 'home' && hasSpaces ? 'mina.home.bReplay' : step.bodyKey;

  return createPortal(
    <div data-testid="mina-tutorial" data-step={step.id}>
      {step.kind === 'fullscreen' && (
        <div
          className="fixed inset-0 z-[130] flex flex-col items-center overflow-y-auto bg-bg"
          data-testid="mina-fullscreen"
          // the art starts below the status bar: the notch cut Mina's head off on tall pictures
          style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}
        >
          <div className="flex w-full max-w-[420px] flex-1 flex-col items-center px-6 pb-8 lg:max-w-[560px] lg:justify-center">
            <img src={MINA_ART[step.art!]} alt="Mina" className="mt-4 max-h-[42dvh] w-auto max-w-full rounded-2xl object-contain lg:max-h-[52dvh]" />
            <div className="flex w-full flex-col items-center text-center">
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
          {/* a transparent full-screen blocker keeps Continue-driven bubbles without a shade from letting the user wander off */}
          {!showShade && !step.act && <div className="fixed inset-0 z-[130]" data-testid="mina-tap-blocker" />}
          {step.act && softRect && (
            <div
              data-testid="mina-soft-glow"
              className="m-mina-glow pointer-events-none fixed z-[60] rounded-2xl transition-all duration-500"
              style={{ top: softRect.top - 4, left: softRect.left - 4, width: softRect.width + 8, height: softRect.height + 8 }}
            />
          )}
          {minimized ? (
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

      {/* with a non-empty ledger the revert question rides along */}
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
