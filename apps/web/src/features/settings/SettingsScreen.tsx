import { useState } from 'react';
import { useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useTheme } from '@/app/theme';
import { AppBar } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

const LANGS: { code: Lang; labelKey: 'lang.en' | 'lang.nl' | 'lang.tr'; badge: string }[] = [
  { code: 'en', labelKey: 'lang.en', badge: 'EN' },
  { code: 'nl', labelKey: 'lang.nl', badge: 'NL' },
  { code: 'tr', labelKey: 'lang.tr', badge: 'TR' },
];

export function SettingsScreen() {
  const { t, lang, setLang } = useLang();
  const { theme, toggle } = useTheme();
  const [langSheetOpen, setLangSheetOpen] = useState(false);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-settings">
      <AppBar large title={t('screen.settings')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <button
            data-testid="settings-language-row"
            onClick={() => setLangSheetOpen(true)}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="translate" size={20} />
            <span className="flex-1">{t('settings.language')}</span>
            <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-3">
              {lang.toUpperCase()}
            </span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="settings-theme-toggle"
            onClick={toggle}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name={theme === 'dark' ? 'weather-night' : 'weather-sunny'} size={20} />
            <span className="flex-1">{t('settings.appearance')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
        </div>

        <div className="pt-6 pb-6 text-center text-[11px] text-ink-4">
          munni · v1.0.0 · build {String(__BUILD_NUMBER__)}
        </div>
      </div>

      <Sheet open={langSheetOpen} onOpenChange={setLangSheetOpen} title={t('lang.title')}>
        <div className="flex flex-col pt-1">
          {LANGS.map((entry) => (
            <button
              key={entry.code}
              data-testid={`lang-option-${entry.code}`}
              onClick={() => {
                setLang(entry.code);
                setLangSheetOpen(false);
              }}
              className="m-tap flex items-center gap-3 border-none bg-transparent px-1 py-3.5 text-left text-[15px] text-ink"
            >
              <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-3">
                {entry.badge}
              </span>
              <span className="flex-1">{t(entry.labelKey)}</span>
              {lang === entry.code && <Icon name="check" size={18} color="var(--m-accent)" />}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
