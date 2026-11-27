import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { onSettingsArrived, settingChanged } from '@/lib/settingsBus';
import { mirrorLangForSw } from '@/lib/swBridge';
import { en } from './en';
import type { TranslationKey } from './en';
import { nl } from './nl';
import { tr } from './tr';

export type Lang = 'en' | 'nl' | 'tr';
export type { TranslationKey };

export const LOCALES: Record<Lang, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

export const LANGS: Lang[] = ['en', 'nl', 'tr'];
/** native names — a language picker must be readable in the language it offers */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', nl: 'Nederlands', tr: 'Türkçe' };

const DICTS: Record<Lang, Partial<Record<TranslationKey, string>>> = { en, nl, tr };
const LS_KEY = 'munni_lang';

export type TFunc = (key: TranslationKey, vars?: Record<string, string | number>) => string;

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** true when the user pinned a language; false = following the device */
  langOverridden: boolean;
  followDeviceLang: () => void;
  t: TFunc;
}

const LangContext = createContext<LangContextValue | null>(null);

function deviceLang(): Lang {
  // scan the whole system preference list, not just the primary: a Dutch system with English first still surfaces nl
  // no IP-country guessing: it needs an external lookup before login, against the zero-telemetry posture
  for (const candidate of navigator.languages?.length ? navigator.languages : [navigator.language || '']) {
    const code = candidate.slice(0, 2).toLowerCase();
    if (code === 'nl' || code === 'tr' || code === 'en') return code as Lang;
  }
  return 'en';
}

function readStoredLang(): Lang {
  // headless callers (node-environment tests, workers) have no DOM
  // storage — the device/default language answers there
  if (typeof localStorage === 'undefined') return typeof navigator === 'undefined' ? 'en' : deviceLang();
  const stored = localStorage.getItem(LS_KEY);
  if (stored === 'en' || stored === 'nl' || stored === 'tr') return stored;
  return deviceLang();
}

/** the active language for non-React code (catalog names), kept in sync by LangProvider */
let currentLang: Lang | null = null;
export function getCurrentLang(): Lang {
  return currentLang ?? readStoredLang();
}

/** a non-string template (a key from a lookup table fed a value this build no longer lists) yields '', not a TypeError */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (typeof template !== 'string') return '';
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);
  currentLang = lang;
  const [langOverridden, setLangOverridden] = useState<boolean>(() => localStorage.getItem(LS_KEY) !== null);

  const setLang = useCallback((next: Lang) => {
    localStorage.setItem(LS_KEY, next);
    setLangOverridden(true);
    setLangState(next);
    settingChanged();
  }, []);

  // #700: the language follows the account; one chosen on another device is read from where it was written
  useEffect(
    () =>
      onSettingsArrived(() => {
        setLangOverridden(localStorage.getItem(LS_KEY) !== null);
        setLangState(readStoredLang());
      }),
    [],
  );

  const followDeviceLang = useCallback(() => {
    localStorage.removeItem(LS_KEY);
    setLangOverridden(false);
    setLangState(deviceLang());
    settingChanged();
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    // push notifications (service worker) must speak the app's language
    mirrorLangForSw(lang);
  }, [lang]);

  const t = useCallback<TFunc>(
    (key, vars) => interpolate(DICTS[lang][key] ?? en[key] ?? key, vars),
    [lang],
  );

  const value = useMemo(
    () => ({ lang, setLang, langOverridden, followDeviceLang, t }),
    [lang, setLang, langOverridden, followDeviceLang, t],
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error('useLang must be used within LangProvider');
  return ctx;
}
