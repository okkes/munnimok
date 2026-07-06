import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { TransactionRow } from '@/db/types';
import { AppBar } from '@/ui/AppBar';
import { TxRow } from '@/ui/TxRow';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

function groupByDate(txs: TransactionRow[]): [string, TransactionRow[]][] {
  const groups = new Map<string, TransactionRow[]>();
  for (const tx of txs) {
    const list = groups.get(tx.date) ?? [];
    list.push(tx);
    groups.set(tx.date, list);
  }
  return [...groups.entries()];
}

export function TransactionsScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const navigate = useNavigate();

  const txs = useLiveQuery(
    () =>
      db.transactions
        .where('[spaceId+date]')
        .between([spaceId, ''], [spaceId, '￿'])
        .reverse()
        .filter((tx) => tx.deleted === 0)
        .limit(200)
        .toArray(),
    [spaceId],
  );

  const fmtDay = (iso: string) =>
    new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'short', day: 'numeric', month: 'short' }).format(
      new Date(iso),
    );

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-transactions">
      <AppBar large title={t('tab.transactions')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" data-testid="tx-list">
        {groupByDate(txs ?? []).map(([date, list]) => (
          <div key={date}>
            <div className="m-cap mt-4 mb-1 px-1">{fmtDay(date)}</div>
            <div className="rounded-card border border-line bg-surface px-3 py-1">
              {list.map((tx) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
