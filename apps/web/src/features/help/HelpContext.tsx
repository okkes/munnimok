import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useData } from '@/app/data';
import { tourById } from './tours';
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
  const { db } = useData();
  const navigate = useNavigate();
  const [slidesFor, setSlidesFor] = useState<TourId | null>(null);
  const [spotlight, setSpotlight] = useState<{ tourId: TourId; step: number } | null>(null);

  const markSeen = useCallback(
    (tourId: TourId) => void db.meta.put({ key: `tutorialSeen_${tourId}`, value: true }).catch(() => undefined),
    [db],
  );

  const openSlides = useCallback((tourId: TourId) => setSlidesFor(tourId), []);
  const startSpotlight = useCallback(
    (tourId: TourId) => {
      const tour = tourById(tourId);
      if (!tour.screen) return;
      setSlidesFor(null);
      markSeen(tourId);
      void navigate({ to: tour.screen });
      setSpotlight({ tourId, step: 0 });
    },
    [navigate, markSeen],
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
        />
      )}
    </HelpContext.Provider>
  );
}
