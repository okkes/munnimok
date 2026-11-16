import { useLang } from '@/i18n';
import { useStoreConnMetas } from '@/application/connections';
import type { ReceiptRow } from '@/db/types';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { ReceiptBody, receiptTitle } from './ReceiptBody';

// a look at a receipt without leaving the flow: the picker keeps its search, party chip and scroll
// full height: the PDF wants every pixel
export function ReceiptPeekSheet({
  open,
  onOpenChange,
  receipt,
  currency,
  onPick,
  testIdPrefix = 'receipt-peek',
}: Readonly<{
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** the receipt on show — kept through the close animation, so the body never empties mid-slide */
  receipt: ReceiptRow | null;
  currency: string;
  /** "Attach this one": the receipt is picked and the host closes both sheets; absent = a look only */
  onPick?: (receipt: ReceiptRow) => void;
  testIdPrefix?: string;
}>) {
  const { t } = useLang();
  const metas = useStoreConnMetas();
  const connection = receipt?.instanceId ? metas?.find((m) => m.id === receipt.instanceId) : undefined;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={receipt ? receiptTitle(receipt, t) : t('receipt.title')}
      size="full"
      wide
      footer={
        onPick && receipt ? (
          <Button className="w-full" data-testid={`${testIdPrefix}-attach`} onClick={() => onPick(receipt)}>
            {t('receipt.peekAttach')}
          </Button>
        ) : undefined
      }
    >
      {/* the body owns the pull: a finger on the picture or the items scrolls, the title bar still dismisses */}
      <div className="flex flex-col gap-3 pt-1" data-sheet-no-drag data-testid={testIdPrefix}>
        {receipt && (
          <ReceiptBody key={receipt.id} receipt={receipt} currency={receipt.currency ?? currency} connectionName={connection?.displayName} testIdPrefix={testIdPrefix} />
        )}
      </div>
    </Sheet>
  );
}
