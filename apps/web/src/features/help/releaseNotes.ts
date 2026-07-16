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
    version: '1.23.0',
    date: '2026-07-16',
    items: [
      {
        en: 'Money you move between your own accounts — say, topping up your credit card — is recognized in review and pre-marked as a transfer instead of counting as spending. One tap opts out.',
        nl: 'Geld dat je tussen je eigen rekeningen verplaatst — bijvoorbeeld je creditcard aanvullen — wordt in review herkend en alvast als overboeking gemarkeerd in plaats van als uitgave geteld. Eén tik zet het terug.',
        tr: 'Kendi hesapların arasında taşıdığın para — örneğin kredi kartına yükleme — incelemede tanınır ve harcama sayılmak yerine transfer olarak önceden işaretlenir. Tek dokunuşla geri alınır.',
      },
      {
        en: 'Splits moved into the space settings where the rest of your tools live, and Home gained a Splits block showing your current split and who owes whom. Recurring and Portfolio now share the same big left-aligned header as Home.',
        nl: 'Splits verhuisde naar de ruimte-instellingen bij je andere tools, en Home kreeg een Splits-blok met je huidige split en wie wie wat schuldig is. Terugkerend en Portfolio hebben nu dezelfde grote kop als Home.',
        tr: 'Bölüşmeler diğer araçlarının yanına, alan ayarlarına taşındı; Ana sayfaya mevcut bölüşmeni ve kimin kime borçlu olduğunu gösteren bir Bölüşmeler bloğu eklendi. Yinelenen ve Portföy artık Ana sayfayla aynı büyük başlığı kullanıyor.',
      },
    ],
  },
  {
    version: '1.22.0',
    date: '2026-07-16',
    items: [
      {
        en: 'The app lock in the Android/iOS apps now uses the real Face ID / fingerprint prompt from your device instead of the browser fallback. Your PIN keeps working everywhere.',
        nl: 'De app-vergrendeling in de Android/iOS-apps gebruikt nu de echte Face ID / vingerafdruk-prompt van je toestel in plaats van de browser-fallback. Je pincode blijft overal werken.',
        tr: 'Android/iOS uygulamalarındaki uygulama kilidi artık tarayıcı yedeği yerine cihazının gerçek Face ID / parmak izi istemini kullanıyor. PIN kodun her yerde çalışmaya devam ediyor.',
      },
    ],
  },
  {
    version: '1.21.0',
    date: '2026-07-16',
    items: [
      {
        en: 'Splits meet events: link a split to one of your own events and expenses you pick from your transactions join the event automatically. The event page shows "you\'re owed…" at a glance, and review recognizes a friend\'s repayment and offers to mark it as a transfer.',
        nl: 'Splits en gebeurtenissen: koppel een split aan een eigen gebeurtenis en uitgaven die je uit je transacties kiest gaan er automatisch bij. De gebeurtenispagina toont in één oogopslag "je krijgt…", en review herkent een terugbetaling van een vriend en biedt aan die als overboeking te markeren.',
        tr: 'Bölüşmeler etkinliklerle buluştu: bir bölüşmeyi kendi etkinliğine bağla; işlemlerinden seçtiğin harcamalar etkinliğe otomatik eklenir. Etkinlik sayfası "alacaklısın…" bilgisini tek bakışta gösterir; inceleme, arkadaşının geri ödemesini tanıyıp transfer olarak işaretlemeyi önerir.',
      },
    ],
  },
  {
    version: '1.20.0',
    date: '2026-07-16',
    items: [
      {
        en: 'Splits settle up: a Settle button next to "you owe…" records the payment in one tap, and the owner can close a finished split — locking it for everyone.',
        nl: 'Splits verrekenen: een Verreken-knop naast "jij bent … schuldig" legt de betaling in één tik vast, en de eigenaar kan een afgeronde split afsluiten — vergrendeld voor iedereen.',
        tr: 'Bölüşmelerde hesap kapama: "borçlusun…" satırındaki Öde düğmesi ödemeyi tek dokunuşla kaydeder; sahibi biten bölüşmeyi kapatabilir — herkes için kilitlenir.',
      },
    ],
  },
  {
    version: '1.19.0',
    date: '2026-07-16',
    items: [
      {
        en: 'Splits go social: invite anyone with one share link — no friendship needed. Joiners pick which of their own spaces the split attaches to, and members only ever see the split itself, never anyone\'s accounts or transactions. There\'s a short tour under Help & tutorials.',
        nl: 'Splits worden sociaal: nodig iedereen uit met één deellink — vriendschap niet nodig. Wie joint kiest aan welke eigen ruimte de split wordt gekoppeld, en leden zien alleen de split zelf, nooit iemands rekeningen of transacties. Er staat een korte tour onder Help & tutorials.',
        tr: 'Bölüşmeler sosyalleşti: tek paylaşım bağlantısıyla herkesi davet et — arkadaşlık gerekmez. Katılanlar bölüşmenin kendi hangi alanına bağlanacağını seçer; üyeler yalnızca bölüşmeyi görür, kimsenin hesaplarını veya işlemlerini asla. Yardım ve eğitimler altında kısa bir tur var.',
      },
    ],
  },
  {
    version: '1.18.0',
    date: '2026-07-16',
    items: [
      {
        en: 'New: Splits — settle up with any group. Create a split under Settings → Splits, add who paid what (typed in, or picked straight from your own transactions), adjust shares when a split isn\'t fifty-fifty, and munni works out who owes whom with the fewest transfers. Inviting others is coming next.',
        nl: 'Nieuw: Splits — verreken met elke groep. Maak een split aan onder Instellingen → Splits, voeg toe wie wat betaalde (getypt of direct uit je eigen transacties gekozen), pas aandelen aan als het niet fifty-fifty is, en munni rekent uit wie wie wat schuldig is met zo min mogelijk overboekingen. Anderen uitnodigen volgt binnenkort.',
        tr: 'Yeni: Bölüşmeler — her grupla hesaplaş. Ayarlar → Bölüşmeler altında bir bölüşme oluştur, kimin ne ödediğini ekle (elle yaz veya doğrudan kendi işlemlerinden seç), eşit olmayan bölüşmelerde payları ayarla; munni en az transferle kimin kime ne borçlu olduğunu hesaplar. Başkalarını davet etme sırada.',
      },
    ],
  },
  {
    version: '1.17.0',
    date: '2026-07-16',
    items: [
      {
        en: 'You can now delete your account entirely — Settings → Delete account. Bank access is revoked at the provider, shared spaces stay intact for their members, and everything else is erased immediately.',
        nl: 'Je kunt je account nu volledig verwijderen — Instellingen → Account verwijderen. Banktoegang wordt bij de provider ingetrokken, gedeelde ruimtes blijven intact voor hun leden, en al het andere wordt direct gewist.',
        tr: 'Artık hesabını tamamen silebilirsin — Ayarlar → Hesabı sil. Banka erişimi sağlayıcıda iptal edilir, paylaşılan alanlar üyeleri için korunur ve geri kalan her şey anında silinir.',
      },
      {
        en: 'Behind the scenes: a redesigned operator console keeps an eye on bank-connection quotas and expiring consents, so syncs stay healthy.',
        nl: 'Achter de schermen: een vernieuwde beheerconsole bewaakt bankverbindingsquota en verlopende toestemmingen, zodat synchronisaties gezond blijven.',
        tr: 'Perde arkasında: yenilenen yönetim konsolu banka bağlantı kotalarını ve süresi dolan izinleri izliyor; senkronizasyonlar sağlıklı kalıyor.',
      },
    ],
  },
  {
    version: '1.15.0',
    date: '2026-07-16',
    items: [
      {
        en: 'The transaction type has its own row in the detail now — see it, tap it, change it (a mismatching category moves to Uncategorized for review).',
        nl: 'Het transactietype heeft nu een eigen regel in het detail — zie het, tik erop, wijzig het (een niet-passende categorie verhuist naar Niet gecategoriseerd ter controle).',
        tr: 'İşlem türünün artık detayda kendi satırı var — gör, dokun, değiştir (uymayan kategori incelenmek üzere Kategorisiz\'e taşınır).',
      },
      {
        en: 'The apps take real receipt photos with the camera, tell you right on Home when a newer version is in the store, and theme & language can follow your device.',
        nl: 'De apps maken nu echte bonnetjesfoto\'s met de camera, melden op Home wanneer er een nieuwere versie in de store staat, en thema & taal kunnen je toestel volgen.',
        tr: 'Uygulamalar artık kamerayla gerçek fiş fotoğrafı çekiyor, mağazada yeni sürüm olduğunda Ana sayfada söylüyor ve tema ile dil cihazını takip edebiliyor.',
      },
      {
        en: 'Raw bank data (like invoice numbers) sits in its own tidy "Bank details" block, and signing out of the apps returns you to the app instead of a browser error.',
        nl: 'Ruwe bankgegevens (zoals factuurnummers) staan in een eigen net "Bankgegevens"-blok, en uitloggen in de apps brengt je terug naar de app in plaats van een browserfout.',
        tr: 'Ham banka verileri (fatura numarası gibi) artık düzenli bir "Banka bilgileri" bloğunda ve uygulamalardan çıkış artık tarayıcı hatası yerine uygulamaya döndürüyor.',
      },
    ],
  },
  {
    version: '1.13.0',
    date: '2026-07-16',
    items: [
      {
        en: 'munni is now a real app: Android (Play internal testing) and iOS (TestFlight), with login, sync and push — and your data on the device is never wiped by the OS.',
        nl: 'munni is nu een echte app: Android (Play interne test) en iOS (TestFlight), met inloggen, sync en meldingen — en je gegevens op het toestel worden nooit meer door het OS gewist.',
        tr: 'munni artık gerçek bir uygulama: Android (Play dahili test) ve iOS (TestFlight); giriş, senkronizasyon ve bildirimlerle — cihazdaki verilerin artık işletim sistemi tarafından silinmiyor.',
      },
      {
        en: 'Reimbursements got honest: income can settle expenses too, and category totals now reflect what things really cost — budgets, trends and drill-downs all agree.',
        nl: 'Vergoedingen zijn nu eerlijk: inkomsten kunnen ook uitgaven vereffenen, en categorietotalen tonen wat dingen echt kostten — budgetten, trends en uitsplitsingen kloppen allemaal.',
        tr: 'Geri ödemeler dürüstleşti: gelirler de giderleri kapatabiliyor ve kategori toplamları artık gerçek maliyeti gösteriyor — bütçeler, eğilimler ve dökümler hepsi tutarlı.',
      },
      {
        en: 'Review, refined: long bank descriptions expand on tap, and "also apply to similar" opens a full list where every transaction shows its details.',
        nl: 'Beoordelen, verfijnd: lange bankomschrijvingen klappen uit bij een tik, en "ook toepassen op vergelijkbare" opent een volledige lijst waar elke transactie zijn details toont.',
        tr: 'İnceleme inceldi: uzun banka açıklamaları dokununca açılıyor; "benzerlerine de uygula" artık her işlemin detayını gösteren tam bir liste açıyor.',
      },
      {
        en: '"Safe to spend" shows its math as a colored bar — bills before payday, money already assigned, and what is truly free.',
        nl: '"Vrij te besteden" toont zijn rekensom als gekleurde balk — vaste lasten vóór betaaldag, al toegewezen geld, en wat echt vrij is.',
        tr: '"Harcanabilir" hesabını renkli bir çubukla gösteriyor — maaş öncesi faturalar, ayrılmış para ve gerçekten serbest olan.',
      },
      {
        en: 'Split transactions pick smarter icons, brand logos got bigger, the demo profile shows every feature in action, and munni speaks your device language on first launch.',
        nl: 'Gesplitste transacties kiezen slimmere iconen, merklogo\'s werden groter, het demoprofiel toont elke functie in actie, en munni spreekt bij de eerste start de taal van je toestel.',
        tr: 'Bölünmüş işlemler daha akıllı simgeler seçiyor, marka logoları büyüdü, demo profili her özelliği iş başında gösteriyor ve munni ilk açılışta cihazının dilini konuşuyor.',
      },
    ],
  },
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
