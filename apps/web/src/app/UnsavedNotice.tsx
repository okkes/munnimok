import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import { UNSAVED_UNDONE_KEY, readUnsavedUndone } from '@/sync/spaceAccess';
import type { UnsavedUndone } from '@/sync/spaceAccess';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { useData } from './data';

/**
 * #505 (user): changes made on this device in a space it may only read
 * never reached the other members — the sync engine undid them. This says
 * so, once: the list lives in meta until the person has seen it, so a
 * restart before that still shows it.
 */
export function UnsavedNotice() {
  const { t } = useLang();
  const { store } = useData();
  const undone = useQuery(store, () => readUnsavedUndone(store), [store], []);
  const dismiss = () => void store.metaDelete(UNSAVED_UNDONE_KEY);
  // a feed has no name of its own: its account's, or — an entry stored before accounts were named — neither
  const sentence = (entry: UnsavedUndone): string => {
    const one = entry.count === 1;
    if (entry.spaceName) return t(one ? 'space.undoneBodyOne' : 'space.undoneBody', { space: entry.spaceName, n: entry.count });
    if (entry.accountName) return t(one ? 'space.undoneAccountOne' : 'space.undoneAccount', { account: entry.accountName, n: entry.count });
    return t('space.undoneOther');
  };
  return (
    <Sheet open={undone.length > 0} onOpenChange={(next) => !next && dismiss()} title={t('space.undoneTitle')} size="compact">
      {undone.length > 0 && (
        <div className="flex flex-col gap-3 pt-1" data-testid="unsaved-undone-sheet">
          {undone.map((entry) => (
            <p key={entry.spaceId} className="text-[14px] leading-relaxed text-ink-2" data-testid={`unsaved-undone-${entry.spaceId}`}>
              {sentence(entry)}
            </p>
          ))}
          <Button data-testid="unsaved-undone-ok" onClick={dismiss}>
            {t('action.done')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
