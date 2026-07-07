// Append new translation keys to all three i18n files (UTF-8 safe).
// Edit the KEYS map, run: node scripts/add-i18n-keys.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const KEYS = {
  en: {
    'gc.connect': 'Connect your bank',
    'gc.connectSub': 'Transactions sync automatically 4× per day',
    'gc.completing': 'Linking your bank…',
    'gc.done': 'Bank connected',
    'gc.failed': 'Bank connection failed — please try again',
    'gc.backToApp': 'Back to munni',
    'gc.connections': 'Bank connections',
    'gc.lastSync': 'Last sync',
    'gc.never': 'Not synced yet',
    'cats.addCustom': 'New category',
    'cats.editCustom': 'Edit category',
    'cats.name': 'Category name',
    'cats.customBadge': 'Custom',
    'txform.addTitle': 'Add transaction',
    'txform.editTitle': 'Edit transaction',
    'txform.amount': 'Amount',
    'txform.expense': 'Expense',
    'txform.income': 'Income',
    'txform.merchant': 'Name or merchant',
    'txform.date': 'Date',
    'txform.account': 'Account',
    'txform.category': 'Category',
    'import.txCountOne': '1 transaction',
    'pwa.updateAvailable': 'A new version of munni is available',
    'pwa.reload': 'Reload',
    'import.statement': 'Import bank statement',
    'import.preview': 'Import preview',
    'import.newAccount': 'New account',
    'import.txCount': '{n} transactions',
    'import.doImport': 'Import',
    'import.done': 'Imported {n} transactions, skipped {s} duplicates',
    'import.invalidFile': 'This is not a valid CAMT.053 file',
  },
  nl: {
    'gc.connect': 'Verbind je bank',
    'gc.connectSub': 'Transacties synchroniseren automatisch 4× per dag',
    'gc.completing': 'Bank wordt gekoppeld…',
    'gc.done': 'Bank verbonden',
    'gc.failed': 'Bankverbinding mislukt — probeer het opnieuw',
    'gc.backToApp': 'Terug naar munni',
    'gc.connections': 'Bankverbindingen',
    'gc.lastSync': 'Laatste synchronisatie',
    'gc.never': 'Nog niet gesynchroniseerd',
    'cats.addCustom': 'Nieuwe categorie',
    'cats.editCustom': 'Categorie bewerken',
    'cats.name': 'Categorienaam',
    'cats.customBadge': 'Eigen',
    'txform.addTitle': 'Transactie toevoegen',
    'txform.editTitle': 'Transactie bewerken',
    'txform.amount': 'Bedrag',
    'txform.expense': 'Uitgave',
    'txform.income': 'Inkomsten',
    'txform.merchant': 'Naam of winkel',
    'txform.date': 'Datum',
    'txform.account': 'Rekening',
    'txform.category': 'Categorie',
    'import.txCountOne': '1 transactie',
    'pwa.updateAvailable': 'Er is een nieuwe versie van munni beschikbaar',
    'pwa.reload': 'Vernieuwen',
    'import.statement': 'Bankafschrift importeren',
    'import.preview': 'Importoverzicht',
    'import.newAccount': 'Nieuwe rekening',
    'import.txCount': '{n} transacties',
    'import.doImport': 'Importeren',
    'import.done': '{n} transacties geïmporteerd, {s} duplicaten overgeslagen',
    'import.invalidFile': 'Dit is geen geldig CAMT.053-bestand',
  },
  tr: {
    'gc.connect': 'Bankanı bağla',
    'gc.connectSub': 'İşlemler günde 4 kez otomatik senkronize edilir',
    'gc.completing': 'Banka bağlanıyor…',
    'gc.done': 'Banka bağlandı',
    'gc.failed': 'Banka bağlantısı başarısız — lütfen tekrar deneyin',
    'gc.backToApp': "munni'ye geri dön",
    'gc.connections': 'Banka bağlantıları',
    'gc.lastSync': 'Son senkronizasyon',
    'gc.never': 'Henüz senkronize edilmedi',
    'cats.addCustom': 'Yeni kategori',
    'cats.editCustom': 'Kategoriyi düzenle',
    'cats.name': 'Kategori adı',
    'cats.customBadge': 'Özel',
    'txform.addTitle': 'İşlem ekle',
    'txform.editTitle': 'İşlemi düzenle',
    'txform.amount': 'Tutar',
    'txform.expense': 'Gider',
    'txform.income': 'Gelir',
    'txform.merchant': 'İsim veya satıcı',
    'txform.date': 'Tarih',
    'txform.account': 'Hesap',
    'txform.category': 'Kategori',
    'import.txCountOne': '1 işlem',
    'pwa.updateAvailable': 'Yeni bir munni sürümü mevcut',
    'pwa.reload': 'Yeniden yükle',
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
  const missing = Object.entries(entries).filter(([k]) => !src.includes(`'${k}'`));
  if (missing.length === 0) {
    console.log(`${lang}: all present`);
    continue;
  }
  const block = missing.map(([k, v]) => `  '${esc(k)}': '${esc(v)}',`).join('\n');
  const marker = lang === 'en' ? '} as const;' : /\};\s*$/;
  const replaced =
    lang === 'en' ? src.replace(marker, `${block}\n} as const;`) : src.replace(marker, `${block}\n};\n`);
  if (replaced === src) throw new Error(`${lang}: marker not found`);
  writeFileSync(file, replaced, 'utf8');
  console.log(`${lang}: +${missing.length} keys`);
}
