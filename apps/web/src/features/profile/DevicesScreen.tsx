import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { getDeviceId } from '@/db/device';
import { apiFetch } from '@/lib/api';
import { fmtTimeAgo } from '@/lib/text';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { revokeDevices, useDeviceList } from './deviceList';
import type { DeviceDto, DeviceListStatus } from './deviceList';

const PLATFORM_ICONS: Record<string, string> = {
  android: 'cellphone',
  ios: 'cellphone',
  web: 'laptop',
};

// #158: only this device's browser is known (the server keeps no UA)
// order matters: Edge/Opera UAs also carry "Chrome", Chrome carries "Safari"
export function browserLabel(): string | null {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('OPR/')) return 'Opera';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/')) return 'Safari';
  return null;
}

// this device can never be disconnected from here, and a disconnected one is already gone
const isSelectable = (device: DeviceDto, myId: string) => device.id !== myId && !device.revoked;

function useDisplayNames(devices: DeviceDto[] | null, platformLabel: (device: DeviceDto) => string) {
  // #158: twins get " (2)", " (3)" by createdAt age; the oldest keeps the bare name
  return useMemo(() => {
    const counts = new Map<string, number>();
    const names = new Map<string, string>();
    for (const device of [...(devices ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const base = device.name ?? platformLabel(device);
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      names.set(device.id, n === 1 ? base : `${base} (${n})`);
    }
    return names;
  }, [devices, platformLabel]);
}

function ListStatusNote({ status, hasList, fetchedAt }: Readonly<{ status: DeviceListStatus; hasList: boolean; fetchedAt: string | null }>) {
  const { t, lang } = useLang();
  if (status !== 'failed') return null;
  // the app works offline: a failed refresh keeps the last list and says how old it is
  const text =
    hasList && fetchedAt ? t('devices.refreshFailed', { when: fmtTimeAgo(fetchedAt, lang) }) : t('devices.loadFailed');
  return (
    <p className="mb-3 flex items-start gap-2 text-[12px] text-negative" data-testid="devices-refresh-failed" role="status">
      <Icon name="cloud-off-outline" size={15} />
      <span>{text}</span>
    </p>
  );
}

function RefreshButton({ status, onRefresh }: Readonly<{ status: DeviceListStatus; onRefresh: () => void }>) {
  const { t } = useLang();
  return (
    <IconButton label={t('devices.refresh')} testId="devices-refresh" onClick={onRefresh}>
      {status === 'loading' ? (
        <span className="inline-flex animate-spin" data-testid="devices-refreshing">
          <Icon name="loading" size={22} />
        </span>
      ) : (
        <Icon name="refresh" size={22} />
      )}
    </IconButton>
  );
}

function SelectToolbar({
  selecting,
  count,
  canSelect,
  onStart,
  onAllOthers,
  onCancel,
}: Readonly<{
  selecting: boolean;
  count: number;
  canSelect: boolean;
  onStart: () => void;
  onAllOthers: () => void;
  onCancel: () => void;
}>) {
  const { t } = useLang();
  const link = 'm-tap border-none bg-transparent text-[13px] font-semibold text-accent-deep';
  if (!selecting) {
    if (!canSelect) return null;
    return (
      <div className="mb-2 flex justify-end">
        <button data-testid="devices-select" onClick={onStart} className={link}>
          {t('devices.select')}
        </button>
      </div>
    );
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="flex-1 text-[13px] text-ink-2" data-testid="devices-selected-count">
        {t('devices.selectedCount', { n: count })}
      </span>
      <button data-testid="devices-select-all" onClick={onAllOthers} className={link}>
        {t('devices.selectAllOthers')}
      </button>
      <button data-testid="devices-select-cancel" onClick={onCancel} className={link}>
        {t('action.cancel')}
      </button>
    </div>
  );
}

interface RowProps {
  device: DeviceDto;
  label: string;
  mine: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onRename: () => void;
  onRevoke: () => void;
}

function DeviceRowText({ device, label, mine }: Readonly<Pick<RowProps, 'device' | 'label' | 'mine'>>) {
  const { t, lang } = useLang();
  const myBrowser = mine && (device.platform ?? 'web') === 'web' ? browserLabel() : null;
  return (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2 text-[14px] text-ink">
        <span className="truncate">{label}</span>
        {mine && (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-deep" data-testid="device-this">
            {t('devices.thisDevice')}
          </span>
        )}
      </span>
      <span className="block text-[11px] text-ink-4">
        {/* #158: only this device knows its own browser; the server has no UA */}
        {myBrowser && <span data-testid="device-browser">{myBrowser} · </span>}
        {device.revoked ? t('devices.revoked') : t('devices.seen', { when: fmtTimeAgo(device.lastSeenAt, lang) })}
      </span>
    </span>
  );
}

function RowActions({ device, mine, onRename, onRevoke }: Readonly<Pick<RowProps, 'device' | 'mine' | 'onRename' | 'onRevoke'>>) {
  const { t } = useLang();
  return (
    <>
      <button
        aria-label={t('devices.rename')}
        data-testid={`device-rename-${device.id}`}
        onClick={onRename}
        className="m-tap border-none bg-transparent text-ink-4"
      >
        <Icon name="pencil-outline" size={17} />
      </button>
      {!mine && !device.revoked && (
        <button
          aria-label={t('devices.disconnect')}
          data-testid={`device-revoke-${device.id}`}
          onClick={onRevoke}
          className="m-tap border-none bg-transparent text-negative"
        >
          <Icon name="link-off" size={18} />
        </button>
      )}
    </>
  );
}

function DeviceRow(props: Readonly<RowProps>) {
  const { device, mine, selecting, selected, onToggle } = props;
  const rowClass = `flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0 ${device.revoked ? 'opacity-55' : ''}`;
  const platformIcon = <Icon name={PLATFORM_ICONS[device.platform ?? 'web'] ?? 'laptop'} size={20} color="var(--m-ink-3)" />;
  if (selecting && !mine && !device.revoked) {
    return (
      <button
        role="checkbox"
        aria-checked={selected}
        data-testid={`device-row-${device.id}`}
        onClick={onToggle}
        className={`m-tap ${rowClass}`}
      >
        <span data-testid={`device-tick-${device.id}`} className="inline-flex">
          <Icon
            name={selected ? 'checkbox-marked' : 'checkbox-blank-outline'}
            size={20}
            color={selected ? 'var(--m-accent)' : 'var(--m-ink-4)'}
          />
        </span>
        {platformIcon}
        <DeviceRowText device={device} label={props.label} mine={mine} />
      </button>
    );
  }
  return (
    <div data-testid={`device-row-${device.id}`} className={rowClass}>
      {/* keeps the names aligned with the selectable rows */}
      {selecting && <span className="inline-block w-5 shrink-0" />}
      {platformIcon}
      <DeviceRowText device={device} label={props.label} mine={mine} />
      {!selecting && <RowActions {...props} />}
    </div>
  );
}

function useSelectMode(devices: DeviceDto[] | null, myId: string) {
  const { select } = useSearch({ strict: false }) as { select?: boolean };
  const navigate = useNavigate();
  const router = useRouter();
  const selecting = select === true;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!selecting) setSelected(new Set());
  }, [selecting]);

  const selectable = useMemo(() => (devices ?? []).filter((d) => isSelectable(d, myId)).map((d) => d.id), [devices, myId]);
  // a device that left the list (or got disconnected elsewhere) leaves the selection
  const chosen = useMemo(() => selectable.filter((id) => selected.has(id)), [selectable, selected]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return {
    selecting,
    chosen,
    canSelect: selectable.length > 0,
    toggle,
    setSelected,
    start: () => void navigate({ to: '/devices', search: { select: true } }),
    allOthers: () => setSelected(new Set(selectable)),
    stop: () => router.history.back(),
  };
}

function bulkCopy(t: ReturnType<typeof useLang>['t'], n: number) {
  return n === 1
    ? { title: t('devices.bulkTitleOne'), body: t('devices.bulkBodyOne') }
    : { title: t('devices.bulkTitle', { n }), body: t('devices.bulkBody', { n }) };
}

// a remote disconnect WIPES the other device on its next connection
export function DevicesScreen() {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const { devices, status, fetchedAt, reload } = useDeviceList();
  const [renaming, setRenaming] = useState<DeviceDto | null>(null);
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<DeviceDto | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<{ done: number; total: number } | null>(null);
  const myId = getDeviceId();
  const select = useSelectMode(devices, myId);

  const platformLabel = useCallback(
    (device: DeviceDto) => {
      if (device.platform === 'android') return t('devices.android');
      if (device.platform === 'ios') return t('devices.ios');
      return t('devices.web');
    },
    [t],
  );
  const displayNames = useDisplayNames(devices, platformLabel);
  const logName = (device: DeviceDto) => device.name ?? platformLabel(device);

  useEffect(() => {
    if (!select.selecting) setBulkNote(null);
  }, [select.selecting]);

  const saveRename = async () => {
    if (!renaming || !name.trim()) return;
    await apiFetch(`/me/devices/${renaming.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }).catch(
      () => null,
    );
    setRenaming(null);
    await reload();
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    const res = await apiFetch(`/me/devices/${revoking.id}/revoke`, { method: 'POST' }).catch(() => null);
    if (res?.ok) void logActivity(store, repo, spaceId, 'deviceRevoke', logName(revoking));
    setRevoking(null);
    await reload();
  };

  const confirmBulk = async () => {
    const ids = select.chosen;
    setBulkBusy(true);
    const { revoked, failed } = await revokeDevices(ids);
    for (const device of (devices ?? []).filter((d) => revoked.includes(d.id))) {
      void logActivity(store, repo, spaceId, 'deviceRevoke', logName(device));
    }
    setBulkBusy(false);
    setBulkOpen(false);
    if (failed.length === 0) {
      select.stop();
    } else {
      select.setSelected(new Set(failed));
      setBulkNote({ done: revoked.length, total: ids.length });
    }
    await reload();
  };

  const bulk = bulkCopy(t, select.chosen.length);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-devices">
      <AppBar
        title={t('devices.title')}
        leading={
          <IconButton label={t('action.back')} testId="devices-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={<RefreshButton status={status} onRefresh={() => void reload()} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <p className="mt-1 mb-3 text-[12px] text-ink-3">{t('devices.sub')}</p>
        <ListStatusNote status={status} hasList={devices !== null} fetchedAt={fetchedAt} />
        <SelectToolbar
          selecting={select.selecting}
          count={select.chosen.length}
          canSelect={select.canSelect}
          onStart={select.start}
          onAllOthers={select.allOthers}
          onCancel={select.stop}
        />
        {bulkNote && (
          <p className="mb-2 text-[12px] text-negative" data-testid="devices-bulk-result" role="status">
            {t('devices.bulkPartial', { done: bulkNote.done, total: bulkNote.total })}
          </p>
        )}
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="devices-list">
          {(devices ?? []).map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              label={displayNames.get(device.id) ?? logName(device)}
              mine={device.id === myId}
              selecting={select.selecting}
              selected={select.chosen.includes(device.id)}
              onToggle={() => select.toggle(device.id)}
              onRename={() => {
                setRenaming(device);
                setName(logName(device));
              }}
              onRevoke={() => setRevoking(device)}
            />
          ))}
          {devices?.length === 0 && <div className="px-4 py-6 text-center text-[12px] text-ink-4">—</div>}
        </div>
      </div>

      {select.selecting && (
        <div className="shrink-0 border-t border-line bg-bg px-5 pt-3 pb-4">
          <Button
            variant="danger"
            className="w-full"
            data-testid="devices-bulk-disconnect"
            disabled={select.chosen.length === 0}
            onClick={() => setBulkOpen(true)}
          >
            <Icon name="link-off" size={18} />
            {t('devices.bulkDisconnect', { n: select.chosen.length })}
          </Button>
        </div>
      )}

      <Sheet open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)} title={t('devices.rename')} size="compact">
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="device-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <Button data-testid="device-name-save" onClick={() => void saveRename()}>
            {t('action.save')}
          </Button>
        </div>
      </Sheet>

      <DangerConfirmSheet
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('devices.disconnect')}
        body={t('devices.disconnectBody', { name: revoking ? logName(revoking) : '' })}
        onConfirm={() => void confirmRevoke()}
        testId="device-revoke-confirm"
      />

      <DangerConfirmSheet
        open={bulkOpen}
        onOpenChange={(open) => !open && !bulkBusy && setBulkOpen(false)}
        title={bulk.title}
        body={bulk.body}
        busy={bulkBusy}
        busyText={t('devices.bulkBusy')}
        onConfirm={() => void confirmBulk()}
        testId="devices-bulk-confirm"
      />
    </div>
  );
}
