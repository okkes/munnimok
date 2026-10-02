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

        <Button variant="danger" data-testid="conn-remove" disabled={busy} onClick={() => setConfirmRemove(true)}>
          {t('conn.remove')}
        </Button>
      </div>
      {/* aligned destructive confirm (user request): sheet + cooldown */}
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
    </Sheet>
  );
}
