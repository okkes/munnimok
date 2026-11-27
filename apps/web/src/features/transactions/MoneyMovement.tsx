import { useLang } from '@/i18n';
import type { AccountRow } from '@/db/types';
import { typeDef } from '@/features/accounts/accountTypes';
import { institutionLogoUrl } from '@/features/accounts/useInstitutionLogos';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';

type Side = Pick<AccountRow, 'type' | 'logo' | 'provider' | 'bankId'> & { name: string; number?: string | null };

function SideFace({ side, own }: Readonly<{ side: Side; own: boolean }>) {
  const logo = side.logo ?? institutionLogoUrl(side);
  return (
    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${own ? 'bg-surface' : 'bg-bg-2'}`}>
      {logo ? <Picture src={logo} className="h-7 w-7 rounded object-contain" loading="lazy" /> : <Icon name={typeDef(side.type).icon} size={20} color={own ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />}
    </span>
  );
}

const TILE = 'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center';

// #696: a transfer, a saving or a loan payment drawn as what it is — money leaving one account for another. The side
// this transaction sits on is the green one; the other side is the counterparty, and tapping it changes it
export function MoneyMovement({
  own,
  other,
  incoming,
  onChange,
}: Readonly<{
  /** the account this transaction is on */
  own: Side;
  /** the counterparty account */
  other: Side;
  /** money came in: the counterparty is where it came from */
  incoming: boolean;
  /** absent = the counterparty cannot be changed here */
  onChange?: () => void;
}>) {
  const { t } = useLang();
  const ownTile = (
    <div className={`${TILE} border-accent bg-accent-soft/50`} data-testid="tx-detail-account-row" data-side={incoming ? 'to' : 'from'}>
      <span className="m-cap">{t(incoming ? 'tx.moveTo' : 'tx.moveFrom')}</span>
      <SideFace side={own} own />
      <span className="line-clamp-2 w-full text-[13px] leading-tight font-semibold break-words text-ink">{own.name}</span>
      <span className="w-full truncate text-[11px] text-ink-3">{t(typeDef(own.type).labelKey)}</span>
      <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-white" data-testid="tx-detail-this-side">
        {t('tx.moveThis')}
      </span>
    </div>
  );
  const otherTile = (
    <button
      type="button"
      data-testid="tx-detail-counter-row"
      data-side={incoming ? 'from' : 'to'}
      onClick={onChange}
      disabled={!onChange}
      className={`${TILE} m-tap border-line bg-surface`}
    >
      <span className="m-cap">{t(incoming ? 'tx.moveFrom' : 'tx.moveTo')}</span>
      <SideFace side={other} own={false} />
      <span className="line-clamp-2 w-full text-[13px] leading-tight font-semibold break-words text-ink" data-testid="tx-detail-linked-account">
        {other.name}
      </span>
      {/* a renamed card read as its masked number here while the sheet called it by its name */}
      {other.number && (
        <span className="w-full truncate font-mono text-[10px] text-ink-4" data-testid="tx-detail-linked-number">
          {other.number}
        </span>
      )}
      <span className="w-full truncate text-[11px] text-ink-3">{t(typeDef(other.type).labelKey)}</span>
    </button>
  );
  return (
    <div className="flex items-stretch gap-2 p-3" data-testid="tx-detail-movement">
      {incoming ? otherTile : ownTile}
      <span className="flex shrink-0 items-center text-ink-4" aria-hidden>
        <Icon name="arrow-right" size={20} />
      </span>
      {incoming ? ownTile : otherTile}
    </div>
  );
}
