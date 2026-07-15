import { useLiveQuery } from 'dexie-react-hooks';
import { useData } from '@/app/data';
import type { Lang } from '@/i18n';

/**
 * Release notes shown in-app (user request: "news notification that
 * explains the latest changes"). MAINTENANCE RULE: every release arc
 * appends one entry here, newest FIRST, all three languages — this list
 * is the user-facing changelog, curated (what changed for THEM), not
 * the git log.
 */
export interface WhatsNewEntry {
  /** app version the entry belongs to (matches release-please tags) */
  version: string;
  date: string; // yyyy-mm-dd
  items: Record<Lang, string>[];
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.6.0',
    date: '2026-07-15',
    items: [
      {
        en: 'Trends: monthly bars per category, income vs expenses, and your net worth over time — under Settings → Trends, with an optional Home block.',
        nl: 'Trends: maandbalken per categorie, inkomsten vs uitgaven en je vermogen door de tijd — onder Instellingen → Trends, met een optioneel Home-blok.',
        tr: 'Eğilimler: kategori başına aylık çubuklar, gelir-gider karşılaştırması ve zaman içinde net varlığın — Ayarlar → Eğilimler altında, isteğe bağlı Ana ekran bloğuyla.',
      },
      {
        en: '"Safe to spend": Home can now tell you what is really free until payday — liquid balance minus upcoming fixed costs and allocation promises, with a transparent breakdown.',
        nl: '"Vrij te besteden": Home vertelt nu wat er echt vrij is tot je betaaldag — saldo minus komende vaste lasten en allocatiebeloften, met een transparante uitsplitsing.',
        tr: '"Harcanabilir": Ana ekran maaş gününe kadar gerçekte neyin serbest olduğunu söylüyor — bakiye eksi yaklaşan sabit giderler ve tahsisler, şeffaf dökümüyle.',
      },
      {
        en: 'Subscriptions show their yearly cost everywhere, and a sustained price change (hello, streaming services) badges itself with the damage per year.',
        nl: 'Abonnementen tonen overal hun jaarkosten, en een blijvende prijsverhoging (hallo, streamingdiensten) meldt zichzelf met de schade per jaar.',
        tr: 'Abonelikler her yerde yıllık maliyetini gösteriyor; kalıcı bir zam kendini yıllık etkisiyle birlikte rozetliyor.',
      },
      {
        en: 'Export your data: CSV (Excel-ready) or a JSON backup, straight from Global settings — everything stays on your device.',
        nl: 'Exporteer je gegevens: CSV (klaar voor Excel) of een JSON-back-up, rechtstreeks vanuit Algemene instellingen — alles blijft op je apparaat.',
        tr: 'Verilerini dışa aktar: CSV (Excel uyumlu) veya JSON yedeği, doğrudan Genel ayarlardan — her şey cihazında kalır.',
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-07-15',
    items: [
      {
        en: 'New categories: parking, bikes, telecom, work lunches, apps & software, outdoor & nature, insurance, kids & clubs — and you can hide whole category groups per space from Manage categories.',
        nl: 'Nieuwe categorieën: parkeren, fiets, telecom, werklunch, apps & software, buiten & natuur, verzekering, kinderen & clubs — en hele categoriegroepen zijn per space te verbergen via Categorieën beheren.',
        tr: 'Yeni kategoriler: otopark, bisiklet, telekom, iş yemeği, uygulama & yazılım, doğa & açık hava, sigorta, çocuklar & kulüpler — ayrıca kategori gruplarını alan başına gizleyebilirsin.',
      },
      {
        en: 'Big screens got a real overhaul: a full-screen sign-in backdrop, denser transaction rows with the account visible, a focused review layout, and keyboard shortcuts (Enter confirms, arrows skip, Esc closes, / searches).',
        nl: 'Grote schermen kregen een echte opknapbeurt: inloggen met achtergrond over het hele scherm, compactere transactieregels met de rekening zichtbaar, een gefocuste beoordelingsweergave en sneltoetsen (Enter bevestigt, pijltjes slaan over, Esc sluit, / zoekt).',
        tr: 'Büyük ekranlar gerçek bir yenileme aldı: tam ekran giriş arka planı, hesabı görünen daha yoğun işlem satırları, odaklı inceleme düzeni ve klavye kısayolları (Enter onaylar, oklar atlar, Esc kapatır, / arar).',
      },
      {
        en: 'You can now leave a shared space from its settings — you immediately lose access to the accounts attached there. And every bank account shows when it last synced.',
        nl: 'Je kunt een gedeelde space nu verlaten via de instellingen — je verliest direct toegang tot de gekoppelde rekeningen. En elke bankrekening toont wanneer die voor het laatst is gesynct.',
        tr: 'Paylaşılan bir alandan artık ayarlarından ayrılabilirsin — oraya bağlı hesaplara erişimin anında kalkar. Ayrıca her banka hesabı en son ne zaman eşitlendiğini gösteriyor.',
      },
      {
        en: 'Reimbursements got smarter: link from the incoming payment too, amounts net out on both sides, and a fully-used refund files itself under Reimbursement.',
        nl: 'Terugbetalingen zijn slimmer: koppelen kan nu ook vanaf de inkomende betaling, bedragen worden aan beide kanten verrekend, en een volledig gebruikte terugbetaling zet zichzelf onder Terugbetaling.',
        tr: 'Geri ödemeler akıllandı: gelen ödemeden de bağlayabilirsin, tutarlar iki tarafta da netleşir ve tamamen kullanılmış bir iade kendini Geri ödeme kategorisine yazar.',
      },
      {
        en: 'Jumbo receipts: their servers block outside connections for now, and the app says so honestly instead of failing silently — photo receipts still work.',
        nl: 'Jumbo-bonnetjes: hun servers blokkeren nu externe verbindingen en de app zegt dat eerlijk in plaats van stil te falen — foto-bonnetjes werken gewoon.',
        tr: 'Jumbo fişleri: sunucuları şu an dış bağlantıları engelliyor ve uygulama bunu sessizce hata vermek yerine dürüstçe söylüyor — fotoğraf fişleri çalışmaya devam ediyor.',
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-07-14',
    items: [
      {
        en: 'Portfolio has its own tab, and the Home blocks follow a new order — long-press-free reordering stays in Customize Home.',
        nl: 'Portefeuille heeft een eigen tab en de blokken op Home volgen een nieuwe volgorde — herschikken kan nog steeds via Home aanpassen.',
        tr: 'Portföy artık kendi sekmesinde ve Ana ekran blokları yeni bir sırada — yeniden sıralama Ana ekranı özelleştir bölümünde.',
      },
      {
        en: 'Reviewing is calmer: everything you pick stays a draft until you hit Confirm, splits clear on tap, and the full bank description is one tap away.',
        nl: 'Beoordelen is rustiger: alles wat je kiest blijft een concept tot je op Bevestigen tikt, splitsingen wissen bij aantikken en de volledige omschrijving is één tik weg.',
        tr: 'İnceleme daha sakin: seçtiklerin Onayla diyene kadar taslak kalır, bölüşümler dokununca temizlenir ve tam açıklama tek dokunuş uzakta.',
      },
      {
        en: 'Receipts got their own home: grouped by store, searchable by item or amount, and store connections can be shared per space.',
        nl: 'Bonnetjes hebben een eigen plek: gegroepeerd per winkel, doorzoekbaar op artikel of bedrag, en winkelkoppelingen zijn per space te delen.',
        tr: 'Fişlerin artık kendi yeri var: mağazaya göre gruplu, ürüne veya tutara göre aranabilir; mağaza bağlantıları alan başına paylaşılabilir.',
      },
      {
        en: 'Banks can sync more than once a day, reserved card payments show up with a badge, and PayPal connections work now.',
        nl: 'Banken kunnen vaker dan één keer per dag synchroniseren, gereserveerde betalingen krijgen een badge en PayPal-koppelingen werken nu.',
        tr: 'Bankalar günde birden çok kez eşitlenebilir, rezerve ödemeler rozetle görünür ve PayPal bağlantıları artık çalışıyor.',
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-07-10',
    items: [
      {
        en: 'The transaction list and its detail sit side by side on wide screens.',
        nl: 'De transactielijst en het detail staan naast elkaar op brede schermen.',
        tr: 'Geniş ekranlarda işlem listesi ve detayı yan yana durur.',
      },
      {
        en: 'Settings split into space-scoped and global sections.',
        nl: 'Instellingen zijn gesplitst in space-gebonden en algemene onderdelen.',
        tr: 'Ayarlar alana özgü ve genel bölümlere ayrıldı.',
      },
    ],
  },
];

const SEEN_KEY = 'whatsNewSeenVersion';

export const latestWhatsNewVersion = (): string | undefined => WHATS_NEW[0]?.version;

/** true while the newest entry hasn't been acknowledged on this device */
export function useWhatsNewUnseen(): boolean {
  const { db } = useData();
  const seen = useLiveQuery(async () => (await db.meta.get(SEEN_KEY)) ?? null, [db]);
  if (seen === undefined) return false; // still loading — don't flash
  const latest = latestWhatsNewVersion();
  return !!latest && seen?.value !== latest;
}

export function useMarkWhatsNewSeen(): () => void {
  const { db } = useData();
  return () => {
    const latest = latestWhatsNewVersion();
    if (latest) void db.meta.put({ key: SEEN_KEY, value: latest });
  };
}
