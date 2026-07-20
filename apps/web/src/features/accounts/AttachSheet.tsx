import { useEffect, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import type { GlobalAccount } from '@/application/accounts';
import { accountLinkId } from '@/domain/feedIds';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import { useData } from '@/app/data';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import type { AccountSource } from '@/db/types';
import { BrandIconPicker } from '@/features/recurring/BrandIconPicker';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { attachAccount, detachAccount, fetchSpaceLinks } from './feedGateway';

/** where an account's data comes from, for the settings section */
export const SOURCE_KEYS: Record<AccountSource, TranslationKey> = {
  manual: 'acct.sourceManual',
  camt053: 'acct.sourceImport',
  gocardless: 'acct.sourceOpenBanking',
};

/**
 * Attach/detach one of YOUR feed accounts to/from your spaces
 * (server-authoritative; the synced accountLink mirror keeps offline
 * devices rendering). Archived attachments (you left the space once)
 * revive through the same attach action — that's the reconnect.
 */
export function AttachSheet({
  open,
  onOpenChange,
  entry,
  canEdit = true,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: GlobalAccount | null;
  /** false for accounts shared WITH me — I don't own their feed */
  canEdit?: boolean;
}>) {
  const { t } = useLang();
  const { store, repo } = useData();
  const [busy, setBusy] = useState<string | null>(null);
  const [historyFrom, setHistoryFrom] = useState('');
  const [name, setName] = useState('');
  const [logoOpen, setLogoOpen] = useState(false);

  const spaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  // LIVE link rows, not the entry snapshot: the checkboxes must flip the
  // moment a toggle writes to Dexie (user bug: they only updated after
  // leaving and re-entering the screen)
  const accountId = entry?.account.id;
  const liveLinks = useQuery(
    store,
    async () =>
      accountId ? (await store.allRows('accountLink')).filter((l) => l.deleted === 0 && l.accountId === accountId) : [],
    [accountId],
  );
  // LIVE account row for the same reason: an icon pick must show up while
  // the sheet stays open (user bug: it looked like nothing happened)
  const liveAccount = useQuery(store, async () => (accountId ? await store.get('account', accountId) : undefined), [
    accountId,
  ]);

  // the date input is an OVERRIDE; empty means each space's own default
  useEffect(() => {
    if (open) {
      setHistoryFrom('');
      setName(entry?.account.name ?? '');
    }
  }, [open, entry?.account.name]);

  if (!entry?.feedSpaceId) return null;
  const { feedSpaceId } = entry;
  const account = liveAccount ?? entry.account;
  const viaBySpace = new Map((liveLinks ?? []).map((l) => [l.spaceId, l]));

  // display name + icon live on the feed's account row — the owner's
  // edit reaches every space the account is shared with (it's their
  // account); raw bank facts (iban, balance) stay untouched
  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== account.name) void repo.upsert('account', account.spaceId, account.id, { name: trimmed });
  };

  const toggle = async (spaceId: string) => {
    if (busy) return;
    setBusy(spaceId);
    try {
      const existing = viaBySpace.get(spaceId);
      if (existing && !existing.archived) {
        const serverLinks = await fetchSpaceLinks(spaceId);
        const serverLink = serverLinks.find((l) => l.feedSpaceId === feedSpaceId && l.accountId === account.id);
        if (serverLink) await detachAccount(spaceId, serverLink.id);
        await repo.remove('accountLink', spaceId, existing.id);
      } else {
        // attach (or revive an archived link — same server action); the
        // override wins, then the space's history start, then the app
        // default — never silently unlimited (user bug report)
        const from =
          historyFrom || (await store.get('space', spaceId))?.historyStartDate || isoMonthsAgo(DEFAULT_HISTORY_MONTHS);
        await attachAccount(spaceId, feedSpaceId, account.id, from);
        await repo.upsert('accountLink', spaceId, accountLinkId(spaceId, feedSpaceId), {
          feedSpaceId,
          accountId: account.id,
          historyFrom: from,
          archived: 0,
        });
      }
    } catch {
      // offline or forbidden — the list simply doesn't change
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={account.name} size="tall">
      {canEdit && (
        <div className="mb-3 flex flex-col gap-2">
          <label className="flex items-center gap-3 text-[13px] text-ink-2">
            {t('acct.displayName')}
            <input
              data-testid="attach-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
            />
          </label>
          <button
            data-testid="attach-change-icon"
            onClick={() => setLogoOpen(true)}
            className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-3 py-2.5 text-left text-[13px] text-ink"
          >
            {account.logo ? (
              <img src={account.logo} alt="" className="h-6 w-6 rounded object-contain" />
            ) : (
              <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
            )}
            <span className="flex-1">{t('acct.changeIcon')}</span>
            <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
          </button>
        </div>
      )}
      <div className="mb-3 flex items-center justify-between px-1 text-[12px]" data-testid="attach-source">
        <span className="text-ink-4">{t('acct.source')}</span>
        <span className="text-ink-2">{t(SOURCE_KEYS[account.source])}</span>
      </div>
      <p className="pb-2 text-[13px] text-ink-3">{t('acct.attachSub')}</p>
      <label className="mb-1 flex items-center gap-3 text-[13px] text-ink-2">
        {t('acct.historyFrom')}
        <input
          data-testid="attach-history-from"
          type="date"
          value={historyFrom}
          onChange={(e) => setHistoryFrom(e.target.value)}
          className="h-10 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
        />
      </label>
      <p className="mb-3 px-1 text-[11px] leading-snug text-ink-4">{t('acct.historyFromHint')}</p>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="attach-spaces">
        {(spaces ?? []).map((space) => {
          const via = viaBySpace.get(space.id);
          const attached = !!via && !via.archived;
          return (
            <button
              key={space.id}
              data-testid={`attach-space-${space.id}`}
              disabled={busy !== null}
              onClick={() => void toggle(space.id)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
            >
              <Icon
                name={attached ? 'checkbox-marked' : 'checkbox-blank-outline'}
                size={20}
                color={attached ? 'var(--m-accent)' : 'var(--m-ink-4)'}
              />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{space.name}</span>
              {via?.archived && (
                <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink-2" data-testid={`attach-archived-${space.id}`}>
                  {t('acct.archivedReconnect')}
                </span>
              )}
              {busy === space.id && <Icon name="loading" size={16} color="var(--m-ink-4)" />}
            </button>
          );
        })}
      </div>
      <BrandIconPicker
        open={logoOpen}
        onOpenChange={setLogoOpen}
        initialQuery={account.name}
        onPick={({ logo }) => {
          void repo.upsert('account', account.spaceId, account.id, { logo: logo ?? (null as never) });
          setLogoOpen(false);
        }}
      />
    </Sheet>
  );
}
