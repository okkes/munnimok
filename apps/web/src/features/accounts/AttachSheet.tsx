import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { GlobalAccount } from '@/application/accounts';
import { accountLinkId } from '@/domain/feedIds';
import { useData } from '@/app/data';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { attachAccount, detachAccount, fetchSpaceLinks } from './feedGateway';

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: GlobalAccount | null;
}) {
  const { t } = useLang();
  const { db, repo } = useData();
  const [busy, setBusy] = useState<string | null>(null);
  const [historyFrom, setHistoryFrom] = useState('');

  const spaces = useLiveQuery(() => db.spaces.filter((s) => s.deleted === 0).toArray(), [db]);

  // prefill from the first space default when opening (editable at attach)
  useEffect(() => {
    if (open) setHistoryFrom(spaces?.find((s) => s.historyStartDate)?.historyStartDate ?? '');
  }, [open, spaces]);

  if (!entry?.feedSpaceId) return null;
  const { account, feedSpaceId, sharedVia } = entry;
  const viaBySpace = new Map(sharedVia.map((v) => [v.spaceId, v]));

  const toggle = async (spaceId: string) => {
    if (busy) return;
    setBusy(spaceId);
    try {
      const existing = viaBySpace.get(spaceId);
      if (existing && !existing.archived) {
        const serverLinks = await fetchSpaceLinks(spaceId);
        const serverLink = serverLinks.find((l) => l.feedSpaceId === feedSpaceId && l.accountId === account.id);
        if (serverLink) await detachAccount(spaceId, serverLink.id);
        await repo.remove('accountLink', spaceId, existing.linkRowId);
      } else {
        // attach (or revive an archived link — same server action)
        const from = historyFrom || (await db.spaces.get(spaceId))?.historyStartDate;
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
    <Sheet open={open} onOpenChange={onOpenChange} title={account.name} size="form">
      <p className="pb-2 text-[13px] text-ink-3">{t('acct.attachSub')}</p>
      <label className="mb-3 flex items-center gap-3 text-[13px] text-ink-2">
        {t('acct.historyFrom')}
        <input
          data-testid="attach-history-from"
          type="date"
          value={historyFrom}
          onChange={(e) => setHistoryFrom(e.target.value)}
          className="h-10 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
        />
      </label>
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
    </Sheet>
  );
}
