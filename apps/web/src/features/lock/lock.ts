import { create } from 'zustand';

/**
 * Device-level app lock: WebAuthn platform authenticator (fingerprint /
 * face via the OS) with a hashed PIN fallback, required again after a
 * configurable period out of sight. This is a UI gate in front of the
 * app — IndexedDB itself is not encrypted (no PWA can do that), which is
 * the same trade-off banking PWAs make.
 */

export interface LockConfig {
  enabled: boolean;
  /** WebAuthn credential id (base64url), when biometrics are set up */
  credentialId?: string;
  pinSalt: string;
  pinHash: string;
  /** seconds hidden before the app locks again (0 = immediately) */
  timeoutSec: number;
}

const LS_KEY = 'munni_lock';

export function readLockConfig(): LockConfig | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LockConfig;
    return parsed.enabled && parsed.pinHash ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLockConfig(config: LockConfig | null): void {
  if (config) localStorage.setItem(LS_KEY, JSON.stringify(config));
  else localStorage.removeItem(LS_KEY);
}

// ── PIN hashing (SHA-256 with a random salt; local gate, not a vault) ──
const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomSalt = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);

export async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export const validPin = (pin: string): boolean => /^\d{4,8}$/.test(pin);

// ── WebAuthn platform authenticator ────────────────────────────────────
const b64url = (buffer: ArrayBuffer) =>
  // '=' is base64 padding and only ever appears at the end
  btoa(String.fromCodePoint(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromB64url = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.codePointAt(0)!);

export async function biometricAvailable(): Promise<boolean> {
  try {
    return (
      typeof PublicKeyCredential !== 'undefined' &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

/** creates a device-bound passkey used purely as an unlock factor */
export async function registerBiometric(): Promise<string | null> {
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'munni' },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'munni-lock',
          displayName: 'munni app lock',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    return credential ? b64url(credential.rawId) : null;
  } catch {
    return null; // user cancelled or unsupported — PIN remains the factor
  }
}

/** OS-level user verification against the stored credential */
export async function verifyBiometric(credentialId: string): Promise<boolean> {
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: fromB64url(credentialId) }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return assertion !== null;
  } catch {
    return false;
  }
}

// ── lock state ──────────────────────────────────────────────────────────
interface LockState {
  locked: boolean;
  lock: () => void;
  unlock: () => void;
}

export const useLock = create<LockState>((set) => ({
  locked: readLockConfig() !== null, // enabled -> start locked
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
}));

/** pure decision: should the app lock after `elapsedMs` out of sight? */
export const shouldLock = (config: LockConfig | null, elapsedMs: number): boolean =>
  config !== null && elapsedMs >= config.timeoutSec * 1000;

/** watches visibility and re-locks after the configured timeout */
export function initLockWatcher(): void {
  let hiddenAt: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null) {
      if (shouldLock(readLockConfig(), Date.now() - hiddenAt)) useLock.getState().lock();
      hiddenAt = null;
    }
  });
}
