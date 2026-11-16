// E2EE connection sync (SC1): an AES-GCM key (CSK) encrypts the tokens; devices pass it wrapped to the target's public key
// the server stores public keys, wraps and ciphertext, none of which it can open; keys are JWK strings
// on this device they get the store tokens' own protection level: the E2EE property protects the SERVER

const subtle = globalThis.crypto.subtle;

const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCodePoint(b);
  return btoa(s);
};
// TS 5.7 types Uint8Array over ArrayBufferLike; WebCrypto wants a plain
// ArrayBuffer-backed view — construct one explicitly
const fromB64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.codePointAt(i)!;
  return bytes;
};

export interface DeviceKeys {
  publicJwk: string;
  privateJwk: string;
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    publicJwk: JSON.stringify(await subtle.exportKey('jwk', pair.publicKey)),
    privateJwk: JSON.stringify(await subtle.exportKey('jwk', pair.privateKey)),
  };
}

/** 6-digit code both screens show during approval — the human check
 *  that the server did not swap the key in transit */
export async function fingerprintOf(publicJwk: string): Promise<string> {
  const jwk = JSON.parse(publicJwk) as { x?: string; y?: string };
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`${jwk.x}.${jwk.y}`));
  const view = new DataView(digest);
  return String(view.getUint32(0) % 1_000_000).padStart(6, '0');
}

export function mintCsk(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

async function agreeKey(privateJwk: string, publicJwk: string): Promise<CryptoKey> {
  const privateKey = await subtle.importKey('jwk', JSON.parse(privateJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicKey = await subtle.importKey('jwk', JSON.parse(publicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('munni-connection-sync-v1') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapCsk(csk: string, targetPublicJwk: string): Promise<string> {
  const ephemeral = await generateDeviceKeys();
  const key = await agreeKey(ephemeral.privateJwk, targetPublicJwk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, fromB64(csk));
  return JSON.stringify({ epk: JSON.parse(ephemeral.publicJwk), iv: toB64(iv), ct: toB64(ct) });
}

export async function unwrapCsk(wrapped: string, myPrivateJwk: string): Promise<string> {
  const { epk, iv, ct } = JSON.parse(wrapped) as { epk: object; iv: string; ct: string };
  const key = await agreeKey(myPrivateJwk, JSON.stringify(epk));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct));
  return toB64(plain);
}

async function cskKey(csk: string, usage: KeyUsage): Promise<CryptoKey> {
  return subtle.importKey('raw', fromB64(csk), 'AES-GCM', false, [usage]);
}

export async function encryptJson(csk: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await cskKey(csk, 'encrypt'), new TextEncoder().encode(JSON.stringify(value)));
  return `${toB64(iv)}.${toB64(ct)}`;
}

export async function decryptJson<T>(csk: string, cipher: string): Promise<T> {
  const [iv, ct] = cipher.split('.');
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await cskKey(csk, 'decrypt'), fromB64(ct));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
