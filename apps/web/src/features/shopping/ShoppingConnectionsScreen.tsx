import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { storesAvailable, useStoreConnections, useStoreMarkers, useStoreOps, useUnmatchedReceipts } from '@/application/stores';
import type { StoreSyncResult } from '@/features/shopping/stores/sync';
import { AH_AUTHORIZE_URL } from './stores/ah';
import type { ReceiptRow } from '@/db/types';
import { fmtCents } from '@/lib/money';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { ReceiptViewSheet } from './ReceiptViewSheet';

/** brand names stay brand names — no translation */
const COMING_SOON = [
  { id: 'jumbo', name: 'Jumbo', icon: 'cart-outline' },
  { id: 'bol', name: 'bol.com', icon: 'package-variant-closed' },
  { id: 'coolblue', name: 'Coolblue', icon: 'laptop' },
  { id: 'mediamarkt', name: 'MediaMarkt', icon: 'television' },
  { id: 'amazon', name: 'Amazon', icon: 'package-variant-closed' },
] as const;

/**
 * Settings → Shopping connections (receipts design S2): Albert Heijn
 * live behind the paste-the-redirect login, the rest honestly labelled.
 * The connection state answers "did it actually work?" out loud:
 * receipt count, last sync, and the result of every sync attempt.
 */
export function ShoppingConnectionsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { db, spaceId } = useData();
  const connections = useStoreConnections();
  const markers = useStoreMarkers();
  const unmatched = useUnmatchedReceipts();
  const ops = useStoreOps();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const allSpaces = useLiveQuery(() => db.spaces.filter((s) => s.deleted === 0).toArray(), [db]);
  const receiptCount = useLiveQuery(
    () => db.receipts.filter((r) => r.deleted === 0 && r.spaceId === spaceId && r.source === 'ah').count(),
    [db, spaceId],
  );
  const currency = space?.currency ?? 'EUR';

  const [connectOpen, setConnectOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [syncState, setSyncState] = useState<'idle' | 'busy' | StoreSyncResult>('idle');
  const [viewing, setViewing] = useState<ReceiptRow | null>(null);

  const signedIn = storesAvailable();
  const ah = connections?.find((c) => c.store === 'ah');
  const ahMarker = markers?.find((m) => m.store === 'ah');
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });

  const runSync = async () => {
    setSyncState('busy');
    setSyncState(await ops.syncNow('ah'));
  };

  const toggleShare = async (targetSpaceId: string) => {
    const current = ah?.sharedSpaceIds ?? [spaceId];
    const next = current.includes(targetSpaceId)
      ? current.filter((id) => id !== targetSpaceId)
      : [...current, targetSpaceId];
    await ops.setSharedSpaces('ah', next);
  };

  const submitConnect = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const ok = await ops.connectAh(pasted);
      if (!ok) {
        setFailed(true);
        return;
      }
      setConnectOpen(false);
      setPasted('');
      // verify out loud: pull receipts right away and show the outcome
      await runSync();
    } finally {
      setBusy(false);
    }
  };

  const renderSyncResult = () => {
    if (syncState === 'idle') return null;
    if (syncState === 'busy')
      return (
        <span className="block text-[11px] text-ink-4" data-testid="shop-ah-syncing">
          {t('shop.syncBusy')}
        </span>
      );
    let text = t('shop.syncFailed', { status: syncState.httpStatus ?? '?' });
    if (syncState.status === 'ok') text = syncState.added > 0 ? t('shop.syncAdded', { n: syncState.added }) : t('shop.syncNone');
    if (syncState.status === 'expired') text = t('shop.syncExpired');
    return (
      <span className={`block text-[11px] ${syncState.status === 'ok' ? 'text-accent-deep' : 'text-negative'}`} data-testid="shop-ah-sync-result">
        {text}
      </span>
    );
  };

  const renderAhStatus = () => {
    if (!signedIn) return <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[11px] font-medium text-ink-4">{t('shop.signInShort')}</span>;
    if (ah?.status === 'ok')
      return (
        <span className="flex items-center gap-2">
          <button data-testid="shop-ah-sync" onClick={() => void runSync()} className="m-tap border-none bg-transparent text-[12px] font-medium text-accent-deep">
            {t('shop.syncNow')}
          </button>
          <button data-testid="shop-ah-disconnect" onClick={() => void ops.disconnect('ah')} className="m-tap border-none bg-transparent text-[12px] text-ink-4">
            {t('shop.disconnect')}
          </button>
        </span>
      );
    if (ah?.status === 'expired' || (ahMarker && !ah))
      return (
        <Button size="sm" variant="outline" data-testid="shop-ah-reconnect" onClick={() => setConnectOpen(true)}>
          {t('shop.reconnect')}
        </Button>
      );
    return (
      <Button size="sm" data-testid="shop-ah-connect" onClick={() => setConnectOpen(true)}>
        {t('shop.connect')}
      </Button>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-shopping">
      <AppBar
        title={t('shop.title')}
        leading={
          <IconButton label={t('action.back')} testId="shopping-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={<HelpButton tourId="shopping" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="shopping-privacy">
          <Icon name="shield-lock-outline" size={18} color="var(--m-accent-deep)" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-2">{t('shop.privacy')}</p>
        </div>

        {!signedIn && (
          <p className="mt-2 px-1 text-[12px] text-ink-4" data-testid="shopping-signin-note">
            {t('shop.signInNote')}
          </p>
        )}

        <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex items-center gap-3 border-b border-line-2 px-4 py-3.5" data-testid="shopping-store-ah">
            <Icon name="cart-outline" size={20} color={ah?.status === 'ok' ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="text-[15px] text-ink">Albert Heijn</span>
                {ah?.status === 'ok' && <Icon name="check-circle" size={14} color="var(--m-accent-deep)" />}
              </span>
              {ah?.status === 'ok' && (
                <span className="block text-[11px] text-ink-4" data-testid="shop-ah-status">
                  {t('shop.connectedLine', { n: receiptCount ?? 0, date: fmtDate(ah.refreshedAt) })}
                </span>
              )}
              {ah?.status === 'expired' && (
                <span className="block text-[11px] text-warning" data-testid="shop-ah-expired-note">
                  {t('shop.expiredNote')}
                </span>
              )}
              {!ah && ahMarker && signedIn && (
                <span className="block text-[11px] text-warning" data-testid="shop-ah-marker-note">
                  {t('shop.reconnectNote')}
                </span>
              )}
              {renderSyncResult()}
            </span>
            {renderAhStatus()}
          </div>
          {COMING_SOON.map((store) => (
            <div key={store.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`shopping-store-${store.id}`}>
              <Icon name={store.icon} size={20} color="var(--m-ink-3)" />
              <span className="min-w-0 flex-1 text-[15px] text-ink">{store.name}</span>
              <Pill>{t('shop.comingSoon')}</Pill>
            </div>
          ))}
        </div>

        {/* which spaces this connection's receipts flow into (user ruling:
            sharing lets every member of those spaces search the receipts) */}
        {ah?.status === 'ok' && (
          <>
            <div className="m-cap mt-4 mb-1 px-1">{t('shop.sharedSpaces')}</div>
            <p className="mb-1 px-1 text-[11px] leading-snug text-ink-4">{t('shop.sharedSpacesSub')}</p>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="shop-ah-spaces">
              {(allSpaces ?? []).map((entry) => {
                const shared = (ah.sharedSpaceIds ?? [spaceId]).includes(entry.id);
                return (
                  <button
                    key={entry.id}
                    data-testid={`shop-ah-share-${entry.id}`}
                    onClick={() => void toggleShare(entry.id)}
                    className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
                  >
                    <Icon
                      name={shared ? 'checkbox-marked' : 'checkbox-blank-outline'}
                      size={20}
                      color={shared ? 'var(--m-accent)' : 'var(--m-ink-4)'}
                    />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{entry.name}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* the browsing door: every receipt, photos included */}
        <button
          data-testid="shop-view-receipts"
          onClick={() => void navigate({ to: '/receipts' })}
          className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
        >
          <Icon name="receipt-text-outline" size={20} color="var(--m-ink-2)" />
          <span className="min-w-0 flex-1 text-[15px] text-ink">{t('receipts.title')}</span>
          <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
        </button>

        {(unmatched?.length ?? 0) > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">
              {t('shop.unmatched')} · {unmatched!.length}
            </div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="shop-unmatched">
              {unmatched!.map((receipt) => (
                <button
                  key={receipt.id}
                  data-testid={`shop-unmatched-${receipt.id}`}
                  onClick={() => setViewing(receipt)}
                  className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
                >
                  <Icon name="receipt-text-outline" size={18} color="var(--m-warning)" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{receipt.merchant ?? receipt.source}</span>
                    <span className="block text-[11px] text-ink-4">{fmtDate(receipt.date)}</span>
                  </span>
                  <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(receipt.totalCents, currency, lang)}</span>
                </button>
              ))}
            </div>
            <p className="mt-1 px-1 text-[11px] text-ink-4">{t('shop.unmatchedSub')}</p>
          </>
        )}

        <p className="mt-3 px-1 text-[12px] text-ink-4" data-testid="shopping-photo-note">
          {t('shop.photoNote')}
        </p>
      </div>

      {/* AH connect: open the real login, paste the appie:// landing address */}
      <Sheet open={connectOpen} onOpenChange={(open) => !open && setConnectOpen(false)} title={t('shop.connectTitle')} size="tall">
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-[13px] leading-relaxed text-ink-2">{t('shop.connectStep1')}</p>
          <a
            data-testid="shop-ah-open-login"
            href={AH_AUTHORIZE_URL}
            target="_blank"
            rel="noreferrer"
            className="m-tap flex items-center justify-center gap-2 rounded-input border border-line bg-surface px-4 py-3 text-[14px] font-medium text-accent-deep no-underline"
          >
            <Icon name="open-in-new" size={16} />
            {t('shop.openLogin')}
          </a>
          <p className="text-[13px] leading-relaxed text-ink-2">{t('shop.connectStep2')}</p>
          {/* the appie:// landing is a custom-scheme link: a phone WITH the
              AH app installed hands it straight to that app, so the address
              is never visible to copy (user report) — say so up front */}
          <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] leading-relaxed text-ink-3" data-testid="shop-ah-app-note">
            {t('shop.connectAppNote')}
          </p>
          <input
            data-testid="shop-ah-paste"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="appie://login-exit?code=…"
            className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4"
          />
          {/* pasted blobs overflow the input silently — echo a glanceable tail (§2L) */}
          {pasted.trim() && (
            <p className="truncate px-1 font-mono text-[11px] text-ink-4" data-testid="shop-ah-preview">
              {pasted.trim()}
            </p>
          )}
          {failed && (
            <p className="text-[12px] text-negative" data-testid="shop-ah-failed">
              {t('shop.connectFailed')}
            </p>
          )}
          <Button data-testid="shop-ah-submit" disabled={busy || !pasted.trim()} onClick={() => void submitConnect()}>
            {t('shop.connect')}
          </Button>
        </div>
      </Sheet>

      <ReceiptViewSheet receipt={viewing} currency={currency} onClose={() => setViewing(null)} />
    </div>
  );
}
