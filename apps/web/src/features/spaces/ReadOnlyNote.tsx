import { useCanEdit } from '@/app/useCanEdit';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';

/** #505: shown where a read-only space's edit doors would be; nothing where the identity may write */
export function ReadOnlyNote({
  spaceId,
  testId = 'readonly-note',
  className = '',
}: Readonly<{ spaceId?: string; testId?: string; className?: string }>) {
  const { t } = useLang();
  const canEdit = useCanEdit(spaceId);
  if (canEdit) return null;
  return (
    <p
      data-testid={testId}
      className={`flex items-center gap-2 rounded-card bg-bg-2 px-4 py-2.5 text-[13px] leading-snug text-ink-3 ${className}`}
    >
      <Icon name="eye-outline" size={16} color="var(--m-ink-4)" />
      <span className="min-w-0">{t('space.readerNote')}</span>
    </p>
  );
}
