import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { hashPin, readLockConfig, verifyBiometric } from './lock';
import type { LockConfig } from './lock';

const MAX_PIN = 8;
const MIN_PIN = 4;
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

function Key({
  label,
  ariaLabel,
  onPress,
  testId,
  children,
}: Readonly<{
  label?: string;
  ariaLabel?: string;
  onPress: () => void;
  testId: string;
  children?: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={onPress}
      className="m-tap flex h-[68px] w-[68px] items-center justify-center rounded-full border border-line/70 bg-surface/80 shadow-[0_2px_10px_rgba(8,55,43,0.06)] backdrop-blur-[2px]"
    >
      {children ?? <span className="text-[26px] leading-none font-medium text-ink">{label}</span>}
    </button>
  );
}

interface UnlockOptions {
  onPass: () => void;
  /** the line the OS biometric prompt shows */
  reason: string;
  /** false keeps the pad inert (a closed sheet); each activation starts empty and may prompt again */
  active: boolean;
  /** asked once per activation: whether the biometric prompt comes up by itself */
  autoPrompt: () => boolean;
}

function useUnlock({ onPass, reason, active, autoPrompt }: UnlockOptions) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const pinRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(false);
  const promptedRef = useRef(false);
  // a late answer (a hash, a biometric) from an earlier round or after a pass must never pass again
  const roundRef = useRef(0);

  const showPin = (next: string) => {
    pinRef.current = next;
    setPin(next);
  };
  const pass = (round: number) => {
    if (!activeRef.current || round !== roundRef.current) return;
    roundRef.current += 1;
    onPass();
  };

  // read per use, not per mount: a sheet's pad can outlive the lock being set up or changed beside it
  const tryBiometric = async () => {
    const config = readLockConfig();
    if (!config?.biometricKind) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const round = roundRef.current;
    if (await verifyBiometric(config, reason, controller.signal)) pass(round);
  };

  const checkPin = async (next: string, lock: LockConfig) => {
    const round = roundRef.current;
    if ((await hashPin(next, lock.pinSalt)) === lock.pinHash) {
      pass(round);
    } else if (next.length === MAX_PIN) {
      // silent from 4 digits: the error shows only once the longest PIN is spent
      setError(true);
      showPin('');
    }
  };

  const pressDigit = (digit: string) => {
    // #202: typing dismisses an in-flight passkey sheet
    abortRef.current?.abort();
    setError(false);
    const next = (pinRef.current + digit).slice(0, MAX_PIN);
    showPin(next);
    const config = readLockConfig();
    if (config && next.length >= MIN_PIN) void checkPin(next, config);
  };
  const backspace = () => showPin(pinRef.current.slice(0, -1));

  // no cleanup on purpose: StrictMode's rehearsal unmount would cancel the prompt it just raised
  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      roundRef.current += 1;
      promptedRef.current = false;
      showPin('');
      setError(false);
      return;
    }
    if (promptedRef.current || !autoPrompt()) return;
    promptedRef.current = true;
    void tryBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(
    () => () => {
      activeRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) pressDigit(e.key);
      if (e.key === 'Backspace') backspace();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { pin, error, hasBiometric: !!readLockConfig()?.biometricKind, pressDigit, backspace, tryBiometric };
}

/** #530: the app-start lock and every "confirm it's you" sheet unlock through this one pad */
export function UnlockPad(props: Readonly<UnlockOptions>) {
  const { t } = useLang();
  const { pin, error, hasBiometric, pressDigit, backspace, tryBiometric } = useUnlock(props);

  return (
    <div className="flex flex-col items-center" data-testid="unlock-pad">
      <p className="mt-1 text-[12px] text-ink-3" data-testid={error ? 'lock-pin-error' : undefined}>
        {error ? t('lock.wrongPin') : t('lock.pinHint')}
      </p>

      {/* dots appear as digits are entered: no fixed-length suggestion */}
      <div className="mt-4 flex h-8 items-center gap-3" data-testid="lock-dots" data-length={pin.length}>
        {pin.length === 0 ? (
          <span className="h-3.5 w-3.5 rounded-full border border-ink-4/40" aria-hidden="true" />
        ) : (
          Array.from({ length: pin.length }, (_, i) => <span key={`dot-${i + 1}`} className="h-3.5 w-3.5 rounded-full bg-brand" />)
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-x-7 gap-y-3.5">
        {DIGITS.map((d) => (
          <Key key={d} label={d} testId={`lock-key-${d}`} onPress={() => pressDigit(d)} />
        ))}
        {hasBiometric ? (
          <Key testId="lock-unlock" ariaLabel={t('lock.disarmBiometric')} onPress={() => void tryBiometric()}>
            <Icon name="fingerprint" size={26} color="var(--m-ink-2)" />
          </Key>
        ) : (
          <span aria-hidden="true" />
        )}
        <Key label="0" testId="lock-key-0" onPress={() => pressDigit('0')} />
        <Key testId="lock-key-back" ariaLabel={t('action.delete')} onPress={backspace}>
          <Icon name="backspace-outline" size={22} color="var(--m-ink-2)" />
        </Key>
      </div>
    </div>
  );
}
