// copies the flags the app uses into src/assets/flags as offline bundle assets: no CDN, no emoji (Windows breaks those)
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, '..', '..', '..', 'node_modules', 'flag-icons', 'flags', '4x3');
const out = join(root, '..', 'src', 'assets', 'flags');
mkdirSync(out, { recursive: true });

const countriesTs = readFileSync(join(root, '..', 'src', 'domain', 'countries.ts'), 'utf8');
const codes = new Set([...countriesTs.matchAll(/"code":"([A-Z]{2})"/g)].map((m) => m[1].toLowerCase()));
// language flags: en renders the GB flag
codes.add('gb').add('nl').add('tr');

let copied = 0;
for (const code of codes) {
  try {
    copyFileSync(join(src, `${code}.svg`), join(out, `${code}.svg`));
    copied++;
  } catch {
    console.warn(`no flag for ${code}`);
  }
}
const total = readdirSync(out).length;
console.log(`flags: ${copied} copied → src/assets/flags (${total} present)`);
