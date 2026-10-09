import { request } from 'node:https';

/**
 * fetch-shaped https client that SKIPS certificate verification — for
 * talking to OUR OWN local services only: the family Caddy signs
 * localhost and the sslip.io LAN hostnames with a locally-minted
 * internal CA, which node rightly distrusts. Never use this for
 * anything on the public internet; the global fetch stays strict for
 * everything else — and since 2026-10-09 the client enforces that
 * itself: a url outside the local origins goes to the strict fetch
 * whoever called (CodeQL js/disabling-certificate-validation, kept
 * deliberately for these origins alone).
 */

/** the four numbers of a dashed sslip name, when they are an address of a LAN (RFC 1918), the loopback or a link-local one — never the public internet */
const isLanAddress = (dashed) => {
  const parts = dashed.split('-').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};

/** does this url point at one of OUR locally-signed origins? localhost, or a <name>.<lan-ip-dashed>.sslip.io host of the family Caddy */
export const isLocalTlsUrl = (url) => {
  const m = /^https:\/\/(localhost(:\d+)?|[a-z0-9-]+\.(\d+-\d+-\d+-\d+)\.sslip\.io)(\/|$)/.exec(String(url));
  return Boolean(m) && (m[1].startsWith('localhost') || isLanAddress(m[3]));
};

/** strict fetch for the world, unverified for our own local-CA https */
export const localAwareFetch = (url, init) => (isLocalTlsUrl(url) ? insecureFetch(url, init) : fetch(url, init));
export function insecureFetch(url, init = {}) {
  // the bypass never leaves the local origins, whichever caller holds this function
  if (!isLocalTlsUrl(url)) return fetch(url, init);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request( // NOSONAR S4830 S5527 - deliberate: our own local-CA services only, gated by isLocalTlsUrl
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers: init.headers,
        signal: init.signal,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            // the few header reads callers make (a redirect's Location)
            headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : (Array.isArray(v) ? v.join(', ') : String(v)); } },
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body) req.write(typeof init.body === 'string' || Buffer.isBuffer(init.body) ? init.body : String(init.body));
    req.end();
  });
}
