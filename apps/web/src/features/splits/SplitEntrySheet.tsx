import { useEffect, useRef, useState } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { localToday } from '@/application/recurring';
import type { SplitEntry, SplitEntryDraft, SplitMember, SplitShareMode, SplitsApi } from '@/application/splitsApi';
import { CURRENCIES } from '@/domain/countries';
import { downscaleImage } from '@/lib/image';
import { fmtCents, parseCents } from '@/lib/money';
import { convertCents, ensureRates, readRatesCache } from '@/lib/rates';
import { Button } from '@/ui/Button';
import { FormBlockerNote } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { ScrollRow } from '@/ui/ScrollRow';
import { Sheet } from '@/ui/Sheet';
import { memberName } from './splitsCore';

const INPUT = 'h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4';
const SMALL_INPUT = 'm-num h-10 w-24 rounded-input border border-line bg-surface px-2 text-right text-[14px] text-ink outline-none';
const MODES: readonly SplitShareMode[] = ['equal', 'exact', 'percent'];
const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const parsePct = (text: string): number => {
  const value = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : 0;
};

/** what a new entry starts from when it is a transaction picked from one of the person's spaces */
export interface EntrySeed {
  description: string;
  amountCents: number;
  date: string;
  currency: string;
  sourceTxId: string;
  sourceSpaceId: string;
}

interface Draft {
  description: string;
  /** what counts, in the split's currency */
  amount: string;
  date: string;
  paidBy: string;
  mode: SplitShareMode;
  /** who shares when it is divided equally */
  included: ReadonlySet<string>;
  /** per member: an amount or a percentage, as typed */
  values: Readonly<Record<string, string>>;
  foreign: { currency: string; amount: string } | null;
  /** undefined = as it was; a picture = new; '' = taken off */
  receipt: string | undefined;
}

function startDraft(entry: SplitEntry | undefined, seed: EntrySeed | undefined, members: readonly SplitMember[], currency: string): Draft {
  const me = members.find((member) => member.isMe)?.userId ?? members[0]?.userId ?? '';
  const everyone = new Set(members.map((member) => member.userId));
  if (entry) {
    const exact = entry.shareMode === 'exact';
    return {
      description: entry.description,
      amount: toText(entry.amountCents),
      date: entry.date,
      paidBy: entry.paidByUserId,
      mode: entry.shareMode,
      included: new Set(entry.shares.map((share) => share.userId)),
      values: Object.fromEntries(entry.shares.map((share) => [share.userId, exact ? toText(share.cents) : String(share.pct ?? '').replace('.', ',')])),
      foreign: entry.originalCurrency && entry.originalCents ? { currency: entry.originalCurrency, amount: toText(entry.originalCents) } : null,
      receipt: undefined,
    };
  }
  const foreign = seed && seed.currency !== currency ? { currency: seed.currency, amount: toText(seed.amountCents) } : null;
  return {
    description: seed?.description ?? '',
    amount: seed && !foreign ? toText(seed.amountCents) : '',
    date: seed?.date ?? localToday(),
    paidBy: me,
    mode: 'equal',
    included: everyone,
    values: {},
    foreign,
    receipt: undefined,
  };
}

/** the shares as the API takes them, and what still stands in the way of saving */
function sharesOf(draft: Draft, cents: number, members: readonly SplitMember[]): { shares: SplitEntryDraft['shares']; left: number; unit: 'cents' | 'pct' | null } {
  if (draft.mode === 'equal') {
    return { shares: members.filter((member) => draft.included.has(member.userId)).map((member) => ({ userId: member.userId })), left: 0, unit: null };
  }
  if (draft.mode === 'exact') {
    const shares = members.map((member) => ({ userId: member.userId, cents: parseCents(draft.values[member.userId] ?? '') ?? 0 })).filter((share) => share.cents > 0);
    return { shares, left: cents - shares.reduce((sum, share) => sum + share.cents, 0), unit: 'cents' };
  }
  const shares = members.map((member) => ({ userId: member.userId, pct: parsePct(draft.values[member.userId] ?? '') })).filter((share) => share.pct > 0);
  return { shares, left: Math.round((100 - shares.reduce((sum, share) => sum + share.pct, 0)) * 100) / 100, unit: 'pct' };
}

/** who shares in it, and how: equally among the ticked, by typed amounts, or by typed percentages */
function SharesEditor({
  draft,
  cents,
  members,
  currency,
  left,
  unit,
  onChange,
}: Readonly<{
  draft: Draft;
  cents: number;
  members: readonly SplitMember[];
  currency: string;
  left: number;
  unit: 'cents' | 'pct' | null;
  onChange: (patch: Partial<Draft>) => void;
}>) {
  const { t, lang } = useLang();
  const each = draft.included.size > 0 ? Math.floor(cents / draft.included.size) : 0;
  const toggle = (userId: string) => {
    const next = new Set(draft.included);
    if (!next.delete(userId)) next.add(userId);
    onChange({ included: next });
  };
  const leftover = () => {
    if (unit === null || left === 0) return null;
    const amount = unit === 'cents' ? fmtCents(Math.abs(left), currency, lang) : `${String(Math.abs(left)).replace('.', ',')}%`;
    return (
      <p className={`px-1 text-[12px] ${left > 0 ? 'text-warning' : 'text-negative'}`} data-testid="splitentry-left">
        {t(left > 0 ? 'splits.entry.remaining' : 'splits.entry.over', { amount })}
      </p>
    );
  };
  return (
    <div data-testid="splitentry-shares">
      <div className="mb-1 px-1 text-[12px] text-ink-3">{t('splits.entry.sharedBy')}</div>
      <div className="mb-2 flex gap-1.5">
        {MODES.map((mode) => (
          <Chip key={mode} selected={draft.mode === mode} onClick={() => onChange({ mode, values: {} })} testId={`splitentry-mode-${mode}`}>
            {t(`splits.mode.${mode}`)}
          </Chip>
        ))}
      </div>
      <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3">
        {members.map((member) => (
          <label key={member.userId} className="flex items-center gap-3 py-2 text-[14px] text-ink">
            {draft.mode === 'equal' && (
              <input
                type="checkbox"
                data-testid={`splitentry-share-${member.userId}`}
                checked={draft.included.has(member.userId)}
                onChange={() => toggle(member.userId)}
                className="h-5 w-5 shrink-0 accent-[var(--m-accent-deep)]"
              />
            )}
            <span className="min-w-0 flex-1 truncate">{memberName(member, t)}</span>
            {draft.mode === 'equal' ? (
              <span className="m-num text-[13px] text-ink-3">{draft.included.has(member.userId) ? fmtCents(each, currency, lang) : ''}</span>
            ) : (
              <input
                data-testid={`splitentry-value-${member.userId}`}
                inputMode="decimal"
                placeholder={draft.mode === 'percent' ? '%' : '0,00'}
                value={draft.values[member.userId] ?? ''}
                onChange={(e) => onChange({ values: { ...draft.values, [member.userId]: e.target.value } })}
                className={SMALL_INPUT}
              />
            )}
          </label>
        ))}
      </div>
      {leftover()}
    </div>
  );
}

/** an amount paid in another currency: what it was there, and what it counts as here */
function ForeignAmount({
  draft,
  currency,
  onChange,
}: Readonly<{ draft: Draft; currency: string; onChange: (patch: Partial<Draft>) => void }>) {
  const { t } = useLang();
  const { store } = useData();
  const { identity } = useSession();
  const foreign = draft.foreign;
  const original = foreign ? parseCents(foreign.amount) : null;
  const foreignCurrency = foreign?.currency;

  // the day's reference rate fills in what it counts as; typing over it afterwards stands until the original changes
  useEffect(() => {
    if (!foreignCurrency || !original || identity?.kind !== 'user') return;
    let stale = false;
    void (async () => {
      await ensureRates(store, [draft.date]).catch(() => undefined);
      const day = (await readRatesCache(store)).days[draft.date];
      const counted = convertCents(original, foreignCurrency, currency, day);
      if (!stale && counted !== null) onChange({ amount: toText(counted) });
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foreignCurrency, original, draft.date, currency]);

  const others = CURRENCIES.filter((code) => code !== currency);
  return (
    <div data-testid="splitentry-foreign">
      <label className="flex items-center gap-2 px-1 text-[13px] text-ink-2">
        <input
          type="checkbox"
          data-testid="splitentry-foreign-toggle"
          checked={foreign !== null}
          onChange={() => onChange({ foreign: foreign ? null : { currency: others[0], amount: '' } })}
          className="h-5 w-5 accent-[var(--m-accent-deep)]"
        />
        {t('splits.entry.foreign')}
      </label>
      {foreign && (
        <div className="mt-2 flex flex-col gap-2">
          <ScrollRow testId="splitentry-foreign-currencies">
            {(others.includes(foreign.currency) ? others : [foreign.currency, ...others]).map((code) => (
              <Chip key={code} selected={foreign.currency === code} onClick={() => onChange({ foreign: { ...foreign, currency: code } })} testId={`splitentry-foreign-${code}`}>
                {code}
              </Chip>
            ))}
          </ScrollRow>
          <input
            data-testid="splitentry-foreign-amount"
            inputMode="decimal"
            placeholder={t('splits.entry.foreignAmount', { currency: foreign.currency })}
            value={foreign.amount}
            onChange={(e) => onChange({ foreign: { ...foreign, amount: e.target.value } })}
            className={`${INPUT} m-num`}
          />
          <p className="px-1 text-[11px] leading-snug text-ink-4">{t('splits.entry.rateNote')}</p>
        </div>
      )}
    </div>
  );
}

/** the photo of the receipt: add one, look at the one there is, take it off */
function ReceiptField({
  api,
  splitId,
  entry,
  receipt,
  editable,
  onChange,
}: Readonly<{ api: SplitsApi; splitId: string; entry: SplitEntry | undefined; receipt: string | undefined; editable: boolean; onChange: (receipt: string) => void }>) {
  const { t } = useLang();
  const fileRef = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<string | null>(null);
  const present = receipt === undefined ? entry?.hasReceipt === true : receipt !== '';
  const view = async () => {
    const image = receipt || (entry ? await api.receipt(splitId, entry.id) : null);
    setShown(image ?? null);
  };
  const picked = async (file: File | undefined) => {
    if (file) onChange(await downscaleImage(file, 2048, 0.8));
  };
  return (
    <div className="flex flex-col gap-2" data-testid="splitentry-receipt">
      <input ref={fileRef} type="file" accept="image/*" className="hidden" data-testid="splitentry-receipt-file" onChange={(e) => void picked(e.target.files?.[0])} />
      {present ? (
        <div className="flex items-center gap-3 px-1 text-[13px]">
          <Icon name="receipt-text-outline" size={18} color="var(--m-ink-3)" />
          <button data-testid="splitentry-receipt-view" onClick={() => void view()} className="m-tap border-none bg-transparent p-0 font-medium text-accent-deep">
            {t('splits.entry.receiptView')}
          </button>
          {editable && (
            <button data-testid="splitentry-receipt-remove" onClick={() => onChange('')} className="m-tap ml-auto border-none bg-transparent p-0 text-ink-3">
              {t('splits.entry.receiptRemove')}
            </button>
          )}
        </div>
      ) : (
        editable && (
          <Button variant="outline" data-testid="splitentry-receipt-add" onClick={() => fileRef.current?.click()}>
            {t('splits.entry.receiptAdd')}
          </Button>
        )
      )}
      {shown && <img src={shown} alt={t('receipt.title')} className="w-full rounded-card" data-testid="splitentry-receipt-image" />}
    </div>
  );
}

/**
 * #538: an expense of a split — what it was, what it cost, when, who paid
 * and who shares in it: equally, by amounts or by percentages. The payer
 * need not share (the chocolate somebody else owes in full). A sum paid in
 * another currency keeps what it was there next to what it counts as here.
 * Whoever may not change it (user: its author, its payer, an owner — and
 * nobody once settled) reads the same sheet without a Save.
 */
export function SplitEntrySheet({
  api,
  splitId,
  currency,
  members,
  open,
  onOpenChange,
  entry,
  seed,
  onSaved,
}: Readonly<{
  api: SplitsApi;
  splitId: string;
  currency: string;
  /** the people who are in the split now */
  members: readonly SplitMember[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the expense looked at or changed; absent = a new one */
  entry?: SplitEntry;
  seed?: EntrySeed;
  onSaved: (draft: SplitEntryDraft, removed: boolean) => void;
}>) {
  const { t, lang } = useLang();
  const [draft, setDraft] = useState<Draft>(() => startDraft(entry, seed, members, currency));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(startDraft(entry, seed, members, currency));
    setAttempted(false);
    setFailed(false);
    setConfirmDelete(false);
    // deliberately only on open: the sheet owns its fields while open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry?.id, seed?.sourceTxId]);

  const editable = !entry || entry.canEdit;
  const patch = (change: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...change }));
  const cents = parseCents(draft.amount) ?? 0;
  const { shares, left, unit } = sharesOf(draft, cents, members);
  const blockers = {
    name: !draft.description.trim(),
    amount: cents <= 0,
    sharers: shares.length === 0,
    division: left !== 0,
    foreign: draft.foreign !== null && !(parseCents(draft.foreign.amount) ?? 0),
  };
  const blocked = Object.values(blockers).some(Boolean);

  const save = async () => {
    if (blocked) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    const body: SplitEntryDraft = {
      id: entry?.id ?? uuidv7(),
      kind: 'expense',
      paidByUserId: draft.paidBy,
      description: draft.description.trim(),
      amountCents: cents,
      date: draft.date,
      shareMode: draft.mode,
      shares,
      originalCurrency: draft.foreign?.currency ?? null,
      originalCents: draft.foreign ? parseCents(draft.foreign.amount) : null,
      ...(draft.receipt === undefined ? {} : { receipt: draft.receipt }),
      sourceTxId: seed?.sourceTxId ?? entry?.sourceTxId ?? null,
      sourceSpaceId: seed?.sourceSpaceId ?? entry?.sourceSpaceId ?? null,
    };
    const saved = entry ? await api.changeEntry(splitId, body) : await api.addEntry(splitId, body);
    setBusy(false);
    if (!saved) {
      setFailed(true);
      return;
    }
    onOpenChange(false);
    onSaved(body, false);
  };

  const remove = async () => {
    if (!entry) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    const removed = await api.deleteEntry(splitId, entry.id);
    setBusy(false);
    if (!removed) {
      setFailed(true);
      return;
    }
    onOpenChange(false);
    onSaved({ id: entry.id, kind: 'expense', paidByUserId: entry.paidByUserId, description: entry.description, amountCents: entry.amountCents, date: entry.date, shareMode: entry.shareMode, shares: [], sourceTxId: entry.sourceTxId, sourceSpaceId: entry.sourceSpaceId }, true);
  };

  const day = new Date(`${draft.date}T12:00:00`).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t(entry ? 'splits.entry.edit' : 'splits.addEntry')} size="full">
      <fieldset disabled={!editable} className="m-0 flex min-w-0 flex-col gap-3 border-none p-0 pt-1" data-testid="splitentry-form" data-readonly={editable ? undefined : 'true'}>
        {!editable && (
          <p className="px-1 text-[12px] leading-snug text-ink-4" data-testid="splitentry-readonly">
            {t('splits.entry.readonly')}
          </p>
        )}
        {(seed ?? entry?.sourceTxId) && (
          <p className="flex items-center gap-1.5 px-1 text-[12px] text-ink-4" data-testid="splitentry-from-tx">
            <Icon name="link-variant" size={14} />
            {t('splits.entry.fromTx')}
          </p>
        )}
        <input data-testid="split-entry-desc" value={draft.description} maxLength={120} onChange={(e) => patch({ description: e.target.value })} placeholder={t('splits.descPlaceholder')} className={INPUT} />
        <FormBlockerNote show={attempted && blockers.name} text={t('form.needName')} testId="splitentry-name-blocker" />

        <ForeignAmount draft={draft} currency={currency} onChange={patch} />
        <FormBlockerNote show={attempted && blockers.foreign} text={t('form.needAmount')} testId="splitentry-foreign-blocker" />

        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-[12px] text-ink-3">
            {draft.foreign ? t('splits.entry.counts', { currency }) : `${t('splits.entry.amount')} (${currency})`}
            <input data-testid="split-entry-amount" inputMode="decimal" placeholder="0,00" value={draft.amount} onChange={(e) => patch({ amount: e.target.value })} className={`${INPUT} m-num mt-1`} />
          </label>
          <label className="min-w-0 flex-1 text-[12px] text-ink-3">
            {t('splits.entry.date')}
            <input data-testid="split-entry-date" type="date" value={draft.date} onChange={(e) => patch({ date: e.target.value || draft.date })} className={`${INPUT} mt-1 appearance-none`} />
          </label>
        </div>
        <FormBlockerNote show={attempted && blockers.amount} text={t('form.needAmount')} testId="splitentry-amount-blocker" />
        {!editable && <p className="px-1 text-[12px] text-ink-4">{day}</p>}

        <div>
          <div className="mb-1 px-1 text-[12px] text-ink-3">{t('splits.whoPaid')}</div>
          <ScrollRow testId="splitentry-payers">
            {members.map((member) => (
              <Chip key={member.userId} selected={draft.paidBy === member.userId} onClick={() => patch({ paidBy: member.userId })} testId={`split-payer-${member.userId}`}>
                {memberName(member, t)}
              </Chip>
            ))}
          </ScrollRow>
        </div>

        <SharesEditor draft={draft} cents={cents} members={members} currency={currency} left={left} unit={unit} onChange={patch} />
        <FormBlockerNote show={attempted && blockers.sharers} text={t('splits.entry.needSharers')} testId="splitentry-sharers-blocker" />

        <ReceiptField api={api} splitId={splitId} entry={entry} receipt={draft.receipt} editable={editable} onChange={(receipt) => patch({ receipt })} />

        {failed && (
          <p className="text-[12px] text-negative" data-testid="splitentry-failed">
            {t('splits.saveFailed')}
          </p>
        )}
        {editable && (
          <Button data-testid="split-entry-save" disabled={busy} onClick={() => void save()}>
            {t('action.save')}
          </Button>
        )}
        {editable && entry && (
          <Button variant="danger" data-testid="split-entry-delete" disabled={busy} onClick={() => void remove()}>
            {t(confirmDelete ? 'splits.entry.deleteConfirm' : 'splits.entry.delete')}
          </Button>
        )}
      </fieldset>
    </Sheet>
  );
}
