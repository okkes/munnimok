import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useData } from '@/app/data';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { COUNTRIES, currencyForCountry } from '@/domain/countries';
import { BankConnectSheet } from '@/features/accounts/BankConnect';
import { Button } from '@/ui/Button';
import { Highlight } from '@/ui/Highlight';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import { Sheet } from '@/ui/Sheet';

const countryLabel = (code: string, lang: Lang) => {
  const c = COUNTRIES.find((x) => x.code === code);
  return c ? c[lang] : code;
};

/**
 * First-login setup for brand-new users: display name (shared with
 * friends/space members) + country, which picks the personal space's
 * currency. Fully skippable; shown once (needsOnboarding meta flag,
 * set only when this device CREATED the personal space).
 */
export function OnboardingScreen() {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [country, setCountry] = useState('NL');
  const [countryOpen, setCountryOpen] = useState(false);
  const [query, setQuery] = useState('');
  // step 1 = profile, step 2 = bank (legacy onboarding parity)
  const [step, setStep] = useState<1 | 2>(1);
  const [gcAvailable, setGcAvailable] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  useEffect(() => {
    void getApiCapabilities().then((caps) => setGcAvailable(caps.gocardless));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return COUNTRIES.filter((c) => !q || c[lang].toLowerCase().includes(q) || c.native.toLowerCase().includes(q));
  }, [query, lang]);

  /** step 1 done: apply the profile, then offer the bank step */
  const applyProfile = async (save: boolean) => {
    if (save) {
      if (name.trim()) {
        // best-effort: offline is fine, the app never blocks on the API
        void apiFetch('/me', { method: 'PUT', body: JSON.stringify({ displayName: name.trim() }) }).catch(() => undefined);
      }
      await repo.upsert('space', spaceId, spaceId, { currency: currencyForCountry(country) });
    }
    // cleared here: a bank redirect leaves the app and must not loop onboarding
    await store.metaDelete('needsOnboarding');
    setStep(2);
  };

  const finish = async (target: '/home' | '/accounts' = '/home') => {
    await navigate({ to: target });
  };

  return (
    <div className="m-fade flex h-full flex-col items-center px-6" data-testid="screen-onboarding">
      <div className="flex h-full w-full max-w-[420px] flex-col">
        <div className="flex flex-col items-center pt-14 pb-8 text-center">
          <Logo size={32} />
          <h1 className="m-h2 mt-5 text-ink">{t('onboarding.title')}</h1>
        </div>

        {step === 1 && (
          <div className="flex flex-col gap-3">
            <input
              data-testid="onboarding-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('login.fullName')}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
            <button
              data-testid="onboarding-country"
              onClick={() => setCountryOpen(true)}
              className="m-tap flex h-12 w-full items-center gap-3 rounded-input border border-line bg-surface px-4 text-left text-[15px] text-ink"
            >
              <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-3">
                {country}
              </span>
              <span className="flex-1">{countryLabel(country, lang)}</span>
              <Icon name="chevron-down" size={18} color="var(--m-ink-4)" />
            </button>
            <p className="px-1 text-[12px] text-ink-3" data-testid="onboarding-currency-hint">
              {t('onboarding.currencyAuto')} {currencyForCountry(country)}
            </p>

            <Button data-testid="onboarding-save" onClick={() => void applyProfile(true)}>
              {t('login.continue')}
            </Button>
            <Button variant="ghost" data-testid="onboarding-skip" onClick={() => void applyProfile(false)}>
              {t('action.skip')}
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-3" data-testid="onboarding-bank-step">
            <div className="flex flex-col items-center gap-2 pb-2 text-center">
              <Icon name="bank-outline" size={36} color="var(--m-accent)" />
              <h2 className="m-h3 text-ink">{t('onboarding.bankTitle')}</h2>
              <p className="max-w-[300px] text-[13px] text-ink-3">{t('onboarding.bankSub')}</p>
            </div>
            {gcAvailable && (
              <Button data-testid="onboarding-connect-bank" onClick={() => setConnectOpen(true)}>
                <Icon name="bank-transfer" size={18} />
                {t('gc.connect')}
              </Button>
            )}
            <Button
              variant="outline"
              data-testid="onboarding-import"
              onClick={() => void finish('/accounts')}
            >
              <Icon name="file-upload-outline" size={17} />
              {t('onboarding.importInstead')}
            </Button>
            <Button variant="ghost" data-testid="onboarding-bank-later" onClick={() => void finish()}>
              {t('onboarding.later')}
            </Button>
          </div>
        )}
      </div>

      <BankConnectSheet open={connectOpen} onOpenChange={setConnectOpen} />

      <Sheet open={countryOpen} onOpenChange={setCountryOpen} title={t('onboarding.country')} size="tall">
        <input
          data-testid="onboarding-country-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('onboarding.countrySearch')}
          className="mb-2 h-11 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        {filtered.map((c) => (
          <button
            key={c.code}
            data-testid={`onboarding-country-${c.code}`}
            onClick={() => {
              setCountry(c.code);
              setCountryOpen(false);
              setQuery('');
            }}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left text-[14px] text-ink"
          >
            <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-3">
              {c.code}
            </span>
            <span className="flex-1">
              <Highlight text={c[lang]} query={query} />
            </span>
            <span className="text-[11px] text-ink-4">{currencyForCountry(c.code)}</span>
          </button>
        ))}
      </Sheet>
    </div>
  );
}
