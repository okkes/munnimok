import type { TxType } from '@/db/types';

// colors near the category palette, not the brand; the type picker is gone (the user chooses a KIND),
// read surfaces still show the resolved type
export const TX_TYPE_VISUAL: Record<TxType, { icon: string; color: string }> = {
  expense: { icon: 'cart-outline', color: '#C0392B' },
  income: { icon: 'cash-plus', color: '#27AE60' },
  saving: { icon: 'piggy-bank-outline', color: '#16A085' },
  transfer: { icon: 'swap-horizontal', color: '#2980B9' },
  debtPayment: { icon: 'hand-coin-outline', color: '#D68910' },
  investment: { icon: 'chart-line', color: '#8E44AD' },
  funding: { icon: 'hand-coin', color: '#16A085' },
  adjustment: { icon: 'tune-variant', color: '#7F8C8D' },
};
