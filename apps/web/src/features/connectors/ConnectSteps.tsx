import { useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useConnectionOps } from '@/application/connections';
import type { AdoptResult } from '@/application/connections';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Sheet } from '@/ui/Sheet';
import { connectorApi } from './api';
import { ConnectFlowSheet, forgetTypedValues } from './ConnectFlowSheet';
import type { ResumeLogin } from './ConnectFlowSheet';
import { usePendingLoginFollower } from './pendingLogins';
import { SpacePicker } from './SpacePicker';
import type { ProviderManifest } from './types';
import type { CatalogueState } from './useCatalogue';

/** a sign-in to run: a party to connect, a connection to sign in again as, or one closed mid-way to pick up */
export interface FlowRequest {
  manifest: ProviderManifest;
  reconnectId: string | null;
  resume?: ResumeLogin;
}

/**
 * What follows a pick (#527: shared by the hubs and the space's own
 * Connect door): the sign-in itself, naming a fresh connection right away
 * (user ruling), and for a shop the spaces its receipts reach — none until
 * picked (user ruling 2026-10-02). A sign-in that settles while its sheet
 * is closed is adopted here too.
 */
export function ConnectSteps({
  flow,
  onFlowChange,
  catalogue,
}: Readonly<{ flow: FlowRequest | null; onFlowChange: (flow: FlowRequest | null) => void; catalogue: CatalogueState }>) {
  const { t } = useLang();
  const { store } = useData();
  const ops = useConnectionOps();
  const allSpaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  const [naming, setNaming] = useState<{ connectionId: string; duplicateOf?: string } | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [spacesStep, setSpacesStep] = useState<{ connectionId: string; picked: string[] } | null>(null);

  const afterConnect = async (result: AdoptResult, reconnect: boolean) => {
    onFlowChange(null);
    if (reconnect) return;
    // fresh connection: ask for a display name right away (user ruling)
    const meta = (await store.allRows('storeConn')).find((c) => c.id === result.connectionId);
    setNameDraft(meta?.displayName ?? '');
    setAttempted(false);
    setNaming({ connectionId: result.connectionId, duplicateOf: result.duplicateOf });
  };

  const saveName = async () => {
    if (!naming) return;
    const named = naming.connectionId;
    await ops.rename(named, nameDraft);
    setNaming(null);
    // a shop's receipts reach no space until picked (user ruling 2026-10-02): the step follows the name
    const meta = (await store.allRows('storeConn')).find((c) => c.id === named && c.deleted === 0);
    const kind = meta?.kind ?? (meta ? catalogue.byId.get(meta.store)?.kind : undefined) ?? 'store';
    if (meta && kind === 'store' && (allSpaces ?? []).length > 0) setSpacesStep({ connectionId: named, picked: [] });
  };

  const saveSpaces = async () => {
    if (!spacesStep) return;
    if (spacesStep.picked.length > 0) await ops.setIncludedSpaces(spacesStep.connectionId, spacesStep.picked);
    setSpacesStep(null);
  };

  const togglePicked = (spaceId: string) =>
    setSpacesStep((step) => step && { ...step, picked: step.picked.includes(spaceId) ? step.picked.filter((id) => id !== spaceId) : [...step.picked, spaceId] });

  // a sign-in that settles while its sheet is closed is adopted right here
  usePendingLoginFollower({
    exclude: flow?.resume?.connectionId ?? null,
    onActive: async (login, view) => {
      const manifest = catalogue.byId.get(login.provider);
      if (!manifest) return;
      const full = view.bundle ? view : await connectorApi.login(login.provider, view.sessionId);
      const result = await ops.adopt({ manifest, view: full, connectionId: login.connectionId, reconnect: login.reconnect });
      forgetTypedValues(login.reconnect ? login.connectionId : null, login.provider);
      await afterConnect(result, login.reconnect);
    },
  });

  return (
    <>
      <ConnectFlowSheet
        open={flow !== null}
        manifest={flow?.manifest ?? null}
        reconnectId={flow?.reconnectId ?? null}
        resume={flow?.resume ?? null}
        onOpenChange={(open) => !open && onFlowChange(null)}
        onDone={(result, reconnect) => void afterConnect(result, reconnect)}
      />

      {/* name-the-connection step right after a successful connect */}
      <Sheet
        open={naming !== null}
        onOpenChange={(open) => {
          if (open) return;
          setNaming(null);
          setAttempted(false);
        }}
        title={t('conn.nameTitle')}
        size="form"
      >
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-[13px] leading-relaxed text-ink-2">{t('conn.nameHint')}</p>
          {naming?.duplicateOf && (
            <p className="rounded-card bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-ink-2" data-testid="conn-dup-note">
              {t('conn.duplicateNote')}
            </p>
          )}
          <input
            data-testid="conn-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            aria-invalid={attempted && !nameDraft.trim()}
            className={`h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none${blockerRing(attempted && !nameDraft.trim())}`}
          />
          <FormBlockerNote show={attempted && !nameDraft.trim()} text={t('form.needName')} testId="conn-name-save-blocker" />
          <Button
            data-testid="conn-name-save"
            onClick={() => {
              if (!nameDraft.trim()) {
                setAttempted(true);
                return;
              }
              void saveName();
            }}
          >
            {t('action.save')}
          </Button>
        </div>
      </Sheet>

      {/* the step after naming: which spaces a shop's receipts reach — none until picked (user ruling 2026-10-02) */}
      <Sheet open={spacesStep !== null} onOpenChange={(open) => !open && setSpacesStep(null)} title={t('conn.spacesTitle')} size="tall">
        {spacesStep && (
          <div className="flex flex-col gap-3 pt-1" data-testid="conn-spaces-step">
            <p className="text-[13px] leading-relaxed text-ink-2">{t('conn.spacesHint')}</p>
            <SpacePicker spaces={allSpaces ?? []} selected={spacesStep.picked} onToggle={togglePicked} testId="conn-spaces-list" />
            <Button data-testid="conn-spaces-save" onClick={() => void saveSpaces()}>
              {t('action.save')}
            </Button>
            <Button variant="outline" data-testid="conn-spaces-skip" onClick={() => setSpacesStep(null)}>
              {t('conn.spacesSkip')}
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}
