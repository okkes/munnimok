import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import leafUrl from '@/assets/leaf.png';
import { hashPin, readLockConfig, useLock, verifyBiometric } from './lock';

const MAX_PIN = 8;
const MIN_PIN = 4;
const KEY_LETTERS: Record<string, string> = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ' };

/** layered soft-green waves along the bottom (brand treatment, no asset) */
function Waves() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%] w-full"
      viewBox="0 0 1440 480"
      preserveAspectRatio="none"
    >
      <path d="M0,220 C240,140 480,300 720,240 C960,180 1200,320 1440,230 L1440,480 L0,480 Z" fill="#AABFA9" opacity="0.22" />
      <path d="M0,300 C280,220 520,380 800,310 C1080,240 1240,400 1440,320 L1440,480 L0,480 Z" fill="#9DB59B" opacity="0.30" />
      <path d="M0,390 C320,320 620,450 920,395 C1160,350 1320,440 1440,410 L1440,480 L0,480 Z" fill="#8FAA8D" opacity="0.38" />
    </svg>
  );
}

function Key({
  label,
  letters,
  onPress,
  testId,
  children,
}: {
  label?: string;
  letters?: string;
  onPress: () => void;
  testId: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onPress}
      className="m-tap flex h-[72px] w-[72px] flex-col items-center justify-center rounded-full border border-line/70 bg-surface/80 shadow-[0_2px_10px_rgba(8,55,43,0.06)] backdrop-blur-[2px]"
    >
      {children ?? (
        <>
          <span className="text-[26px] leading-none font-medium text-ink">{label}</span>
          {letters && <span className="mt-0.5 text-[10px] tracking-[0.12em] text-ink-4">{letters}</span>}
        </>
      )}
    </button>
  );
}

/**
 * Full-screen gate rendered above the whole app while locked: brand wash
 * with waves + arch, PIN keypad as the primary surface (auto-verifies from
 * 4 digits), biometric on the pad and auto-prompted once on mount.
 */
export function LockScreen() {
  const { t } = useLang();
  const unlock = useLock((s) => s.unlock);
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const attempted = useRef(false);
  const config = readLockConfig();
  const hasBiometric = !!config?.credentialId;

  const tryBiometric = async () => {
    if (!config?.credentialId) return;
    if (await verifyBiometric(config.credentialId)) unlock();
  };

  // auto-prompt once on mount
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    void tryBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pressDigit = useCallback(
    (digit: string) => {
      setError(false);
      setPin((prev) => {
        const next = (prev + digit).slice(0, MAX_PIN);
        if (config && next.length >= MIN_PIN) {
          // verify silently on every keypress from 4 digits — unlock on match,
          // flag the error only once the maximum length is exhausted
          void hashPin(next, config.pinSalt).then((hash) => {
            if (hash === config.pinHash) {
              unlock();
            } else if (next.length === MAX_PIN) {
              setError(true);
              setPin('');
            }
          });
        }
        return next;
      });
    },
    [config, unlock],
  );

  // physical keyboard support (desktop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) pressDigit(e.key);
      if (e.key === 'Backspace') setPin((prev) => prev.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pressDigit]);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-bg" data-testid="lock-screen">
      <Waves />
      {/* soft leaf watermark, mockup parity */}
      <img
        src={leafUrl}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute right-[6%] bottom-[8%] w-[140px] opacity-25 grayscale-[0.2]"
      />
      <span aria-hidden="true" className="absolute top-[16%] left-[12%] text-[18px] text-[#C9BFA9]">✦</span>
      <span aria-hidden="true" className="absolute top-[9%] right-[14%] text-[12px] text-[#C9BFA9]">✦</span>

      <div className="relative mx-auto flex h-full w-full max-w-[420px] flex-col items-center overflow-y-auto px-6 pt-[max(28px,env(safe-area-inset-top))] pb-[max(20px,env(safe-area-inset-bottom))]">
        {/* arch ring behind the brand block */}
        <div className="pointer-events-none absolute top-[3%] left-1/2 h-[62%] w-[min(88%,360px)] -translate-x-1/2 rounded-t-[999px] border border-white/70 bg-white/20" />

        <div className="relative mt-4 flex flex-col items-center gap-2">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface shadow-[0_4px_18px_rgba(8,55,43,0.10)]">
            <img src={leafUrl} alt="" className="h-8 w-8 object-contain" />
          </span>
          <Logo size={30} />
        </div>

        <p className="relative mt-6 text-[17px] font-semibold text-ink">{t('lock.enterPin')}</p>
        <p className="relative mt-1 text-[12px] text-ink-3" data-testid={error ? 'lock-pin-error' : undefined}>
          {error ? t('lock.wrongPin') : t('lock.pinHint')}
        </p>

        {/* PIN dots */}
        <div
          className="relative mt-4 flex items-center gap-3 rounded-2xl border border-line/60 bg-surface/80 px-5 py-3.5 shadow-[0_2px_10px_rgba(8,55,43,0.05)]"
          data-testid="lock-dots"
          data-length={pin.length}
        >
          {Array.from({ length: MAX_PIN }, (_, i) => (
            <span
              key={`dot-${i + 1}`}
              className={`h-3.5 w-3.5 rounded-full border ${i < pin.length ? 'border-brand bg-brand' : 'border-ink-4/50 bg-transparent'}`}
            />
          ))}
        </div>

        {/* keypad */}
        <div className="relative mt-6 grid grid-cols-3 gap-x-8 gap-y-4">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <Key key={d} label={d} letters={KEY_LETTERS[d]} testId={`lock-key-${d}`} onPress={() => pressDigit(d)} />
          ))}
          {hasBiometric ? (
            <Key testId="lock-unlock" onPress={() => void tryBiometric()}>
              <Icon name="fingerprint" size={26} color="var(--m-ink-2)" />
            </Key>
          ) : (
            <span aria-hidden="true" />
          )}
          <Key label="0" testId="lock-key-0" onPress={() => pressDigit('0')} />
          <Key testId="lock-key-back" onPress={() => setPin((prev) => prev.slice(0, -1))}>
            <Icon name="backspace-outline" size={22} color="var(--m-ink-2)" />
          </Key>
        </div>
      </div>
    </div>
  );
}
