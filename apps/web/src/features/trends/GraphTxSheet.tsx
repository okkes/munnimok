import { useLang } from '@/i18n';
import type { SpaceTx } from '@/application/transactions';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

export interface ScopedTx {
  tx: SpaceTx;
  /** what the row contributes to the card's scope (a split's part, a spread's slice) */
  cents: number;
  /** the row's own net — the headline when the scope takes all of it */
  netCents: number;
}

/**
 * The transactions behind a card's number (user 2026-10-08: "the
 * associated transactions like in recurring"): the picked period's rows
 * inside the scope, newest first, the same rows as the transactions list.
 * A row the scope takes only partly shows its share as the headline with
 * the row's own total under it.
 */
export function GraphTxSheet({
  open,
  onOpenChange,
  title,
  rows,
  onOpenTx,
  testId,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  rows: readonly ScopedTx[];
  onOpenTx: (txId: string) => void;
  testId: string;
}>) {
  const { t } = useLang();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} size="tall">
      <div data-testid={testId}>
        {rows.length === 0 ? (
          <p className="px-1 py-3 text-[13px] text-ink-4" data-testid={`${testId}-empty`}>
            {t('trends.txEmpty')}
          </p>
        ) : (
          <div className="divide-y divide-line-2">
            {rows.map(({ tx, cents, netCents }) => (
              <TxRow
                key={tx.id}
                tx={tx}
                showDate
                amountOverrideCents={cents === Math.abs(netCents) ? undefined : -cents}
                onClick={() => onOpenTx(tx.id)}
              />
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
