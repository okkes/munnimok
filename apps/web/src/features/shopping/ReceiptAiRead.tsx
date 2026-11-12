import { useMemo, useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import type { ReceiptItem } from '@/db/types';
import { catName, useCategories } from '@/features/categories/useCategories';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { itemsFromRead, readReceiptPhotos, receiptAiChoice, setReceiptAiChoice } from './receiptAi';
import type { ReadCategory, ReceiptReadReply } from './receiptAi';

/** what the reader found, as the receipt takes it */
export interface ReceiptReadOutcome {
  items: ReceiptItem[];
  reconciled: boolean;
  currency?: string;
}

/** the expense categories the reader may choose from: every sub under its main, and a main that stands alone */
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

/**
 * #567 (user): the photo is read by a vision model through munni's API.
 * The first time, a notice names where the photo goes and asks; "no"
 * is remembered and the door stays shut until the person opens it again
 * in the same notice. Reading again replaces the lines a reader made.
 */
export function ReceiptAiRead({
  images,
  hasItems,
  onRead,
}: Readonly<{ images: readonly string[]; hasItems: boolean; onRead: (outcome: ReceiptReadOutcome) => Promise<void> }>) {
  const { t, lang } = useLang();
  const categories = useReadCategories();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ReceiptReadReply | null>(null);

  const read = async () => {
    setBusy(true);
    setReply(null);
    try {
      const answer = await readReceiptPhotos(images, categories);
      setReply(answer);
      if (answer.state === 'ok' && answer.receipt) {
        await onRead({ items: itemsFromRead(answer.receipt), reconciled: answer.receipt.reconciled, ...(answer.receipt.currency ? { currency: answer.receipt.currency } : {}) });
      }
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <>
      <Button variant="outline" className="w-full" data-testid="receipt-ai-read" disabled={busy} onClick={start}>
        {busy ? t('receipt.ai.busy') : doorLabel}
      </Button>
      {reply && reply.state !== 'ok' && (
        <p className="text-center text-[12px] leading-snug text-ink-4" data-testid="receipt-ai-note" data-state={reply.state}>
          {note[reply.state]}
        </p>
      )}
      <Sheet open={asking} onOpenChange={setAsking} title={t('receipt.ai.askTitle')} size="form">
        <div className="flex flex-col gap-3 pt-1" data-testid="receipt-ai-ask">
          <p className="text-[13px] leading-snug text-ink-2">{t('receipt.ai.askBody')}</p>
          <p className="text-[12px] leading-snug text-ink-4">{t('receipt.ai.askKeep')}</p>
          <Button
            data-testid="receipt-ai-yes"
            onClick={() => {
              setReceiptAiChoice('yes');
              setAsking(false);
              void read();
            }}
          >
            {t('receipt.ai.askYes')}
          </Button>
          <Button
            variant="outline"
            data-testid="receipt-ai-no"
            onClick={() => {
              setReceiptAiChoice('no');
              setAsking(false);
            }}
          >
            {t('receipt.ai.askNo')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
