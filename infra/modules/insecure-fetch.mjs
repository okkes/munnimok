import { request } from 'node:https';

/**
 * fetch-shaped https client that SKIPS certificate verification — for
 * talking to OUR OWN vault only: Vaultwarden sits behind a Caddy
 * sidecar with a locally-minted (internal CA) certificate, which node
 * rightly distrusts. Never use this for anything on the public
 * internet; the global fetch stays strict for everything else.
 */
export function insecureFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers: init.headers,
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
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
