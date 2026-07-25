import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useData } from '@/app/data';
import { tourById, welcomeStartStep } from './tours';
import type { TourId } from './tours';
import { HelpSlidesSheet } from './HelpSlidesSheet';
import { SpotlightOverlay } from './SpotlightOverlay';

interface HelpApi {
  /** open the slide tour (layer 2) */
  openSlides: (tourId: TourId) => void;
  /** start the interactive walkthrough (layer 3) on its own screen */
  startSpotlight: (tourId: TourId) => void;
}

const HelpContext = createContext<HelpApi>({ openSlides: () => {}, startSpotlight: () => {} });
export const useHelp = (): HelpApi => useContext(HelpContext);

/** hosts the two tutorial renderers above every screen */
export function HelpProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { store } = useData();
  const navigate = useNavigate();
  const [slidesFor, setSlidesFor] = useState<TourId | null>(null);
  const [spotlight, setSpotlight] = useState<{ tourId: TourId; step: number } | null>(null);

  const markSeen = useCallback(
    (tourId: TourId) => void store.metaPut(`tutorialSeen_${tourId}`, true).catch(() => undefined),
    [store],
  );

  const openSlides = useCallback((tourId: TourId) => setSlidesFor(tourId), []);
  const startSpotlight = useCallback(
    (tourId: TourId) => {
      const tour = tourById(tourId);
      if (!tour.screen) return;
      setSlidesFor(null);
      markSeen(tourId);
      // 'current' = run where the help button lives (param routes can't
      // be navigated to blindly — e.g. a space's accounts screen)
      if (tour.screen !== 'current') void navigate({ to: tour.screen });
      if (tourId === 'welcome') {
        // resume detection (walkthrough design): fast-forward past steps
        // whose real-world outcome already exists
        void (async () => {
          const [accounts, txs, spaces] = await Promise.all([
            store.allRows('account'),
            store.allRows('transaction'),
            store.allRows('space'),
          ]);
          const step = welcomeStartStep({
            hasAccount: accounts.some((a) => a.deleted === 0),
            hasTx: txs.some((t) => t.deleted === 0),
            hasSecondSpace: spaces.filter((s) => s.deleted === 0 && !!s.kind).length > 1,
          });
          setSpotlight({ tourId, step });
        })();
        return;
      }
      setSpotlight({ tourId, step: 0 });
    },
    [navigate, markSeen, store],
  );

  const api = useMemo(() => ({ openSlides, startSpotlight }), [openSlides, startSpotlight]);

  return (
    <HelpContext.Provider value={api}>
      {children}
      <HelpSlidesSheet
        tourId={slidesFor}
        onClose={() => setSlidesFor(null)}
        onDone={(tourId) => {
          markSeen(tourId);
          setSlidesFor(null);
        }}
        onInteractive={startSpotlight}
      />
      {spotlight && (
        <SpotlightOverlay
          tour={tourById(spotlight.tourId)}
          step={spotlight.step}
          onStep={(step) => setSpotlight({ ...spotlight, step })}
          onEnd={() => setSpotlight(null)}
          onComplete={() => {
            // the guided walkthrough only counts as done when its wrap
            // step was reached — an early End keeps the Home card alive
            if (spotlight.tourId === 'welcome') void store.metaPut('welcomeTourDone', true).catch(() => undefined);
          }}
        />
      )}
    </HelpContext.Provider>
  );
}
