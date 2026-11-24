import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { paymentsHolding } from '@/application/receiptLinks';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { SpacePicker } from './SpacePicker';

type Translate = ReturnType<typeof useLang>['t'];

/** how many transactions lose their receipt, as a sentence; nothing to say for none */
export const impactLine = (n: number, t: Translate): string => {
  if (n === 0) return '';
  return t(n === 1 ? 'conn.impactOne' : 'conn.impactN', { n });
};

// #648: the spaces that read a receipt feed — a connection's, or the person's own scans. Picking a space shares the
// feed with it (the server's grant, so it needs a network); unpicking takes the feed's receipts off that space's
// transactions, which is said first, with how many.
// Two pieces: the question is a sheet of its own and belongs BESIDE a sheet the picker sits in — inside it, it comes up behind
export function useFeedSharing({
  spaces,
  selected,
  feedId,
  disabled = false,
  apply,
  testId,
}: Readonly<{
  spaces: readonly { id: string; name: string }[];
  selected: readonly string[];
  /** the feed whose receipts are shared; null while this identity has none */
  feedId: string | null;
  disabled?: boolean;
  apply: (spaceIds: string[]) => Promise<void>;
  testId: string;
}>): { picker: ReactNode; confirm: ReactNode } {
  const { t } = useLang();
  const { store } = useData();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // what is asked stays while the question closes: the sheet leaves with its words on it
  const [leaving, setLeaving] = useState<{ spaceId: string; name: string; impact: number } | null>(null);
  const [asking, setAsking] = useState(false);

  const set = async (next: string[]) => {
    setBusy(true);
    setFailed(false);
    try {
      await apply(next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (spaceId: string) => {
    if (busy) return;
    if (!selected.includes(spaceId)) {
      await set([...selected, spaceId]);
      return;
    }
    const impact = feedId ? await paymentsHolding(store, (link) => link.feedSpaceId === feedId && link.spaceId === spaceId) : 0;
    if (impact === 0) await set(selected.filter((id) => id !== spaceId));
    else {
      setLeaving({ spaceId, name: spaces.find((space) => space.id === spaceId)?.name ?? '', impact });
      setAsking(true);
    }
  };

  const picker = (
    <>
      <SpacePicker spaces={spaces} selected={selected} disabled={disabled || busy} onToggle={(id) => void toggle(id)} testId={testId} />
      {failed && (
        <p className="px-1 text-[12px] text-ink-4" data-testid={`${testId}-failed`}>
          {t('receipt.shareFailed')}
        </p>
      )}
    </>
  );
  const confirm = (
    <DangerConfirmSheet
      open={asking}
      onOpenChange={setAsking}
      title={t('conn.unshareTitle', { space: leaving?.name ?? '' })}
      body={`${t('conn.unshareNote', { space: leaving?.name ?? '' })} ${impactLine(leaving?.impact ?? 0, t)}`}
      onConfirm={() => {
        setAsking(false);
        if (leaving) void set(selected.filter((id) => id !== leaving.spaceId));
      }}
      testId={`${testId}-unshare`}
    />
  );
  return { picker, confirm };
}
