import { useLang } from '@/i18n';
import { openExternal, webSearchUrl } from '@/lib/platform';
import { Icon } from '@/ui/Icon';

/** #506: a vague bank title is one tap from a web search; the in-app browser on the shells, a tab on the web */
export function TitleSearchButton({ query, testId }: Readonly<{ query: string; testId: string }>) {
  const { t } = useLang();
  if (!query.trim()) return null;
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

export function SearchableTitle({ text, query, testId }: Readonly<{ text: string; query: string; testId: string }>) {
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 align-middle">
      <span className="min-w-0 truncate">{text}</span>
      <TitleSearchButton query={query} testId={testId} />
    </span>
  );
}
