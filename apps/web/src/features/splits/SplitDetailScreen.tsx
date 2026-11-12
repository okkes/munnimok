import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { v7 as uuidv7 } from 'uuid';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { localToday } from '@/application/recurring';
import type { SplitDetail, SplitEntry, SplitEntryDraft, SplitMember, SplitPayment, SplitsApi, SplitTransfer } from '@/application/splitsApi';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SplitRef } from '@/db/types';
import { netPositions } from '@/domain/splitLedger';
import { EVENT_PICTURES } from '@/features/events/EventsScreen';
import { fmtCents, parseCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { ScrollRow } from '@/ui/ScrollRow';
import { Sheet } from '@/ui/Sheet';
import { SplitEventsSection } from './SplitEventsSection';
import { SplitEntrySheet } from './SplitEntrySheet';
import type { EntrySeed } from './SplitEntrySheet';
import { SplitFormSheet } from './SplitFormSheet';
import { SplitPeopleSheet } from './SplitPeopleSheet';
import { SplitTxPickSheet } from './SplitTxPickSheet';
import { memberName, splitDates, useSplitDetail, useSplitsApi } from './splitsCore';

type Translate = ReturnType<typeof useLang>['t'];
type Ask = 'settle' | 'reopen' | 'archive' | 'delete' | 'leave';

const CARD = 'overflow-hidden rounded-card border border-line bg-surface';
const ACTION = 'm-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left text-[14px] text-ink last:border-0';

const netTone = (net: number): string => {
  if (net > 0) return 'text-accent-deep';
  return net < 0 ? 'text-negative' : 'text-ink-3';
};

const nameIn = (members: readonly SplitMember[], t: Translate) => (userId: string) => memberName(members.find((member) => member.userId === userId), t);

/** the picture, the days, what it cost together and how many are in it */
function Header({ detail }: Readonly<{ detail: SplitDetail }>) {
  const { t, lang } = useLang();
  const { split } = detail;
  const dates = splitDates(split, LOCALES[lang], t);
  const members = split.memberCount === 1 ? t('splits.membersCountOne') : t('splits.membersCount', { n: split.memberCount });
  return (
    <div className={`${CARD} mt-2`} data-testid="split-header">
      <img src={split.picture ?? EVENT_PICTURES[0]} alt="" className="h-28 w-full object-cover" />
      <div className="flex items-end gap-3 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-ink-4">{[dates, members].filter(Boolean).join(' · ')}</span>
          <span className="m-num block text-[22px] font-semibold text-ink" data-testid="split-total">
            {fmtCents(split.totalCents, split.currency, lang)}
          </span>
          <span className="block text-[11px] text-ink-4">{t('splits.totalCap')}</span>
        </span>
        <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-deep" data-testid="split-status" data-status={split.status}>
          {t(`splits.status.${split.status}`)}
        </span>
      </div>
    </div>
  );
}

/** what stands in the way of using the split as usual: a deletion counting down, a membership that ended, a closed state */
function Notes({ detail, busy, onKeep }: Readonly<{ detail: SplitDetail; busy: boolean; onKeep: () => void }>) {
  const { t, lang } = useLang();
  const { split } = detail;
  const owner = split.role === 'owner' && split.state === 'active';
  return (
    <>
      {split.deleteAt && (
        <div className="mt-3 rounded-card border border-warning bg-warning-soft p-3" data-testid="split-delete-banner">
          <p className="text-[13px] text-ink">
            {t('splits.deleteBanner', { date: new Date(split.deleteAt).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'long' }) })}
          </p>
          {owner && (
            <Button size="sm" variant="outline" className="mt-2" disabled={busy} data-testid="split-keep" onClick={onKeep}>
              {t('splits.keep')}
            </Button>
          )}
        </div>
      )}
      {split.state !== 'active' && (
        <p className="mt-3 px-1 text-[12px] text-ink-4" data-testid="split-former-note">
          {t(`splits.formerNote.${split.state}`)}
        </p>
      )}
      {split.status !== 'open' && (
        <p className="mt-3 px-1 text-[12px] text-ink-4" data-testid="split-closed-note">
          {t(`splits.closedNote.${split.status}`)}
        </p>
      )}
    </>
  );
}

/** who stands where: owed (+) or owing (−) — people who left stay listed while something is open with them */
function Ledger({ detail }: Readonly<{ detail: SplitDetail }>) {
  const { t, lang } = useLang();
  const nets = useMemo(() => netPositions(detail.entries, detail.members.map((member) => member.userId)), [detail]);
  const listed = detail.members.filter((member) => member.state === 'active' || (nets.get(member.userId) ?? 0) !== 0);
  if (detail.entries.length === 0) return null;
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('splits.balances')}</div>
      <div className={CARD} data-testid="split-ledger">
        {listed.map((member) => {
          const net = nets.get(member.userId) ?? 0;
          return (
            <div key={member.userId} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0" data-testid={`split-net-${member.userId}`}>
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink first-letter:uppercase">{memberName(member, t)}</span>
              <span className={`m-num text-[14px] font-semibold ${netTone(net)}`}>{fmtCents(net, detail.split.currency, lang, { sign: true })}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * While the split runs: what settling now would ask — a look ahead, with
 * a door to record a payment someone already made. Once settled: the plan
 * itself, each payment marked paid by its payer, its receiver or an owner.
 */
function Plan({
  detail,
  preview,
  busy,
  onRecord,
  onPaid,
}: Readonly<{ detail: SplitDetail; preview: readonly SplitTransfer[] | null; busy: boolean; onRecord: (transfer: SplitTransfer) => void; onPaid: (payment: SplitPayment, paid: boolean) => void }>) {
  const { t, lang } = useLang();
  const { split, members } = detail;
  const name = nameIn(members, t);
  const me = members.find((member) => member.isMe);
  const owner = split.role === 'owner' && split.state === 'active';
  const line = (from: string, to: string, cents: number) => t('splits.owes', { from: name(from), to: name(to), amount: fmtCents(cents, split.currency, lang) });

  if (split.status === 'open') {
    if (!preview?.length) return null;
    return (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t('splits.previewCap')}</div>
        <div className={CARD} data-testid="split-preview">
          {preview.map((transfer) => (
            <div key={`${transfer.fromUserId}-${transfer.toUserId}`} className="flex items-center gap-2 border-b border-line-2 px-4 py-2.5 text-[13px] text-ink-2 last:border-0" data-testid="split-transfer">
              <Icon name="arrow-right-thin" size={16} color="var(--m-ink-4)" />
              <span className="min-w-0 flex-1">{line(transfer.fromUserId, transfer.toUserId, transfer.amountCents)}</span>
              {split.state === 'active' && (transfer.fromUserId === me?.userId || transfer.toUserId === me?.userId) && (
                <button
                  data-testid="split-settle"
                  disabled={busy}
                  onClick={() => onRecord(transfer)}
                  className="m-tap shrink-0 rounded-full border border-accent bg-accent-soft px-3 py-1 text-[12px] font-semibold text-accent-deep"
                >
                  {t('splits.recordPayment')}
                </button>
              )}
            </div>
          ))}
        </div>
      </>
    );
  }
  if (detail.payments.length === 0) return null;
  const paidCount = detail.payments.filter((payment) => payment.paidAt).length;
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1" data-testid="split-payments-cap">
        {t('splits.paymentsCap', { paid: paidCount, all: detail.payments.length })}
      </div>
      <div className={CARD} data-testid="split-payments">
        {detail.payments.map((payment) => {
          const mine = payment.fromUserId === me?.userId || payment.toUserId === me?.userId;
          return (
            <div key={payment.id} className="flex items-center gap-2 border-b border-line-2 px-4 py-2.5 text-[13px] last:border-0" data-testid={`split-payment-${payment.id}`} data-paid={payment.paidAt ? 'true' : undefined}>
              <Icon name={payment.paidAt ? 'check-circle' : 'circle-outline'} size={18} color={payment.paidAt ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'} />
              <span className={`min-w-0 flex-1 ${payment.paidAt ? 'text-ink-4' : 'text-ink-2'}`}>{line(payment.fromUserId, payment.toUserId, payment.amountCents)}</span>
              {split.status === 'settled' && (mine || owner) && (
                <button
                  data-testid={`split-payment-toggle-${payment.id}`}
                  disabled={busy}
                  onClick={() => onPaid(payment, !payment.paidAt)}
                  className="m-tap shrink-0 border-none bg-transparent p-0 text-[12px] font-medium text-accent-deep"
                >
                  {t(payment.paidAt ? 'splits.markUnpaid' : 'splits.markPaid')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Entries({ detail, onOpen, onRemovePayment }: Readonly<{ detail: SplitDetail; onOpen: (entry: SplitEntry) => void; onRemovePayment: (entry: SplitEntry) => void }>) {
  const { t, lang } = useLang();
  const name = nameIn(detail.members, t);
  const { currency } = detail.split;
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('splits.entries')}</div>
      <div className={CARD} data-testid="split-entries">
        {detail.entries.map((entry) => {
          const payment = entry.kind === 'settlement';
          const foreign = entry.originalCurrency && entry.originalCents ? ` · ${fmtCents(entry.originalCents, entry.originalCurrency, lang)}` : '';
          return (
            <div key={entry.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0" data-testid={`split-entry-${entry.id}`} data-kind={entry.kind}>
              <button disabled={payment} onClick={() => onOpen(entry)} className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left" data-testid={`split-entry-open-${entry.id}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">
                    {payment ? t('splits.settlementLabel', { from: name(entry.paidByUserId), to: name(entry.shares[0]?.userId ?? '') }) : entry.description}
                  </span>
                  <span className="block truncate text-[11px] text-ink-4">
                    {payment ? day(entry.date) : `${t('splits.paidBy', { name: name(entry.paidByUserId) })} · ${day(entry.date)}${foreign}`}
                  </span>
                </span>
                {entry.hasReceipt && <Icon name="receipt-text-outline" size={15} color="var(--m-ink-4)" />}
                <span className="m-num shrink-0 text-[14px] font-semibold text-ink">{fmtCents(entry.amountCents, currency, lang)}</span>
              </button>
              {payment && entry.canEdit && (
                <button aria-label={t('action.delete')} data-testid={`split-entry-remove-${entry.id}`} onClick={() => onRemovePayment(entry)} className="m-tap flex shrink-0 border-none bg-transparent p-0 text-ink-4">
                  <Icon name="close" size={18} />
                </button>
              )}
            </div>
          );
        })}
        {detail.entries.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-ink-4">{t('splits.noEntries')}</div>}
      </div>
    </>
  );
}

/** "Anna already paid me €20 back": a payment between two members, recorded so the balances know */
function PaymentSheet({
  api,
  detail,
  start,
  onOpenChange,
  onSaved,
}: Readonly<{ api: SplitsApi; detail: SplitDetail; start: SplitTransfer | null; onOpenChange: (open: boolean) => void; onSaved: () => void }>) {
  const { t } = useLang();
  const active = detail.members.filter((member) => member.state === 'active');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!start) return;
    setFrom(start.fromUserId);
    setTo(start.toUserId);
    setAmount(start.amountCents > 0 ? (start.amountCents / 100).toFixed(2).replace('.', ',') : '');
  }, [start]);
  const cents = parseCents(amount) ?? 0;
  const save = async () => {
    setBusy(true);
    const saved = await api.addEntry(detail.split.id, {
      id: uuidv7(),
      kind: 'settlement',
      paidByUserId: from,
      description: 'settlement',
      amountCents: cents,
      date: localToday(),
      shareMode: 'exact',
      shares: [{ userId: to, cents }],
    });
    setBusy(false);
    if (!saved) return;
    onOpenChange(false);
    onSaved();
  };
  const pickers: [string, string, (id: string) => void, string][] = [
    ['splits.payment.from', from, setFrom, 'split-payment-from'],
    ['splits.payment.to', to, setTo, 'split-payment-to'],
  ];
  return (
    <Sheet open={start !== null} onOpenChange={onOpenChange} title={t('splits.recordPayment')} size="form">
      <div className="flex flex-col gap-3 pt-1" data-testid="split-payment-sheet">
        <p className="text-[12px] leading-snug text-ink-4">{t('splits.payment.hint')}</p>
        {pickers.map(([label, value, set, testId]) => (
          <div key={testId}>
            <div className="mb-1 px-1 text-[12px] text-ink-3">{t(label as 'splits.payment.from')}</div>
            <ScrollRow testId={testId}>
              {active.map((member) => (
                <Chip key={member.userId} selected={value === member.userId} onClick={() => set(member.userId)} testId={`${testId}-${member.userId}`}>
                  {memberName(member, t)}
                </Chip>
              ))}
            </ScrollRow>
          </div>
        ))}
        <input
          data-testid="split-payment-amount"
          inputMode="decimal"
          placeholder="0,00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="m-num h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
        />
        <Button data-testid="split-payment-save" disabled={busy || cents <= 0 || !from || !to || from === to} onClick={() => void save()}>
          {t('action.save')}
        </Button>
      </div>
    </Sheet>
  );
}

/** the sentence and the button of each thing an owner (or a leaver) is asked to confirm */
const ASKS: Record<Ask, { title: string; body: string; danger: boolean }> = {
  settle: { title: 'splits.settleNow', body: 'splits.ask.settle', danger: false },
  reopen: { title: 'splits.reopen', body: 'splits.ask.reopen', danger: false },
  archive: { title: 'splits.archive', body: 'splits.ask.archive', danger: false },
  delete: { title: 'splits.delete', body: 'splits.ask.delete', danger: true },
  leave: { title: 'splits.leave', body: 'splits.ask.leave', danger: true },
};

/** The screen while there is no split to show: still loading, gone, or out of reach. */
function Missing({ state }: Readonly<{ state: 'loading' | 'offline' | 'gone' | 'ready' }>) {
  const { t } = useLang();
  return (
    <div className="flex h-dvh flex-col bg-bg" data-testid="screen-split-detail">
      <AppBar
        title="…"
        leading={
          <IconButton label={t('action.back')} testId="split-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      {state !== 'loading' && (
        <p className="px-6 pt-16 text-center text-[13px] text-ink-3" data-testid={`split-${state}`}>
          {t(state === 'gone' ? 'splits.gone' : 'splits.offline')}
        </p>
      )}
    </div>
  );
}

/** What a member can do with the split from its page; an owner's doors show to owners only, each while it applies. */
function Actions({
  split,
  waiting,
  onPeople,
  onEdit,
  onAsk,
}: Readonly<{ split: SplitDetail['split']; waiting: number; onPeople: () => void; onEdit: () => void; onAsk: (ask: Ask) => void }>) {
  const { t } = useLang();
  const active = split.state === 'active';
  const owner = active && split.role === 'owner';
  const actions: [string, string, string, () => void, boolean][] = [
    ['split-people-row', 'account-group-outline', waiting > 0 ? t('splits.people.rowWaiting', { n: waiting }) : t('splits.people.title'), onPeople, true],
    ['split-edit', 'pencil-outline', t('splits.edit'), onEdit, owner && split.status !== 'archived'],
    ['split-settle-now', 'handshake-outline', t('splits.settleNow'), () => onAsk('settle'), owner && split.status === 'open'],
    ['split-reopen', 'lock-open-variant-outline', t('splits.reopen'), () => onAsk('reopen'), owner && split.status === 'settled'],
    ['split-archive', 'archive-outline', t('splits.archive'), () => onAsk('archive'), owner && split.status !== 'archived'],
    ['split-leave', 'exit-run', t('splits.leave'), () => onAsk('leave'), active],
    ['split-delete', 'trash-can-outline', t('splits.delete'), () => onAsk('delete'), owner && !split.deleteAt],
  ];
  return (
    <div className={`${CARD} mt-5`} data-testid="split-actions">
      {actions
        .filter(([, , , , shown]) => shown)
        .map(([testId, icon, label, act]) => (
          <button key={testId} data-testid={testId} onClick={act} className={ACTION}>
            <Icon name={icon} size={19} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
        ))}
    </div>
  );
}

/** What a confirmed question does; true when the split is behind the person afterwards — left, or deleted at once. */
async function carryOut(api: SplitsApi, asked: Ask, splitId: string): Promise<boolean> {
  switch (asked) {
    case 'settle':
      await api.settle(splitId);
      return false;
    case 'reopen':
      await api.reopen(splitId);
      return false;
    case 'archive':
      await api.archive(splitId);
      return false;
    case 'leave':
      await api.leave(splitId);
      return true;
    default:
      return (await api.deleteEvent(splitId))?.deleted === true;
  }
}

/**
 * One split (#538): what it cost, who stands where, what settling would
 * ask, and the expenses — with the doors its members have: add an expense
 * (typed, or one of their own transactions), record a payment, see the
 * people; and an owner's: invite, edit, settle, reopen, archive, delete.
 */
export function SplitDetailScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { splitId } = useParams({ strict: false }) as { splitId: string };
  const api = useSplitsApi();
  const { store, repo } = useData();
  const { view, reload } = useSplitDetail(api, splitId);
  const detail = view.state === 'ready' ? view.detail : null;
  const [preview, setPreview] = useState<SplitTransfer[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entry, setEntry] = useState<SplitEntry | undefined>();
  const [seed, setSeed] = useState<EntrySeed | undefined>();
  const [txOpen, setTxOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [payment, setPayment] = useState<SplitTransfer | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);

  const open = detail?.split.status === 'open';
  useEffect(() => {
    if (!api || !open) {
      setPreview(null);
      return;
    }
    void api.preview(splitId).then(setPreview);
  }, [api, splitId, open, detail]);

  const taken = useMemo(() => new Set((detail?.entries ?? []).map((e) => e.sourceTxId).filter((id): id is string => !!id)), [detail]);

  if (!api) return null;
  if (!detail) return <Missing state={view.state} />;

  const { split } = detail;
  const active = split.state === 'active';
  const members = detail.members.filter((member) => member.state === 'active');
  const waiting = detail.requests?.length ?? 0;

  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    await act();
    setBusy(false);
    await reload();
  };

  /** the space keeps a mark on a payment that sits in a split: everyone there sees it, and nobody adds it twice */
  const markTx = async (txId: string | null | undefined, txSpaceId: string | null | undefined, ref: SplitRef | null) => {
    if (!txId || !txSpaceId) return;
    const tx = (await visibleTransactions(store, txSpaceId)).find((row) => row.id === txId);
    // a follow-up, not the person's edit: a space they only read keeps its rows
    if (tx) await writeTxTransform(repo.upkeep(), tx, { splitRef: ref });
  };
  const entrySaved = async (draft: SplitEntryDraft, removed: boolean) => {
    await markTx(draft.sourceTxId, draft.sourceSpaceId, removed ? null : { splitId: split.id, name: split.name });
    await reload();
  };

  const confirmed = async () => {
    const asked = ask;
    setAsk(null);
    if (!asked) return;
    setBusy(true);
    const behind = await carryOut(api, asked, split.id);
    setBusy(false);
    if (behind) void navigate({ to: '/splits' });
    else await reload();
  };

  const openEntry = (picked?: SplitEntry, from?: EntrySeed) => {
    setEntry(picked);
    setSeed(from);
    setEntryOpen(true);
  };

  const asked = ask ? ASKS[ask] : null;

  return (
    <div className="flex h-dvh flex-col bg-bg" data-testid="screen-split-detail">
      <AppBar
        title={split.name}
        leading={
          <IconButton label={t('action.back')} testId="split-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          open && active ? (
            <IconButton label={t('splits.addEntry')} testId="split-add-entry" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={22} />
            </IconButton>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <Header detail={detail} />
        <Notes detail={detail} busy={busy} onKeep={() => void run(() => api.keep(split.id))} />
        <Ledger detail={detail} />
        <Plan detail={detail} preview={preview} busy={busy} onRecord={setPayment} onPaid={(paid, on) => void run(() => api.paid(split.id, paid.id, on))} />
        <Entries detail={detail} onOpen={(picked) => openEntry(picked)} onRemovePayment={(removed) => void run(() => api.deleteEntry(split.id, removed.id))} />
        {active && <SplitEventsSection detail={detail} onAddToSplit={(from) => openEntry(undefined, from)} />}

        <Actions split={split} waiting={waiting} onPeople={() => setPeopleOpen(true)} onEdit={() => setFormOpen(true)} onAsk={setAsk} />
      </div>

      <Sheet open={addOpen} onOpenChange={setAddOpen} title={t('splits.addEntry')} size="compact">
        <div className="flex flex-col pt-1" data-testid="split-add-sheet">
          {(
            [
              ['split-add-manual', 'pencil-plus-outline', 'splits.add.manual', () => openEntry()],
              ['split-add-from-tx', 'bank-transfer', 'splits.fromTx', () => setTxOpen(true)],
              ['split-add-payment', 'cash-fast', 'splits.recordPayment', () => setPayment({ fromUserId: members.find((m) => m.isMe)?.userId ?? '', toUserId: '', amountCents: 0 })],
            ] as const
          ).map(([testId, icon, label, act]) => (
            <button
              key={testId}
              data-testid={testId}
              onClick={() => {
                setAddOpen(false);
                act();
              }}
              className={ACTION}
            >
              <Icon name={icon} size={20} color="var(--m-accent-deep)" />
              {t(label)}
            </button>
          ))}
        </div>
      </Sheet>

      <SplitEntrySheet
        api={api}
        splitId={split.id}
        currency={split.currency}
        members={members}
        open={entryOpen}
        onOpenChange={setEntryOpen}
        entry={entry}
        seed={seed}
        onSaved={(draft, removed) => void entrySaved(draft, removed)}
      />
      <SplitTxPickSheet open={txOpen} onOpenChange={setTxOpen} splitId={split.id} taken={taken} onPick={(picked) => openEntry(undefined, picked)} />
      <PaymentSheet api={api} detail={detail} start={payment} onOpenChange={(shown) => !shown && setPayment(null)} onSaved={() => void reload()} />
      <SplitPeopleSheet api={api} detail={detail} open={peopleOpen} onOpenChange={setPeopleOpen} onChanged={reload} />
      <SplitFormSheet api={api} open={formOpen} onOpenChange={setFormOpen} editing={split} defaultCurrency={split.currency} onSaved={() => void reload()} />

      <Sheet open={asked !== null} onOpenChange={(shown) => !shown && setAsk(null)} title={asked ? t(asked.title as 'splits.leave') : ''} size="compact">
        {asked && (
          <div className="flex flex-col gap-3 pt-1" data-testid={`split-ask-${ask}`}>
            <p className="text-[13px] leading-snug text-ink-2">{t(asked.body as 'splits.ask.leave')}</p>
            {ask === 'delete' && members.length > 1 && <p className="text-[12px] leading-snug text-warning">{t('splits.ask.deleteCountdown')}</p>}
            <Button variant={asked.danger ? 'danger' : 'primary'} disabled={busy} data-testid="split-ask-confirm" onClick={() => void confirmed()}>
              {t(asked.title as 'splits.leave')}
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
