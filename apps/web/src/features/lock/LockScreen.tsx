import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import { hashPin, readLockConfig, useLock, verifyBiometric } from './lock';

/**
 * Full-screen gate rendered above the whole app while locked. Tries the
 * platform authenticator first; the backup PIN always works.
 */
export function LockScreen() {
  const { t } = useLang();
  const unlock = useLock((s) => s.unlock);
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const attempted = useRef(false);
  const config = readLockConfig();

  const tryBiometric = async () => {
    if (!config?.credentialId) {
      setPinMode(true);
      return;
    }
    if (await verifyBiometric(config.credentialId)) unlock();
    else setPinMode(true);
  };

  // auto-prompt once on mount
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    void tryBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tryPin = async () => {
    if (!config) {
      unlock();
      return;
    }
    if ((await hashPin(pin, config.pinSalt)) === config.pinHash) {
      unlock();
    } else {
      setError(true);
      setPin('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-bg px-8" data-testid="lock-screen">
      <Logo size={40} />
      {!pinMode && (
        <Button data-testid="lock-unlock" onClick={() => void tryBiometric()}>
          <Icon name="fingerprint" size={20} />
          {t('lock.unlock')}
        </Button>
      )}
      {!pinMode && (
        <button
          data-testid="lock-use-pin"
          onClick={() => setPinMode(true)}
          className="m-tap border-none bg-transparent text-[13px] text-ink-3"
        >
          {t('lock.usePin')}
        </button>
      )}
      {pinMode && (
        <div className="flex w-full max-w-[280px] flex-col gap-3">
          <input
            data-testid="lock-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replaceAll(/\D/g, ''));
              setError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void tryPin();
            }}
            placeholder={t('lock.pinLabel')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-center text-[18px] tracking-[6px] text-ink outline-none"
          />
          {error && (
            <p className="text-center text-[13px] text-negative" data-testid="lock-pin-error">
              {t('lock.wrongPin')}
            </p>
          )}
          <Button data-testid="lock-pin-submit" onClick={() => void tryPin()} disabled={pin.length < 4}>
            {t('lock.unlock')}
          </Button>
        </div>
      )}
    </div>
  );
}
