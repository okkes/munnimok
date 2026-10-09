import { useLang } from '@/i18n';
import { useStoreConnMetas } from '@/application/connections';
import type { ReceiptRow } from '@/db/types';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { ReceiptBody, receiptTitle } from './ReceiptBody';

/**
 * A look at a receipt WITHOUT leaving the picker (user 2026-10-09:
 * "whenever we open a receipt and return we have to start over again"):
 * a sheet at full height over the attach sheet — the PDF wants every
 * pixel — with the receipt's body as the screen shows it (head, picture,
 * items, invoices in place), read-only, plus the pick at its foot. The
 * picker underneath keeps its search, its party chip and its scroll
 * position, and the row that was peeked at stays lit meanwhile.
 */
export function ReceiptPeekSheet({
  open,
  onOpenChange,
  receipt,
  currency,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** the receipt on show — kept through the close animation, so the body never empties mid-slide */
  receipt: ReceiptRow | null;
  currency: string;
  /** "Attach this one": the receipt is picked and the host closes both sheets; absent = a look only */
  onPick?: (receipt: ReceiptRow) => void;
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
          <Button className="w-full" data-testid="receipt-peek-attach" onClick={() => onPick(receipt)}>
            {t('receipt.peekAttach')}
          </Button>
        ) : undefined
      }
    >
      {/* the body owns the pull: a finger on the picture or the items scrolls, the title bar still dismisses */}
      <div className="flex flex-col gap-3 pt-1" data-sheet-no-drag data-testid="receipt-peek">
        {receipt && (
          <ReceiptBody key={receipt.id} receipt={receipt} currency={receipt.currency ?? currency} connectionName={connection?.displayName} testIdPrefix="receipt-peek" />
        )}
      </div>
    </Sheet>
  );
}
