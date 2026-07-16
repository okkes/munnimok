import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { v7 as uuidv7 } from 'uuid';
import { useLang, LOCALES } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { apiFetch } from '@/lib/api';
import { fmtCents, parseCents } from '@/lib/money';
import { netPositions, settlementPlan } from '@/domain/splitLedger';
import type { LedgerEntry } from '@/domain/splitLedger';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

interface SplitSummary {
  id: string;
  name: string;
  currency: string;
  status: string;
  role: string;
  memberCount: number;
  entryCount: number;
}
interface SplitMember {
  userId: string;
  role: string;
  displayName: string | null;
  isMe: boolean;
}
interface SplitEntryRow {
  id: string;
  kind: string;
  paidByUserId: string;
  description: string;
  amountCents: number;
  date: string;
  shares: { userId: string; cents: number }[];
  createdBy: string;
}
interface SplitDetail {
  id: string;
  name: string;
  currency: string;
  status: string;
  role: string;
  members: SplitMember[];
  entries: SplitEntryRow[];
}

const memberName = (member: SplitMember | undefined, meLabel: string) =>
  member?.isMe ? meLabel : (member?.displayName ?? '…');

const netTone = (net: number): string => {
  if (net > 0) return 'text-accent-deep';
  if (net < 0) return 'text-negative';
  return 'text-ink-3';
};

/**
 * Split sessions (settleup-splits SP1): Splitwise-style group ledgers
 * whose membership is independent of spaces — server-resident and
 * online-only, so only signed-in identities see the feature.
 */
export function SplitsScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { spaceId } = useData();
  const [splits, setSplits] = useState<SplitSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);

  const reload = useCallback(async () => {
    const res = await apiFetch('/splits').catch(() => null);
    if (res?.ok) {
      setSplits((await res.json()) as SplitSummary[]);
      setOffline(false);
    } else {
      setOffline(true);
      setSplits((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const id = uuidv7();
    const res = await apiFetch('/splits', {
      method: 'POST',
      body: JSON.stringify({ id, name: name.trim(), currency: 'EUR', spaceId }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setOffline(true);
      return;
    }
    setCreateOpen(false);
    setName('');
    await navigate({ to: '/splits/$splitId', params: { splitId: id } });
  };

  return (
    <div className="flex h-dvh flex-col bg-bg" data-testid="screen-splits">
      <AppBar
        title={t('splits.title')}
        leading={
          <IconButton label={t('action.back')} testId="splits-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          <IconButton label={t('splits.new')} testId="splits-add" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {offline && (
          <p className="py-2 text-center text-[12px] text-ink-4" data-testid="splits-offline">
            {t('splits.offline')}
          </p>
        )}
        {splits !== null && splits.length === 0 && !offline && (
          <div className="pt-16 text-center" data-testid="splits-empty">
            <Icon name="account-cash-outline" size={40} color="var(--m-ink-4)" />
            <p className="mt-3 text-[15px] font-medium text-ink">{t('splits.emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-[280px] text-[13px] text-ink-3">{t('splits.emptyBody')}</p>
          </div>
        )}
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {(splits ?? []).map((split) => (
            <button
              key={split.id}
              data-testid={`split-row-${split.id}`}
              onClick={() => void navigate({ to: '/splits/$splitId', params: { splitId: split.id } })}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3.5 text-left last:border-0"
            >
              <Icon name="account-cash-outline" size={20} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-ink">{split.name}</span>
                <span className="block text-[11px] text-ink-4">
                  {split.memberCount === 1 ? t('splits.membersCountOne') : t('splits.membersCount', { n: split.memberCount })}
                  {' · '}
                  {split.entryCount === 1 ? t('splits.entriesCountOne') : t('splits.entriesCount', { n: split.entryCount })}
                </span>
              </span>
              {split.status === 'settled' && <span className="text-[11px] text-ink-4">{t('splits.settled')}</span>}
              <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
            </button>
          ))}
          {splits === null && <div className="px-4 py-6 text-center text-[13px] text-ink-4">…</div>}
        </div>
      </div>

      <Sheet open={createOpen} onOpenChange={setCreateOpen} title={t('splits.new')} size="form">
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="split-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('splits.namePlaceholder')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <p className="text-[12px] text-ink-4">{t('splits.createHint')}</p>
          <Button data-testid="split-create" disabled={busy || !name.trim()} onClick={() => void create()}>
            {t('action.create')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

export function SplitDetailScreen() {
  const { t, lang } = useLang();
  const { splitId } = useParams({ strict: false }) as { splitId: string };
  const { identity } = useSession();
  const [detail, setDetail] = useState<SplitDetail | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await apiFetch(`/splits/${splitId}`).catch(() => null);
    if (res?.ok) setDetail((await res.json()) as SplitDetail);
  }, [splitId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const me = detail?.members.find((m) => m.isMe);
  const nameOf = useCallback(
    (userId: string) => memberName(detail?.members.find((m) => m.userId === userId), t('word.you')),
    [detail, t],
  );

  const ledger = useMemo(() => {
    if (!detail) return null;
    const entries: LedgerEntry[] = detail.entries.map((e) => ({
      paidByUserId: e.paidByUserId,
      amountCents: e.amountCents,
      shares: e.shares.map((s) => ({ userId: s.userId, cents: s.cents })),
    }));
    const nets = netPositions(entries, detail.members.map((m) => m.userId));
    return { nets, plan: settlementPlan(nets) };
  }, [detail]);

  const addEntry = async () => {
    const cents = parseCents(amount) ?? 0;
    if (!description.trim() || cents <= 0 || !detail) return;
    setBusy(true);
    const res = await apiFetch(`/splits/${splitId}/entries`, {
      method: 'POST',
      body: JSON.stringify({
        id: uuidv7(),
        kind: 'expense',
        paidByUserId: paidBy ?? me?.userId,
        description: description.trim(),
        amountCents: cents,
        date: new Date().toISOString().slice(0, 10),
      }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return;
    setAddOpen(false);
    setDescription('');
    setAmount('');
    setPaidBy(null);
    await reload();
  };

  if (identity?.kind !== 'user') return null;

  return (
    <div className="flex h-dvh flex-col bg-bg" data-testid="screen-split-detail">
      <AppBar
        title={detail?.name ?? '…'}
        leading={
          <IconButton label={t('action.back')} testId="split-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          detail?.status === 'open' ? (
            <IconButton label={t('splits.addEntry')} testId="split-add-entry" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={22} />
            </IconButton>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* who owes whom — the whole point, so it leads */}
        {ledger && detail && detail.entries.length > 0 && (
          <>
            <div className="m-cap mt-2 mb-1 px-1">{t('splits.balances')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="split-ledger">
              {detail.members.map((member) => {
                const net = ledger.nets.get(member.userId) ?? 0;
                return (
                  <div key={member.userId} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{memberName(member, t('word.you'))}</span>
                    <span className={`m-num text-[14px] font-semibold ${netTone(net)}`}>
                      {fmtCents(net, detail.currency, lang, { sign: true })}
                    </span>
                  </div>
                );
              })}
              {ledger.plan.length > 0 && <div className="mx-4 h-px bg-line-2" />}
              {ledger.plan.map((transfer) => (
                <div
                  key={`${transfer.fromUserId}-${transfer.toUserId}`}
                  data-testid="split-transfer"
                  className="flex items-center gap-2 px-4 py-2.5 text-[13px] text-ink-2"
                >
                  <Icon name="arrow-right-thin" size={16} color="var(--m-ink-4)" />
                  {t('splits.owes', {
                    from: nameOf(transfer.fromUserId),
                    to: nameOf(transfer.toUserId),
                    amount: fmtCents(transfer.cents, detail.currency, lang),
                  })}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="m-cap mt-5 mb-1 px-1">{t('splits.entries')}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="split-entries">
          {(detail?.entries ?? []).map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{entry.description}</span>
                <span className="block text-[11px] text-ink-4">
                  {new Date(entry.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' })} ·{' '}
                  {t('splits.paidBy', { name: nameOf(entry.paidByUserId) })}
                </span>
              </span>
              <span className="m-num text-[14px] font-semibold text-ink">
                {fmtCents(entry.amountCents, detail?.currency ?? 'EUR', lang)}
              </span>
            </div>
          ))}
          {detail !== null && detail.entries.length === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-ink-4">{t('splits.noEntries')}</div>
          )}
          {detail === null && <div className="px-4 py-6 text-center text-[13px] text-ink-4">…</div>}
        </div>

        <div className="m-cap mt-5 mb-1 px-1">{t('space.members')}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="split-members">
          {(detail?.members ?? []).map((member) => (
            <div key={member.userId} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
              <Icon name="account-outline" size={18} color="var(--m-ink-3)" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{memberName(member, t('word.you'))}</span>
              {member.role === 'owner' && <span className="text-[11px] text-ink-4">{t('space.permOwner')}</span>}
            </div>
          ))}
        </div>
      </div>

      <Sheet open={addOpen} onOpenChange={setAddOpen} title={t('splits.addEntry')} size="form">
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="split-entry-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('splits.descPlaceholder')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <input
            data-testid="split-entry-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder={t('txform.amount')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <div>
            <p className="mb-1 text-[12px] text-ink-3">{t('splits.whoPaid')}</p>
            <div className="flex flex-wrap gap-2">
              {(detail?.members ?? []).map((member) => (
                <button
                  key={member.userId}
                  data-testid={`split-payer-${member.userId}`}
                  onClick={() => setPaidBy(member.userId)}
                  className={`m-tap rounded-full border px-3 py-1.5 text-[13px] ${
                    (paidBy ?? me?.userId) === member.userId
                      ? 'border-accent bg-accent-soft text-accent-deep'
                      : 'border-line bg-surface text-ink-2'
                  }`}
                >
                  {memberName(member, t('word.you'))}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[12px] text-ink-4">{t('splits.equalHint')}</p>
          <Button data-testid="split-entry-save" disabled={busy || !description.trim() || !(parseCents(amount) ?? 0)} onClick={() => void addEntry()}>
            {t('action.save')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
