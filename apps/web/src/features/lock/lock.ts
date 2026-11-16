import { create } from 'zustand';
import { identityKey, readSessionIdentity, useSession } from '@/app/session';
import { isNativeApp, nativeBiometricAvailable, nativeBiometricVerify } from '@/lib/platform';

// signed out means no lock: the gate must never brick the login screen of a shared machine; the config survives sign-out
// a UI gate only: IndexedDB is not encrypted (no PWA can do that)

export type BiometricKind = 'webauthn' | 'native';

export interface LockConfig {
  enabled: boolean;
  credentialId?: string;
  // 'native' = the OS prompt via the Capacitor plugin (nothing stored); 'webauthn' = the passkey in credentialId
  // absent = PIN only
  biometricKind?: BiometricKind;
  pinSalt: string;
  pinHash: string;
  /** seconds hidden before the app locks again (0 = immediately) */
  timeoutSec: number;
  // #315: last moment seen unlocked (epoch ms), so a refresh within timeoutSec boots unlocked
  // missing/invalid/future = locked
  lastActiveAt?: number;
}

const keyForIdentity = (): string | null => {
  const identity = readSessionIdentity();
  return identity ? `munni_lock_${identityKey(identity)}` : null;
};

export function readLockConfig(): LockConfig | null {
  const key = keyForIdentity();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LockConfig;
    return parsed.enabled && parsed.pinHash ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLockConfig(config: LockConfig | null): void {
  const key = keyForIdentity();
  if (!key) return;
  if (config) localStorage.setItem(key, JSON.stringify(config));
  else localStorage.removeItem(key);
}

// SHA-256 with a random salt: a local gate, not a vault
const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const randomSalt = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);

export async function hashPin(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export const validPin = (pin: string): boolean => /^\d{4,8}$/.test(pin);

const b64url = (buffer: ArrayBuffer) =>
  // '=' is base64 padding and only ever appears at the end
  btoa(String.fromCodePoint(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromB64url = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.codePointAt(0)!);

export async function biometricAvailable(): Promise<boolean> {
  // WKWebView has no WebAuthn platform authenticator: on native, availability means the OS biometric prompt
  if (isNativeApp()) return nativeBiometricAvailable();
  try {
    return (
      typeof PublicKeyCredential !== 'undefined' &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

export interface BiometricRegistration {
  kind: BiometricKind;
  credentialId?: string;
}

export async function registerBiometric(): Promise<BiometricRegistration | null> {
  if (isNativeApp()) {
    // prove the prompt actually works before promising it as the factor
    return (await nativeBiometricVerify('munni')) ? { kind: 'native' } : null;
  }
  const credentialId = await registerWebauthn();
  return credentialId ? { kind: 'webauthn', credentialId } : null;
}

async function registerWebauthn(): Promise<string | null> {
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
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
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

/** #202: the signal lets the PIN pad dismiss an in-flight passkey sheet once the user starts typing */
export async function verifyBiometric(
  config: Pick<LockConfig, 'credentialId' | 'biometricKind'>,
  reason = 'munni',
  signal?: AbortSignal,
): Promise<boolean> {
  const kind = config.biometricKind;
  if (kind === 'native') return nativeBiometricVerify(reason);
  if (kind !== 'webauthn' || !config.credentialId) return false;
  try {
    const assertion = await navigator.credentials.get({
      signal,
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: fromB64url(config.credentialId) }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return assertion !== null;
  } catch {
    return false;
  }
}

export const shouldLock = (config: LockConfig | null, elapsedMs: number): boolean =>
  config !== null && elapsedMs >= config.timeoutSec * 1000;

/** #315: fail closed: a missing/corrupted stamp, or one from the future (clock moved back), cannot prove recent activity */
export const bootLocked = (config: LockConfig | null, now: number): boolean => {
  if (!config) return false;
  const stamp = config.lastActiveAt;
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp > now) return true;
  return shouldLock(config, now - stamp);
};

/** only an unlocked page extends trust: a refresh under the lock screen must come back locked */
function touchLockStamp(): void {
  if (useLock.getState().locked) return;
  const config = readLockConfig();
  if (config) writeLockConfig({ ...config, lastActiveAt: Date.now() });
}

function clearLockStamp(): void {
  const config = readLockConfig();
  if (config?.lastActiveAt !== undefined) writeLockConfig({ ...config, lastActiveAt: undefined });
}

interface LockState {
  locked: boolean;
  // #202: the auto passkey prompt fires once per lock cycle: the OS sheet backgrounds the page, which re-locks (timeout 0),
  // and every remount used to re-prompt forever
  promptSpent: boolean;
  lock: () => void;
  unlock: () => void;
  spendPrompt: () => void;
}

export const useLock = create<LockState>((set) => ({
  locked: bootLocked(readLockConfig(), Date.now()),
  promptSpent: false,
  lock: () => {
    set({ locked: true, promptSpent: false });
    clearLockStamp();
  },
  unlock: () => {
    set({ locked: false });
    touchLockStamp();
  },
  spendPrompt: () => set({ promptSpent: true }),
}));

/** low-frequency safety net for pages killed without a pagehide */
const STAMP_INTERVAL_MS = 30_000;

export function initLockWatcher(): void {
  let hiddenAt: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      touchLockStamp();
    } else if (hiddenAt !== null) {
      if (shouldLock(readLockConfig(), Date.now() - hiddenAt)) useLock.getState().lock();
      else touchLockStamp();
      hiddenAt = null;
    }
  });

  // pagehide catches the reload itself, the slow tick covers hard kills that never fire it; any tab may stamp (shared storage)
  window.addEventListener('pagehide', touchLockStamp);
  setInterval(() => {
    if (document.visibilityState === 'visible') touchLockStamp();
  }, STAMP_INTERVAL_MS);

  // an identity change is fresh verification: never keep a stale lock across it (logout must free a shared machine)
  let lastIdentity = useSession.getState().identity;
  useSession.subscribe((state) => {
    if (state.identity !== lastIdentity) {
      lastIdentity = state.identity;
      useLock.getState().unlock();
    }
  });
}
