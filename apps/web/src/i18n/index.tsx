import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { en } from './en';
import type { TranslationKey } from './en';
import { nl } from './nl';
import { tr } from './tr';

export type Lang = 'en' | 'nl' | 'tr';
export type { TranslationKey };

/** BCP 47 locale per UI language, for Intl formatting */
export const LOCALES: Record<Lang, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

const DICTS: Record<Lang, Partial<Record<TranslationKey, string>>> = { en, nl, tr };
const LS_KEY = 'munni_lang';

export type TFunc = (key: TranslationKey, vars?: Record<string, string | number>) => string;

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunc;
}

const LangContext = createContext<LangContextValue | null>(null);

function readStoredLang(): Lang {
  const stored = localStorage.getItem(LS_KEY);
  if (stored === 'en' || stored === 'nl' || stored === 'tr') return stored;
  return 'en';
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);

  const setLang = useCallback((next: Lang) => {
    localStorage.setItem(LS_KEY, next);
    setLangState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback<TFunc>(
    (key, vars) => interpolate(DICTS[lang][key] ?? en[key] ?? key, vars),
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LangProvider');
  return ctx;
}
