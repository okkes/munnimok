import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@/db/useQuery';
import type { GlobalAccount } from '@/application/accounts';
import { newestTxDate } from '@/application/accounts';
import { setSpaceAttachIntent } from './openHandoff';
import { detachFeedFromSpace } from '@/application/accountAttach';
import { purgeAccountRemnants } from '@/application/accountPurge';
import { logActivity } from '@/application/activity';
import { settleSpaceReimbursements } from '@/application/catalogMaintenance';
import { SharedSpaceBadge } from '@/features/spaces/SpaceSwitcher';
import { useData } from '@/app/data';
import { useReadOnlySpaceIds } from '@/app/useCanEdit';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import type { AccountRow, AccountSource } from '@/db/types';
import { partyName } from '@/features/connectors/logos';
import { BrandIconPicker } from '@/features/recurring/BrandIconPicker';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';
import { Sheet } from '@/ui/Sheet';
import { deleteFeedAccount } from './feedGateway';

interface ImportBatchView {
  id: string;
  count: number;
  from: string;
  to: string;
  importedBy?: string;
}

export const SOURCE_KEYS: Record<AccountSource, TranslationKey> = {
  manual: 'acct.sourceManual',
  camt053: 'acct.sourceImport',
  connector: 'acct.sourceConnector',
};

/** the table read with a source as stored — a row written by an earlier build may carry one this build no longer lists */
const sourceKeyOf = (source: string): TranslationKey | undefined => (SOURCE_KEYS as Record<string, TranslationKey | undefined>)[source];

// a source this build no longer lists (`gocardless`, retired in #414) reads as fetched by that party, not a crash
export const sourceKeyFor = (account: Pick<AccountRow, 'source' | 'provider'>): TranslationKey =>
  sourceKeyOf(account.source) ?? 'acct.sourceConnector';

export const sourceParamsFor = (account: Pick<AccountRow, 'source' | 'provider'>): Record<string, string> => {
  const listed = sourceKeyOf(account.source);
  if (listed && account.source !== 'connector') return {};
  return { party: partyName(account.provider ?? account.source) };
};

/** rows a party keeps current by itself, as opposed to statements a human uploads */
export const fetchesItself = (account: Pick<AccountRow, 'source'>): boolean => account.source === 'connector';

/** global view of one of YOUR feed accounts: detach-only, attaching happens on each space's own accounts screen */
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
  const { store, repo, engine, spaceId } = useData();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [detachSpaceId, setDetachSpaceId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [logoOpen, setLogoOpen] = useState(false);
  const [renameAsk, setRenameAsk] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  // #185: a big account deletes in visible stages: server first, then the local purge
  const [deleteStage, setDeleteStage] = useState<'server' | 'local'>('server');

  const spaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  const readOnlySpaces = useReadOnlySpaceIds(); // #505
  // live link rows, not the entry snapshot: the checkboxes must flip as soon as a toggle writes to Dexie
  const accountId = entry?.account.id;
  const liveLinks = useQuery(
    store,
    async () =>
      accountId ? (await store.allRows('accountLink')).filter((l) => l.deleted === 0 && l.accountId === accountId) : [],
    [accountId],
  );
  // live account row: an icon pick must show while the sheet stays open
  const liveAccount = useQuery(store, async () => (accountId ? await store.get('account', accountId) : undefined), [
    accountId,
  ]);
  const newestTx = useQuery(store, async () => (accountId ? newestTxDate(store, accountId) : undefined), [accountId]);

  const batches =
    useQuery(
      store,
      async () => {
        if (!accountId) return [] as ImportBatchView[];
        const byBatch = new Map<string, ImportBatchView>();
        for (const tx of await store.allRows('transaction')) {
          if (tx.deleted !== 0 || tx.accountId !== accountId || !tx.importBatchId) continue;
          const batch = byBatch.get(tx.importBatchId) ?? {
            id: tx.importBatchId,
            count: 0,
            from: tx.date,
            to: tx.date,
            importedBy: tx.importedBy,
          };
          batch.count++;
          if (tx.date < batch.from) batch.from = tx.date;
          if (tx.date > batch.to) batch.to = tx.date;
          byBatch.set(tx.importBatchId, batch);
        }
        return [...byBatch.values()].sort((a, b) => b.to.localeCompare(a.to));
      },
      [accountId],
    ) ?? [];
  const [rollbackBatch, setRollbackBatch] = useState<ImportBatchView | null>(null);
  const rollback = async () => {
    if (!rollbackBatch) return;
    // a batch removes only rows it created: rows an upload merely re-encountered keep their first batch id
    for (const tx of await store.allRows('transaction')) {
      if (tx.deleted === 0 && tx.importBatchId === rollbackBatch.id) await repo.remove('transaction', tx.spaceId, tx.id);
    }
    // #617: a reimbursement that named one of those rows is none any more
    await settleSpaceReimbursements(store, repo, spaceId).catch(() => undefined);
    void logActivity(store, repo, spaceId, 'importRollback', `${rollbackBatch.count}`);
    setRollbackBatch(null);
  };

  useEffect(() => {
    if (open) setName(entry?.account.name ?? '');
  }, [open, entry?.account.name]);

  if (!entry?.feedSpaceId) return null;
  const { feedSpaceId } = entry;
  const account = liveAccount ?? entry.account;
  const viaBySpace = new Map((liveLinks ?? []).map((l) => [l.spaceId, l]));

  // name and icon live on the feed's account row: the owner's edit reaches every space it is shared with
  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== account.name) {
      void repo.upsert('account', account.spaceId, account.id, { name: trimmed });
      void logActivity(store, repo, spaceId, 'accountEdit', trimmed);
      // #239: spaces may hold their own name for the account: a global rename asks whether those follow or stay
      if ((liveLinks ?? []).some((l) => l.displayName)) setRenameAsk(trimmed);
    }
  };

  // #239: replace every space's own name with the fresh global one
  // (#505: a space this identity only reads keeps its name for the account)
  const renameEverywhere = () => {
    for (const link of liveLinks ?? []) {
      if (link.displayName) void repo.upkeep().upsert('accountLink', link.spaceId, link.id, { displayName: null as never });
    }
    setRenameAsk(null);
  };

  const deleteAccount = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteFailed(false);
    setDeleteStage('server');
    try {
      // server first: consent revocation + cascade, or partial removal when someone else still covers the account
      await deleteFeedAccount(feedSpaceId);
      // my synced mirrors tombstone via the outbox; the feed's local rows are purged directly (no longer ours)
      // #505: a space this identity only reads gets the server's own tombstones: skipped here, never a halt
      setDeleteStage('local');
      const upkeep = repo.upkeep();
      for (const link of liveLinks ?? []) {
        await upkeep.remove('accountLink', link.spaceId, link.id);
      }
      // #279: the engine purge is feed-keyed: member spaces keep txMeta overlays and own rows unless swept here
      await purgeAccountRemnants(store, upkeep, account.id, feedSpaceId);
      await engine?.purgeSpace(feedSpaceId);
      void logActivity(store, repo, spaceId, 'accountRemove', account.name);
      setDeleteOpen(false);
      onOpenChange(false);
    } catch {
      setDeleteFailed(true);
    } finally {
      setDeleteBusy(false);
    }
  };

  const detach = async () => {
    if (busy || !detachSpaceId) return;
    setBusy(detachSpaceId);
    try {
      await detachFeedFromSpace(store, repo, detachSpaceId, feedSpaceId, account.id);
      setDetachSpaceId(null);
    } catch {
      // offline or forbidden — the list simply doesn't change
    } finally {
      setBusy(null);
    }
  };

  // only the spaces the account currently feeds (archived = left once; revive on the space's own accounts screen)
  const attachedSpaces = (spaces ?? [])
    .map((space) => ({ space, via: viaBySpace.get(space.id) }))
    .filter((row) => !!row.via);
  const activeSpace = (spaces ?? []).find((s) => s.id === spaceId);

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange} title={account.name} size="tall" dragHandle>
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
              <Picture src={account.logo} className="h-6 w-6 rounded object-contain" />
            ) : (
              <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
            )}
            <span className="flex-1">{t('acct.changeIcon')}</span>
            <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
          </button>
        </div>
      )}
      {/* #212: no type here: a global account is just an account, each space decides at attach time */}
      <div className="mb-3 flex items-center justify-between px-1 text-[12px]" data-testid="attach-source">
        <span className="text-ink-4">{t('acct.source')}</span>
        <span className="text-ink-2">{t(sourceKeyFor(account), sourceParamsFor(account))}</span>
      </div>
      {account.dataThroughDate && (
        <div className="mb-3 flex items-center justify-between px-1 text-[12px]" data-testid="attach-datathrough">
          <span className="text-ink-4">{t('acct.dataThroughLabel')}</span>
          <span className="font-mono text-ink-2">{account.dataThroughDate}</span>
        </div>
      )}
      <div className="mb-3 flex items-center justify-between px-1 text-[12px]" data-testid="attach-newest-tx">
        <span className="text-ink-4">{t('acct.newestTx')}</span>
        <span className="font-mono text-ink-2">{newestTx ?? '—'}</span>
      </div>
      <p className="pb-2 text-[13px] text-ink-3">{t('acct.attachedSpaces')}</p>
      {attachedSpaces.length === 0 && (
        <p className="px-1 text-[13px] text-ink-4" data-testid="attach-none">
          {t('acct.notAttached')}
        </p>
      )}
      {/* #318: a link-less account offers the current space through the real attach flow, never a silent attach */}
      {canEdit && liveLinks?.length === 0 && activeSpace && !readOnlySpaces.has(activeSpace.id) && (
        <Button
          variant="outline"
          className="mt-2 w-full"
          data-testid="account-attach-here"
          onClick={() => {
            setSpaceAttachIntent(account.id);
            onOpenChange(false);
            void navigate({ to: '/spaces/$spaceId/accounts', params: { spaceId } });
          }}
        >
          <Icon name="link-plus" size={16} />
          {t('acct.attachHere', { space: activeSpace.name })}
        </Button>
      )}
      {attachedSpaces.length > 0 && (
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="attach-spaces">
          {attachedSpaces.map(({ space, via }) => (
            <div
              key={space.id}
              data-testid={`attach-space-${space.id}`}
              className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0"
            >
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{space.name}</span>
              {space.kind === 'shared' && <SharedSpaceBadge testId={`attach-space-shared-${space.id}`} />}
              {via?.historyFrom && <span className="font-mono text-[11px] text-ink-4">{via.historyFrom}</span>}
              {via?.archived && (
                <span
                  className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink-2"
                  data-testid={`attach-archived-${space.id}`}
                >
                  {t('acct.archivedReconnect')}
                </span>
              )}
              {/* #505: a space this identity only reads keeps its accounts */}
              {!via?.archived && !readOnlySpaces.has(space.id) && (
                <button
                  aria-label={t('acct.detach')}
                  data-testid={`attach-detach-${space.id}`}
                  disabled={busy !== null}
                  onClick={() => setDetachSpaceId(space.id)}
                  className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-4"
                >
                  <Icon name="link-off" size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canEdit && batches.length > 0 && (
        <>
          <div className="m-cap mt-4 mb-1 px-1">{t('imports.section')}</div>
          <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="attach-imports">
            {batches.map((batch) => (
              <div key={batch.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
                <Icon name="file-upload-outline" size={18} color="var(--m-ink-3)" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink">
                    {t('imports.batch', { n: batch.count, from: batch.from, to: batch.to })}
                  </span>
                  {batch.importedBy && (
                    <span className="block text-[11px] text-ink-4">{t('imports.by', { name: batch.importedBy })}</span>
                  )}
                </span>
                <button
                  aria-label={t('imports.rollback')}
                  data-testid={`attach-rollback-${batch.id}`}
                  onClick={() => setRollbackBatch(batch)}
                  className="m-tap border-none bg-transparent text-negative"
                >
                  <Icon name="file-undo" size={18} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {/* deletion exists for connected accounts too: syncing identities only, the server owns the cascade */}
      {canEdit && engine && (
        <Button
          variant="danger"
          className="mt-4 w-full"
          data-testid="attach-delete"
          onClick={() => {
            setDeleteFailed(false);
            setDeleteOpen(true);
          }}
        >
          {t('acct.deleteAccount')}
        </Button>
      )}
    </Sheet>
    {/* #241: siblings, not children: a nested sheet portals first and paints below its parent (body order) */}
    <BrandIconPicker
      open={logoOpen}
      onOpenChange={setLogoOpen}
      initialQuery={account.name}
      onPick={({ logo }) => {
        void repo.upsert('account', account.spaceId, account.id, { logo: logo ?? (null as never) });
        void logActivity(store, repo, spaceId, 'accountEdit', account.name);
        setLogoOpen(false);
      }}
    />
    <Sheet
      open={renameAsk !== null}
      onOpenChange={(next) => {
        if (!next) setRenameAsk(null);
      }}
      title={t('acct.renameSpacesTitle')}
      size="compact"
    >
      <p className="pb-4 text-[13px] leading-relaxed text-ink-2" data-testid="attach-rename-ask">
        {t('acct.renameSpacesBody', { name: renameAsk ?? '' })}
      </p>
      <div className="flex flex-col gap-2">
        <Button data-testid="attach-rename-everywhere" onClick={renameEverywhere}>
          {t('acct.renameSpacesGo')}
        </Button>
        <Button variant="outline" data-testid="attach-rename-keep" onClick={() => setRenameAsk(null)}>
          {t('acct.renameSpacesKeep')}
        </Button>
      </div>
    </Sheet>
    {/* #288: the destructive confirms are siblings too (same #241 body-order rule) */}
    <DangerConfirmSheet
      open={rollbackBatch !== null}
      onOpenChange={(o) => !o && setRollbackBatch(null)}
      title={t('imports.rollback')}
      body={t('imports.rollbackBody', { n: rollbackBatch?.count ?? 0, from: rollbackBatch?.from ?? '', to: rollbackBatch?.to ?? '' })}
      onConfirm={() => void rollback()}
      testId="attach-rollback"
    />
    <DangerConfirmSheet
      open={detachSpaceId !== null}
      onOpenChange={(o) => !o && setDetachSpaceId(null)}
      title={t('acct.detachConfirmTitle')}
      body={t('acct.detachConfirmBodySpace', {
        account: account.name,
        space: (spaces ?? []).find((s) => s.id === detachSpaceId)?.name ?? '',
      })}
      busy={busy !== null}
      onConfirm={() => void detach()}
      testId="attach-detach"
    />
    <DangerConfirmSheet
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
      title={t('acct.deleteConfirmTitle')}
      body={t('acct.deleteConfirmBody')}
      busy={deleteBusy}
      busyText={deleteStage === 'local' ? t('acct.deleteStageLocal') : t('acct.deleteStageServer')}
      error={deleteFailed ? t('acct.deleteFailed') : null}
      onConfirm={() => void deleteAccount()}
      testId="attach-delete"
    />
    </>
  );
}
