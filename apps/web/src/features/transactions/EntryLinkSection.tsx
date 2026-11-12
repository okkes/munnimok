import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { bankRowsOf, linkEntry, unlinkEntry } from '@/application/entryLink';
import type { BankRowRef } from '@/application/entryLink';
import { parseLocalDate } from '@/application/planningModel';
import type { SpaceAccount, SpaceTx } from '@/application/transactions';
import type { TransactionRow } from '@/db/types';
import { useQuery } from '@/db/useQuery';
import { canCountInBalance, isEntry, linkCandidates } from '@/domain/entryMatch';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

/** the bank rows an entry could be linked to, and a way to reach any bank row of the space by id */
function useBankRows(entryId: string | undefined, active: boolean) {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const entry = entryId && active ? await store.get('transaction', entryId) : undefined;
      if (!entry) return null;
      const accounts = new Map<string, SpaceAccount>();
      for (const account of await store.bySpace('account', spaceId)) if (account.deleted === 0) accounts.set(account.id, account);
      const own = await store.get('account', entry.accountId);
      if (own?.deleted === 0) accounts.set(own.id, own);
      const rows = await bankRowsOf(store, spaceId, accounts);
      const taken = new Set((await store.bySpace('transaction', spaceId)).filter((row) => row.deleted === 0 && !!row.bankTxId && row.id !== entry.id).map((row) => row.bankTxId!));
      const candidates = linkCandidates(entry, [...rows.values()].map((row) => row.raw), taken);
      return { rows, candidates };
    },
    [spaceId, entryId, active],
  );
}

/**
 * The review card's line for a row an entry was linked to (user: "show
 * during the transaction review that we have automatically linked the new
 * transaction with an existing manual transaction and that the user can
 * manage it on the spot"): what was typed, and Take apart right there —
 * picking another row lives on the transaction's page, one tap away.
 */
export function EntryReviewRow({ tx }: Readonly<{ tx: SpaceTx }>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, repo, spaceId } = useData();
  const { fmt } = useDisplayMoney();
  const [busy, setBusy] = useState(false);
  const linked = tx.entry;
  if (!linked) return null;
  const takeApart = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const entry = await store.get('transaction', linked.id);
      if (!entry?.bankTxId) return;
      const raw = await store.get('transaction', entry.bankTxId);
      await unlinkEntry(store, repo, spaceId, entry, raw ? { raw, feedSpaceId: raw.spaceId === spaceId ? undefined : raw.spaceId } : undefined);
      void logActivity(store, repo, spaceId, 'entryUnlink', linked.title);
    } finally {
      setBusy(false);
    }
  };
  const day = parseLocalDate(linked.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
  return (
    <div className="flex items-center" data-testid="review-entry-row">
      <button
        type="button"
        data-testid="review-entry-open"
        onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
        className="m-tap flex min-w-0 flex-1 items-center gap-2.5 border-none bg-transparent py-2.5 pr-1 pl-4 text-left text-[14px] text-ink"
      >
        <Icon name="link-variant" size={18} color="var(--m-accent-deep)" />
        <span className="min-w-0 flex-1 truncate">{t('review.linkedEntry', { date: day, amount: fmt(linked.amountCents, tx.currency) })}</span>
      </button>
      <button
        type="button"
        data-testid="review-entry-unlink"
        disabled={busy}
        onClick={() => void takeApart()}
        className="m-tap mr-3 shrink-0 border-none bg-transparent text-[12px] font-semibold text-accent-deep"
      >
        {t('entry.unlink')}
      </button>
    </div>
  );
}

/**
 * #547 (user): "we should visualize … that manual and auto transactions
 * are merged, but give the user the option to unlink it (and of course
 * allow the user to link transactions they wish)". On the bank's row: what
 * was typed, with Take apart and Pick another. On an entry the bank has
 * not shown yet: that it waits, whether it counts in the balance here, and
 * a door to link it by hand.
 */
export function EntryLinkSection({ tx, account, readOnly }: Readonly<{ tx: SpaceTx; account: SpaceAccount | undefined; readOnly: boolean }>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, repo, spaceId } = useData();
  const { fmt } = useDisplayMoney();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const waiting = !tx.entry && !tx.feedSpaceId && isEntry(tx, account);
  // the stored entry: the one behind this bank row, or this row itself
  const entryId = tx.entry?.id ?? (waiting ? tx.id : undefined);
  const bank = useBankRows(entryId, picking);
  // read at the moment of the act: a tap must never work on a row as it was when the page opened
  const storedEntry = async (): Promise<TransactionRow | undefined> => (entryId ? store.get('transaction', entryId) : undefined);
  if (!tx.entry && !waiting) return null;

  const day = (iso: string) => parseLocalDate(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const bankRefOf = async (id: string): Promise<BankRowRef | undefined> => {
    const raw = await store.get('transaction', id);
    return raw ? { raw, feedSpaceId: raw.spaceId === spaceId ? undefined : raw.spaceId } : undefined;
  };

  const takeApart = () =>
    run(async () => {
      const entry = await storedEntry();
      if (!entry?.bankTxId) return;
      await unlinkEntry(store, repo, spaceId, entry, await bankRefOf(entry.bankTxId));
      void logActivity(store, repo, spaceId, 'entryUnlink', tx.entry?.title ?? entry.merchant);
    });

  const linkTo = (target: BankRowRef) =>
    run(async () => {
      const entry = await storedEntry();
      if (!entry) return;
      setPicking(false);
      // picking another first hands the story back, so it moves on to the new row whole
      if (entry.bankTxId) await unlinkEntry(store, repo, spaceId, entry, await bankRefOf(entry.bankTxId));
      const fresh = (await store.get('transaction', entry.id)) ?? entry;
      await linkEntry(store, repo, spaceId, fresh, target, false);
      void logActivity(store, repo, spaceId, 'entryLink', entry.titleOverride || entry.merchant);
      // the entry is behind the bank's row from here on: that row is the page to be on
      if (target.raw.id !== tx.id) void navigate({ to: '/transactions/$txId', params: { txId: target.raw.id }, replace: true });
    });

  const counts = waiting && tx.inBalance === 1;
  const canCount = !!account && canCountInBalance(tx.date, account);
  const setCounts = (on: boolean) => void repo.upsert('transaction', spaceId, tx.id, { inBalance: on ? 1 : 0 });
  let balanceLine = t('txform.inBalanceLocked', { date: account?.balanceAsOf ?? '' });
  if (canCount) balanceLine = t(counts ? 'entry.counted' : 'entry.notCounted');

  return (
    <>
      <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="tx-entry" data-state={tx.entry ? 'linked' : 'waiting'}>
        <div className="flex items-center gap-2">
          <Icon name={tx.entry ? 'link-variant' : 'clock-outline'} size={18} color="var(--m-accent-deep)" />
          <span className="text-[14px] font-semibold text-ink">{t(tx.entry ? 'entry.linkedTitle' : 'entry.waitingTitle')}</span>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-ink-2" data-testid="tx-entry-body">
          {tx.entry
            ? t('entry.linkedBody', { amount: fmt(tx.entry.amountCents, tx.currency), date: day(tx.entry.date), title: tx.entry.title })
            : t('entry.waitingBody')}
        </p>
        {waiting && (
          <label className={`mt-2 flex items-start gap-2 text-[12px] leading-snug ${canCount ? 'cursor-pointer text-ink-2' : 'text-ink-4'}`}>
            <input
              type="checkbox"
              data-testid="tx-entry-in-balance"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--m-accent)]"
              checked={counts && canCount}
              disabled={readOnly || !canCount}
              onChange={(e) => setCounts(e.target.checked)}
            />
            <span className="min-w-0 flex-1">{balanceLine}</span>
          </label>
        )}
        {!readOnly && (
          <div className="mt-3 flex gap-2">
            {tx.entry && (
              <Button variant="outline" className="flex-1" data-testid="tx-entry-unlink" disabled={busy} onClick={() => void takeApart()}>
                {t('entry.unlink')}
              </Button>
            )}
            <Button variant="outline" className="flex-1" data-testid="tx-entry-pick" disabled={busy} onClick={() => setPicking(true)}>
              {t(tx.entry ? 'entry.pickAnother' : 'entry.link')}
            </Button>
          </div>
        )}
      </div>

      <Sheet open={picking} onOpenChange={setPicking} title={t('entry.pickTitle')} size="tall">
        <div className="divide-y divide-line-2 pt-1" data-testid="tx-entry-candidates">
          {(bank?.candidates ?? []).map((row) => (
            <div key={row.id} data-testid={`tx-entry-candidate-${row.id}`}>
              <TxRow
                tx={row}
                showDate
                onClick={() => {
                  const target = bank?.rows.get(row.id);
                  if (target) void linkTo(target);
                }}
              />
            </div>
          ))}
          {bank?.candidates.length === 0 && (
            <p className="px-1 py-4 text-[12px] leading-snug text-ink-4" data-testid="tx-entry-candidates-empty">
              {t('entry.pickEmpty')}
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}
