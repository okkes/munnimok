import { useLang } from '@/i18n';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';

/** brand names stay brand names — no translation */
const STORES = [
  { id: 'ah', name: 'Albert Heijn', icon: 'cart-outline' },
  { id: 'jumbo', name: 'Jumbo', icon: 'cart-outline' },
  { id: 'bol', name: 'bol.com', icon: 'package-variant-closed' },
  { id: 'coolblue', name: 'Coolblue', icon: 'laptop' },
  { id: 'mediamarkt', name: 'MediaMarkt', icon: 'television' },
  { id: 'amazon', name: 'Amazon', icon: 'package-variant-closed' },
] as const;

/**
 * Settings → Shopping connections (receipts design S1 skeleton): the
 * six target stores with their coming-soon status. Adapters land per
 * store from S2; logins will run on-device only.
 */
export function ShoppingConnectionsScreen() {
  const { t } = useLang();
  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-shopping">
      <AppBar
        title={t('shop.title')}
        leading={
          <IconButton label={t('action.back')} testId="shopping-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="shopping-privacy">
          <Icon name="shield-lock-outline" size={18} color="var(--m-accent-deep)" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-2">{t('shop.privacy')}</p>
        </div>

        <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface">
          {STORES.map((store) => (
            <div key={store.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`shopping-store-${store.id}`}>
              <Icon name={store.icon} size={20} color="var(--m-ink-3)" />
              <span className="min-w-0 flex-1 text-[15px] text-ink">{store.name}</span>
              <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[11px] font-medium text-ink-4">{t('shop.comingSoon')}</span>
            </div>
          ))}
        </div>

        <p className="mt-3 px-1 text-[12px] text-ink-4" data-testid="shopping-photo-note">
          {t('shop.photoNote')}
        </p>
      </div>
    </div>
  );
}
