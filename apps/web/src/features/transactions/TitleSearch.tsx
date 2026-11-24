import { useSession } from '@/app/session';
import { useLang } from '@/i18n';
import { openExternal, webSearchUrl } from '@/lib/platform';
import { Icon } from '@/ui/Icon';

/** an offline profile's promise is that nothing of its data leaves the device, a search the person starts included;
 *  the demo's titles are made-up sample data, so it keeps the search */
export function useTitleSearchOffered(): boolean {
  return useSession((s) => s.identity?.kind === 'user' || s.identity?.kind === 'demo');
}

/** #506: a vague bank title is one tap from a web search; the in-app browser on the shells, a tab on the web */
export function TitleSearchButton({ query, testId }: Readonly<{ query: string; testId: string }>) {
  const { t } = useLang();
  const offered = useTitleSearchOffered();
  if (!offered || !query.trim()) return null;
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={t('tx.searchWeb')}
      title={t('tx.searchWeb')}
      onClick={(e) => {
        e.stopPropagation();
        openExternal(webSearchUrl(query));
      }}
      className="m-tap inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-none bg-transparent align-middle text-ink-3"
    >
      <Icon name="search-web" size={16} />
    </button>
  );
}

/** #506: the whole title is read, never cut short: it wraps, codes without spaces included, the search icon at its end */
export function SearchableTitle({
  text,
  query,
  testId,
  titleTestId,
}: Readonly<{ text: string; query: string; testId: string; titleTestId?: string }>) {
  return (
    <span className="wrap-anywhere" data-testid={titleTestId}>
      {text}
      <TitleSearchButton query={query} testId={testId} />
    </span>
  );
}
