// Append new translation keys to all three i18n files (UTF-8 safe).
// Edit the KEYS map, run: node scripts/add-i18n-keys.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const KEYS = {
  en: {
    'import.statement': 'Import bank statement',
    'import.preview': 'Import preview',
    'import.newAccount': 'New account',
    'import.txCount': '{n} transactions',
    'import.doImport': 'Import',
    'import.done': 'Imported {n} transactions, skipped {s} duplicates',
    'import.invalidFile': 'This is not a valid CAMT.053 file',
  },
  nl: {
    'import.statement': 'Bankafschrift importeren',
    'import.preview': 'Importoverzicht',
    'import.newAccount': 'Nieuwe rekening',
    'import.txCount': '{n} transacties',
    'import.doImport': 'Importeren',
    'import.done': '{n} transacties geïmporteerd, {s} duplicaten overgeslagen',
    'import.invalidFile': 'Dit is geen geldig CAMT.053-bestand',
  },
  tr: {
    'import.statement': 'Banka ekstresi içe aktar',
    'import.preview': 'İçe aktarma önizlemesi',
    'import.newAccount': 'Yeni hesap',
    'import.txCount': '{n} işlem',
    'import.doImport': 'İçe aktar',
    'import.done': '{n} işlem içe aktarıldı, {s} kopya atlandı',
    'import.invalidFile': 'Bu geçerli bir CAMT.053 dosyası değil',
  },
};

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

for (const [lang, entries] of Object.entries(KEYS)) {
  const file = path.resolve(here, `../src/i18n/${lang}.ts`);
  let src = readFileSync(file, 'utf8');
  const existing = Object.keys(entries).filter((k) => src.includes(`'${k}'`));
  if (existing.length) {
    console.log(`${lang}: skipping, already present: ${existing.join(', ')}`);
    continue;
  }
  const block = Object.entries(entries)
    .map(([k, v]) => `  '${esc(k)}': '${esc(v)}',`)
    .join('\n');
  const marker = lang === 'en' ? '} as const;' : /\};\s*$/;
  const replaced =
    lang === 'en' ? src.replace(marker, `${block}\n} as const;`) : src.replace(marker, `${block}\n};\n`);
  if (replaced === src) throw new Error(`${lang}: marker not found`);
  writeFileSync(file, replaced, 'utf8');
  console.log(`${lang}: +${Object.keys(entries).length} keys`);
}
