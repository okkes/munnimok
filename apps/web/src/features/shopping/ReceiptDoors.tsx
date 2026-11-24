import { useState } from 'react';
import { useLang } from '@/i18n';
import { useConnectionOps, useScansSpaces } from '@/application/connections';
import { useReceiptOps } from '@/application/receipts';
import type { ReceiptRow } from '@/db/types';
import { Button } from '@/ui/Button';
import { ReceiptAiConsentSheet } from './ReceiptAiRead';
import { receiptAiChoice, receiptPhotoCleanup } from './receiptAi';
import { useCategoriser } from './useCategoriser';

// #648: what a receipt's owner can do on its screen beyond linking it. Each door keeps its own state — the screen only
// decides which of them stand, and gives each the receipt as its key so another receipt starts afresh

/** a scan looked at from a space that does not read the person's scans: shared before it is used there */
export function ShareScansDoor({ spaceId, spaceName }: Readonly<{ spaceId: string; spaceName: string }>) {
  const { t } = useLang();
  const ops = useConnectionOps();
  const shared = useScansSpaces();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const share = async () => {
    setState('busy');
    try {
      await ops.setScansSpaces([...new Set([...(shared ?? []), spaceId])]);
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3" data-testid="receipt-unshared">
      <p className="text-[12px] leading-snug text-ink-3">{t('receipt.notShared', { space: spaceName })}</p>
      <Button variant="outline" className="w-full" data-testid="receipt-share-scans" disabled={state === 'busy'} onClick={() => void share()}>
        {t('receipt.shareScans', { space: spaceName })}
      </Button>
      {state === 'failed' && (
        <p className="text-center text-[12px] text-ink-4" data-testid="receipt-share-failed">
          {t('receipt.shareFailed')}
        </p>
      )}
    </div>
  );
}

/** once its lines are read, the photo itself can go — its owner's call, and never by one tap */
export function PhotoCleanupDoor({ receipt }: Readonly<{ receipt: Pick<ReceiptRow, 'id' | 'spaceId'> }>) {
  const { t } = useLang();
  const ops = useReceiptOps();
  const [armed, setArmed] = useState(false);
  const remove = () => {
    if (armed) void ops.removePhoto(receipt);
    setArmed(!armed);
  };
  return (
    <div className="flex flex-col gap-2" data-testid="receipt-photo-cleanup">
      {receiptPhotoCleanup() !== 'off' && <p className="px-1 text-[12px] leading-snug text-ink-3">{t('receipt.photo.verify')}</p>}
      <Button variant="outline" className="w-full" data-testid="receipt-photo-delete" onClick={remove}>
        {t(armed ? 'receipt.photo.confirm' : 'receipt.photo.delete')}
      </Button>
    </div>
  );
}

/** a fetched receipt's lines get a suggested category from the reader, at its owner's word */
export function CategoriseDoor({ receipt }: Readonly<{ receipt: ReceiptRow }>) {
  const { t } = useLang();
  const categorise = useCategoriser();
  const [state, setState] = useState<'idle' | 'busy' | 'later' | 'unavailable'>('idle');
  const [asking, setAsking] = useState(false);
  const suggest = async () => {
    setState('busy');
    const outcome = await categorise([receipt]);
    if (outcome.state === 'limited' || outcome.state === 'capped') setState('later');
    else setState(outcome.state === 'unavailable' ? 'unavailable' : 'idle');
  };
  const start = () => {
    if (receiptAiChoice() === 'yes') void suggest();
    else setAsking(true);
  };
  return (
    <>
      <Button variant="outline" className="w-full" data-testid="receipt-categorise-ai" disabled={state === 'busy'} onClick={start}>
        {t(state === 'busy' ? 'receipt.cats.busy' : 'receipt.cats.suggest')}
      </Button>
      {(state === 'later' || state === 'unavailable') && (
        <p className="text-center text-[12px] text-ink-4" data-testid="receipt-categorise-note">
          {t(state === 'later' ? 'receipt.cats.later' : 'receipt.ai.unavailable')}
        </p>
      )}
      <ReceiptAiConsentSheet open={asking} onOpenChange={setAsking} onAnswer={(agreed) => agreed && void suggest()} />
    </>
  );
}
