import { useState } from 'react';
import { useLang } from '@/i18n';
import { useConnectionOps } from '@/application/connections';
import type { ConnectionView } from '@/application/connections';
import { BrandIconPicker } from '@/features/recurring/BrandIconPicker';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { kindIcon } from './logos';
import { SpacePicker } from './SpacePicker';
import type { ProviderKind } from './types';

/** rename / icon / included spaces / remove for one connection */
export function ConnectionSheet({
  view,
  kind,
  allSpaces,
  includedSpaceIds,
  onClose,
}: Readonly<{
  view: ConnectionView;
  kind: ProviderKind | undefined;
  allSpaces: readonly { id: string; name: string }[];
  includedSpaceIds: readonly string[];
  onClose: () => void;
}>) {
  const { t } = useLang();
  const ops = useConnectionOps();
  const [name, setName] = useState(view.meta.displayName);
  const [iconOpen, setIconOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggleSpace = async (spaceId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = includedSpaceIds.includes(spaceId)
        ? includedSpaceIds.filter((id) => id !== spaceId)
        : [...includedSpaceIds, spaceId];
      await ops.setIncludedSpaces(view.meta.id, next);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await ops.remove(view.meta.id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Sheet open onOpenChange={(open) => !open && onClose()} title={view.meta.displayName} size="tall">
      <div className="flex flex-col gap-3 pt-1">
        <label className="flex items-center gap-3 text-[13px] text-ink-2">
          {t('acct.displayName')}
          <input
            data-testid="conn-manage-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== view.meta.displayName && void ops.rename(view.meta.id, name)}
            className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
          />
        </label>
        <button
          data-testid="conn-manage-icon"
          onClick={() => setIconOpen(true)}
          className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-3 py-2.5 text-left text-[13px] text-ink"
        >
          {view.meta.icon ? (
            <img src={view.meta.icon} alt="" className="h-6 w-6 rounded object-contain" />
          ) : (
            <Icon name={kindIcon(kind)} size={20} color="var(--m-ink-3)" />
          )}
          <span className="flex-1">{t('acct.changeIcon')}</span>
          <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
        </button>

        {/* which spaces this connection's receipts flow into */}
        <div className="m-cap px-1">{t('conn.sharedSpaces')}</div>
        <p className="px-1 text-[11px] leading-snug text-ink-4">{t('conn.sharedSpacesSub')}</p>
        <SpacePicker spaces={allSpaces} selected={includedSpaceIds} disabled={busy} onToggle={(id) => void toggleSpace(id)} testId="conn-manage-spaces" />

        {/* #441 L1: a failed run's picture reaches the people who run munni only with the person's word — this gives it once */}
        {view.device && (
          <div className="flex items-center justify-between gap-3 rounded-input border border-line bg-surface px-3 py-2.5 text-[13px] text-ink">
            <span className="flex min-w-0 flex-col">
              <span>{t('conn.report.always')}</span>
              <span className="text-[11px] leading-snug text-ink-4">{t('conn.report.alwaysSub')}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={!!view.device.reportFailures}
              aria-label={t('conn.report.always')}
              data-testid="conn-report-always"
              disabled={busy}
              onClick={() => void ops.setReportFailures(view.meta.id, !view.device?.reportFailures)}
              className={`flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-none p-0.5 transition-colors ${
                view.device.reportFailures ? 'justify-end bg-accent' : 'justify-start bg-bg-2'
              }`}
            >
              <span className="h-4 w-4 rounded-full bg-surface shadow" />
            </button>
          </div>
        )}

        <Button variant="danger" data-testid="conn-remove" disabled={busy} onClick={() => setConfirmRemove(true)}>
          {t('conn.remove')}
        </Button>
      </div>
    </Sheet>
    {/* aligned destructive confirm (user request): sheet + cooldown.
        2026-10-06 (user ss, phone): mounted INSIDE the sheet these two
        came up behind it, dimmed with the covered parent - every other
        sheet keeps its confirm and pickers as siblings, mounted after it */}
    <DangerConfirmSheet
      open={confirmRemove}
      onOpenChange={setConfirmRemove}
      title={t('conn.remove')}
      body={t('conn.removeNote')}
      onConfirm={() => void remove()}
      testId="conn-remove"
    />
    <BrandIconPicker
      open={iconOpen}
      onOpenChange={setIconOpen}
      initialQuery={view.meta.displayName}
      onPick={({ logo }) => {
        void ops.setIcon(view.meta.id, logo);
        setIconOpen(false);
      }}
    />
    </>
  );
}
