import { useEffect, useState } from 'react';
import { readLockConfig } from '@/features/lock/lock';
import { PinChallengeSheet } from '@/features/lock/PinChallengeSheet';
import { useLang } from '@/i18n';
import { Pill, Row } from '@/ui/primitives';
import { takeHideSensitiveFocusIntent, useHideSensitive } from './sensitive';

const ROW_TEST_ID = 'settings-hide-sensitive';
/** the scroll gets this long to land before the pulse starts (the accounts screen's rule) */
const SETTLE_MS = 450;
const FLASH_MS = 1600;

/**
 * #530: the Global settings switch. Turning it on is free; turning it off
 * shows the figures again, so the app lock answers first where one is set.
 */
export function HideSensitiveRow() {
  const { t } = useLang();
  const hideSensitive = useHideSensitive((s) => s.on);
  const setHideSensitive = useHideSensitive((s) => s.set);
  const [challengeOpen, setChallengeOpen] = useState(false);

  // arriving from Home's info button: bring the row into view and flash it once.
  // The timers are left to run on purpose — StrictMode's rehearsal unmount
  // would otherwise cancel them after the read-once intent is already taken.
  useEffect(() => {
    if (!takeHideSensitiveFocusIntent()) return;
    const row = document.querySelector<HTMLElement>(`[data-testid="${ROW_TEST_ID}"]`);
    if (!row) return;
    row.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    globalThis.setTimeout(() => {
      row.dataset.flash = '1';
      globalThis.setTimeout(() => delete row.dataset.flash, FLASH_MS);
    }, SETTLE_MS);
  }, []);

  const toggle = () => {
    if (!hideSensitive) setHideSensitive(true);
    else if (readLockConfig()) setChallengeOpen(true);
    else setHideSensitive(false);
  };

  return (
    <>
      <Row
        testId={ROW_TEST_ID}
        icon={hideSensitive ? 'eye-off-outline' : 'eye-outline'}
        title={t('privacy.rowTitle')}
        sub={t('privacy.rowSub')}
        chevron={false}
        trailing={
          <Pill tone={hideSensitive ? 'accent' : 'neutral'} testId="settings-hide-sensitive-state">
            {hideSensitive ? 'ON' : 'OFF'}
          </Pill>
        }
        onClick={toggle}
      />
      <PinChallengeSheet
        open={challengeOpen}
        onOpenChange={setChallengeOpen}
        title={t('privacy.disarmTitle')}
        body={t('privacy.disarmBody')}
        onPass={() => setHideSensitive(false)}
      />
    </>
  );
}
