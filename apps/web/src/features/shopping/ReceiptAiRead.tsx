import { useEffect, useMemo, useRef, useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import type { ReceiptItem } from '@/db/types';
import { catName, useCategories } from '@/features/categories/useCategories';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { itemsFromRead, readReceiptPhotos, receiptAiChoice, setReceiptAiChoice, takeFreshPhoto, useFreshPhoto } from './receiptAi';
import type { ReadCategory, ReceiptReadReply } from './receiptAi';

export interface ReceiptReadOutcome {
  items: ReceiptItem[];
  reconciled: boolean;
  totalCents: number;
  currency?: string;
  /** the shop and the day as printed — a receipt kept without a transaction has no other source for them */
  merchant?: string;
  date?: string;
}

function useReadCategories(): ReadCategory[] {
  const { t } = useLang();
  const cats = useCategories();
  return useMemo(() => {
    const out: ReadCategory[] = [];
    for (const main of cats.parents.filter((parent) => parent.txTypes.includes('expense'))) {
      const subs = cats.childrenOf(main.id);
      if (subs.length === 0) out.push({ id: main.id, name: catName(main, t) });
      for (const sub of subs) out.push({ id: sub.id, name: `${catName(main, t)} › ${catName(sub, t)}` });
    }
    return out;
  }, [cats, t]);
}

/** #567: the one-time notice naming where a photo goes; "no" is remembered */
export function ReceiptAiConsentSheet({
  open,
  onOpenChange,
  onAnswer,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; onAnswer: (agreed: boolean) => void }>) {
  const { t } = useLang();
  const answer = (agreed: boolean) => {
    setReceiptAiChoice(agreed ? 'yes' : 'no');
    onOpenChange(false);
    onAnswer(agreed);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('receipt.ai.askTitle')} size="form">
      <div className="flex flex-col gap-3 pt-1" data-testid="receipt-ai-ask">
        <p className="text-[13px] leading-snug text-ink-2">{t('receipt.ai.askBody')}</p>
        <p className="text-[12px] leading-snug text-ink-4">{t('receipt.ai.askKeep')}</p>
        <Button data-testid="receipt-ai-yes" onClick={() => answer(true)}>
          {t('receipt.ai.askYes')}
        </Button>
        <Button variant="outline" data-testid="receipt-ai-no" onClick={() => answer(false)}>
          {t('receipt.ai.askNo')}
        </Button>
      </div>
    </Sheet>
  );
}

// reading again replaces the reader's lines
// #648: `freshId` names a photo taken a moment ago — with the standing order on, it is read without the button
export function ReceiptAiRead({
  images,
  hasItems,
  onRead,
  freshId,
  variant = 'button',
  testIdPrefix = 'receipt-ai',
}: Readonly<{
  images: readonly string[];
  hasItems: boolean;
  onRead: (outcome: ReceiptReadOutcome) => Promise<void>;
  freshId?: string;
  /** 'row' sits inside a card, under its other doors */
  variant?: 'button' | 'row';
  /** the card's door stands beside the receipt screen's in a desktop window: each keeps its own ids */
  testIdPrefix?: string;
}>) {
  const { t, lang } = useLang();
  const categories = useReadCategories();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ReceiptReadReply | null>(null);
  // the person's say, mirrored so the off-switch shows and hides without a reload
  const [agreed, setAgreed] = useState(() => receiptAiChoice() === 'yes');
  const reading = useRef(false);
  const fresh = useFreshPhoto(freshId);

  const read = async () => {
    if (reading.current) return;
    reading.current = true;
    setBusy(true);
    setReply(null);
    try {
      const answer = await readReceiptPhotos(images, categories);
      setReply(answer);
      if (answer.state === 'ok' && answer.receipt) {
        await onRead({
          items: itemsFromRead(answer.receipt),
          reconciled: answer.receipt.reconciled,
          totalCents: answer.receipt.totalCents,
          ...(answer.receipt.currency ? { currency: answer.receipt.currency } : {}),
          ...(answer.receipt.merchant ? { merchant: answer.receipt.merchant } : {}),
          ...(answer.receipt.date ? { date: answer.receipt.date } : {}),
        });
      }
    } finally {
      reading.current = false;
      setBusy(false);
    }
  };

  // the mark is taken once, so a second look at the same receipt reads nothing by itself
  useEffect(() => {
    if (fresh && freshId && images.length > 0 && takeFreshPhoto(freshId)) void read();
    // deliberately on the mark and the photo's arrival only: `read` is a fresh function every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, freshId, images.length]);

  const start = () => {
    if (receiptAiChoice() === 'yes') void read();
    else setAsking(true);
  };

  const doorLabel = t(hasItems ? 'receipt.ai.readAgain' : 'receipt.ai.read');
  const when = reply?.until ? new Date(reply.until).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'long' }) : '';
  const note: Partial<Record<ReceiptReadReply['state'], string>> = {
    limited: t('receipt.ai.limited', { when }),
    capped: t('receipt.ai.capped', { when }),
    unreadable: t('receipt.ai.unreadable'),
    unavailable: t('receipt.ai.unavailable'),
  };
  const failed = reply && reply.state !== 'ok' ? note[reply.state] : undefined;

  return (
    <>
      {variant === 'row' ? (
        <button
          data-testid={`${testIdPrefix}-read`}
          disabled={busy}
          onClick={start}
          className="m-tap flex w-full items-center justify-center gap-1.5 border-0 border-t border-line-2 bg-transparent py-2 text-[12px] font-medium text-accent-deep disabled:text-ink-4"
        >
          <Icon name={busy ? 'progress-clock' : 'text-recognition'} size={14} />
          {busy ? t('receipt.ai.busy') : doorLabel}
        </button>
      ) : (
        <Button variant="outline" className="w-full" data-testid={`${testIdPrefix}-read`} disabled={busy} onClick={start}>
          {busy ? t('receipt.ai.busy') : doorLabel}
        </Button>
      )}
      {failed && (
        <p
          className={`text-center text-[12px] leading-snug text-ink-4 ${variant === 'row' ? 'border-t border-line-2 px-4 py-2' : ''}`}
          data-testid={`${testIdPrefix}-note`}
          data-state={reply?.state}
        >
          {failed}
        </p>
      )}
      {agreed && variant === 'button' && (
        <p className="text-center text-[11px] leading-snug text-ink-4" data-testid="receipt-ai-on">
          {t('receipt.ai.onNote')}{' '}
          <button
            data-testid="receipt-ai-off"
            onClick={() => {
              setReceiptAiChoice('no');
              setAgreed(false);
            }}
            className="m-tap border-none bg-transparent p-0 text-[11px] font-medium text-accent-deep underline"
          >
            {t('receipt.ai.turnOff')}
          </button>
        </p>
      )}
      <ReceiptAiConsentSheet
        open={asking}
        onOpenChange={setAsking}
        onAnswer={(yes) => {
          setAgreed(yes);
          if (yes) void read();
        }}
      />
    </>
  );
}
