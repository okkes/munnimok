import { useEffect, useRef, useState } from 'react';
import { v7 as uuidv7 } from 'uuid';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { SplitFacts, SplitsApi, SplitSummary } from '@/application/splitsApi';
import { CURRENCIES } from '@/domain/countries';
import { EVENT_PICTURES } from '@/features/events/EventsScreen';
import { downscaleImage } from '@/lib/image';
import { Button } from '@/ui/Button';
import { FormBlockerNote } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { usePictureSource } from '@/ui/PictureSource';
import { Chip } from '@/ui/primitives';
import { ScrollRow } from '@/ui/ScrollRow';
import { Sheet } from '@/ui/Sheet';

const DATE_INPUT = 'mt-1 h-12 w-full appearance-none rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none';

/**
 * #538 (user): a split has a name, a picture like a regular event's,
 * optional first and last days, and a currency — fixed once something was
 * entered in it. The same sheet makes a new one and lets an owner change
 * an existing one.
 */
export function SplitFormSheet({
  api,
  open,
  onOpenChange,
  editing,
  defaultCurrency,
  onSaved,
}: Readonly<{
  api: SplitsApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the split being changed; null = a new one */
  editing: SplitSummary | null;
  defaultCurrency: string;
  onSaved: (splitId: string) => void;
}>) {
  const { t } = useLang();
  const { spaceId } = useData();
  const [name, setName] = useState('');
  const [picture, setPicture] = useState<string>(EVENT_PICTURES[0]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setPicture(editing?.picture ?? EVENT_PICTURES[0]);
    setFrom(editing?.startDate ?? '');
    setTo(editing?.endDate ?? '');
    setCurrency(editing?.currency ?? defaultCurrency);
    setAttempted(false);
    setFailed(false);
    // deliberately only on open: the sheet owns its fields while open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const onUpload = async (file: File | undefined) => {
    // wide enough for the header, small enough to travel with the list
    if (file) setPicture(await downscaleImage(file, 1080, 0.72));
  };
  const { pick: pickPhoto, sheet: pictureSheet } = usePictureSource((file) => void onUpload(file), () => uploadRef.current?.click(), name.trim());

  const nameMissing = !name.trim();
  const datesWrong = !!from && !!to && to < from;
  // the currency is the event's for good once it holds an entry
  const currencyFixed = (editing?.entryCount ?? 0) > 0;
  const currencies = CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];

  const save = async () => {
    if (nameMissing || datesWrong) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    const facts: SplitFacts = { name: name.trim(), currency, picture, startDate: from || null, endDate: to || null };
    const id = editing?.id ?? uuidv7();
    const saved = editing ? await api.update(id, facts) : await api.create(id, facts, spaceId);
    setBusy(false);
    if (!saved) {
      setFailed(true);
      return;
    }
    onOpenChange(false);
    onSaved(id);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t(editing ? 'splits.edit' : 'splits.new')} size="tall">
      <div className="flex flex-col gap-3 pt-1" data-testid="split-form">
        <ScrollRow testId="splitform-pictures">
          <button
            data-testid="splitform-upload"
            onClick={pickPhoto}
            className="m-tap flex h-16 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line bg-surface text-[10px] text-ink-3"
          >
            <Icon name="image-plus" size={18} />
            {t('events.uploadPicture')}
          </button>
          {picture.startsWith('data:') && (
            <span className="h-16 w-24 shrink-0 overflow-hidden rounded-xl border-2 border-accent" data-testid="splitform-own-picture">
              <img src={picture} alt="" className="h-full w-full object-cover" />
            </span>
          )}
          {EVENT_PICTURES.map((candidate) => (
            <button
              key={candidate}
              data-testid={`splitform-pic-${candidate.split('/').pop()?.replace('.jpg', '')}`}
              onClick={() => setPicture(candidate)}
              className={`m-tap h-16 w-24 shrink-0 overflow-hidden rounded-xl border-2 p-0 ${picture === candidate ? 'border-accent' : 'border-transparent'}`}
            >
              <img src={candidate} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          ))}
        </ScrollRow>
        {pictureSheet}
        <input ref={uploadRef} type="file" accept="image/*" className="hidden" data-testid="splitform-upload-input" onChange={(e) => void onUpload(e.target.files?.[0])} />

        <input
          data-testid="split-name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('splits.namePlaceholder')}
          aria-invalid={attempted && nameMissing}
          className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        <FormBlockerNote show={attempted && nameMissing} text={t('form.needName')} testId="splitform-name-blocker" />

        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-[12px] text-ink-3">
            {t('events.from')}
            <input data-testid="splitform-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={DATE_INPUT} />
          </label>
          <label className="min-w-0 flex-1 text-[12px] text-ink-3">
            {t('events.to')}
            <input data-testid="splitform-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={DATE_INPUT} />
          </label>
        </div>
        <FormBlockerNote show={attempted && datesWrong} text={t('splits.form.datesWrong')} testId="splitform-dates-blocker" />

        <div>
          <div className="mb-1 px-1 text-[12px] text-ink-3">{t('splits.form.currency')}</div>
          {currencyFixed ? (
            <p className="px-1 text-[13px] text-ink-2" data-testid="splitform-currency-fixed">
              {currency} · <span className="text-ink-4">{t('splits.form.currencyFixed')}</span>
            </p>
          ) : (
            <ScrollRow testId="splitform-currencies">
              {currencies.map((code) => (
                <Chip key={code} selected={currency === code} onClick={() => setCurrency(code)} testId={`splitform-currency-${code}`}>
                  {code}
                </Chip>
              ))}
            </ScrollRow>
          )}
        </div>

        {!editing && <p className="text-[12px] text-ink-4">{t('splits.createHint')}</p>}
        {failed && (
          <p className="text-[12px] text-negative" data-testid="splitform-failed">
            {t('splits.saveFailed')}
          </p>
        )}
        <Button data-testid="split-create" disabled={busy} onClick={() => void save()}>
          {t(editing ? 'action.save' : 'action.create')}
        </Button>
      </div>
    </Sheet>
  );
}
