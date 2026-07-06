import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { fmtCents } from '@/lib/money';
import { AppBar } from '@/ui/AppBar';
import { TxRow } from '@/ui/TxRow';

export function HomeScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const navigate = useNavigate();

  const accounts = useLiveQuery(
    () => db.accounts.where('spaceId').equals(spaceId).filter((a) => a.deleted === 0).toArray(),
    [spaceId],
  );
  const recentTxs = useLiveQuery(
    () =>
      db.transactions
        .where('[spaceId+date]')
        .between([spaceId, ''], [spaceId, '￿'])
        .reverse()
        .filter((tx) => tx.deleted === 0)
        .limit(5)
        .toArray(),
    [spaceId],
  );

  const totalCents = (accounts ?? []).reduce((sum, a) => sum + a.balanceCents, 0);
  const currency = accounts?.[0]?.currency ?? 'EUR';

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-home">
      <AppBar large title={t('tab.home')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="rounded-card bg-brand px-5 py-6 text-on-brand">
          <div className="text-xs font-medium uppercase tracking-wider opacity-70">{t('home.balance')}</div>
          <div className="m-num mt-1 text-4xl" data-testid="home-total-balance">
            {accounts ? fmtCents(totalCents, currency, lang) : '—'}
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {(accounts ?? []).map((a) => (
              <div key={a.id} className="flex items-center justify-between text-[13px] opacity-90">
                <span className="truncate">{a.name}</span>
                <span className="m-num">{fmtCents(a.balanceCents, a.currency, lang)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="m-cap mt-6 mb-1 px-1">{t('tab.transactions')}</div>
        <div className="rounded-card border border-line bg-surface px-3 py-1">
          {(recentTxs ?? []).map((tx) => (
            <TxRow
              key={tx.id}
              tx={tx}
              onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
