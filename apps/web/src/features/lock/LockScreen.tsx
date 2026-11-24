import { useLang } from '@/i18n';
import { Logo } from '@/ui/Logo';
import leafUrl from '@/assets/leaf.png';
import { useLock } from './lock';
import { UnlockPad } from './UnlockPad';

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

// #202: once per lock cycle, not per mount: the OS passkey sheet backgrounds the page, the watcher re-locks (timeout 0)
// and the remounted screen prompted again, endlessly
const promptOncePerCycle = () => {
  const lock = useLock.getState();
  if (lock.promptSpent) return false;
  lock.spendPrompt();
  return true;
};

export function LockScreen() {
  const { t } = useLang();
  const unlock = useLock((s) => s.unlock);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-bg" data-testid="lock-screen">
      <Waves />
      <span aria-hidden="true" className="absolute top-[16%] left-[12%] text-[18px] text-[#C9BFA9]">✦</span>
      <span aria-hidden="true" className="absolute top-[9%] right-[14%] text-[12px] text-[#C9BFA9]">✦</span>

      <div className="relative mx-auto flex h-full w-full max-w-[420px] flex-col items-center overflow-y-auto px-6 pt-[max(28px,env(safe-area-inset-top))] pb-[max(20px,env(safe-area-inset-bottom))]">
        <div className="relative flex w-full flex-col items-center rounded-t-[999px] rounded-b-[28px] border border-white/70 bg-white/25 px-4 pt-10 pb-7">
          <div className="flex flex-col items-center gap-2">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface shadow-[0_4px_18px_rgba(8,55,43,0.10)]">
              <img src={leafUrl} alt="" className="h-8 w-8 object-contain" />
            </span>
            <Logo size={30} />
          </div>

          <p className="mt-5 text-[17px] font-semibold text-ink">{t('lock.enterPin')}</p>
          <UnlockPad active onPass={unlock} reason={t('lock.sub')} autoPrompt={promptOncePerCycle} />
        </div>
      </div>
    </div>
  );
}
