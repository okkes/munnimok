import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { AccountRow } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';

interface AttachedAccountEntry {
  key: string;
  name: string;
  subtitle: string;
  archived: boolean;
}

/**
 * The financial accounts this space sees: manual/imported accounts that
 * live in the space itself plus feed accounts attached via accountLink
 * rows. Extracted from the overloaded space-settings screen (user
 * remark) — pure local data, renders offline for every identity.
 */
export function SpaceAccountsScreen() {
  const { t } = useLang();
  const { store } = useData();
  const navigate = useNavigate();
  const router = useRouter();
  const { spaceId } = useParams({ strict: false }) as { spaceId: string };
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);

  const entries = useQuery(store, async () => {
    // reads only — a teardown/closed-db rejection must never escape
    const [allAccounts, allLinks] = await Promise.all([
      store.bySpace('account', spaceId),
      store.bySpace('accountLink', spaceId),
    ]).catch(() => [[], []] as const);
    const ownAccounts = allAccounts.filter((a) => a.deleted === 0);
    const links = allLinks.filter((l) => l.deleted === 0);
    const feedAccounts = new Map<string, AccountRow>();
    const linkedIds = new Set(links.map((l) => l.accountId));
    const linked = await Promise.all([...linkedIds].map((id) => store.get('account', id))).catch(() => []);
    for (const account of linked) {
      if (account) feedAccounts.set(account.id, account);
    }
    const ibanTail = (iban?: string) => (iban ? `…${iban.slice(-4)}` : undefined);
    const list: AttachedAccountEntry[] = ownAccounts.map((account) => ({
      key: account.id,
      name: account.name,
      subtitle: [ibanTail(account.iban), t(account.source === 'manual' ? 'acct.manual' : 'acct.automated')]
        .filter(Boolean)
        .join(' · '),
      archived: !!account.archived,
    }));
    for (const link of links) {
      const account = feedAccounts.get(link.accountId);
      list.push({
        key: link.id,
        name: account?.name ?? t('acct.bank'),
        subtitle: [
          ibanTail(account?.iban),
          link.attachedByName ? `${t('space.by')} ${link.attachedByName}` : undefined,
          link.historyFrom ? `${t('acct.historyFrom')} ${link.historyFrom}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        archived: !!link.archived,
      });
    }
    list.sort((x, y) => x.name.localeCompare(y.name));
    return list;
  }, [spaceId]);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-space-accounts">
      <AppBar
        title={t('space.financialAccounts')}
        sub={space?.name}
        leading={
          <IconButton label={t('action.back')} testId="spaceaccounts-back" onClick={() => router.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <div className="pt-1" data-testid="space-accounts">
          {entries?.length === 0 && (
            <p className="px-1 text-[13px] text-ink-4" data-testid="space-accounts-empty">
              {t('space.noAccounts')}
            </p>
          )}
          {!!entries?.length && (
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {entries.map((entry) => (
                <Row
                  key={entry.key}
                  kind="data"
                  icon="bank-outline"
                  title={entry.name}
                  sub={entry.subtitle || undefined}
                  trailing={entry.archived ? <Pill>{t('acct.archived')}</Pill> : undefined}
                />
              ))}
            </div>
          )}
          <button
            data-testid="space-accounts-manage"
            onClick={() => void navigate({ to: '/accounts' })}
            className="m-tap mt-1.5 flex items-center gap-1 border-none bg-transparent px-1 text-[13px] text-accent-deep"
          >
            {t('space.manageAccounts')}
            <Icon name="chevron-right" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
