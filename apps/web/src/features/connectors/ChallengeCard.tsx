import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { connectorApi } from './api';
import { LiveView } from './LiveView';
import { challengeKey, encodeTaps } from './manifestForm';
import { openPartyPage } from './redirect';
import type { ChallengeView } from './types';

/**
 * One question a party asks mid-login or mid-fetch, rendered by its
 * typed kind (docs/connectors/contract.md): a code to type, a code to
 * enter elsewhere, a QR to scan, an approval to wait for, a picture to
 * read or tap, a choice, a page to finish on, or the page itself.
 */
export interface ChallengeCardProps {
  provider: string;
  sessionId: string;
  challenge: ChallengeView;
  busy: boolean;
  onAnswer: (value: string) => void;
}

const INPUT = 'h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4';

/** the challenge's picture, fetched with the caller's credentials and held as an object URL */
function useChallengeImage(provider: string, sessionId: string, challenge: ChallengeView): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!challenge.imageUrl && challenge.type !== 'image' && challenge.type !== 'qr_display') return;
    let current: string | null = null;
    let alive = true;
    void connectorApi
      .challengeImage(provider, sessionId, challenge.id)
      .then((blob) => {
        if (!alive || !blob) return;
        current = URL.createObjectURL(blob);
        setUrl(current);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [provider, sessionId, challenge.id, challenge.imageUrl, challenge.type]);
  return url;
}

/** seconds until the question expires, ticking */
function useCountdown(expiresAt: string): number {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000)));
  useEffect(() => {
    const timer = setInterval(() => setLeft(Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return left;
}

function TextAnswer({ challenge, busy, onAnswer, placeholder, numeric }: Readonly<{ challenge: ChallengeView; busy: boolean; onAnswer: (v: string) => void; placeholder?: string; numeric?: boolean }>) {
  const { t } = useLang();
  const [value, setValue] = useState('');
  return (
    <>
      <input
        data-testid="connect-answer"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        inputMode={numeric ? 'numeric' : undefined}
        maxLength={challenge.length ?? undefined}
        autoComplete="one-time-code"
        placeholder={placeholder}
        className={INPUT}
      />
      <Button data-testid="connect-answer-submit" disabled={busy || !value.trim()} onClick={() => onAnswer(value.trim())}>
        {t('connect.next')}
      </Button>
    </>
  );
}

function TapsAnswer({ url, busy, onAnswer }: Readonly<{ url: string | null; busy: boolean; onAnswer: (v: string) => void }>) {
  const { t } = useLang();
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  return (
    <>
      <p className="text-[12px] text-ink-3">{t('connect.taps.hint')}</p>
      <div className="relative w-full overflow-hidden rounded-card border border-line bg-bg-2">
        {url ? (
          <button
            type="button"
            data-testid="connect-taps-image"
            className="block w-full cursor-crosshair border-0 bg-transparent p-0"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setPoints((p) => [...p, { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }]);
            }}
          >
            <img src={url} alt="" className="block w-full select-none" draggable={false} />
          </button>
        ) : (
          <div className="h-40" />
        )}
        {points.map((p, i) => (
          <span
            key={`${p.x}-${p.y}-${i}`}
            className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent-soft"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          />
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" data-testid="connect-taps-none" disabled={busy} onClick={() => onAnswer('tap.v1:')}>
          {t('connect.taps.none')}
        </Button>
        <Button className="flex-1" data-testid="connect-taps-submit" disabled={busy || points.length === 0} onClick={() => onAnswer(encodeTaps(points))}>
          {t('connect.taps.submit')}
        </Button>
      </div>
    </>
  );
}

function RedirectAnswer({ challenge, busy, onAnswer }: Readonly<{ challenge: ChallengeView; busy: boolean; onAnswer: (v: string) => void }>) {
  const { t } = useLang();
  const [pasted, setPasted] = useState('');
  const open = async () => {
    if (!challenge.url) return;
    const captured = await openPartyPage(challenge.url, challenge.returnPattern).catch(() => null);
    if (captured) onAnswer(captured);
  };
  return (
    <>
      <Button variant="outline" className="w-full" data-testid="connect-redirect-open" disabled={busy || !challenge.url} onClick={() => void open()}>
        <Icon name="open-in-new" size={16} />
        {t('connect.redirect.open')}
      </Button>
      <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] leading-relaxed text-ink-3" data-testid="connect-redirect-note">
        {t('connect.redirect.appNote')}
      </p>
      <input
        data-testid="connect-redirect-paste"
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder={t('connect.redirect.paste')}
        className={`${INPUT} font-mono text-[13px]`}
      />
      <Button data-testid="connect-redirect-submit" disabled={busy || !pasted.trim()} onClick={() => onAnswer(pasted.trim())}>
        {t('connect.redirect.submit')}
      </Button>
    </>
  );
}

export function ChallengeCard({ provider, sessionId, challenge, busy, onAnswer }: Readonly<ChallengeCardProps>) {
  const { t } = useLang();
  const image = useChallengeImage(provider, sessionId, challenge);
  const left = useCountdown(challenge.expiresAt);
  const delivery = challenge.delivery ? `connect.codeDelivery.${challenge.delivery}` : undefined;

  const body = () => {
    switch (challenge.type) {
      case 'mfa_code':
        return <TextAnswer challenge={challenge} busy={busy} onAnswer={onAnswer} numeric placeholder={challenge.length ? '•'.repeat(challenge.length) : undefined} />;
      case 'code_display':
        return (
          <>
            <p className="rounded-card bg-bg-2 px-4 py-3 text-center font-mono text-[22px] font-semibold tracking-widest text-ink" data-testid="connect-code">
              {challenge.code}
            </p>
            <Button data-testid="connect-answer-submit" disabled={busy} onClick={() => onAnswer('ok')}>
              {t('connect.codeEntered')}
            </Button>
          </>
        );
      case 'qr_display':
        return (
          <>
            {image && <img src={image} alt="" data-testid="connect-qr" className="mx-auto h-48 w-48 rounded-card bg-white object-contain p-2" />}
            <Button data-testid="connect-answer-submit" disabled={busy} onClick={() => onAnswer('')}>
              {t('connect.approved')}
            </Button>
          </>
        );
      case 'app_approval':
        return (
          <>
            <div className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="connect-waiting">
              <Icon name="cellphone-check" size={20} color="var(--m-accent-deep)" />
              <span className="text-[13px] text-ink-2">{t('connect.approval.waiting')}</span>
            </div>
            <Button variant="outline" data-testid="connect-answer-submit" disabled={busy} onClick={() => onAnswer('')}>
              {t('connect.approved')}
            </Button>
          </>
        );
      case 'image':
        return challenge.answerKind === 'taps' ? (
          <TapsAnswer url={image} busy={busy} onAnswer={onAnswer} />
        ) : (
          <>
            {image && <img src={image} alt="" data-testid="connect-captcha" className="w-full rounded-card bg-white object-contain" />}
            <TextAnswer challenge={challenge} busy={busy} onAnswer={onAnswer} />
          </>
        );
      case 'select_option':
        return (
          <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="connect-options">
            {(challenge.options ?? []).map((option) => (
              <button
                key={option.value}
                data-testid={`connect-option-${option.value}`}
                disabled={busy}
                onClick={() => onAnswer(option.value)}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left text-[14px] text-ink last:border-0"
              >
                <Icon name="radiobox-blank" size={18} color="var(--m-ink-4)" />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </button>
            ))}
          </div>
        );
      case 'redirect':
        return <RedirectAnswer challenge={challenge} busy={busy} onAnswer={onAnswer} />;
      case 'live_view':
        return <LiveView provider={provider} sessionId={sessionId} challengeId={challenge.id} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid={`connect-challenge-${challenge.type}`}>
      <p className="text-[13px] leading-relaxed text-ink-2" data-testid="connect-challenge-prompt">
        {t(challengeKey(challenge.type, challenge.promptKey))}
        {delivery && <span className="text-ink-4"> · {t(delivery as never)}</span>}
      </p>
      {body()}
      {left > 0 && left < 120 && (
        <p className="text-[11px] text-ink-4" data-testid="connect-challenge-expires">
          {t('connect.expiresIn', { s: left })}
        </p>
      )}
    </div>
  );
}
