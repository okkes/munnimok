import { useQuery } from '@/db/useQuery';
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
    version: '2.13.0',
    date: '2026-07-18',
    items: [
      {
        en: 'Real app links: bank-consent returns and split invites are now verified https links that open the app directly — no more "Open in munni?" popup on iPhone once the new build is installed. Invite links work as normal web links for everyone else.',
        nl: 'Echte app-links: terugkeer na banktoestemming en split-uitnodigingen zijn nu geverifieerde https-links die de app direct openen — geen "Openen in munni?"-popup meer op iPhone zodra de nieuwe build is geïnstalleerd. Uitnodigingslinks werken als gewone weblinks voor iedereen anders.',
        tr: 'Gerçek uygulama bağlantıları: banka onayı dönüşleri ve bölüşme davetleri artık uygulamayı doğrudan açan doğrulanmış https bağlantıları — yeni sürüm kurulduktan sonra iPhone\'da "munni\'de aç?" penceresi yok. Davet bağlantıları diğer herkes için normal web bağlantısı olarak çalışır.',
      },
      {
        en: 'Transaction detail refined: one Edit button for the whole categories block, the type row reads value-first like its neighbours, the Details rows carry icons, and the duplicate struck-through amount left the header.',
        nl: 'Transactiedetail verfijnd: één Bewerken-knop voor het hele categorieënblok, de typeregel toont eerst de waarde net als zijn buren, de Details-regels hebben iconen, en het dubbele doorgestreepte bedrag is uit de kop verdwenen.',
        tr: 'İşlem detayı inceltildi: tüm kategoriler bloğu için tek Düzenle düğmesi, tür satırı komşuları gibi önce değeri gösteriyor, Detay satırlarında simgeler var ve başlıktaki mükerrer üstü çizili tutar kaldırıldı.',
      },
      {
        en: 'Categories feel consistent: holding your own sub-category now opens an action menu (edit, move) just like main categories — the accidental drag is gone — and every hold answers with a small vibration so you know the menu is coming. The tour explains it.',
        nl: 'Categorieën voelen consistent: je eigen subcategorie vasthouden opent nu een actiemenu (bewerken, verplaatsen) net als hoofdcategorieën — het onbedoelde slepen is weg — en elk vasthouden antwoordt met een kleine tril zodat je weet dat het menu komt. De tour legt het uit.',
        tr: 'Kategoriler tutarlı: kendi alt kategorini basılı tutmak artık ana kategoriler gibi bir işlem menüsü açıyor (düzenle, taşı) — istenmeyen sürükleme kalktı — ve her basılı tutuş menünün geleceğini bildiren küçük bir titreşimle yanıt veriyor. Tur bunu anlatıyor.',
      },
    ],
  },
  {
    version: '2.12.2',
    date: '2026-07-18',
    items: [
      {
        en: 'Enable Banking connections work again: a low-level key-handling bug made every bank list request after the first one fail — fixed for good, with the failure reason on screen if anything else ever goes wrong. And your profile picture now survives a reinstall: the Settings header fetches it from your account instead of waiting for a re-save.',
        nl: 'Enable Banking-koppelingen werken weer: een laag-niveau sleutelfout liet elk banklijst-verzoek na het eerste mislukken — definitief opgelost, met de foutreden in beeld als er ooit iets anders misgaat. En je profielfoto overleeft nu een herinstallatie: de Instellingen-kop haalt hem uit je account in plaats van te wachten op opnieuw opslaan.',
        tr: 'Enable Banking bağlantıları yeniden çalışıyor: düşük seviyeli bir anahtar hatası ilkinden sonraki her banka listesi isteğini başarısız kılıyordu — kalıcı olarak düzeltildi; başka bir şey ters giderse nedeni ekranda. Profil fotoğrafın da artık yeniden kurulumdan sağ çıkıyor: Ayarlar başlığı yeniden kaydetmeyi beklemek yerine onu hesabından alıyor.',
      },
    ],
  },
  {
    version: '2.12.1',
    date: '2026-07-18',
    items: [
      {
        en: 'Changing your password on one device no longer traps other devices in a sign-in loop: a failed sign-in now cleans up after itself, so the next attempt starts fresh — no more deleting the app or clearing the browser to recover.',
        nl: 'Je wachtwoord wijzigen op één apparaat zet andere apparaten niet langer vast in een inloglus: een mislukte aanmelding ruimt nu zichzelf op, zodat de volgende poging schoon begint — nooit meer de app verwijderen of de browser wissen om te herstellen.',
        tr: 'Bir cihazda şifreni değiştirmek diğer cihazları artık giriş döngüsüne hapsetmiyor: başarısız bir giriş artık kendini temizliyor, böylece sonraki deneme temiz başlıyor — kurtarmak için uygulamayı silmek ya da tarayıcıyı temizlemek yok.',
      },
    ],
  },
  {
    version: '2.12.0',
    date: '2026-07-18',
    items: [
      {
        en: 'Bank connections are reliable again: a completed consent could be processed twice behind the scenes, which burned the bank\'s daily quota and made connecting look broken — it now completes exactly once, and any failure tells you the provider\'s actual reason.',
        nl: 'Bankkoppelingen zijn weer betrouwbaar: een afgeronde toestemming kon achter de schermen dubbel verwerkt worden, wat het daglimiet van de bank opbrandde en koppelen kapot deed lijken — het rondt nu precies één keer af, en elke fout vertelt de echte reden van de aanbieder.',
        tr: 'Banka bağlantıları yeniden güvenilir: tamamlanan bir onay arka planda iki kez işlenebiliyordu; bu, bankanın günlük kotasını tüketip bağlantıyı bozuk gösteriyordu — artık tam olarak bir kez tamamlanıyor ve her hata sağlayıcının gerçek nedenini söylüyor.',
      },
      {
        en: 'Give transactions your own names: rename any transaction in its detail — apply it to similar ones in one go, and munni remembers, renaming future arrivals of that merchant automatically. The bank\'s original always stays visible under Details, and predictions read your names too.',
        nl: 'Geef transacties je eigen namen: hernoem elke transactie in het detail — pas het in één keer toe op vergelijkbare, en munni onthoudt het en hernoemt toekomstige transacties van die winkel automatisch. Het origineel van de bank blijft altijd zichtbaar onder Details, en voorspellingen lezen jouw namen ook.',
        tr: 'İşlemlere kendi adlarını ver: herhangi bir işlemi detayında yeniden adlandır — benzerlerine tek seferde uygula; munni bunu hatırlar ve o satıcının gelecekteki işlemlerini otomatik yeniden adlandırır. Bankanın orijinali her zaman Detaylar altında görünür kalır ve tahminler senin adlarını da okur.',
      },
      {
        en: 'The transaction detail reorganized into calm blocks: account & type, categories (edited through the same split flow as review, starting from one category), actions, and a details block with the original amount, original title and bank data. The transactions tab\'s quick filter now surfaces Uncategorized instead of Unreviewed.',
        nl: 'De transactiedetails zijn gereorganiseerd in rustige blokken: rekening & type, categorieën (bewerkt via dezelfde splitsstroom als beoordelen, beginnend met één categorie), acties, en een detailblok met het oorspronkelijke bedrag, de oorspronkelijke titel en bankgegevens. De sneltoets in het transactietabblad toont nu Ongecategoriseerd in plaats van Onbeoordeeld.',
        tr: 'İşlem detayı sakin bloklara yeniden düzenlendi: hesap ve tür, kategoriler (incelemedeki bölüşme akışıyla, tek kategoriden başlayarak düzenlenir), işlemler ve orijinal tutar, orijinal başlık ile banka verilerini içeren detay bloğu. İşlemler sekmesindeki hızlı filtre artık İncelenmemiş yerine Kategorisiz gösteriyor.',
      },
    ],
  },
  {
    version: '2.11.0',
    date: '2026-07-18',
    items: [
      {
        en: 'Everything unfolds smoothly now: category groups, spending drill-downs and insights animate open instead of snapping, and on desktop the list gently slides aside for the detail pane instead of the page rebuilding. In review, the "also apply" bar flies along with the card.',
        nl: 'Alles klapt nu soepel uit: categoriegroepen, uitgaven-details en inzichten openen met een animatie in plaats van te knippen, en op desktop schuift de lijst rustig opzij voor het detailpaneel in plaats van dat de pagina opnieuw opbouwt. Bij beoordelen vliegt de "ook toepassen"-balk mee met de kaart.',
        tr: 'Artık her şey akıcı açılıyor: kategori grupları, harcama detayları ve içgörüler aniden değil animasyonla açılıyor; masaüstünde liste, sayfa yeniden kurulmak yerine detay paneli için usulca kenara kayıyor. İncelemede "şunlara da uygula" çubuğu kartla birlikte uçuyor.',
      },
      {
        en: 'Review will not let an "Uncategorized" slip through anymore — Confirm stays off until a real category is picked (transfers excepted). Bank logos in the connect list now come from munni\'s own server, so they load reliably, and a failed bank connection finally tells you the provider\'s actual reason.',
        nl: 'Beoordelen laat "Ongecategoriseerd" niet meer door — Bevestigen blijft uit tot een echte categorie is gekozen (behalve bij overboekingen). Banklogo\'s in de koppellijst komen nu van munni\'s eigen server en laden dus betrouwbaar, en een mislukte bankkoppeling vertelt eindelijk de echte reden van de aanbieder.',
        tr: 'İnceleme artık "Kategorisiz" olanı geçirmiyor — gerçek bir kategori seçilene kadar Onayla kapalı kalıyor (transferler hariç). Bağlantı listesindeki banka logoları artık munni\'nin kendi sunucusundan geliyor ve güvenilir yükleniyor; başarısız bir banka bağlantısı da sonunda sağlayıcının gerçek nedenini söylüyor.',
      },
      {
        en: 'The encrypted-storage beta on iPhone is fixed — a data-format quirk froze the first sync at "connecting"; it now completes. Shop logins got their own door under Settings, and category headers grew to a comfortable size.',
        nl: 'De bèta voor versleutelde opslag op iPhone is gerepareerd — een dataformaat-eigenaardigheid bevroor de eerste synchronisatie bij "verbinden"; die rondt nu af. Winkellogins kregen hun eigen ingang onder Instellingen, en categoriekoppen kregen een comfortabel formaat.',
        tr: 'iPhone\'daki şifreli depolama betası düzeltildi — bir veri biçimi tuhaflığı ilk eşitlemeyi "bağlanıyor"da donduruyordu; artık tamamlanıyor. Mağaza girişleri Ayarlar altında kendi kapısına kavuştu ve kategori başlıkları rahat bir boyuta büyüdü.',
      },
    ],
  },
  {
    version: '2.10.0',
    date: '2026-07-18',
    items: [
      {
        en: 'Review feels alive: confirmed and skipped cards fly off while the next slides in, the prediction reason sits right inside the category editor, and the whole "also apply" bar is tappable. No auto-detected subscription? Link any recurring cost to the card by hand.',
        nl: 'Beoordelen voelt levendig: bevestigde en overgeslagen kaarten vliegen weg terwijl de volgende binnenschuift, de voorspellingsreden staat direct in de categorie-editor, en de hele "ook toepassen"-balk is tikbaar. Geen automatisch herkend abonnement? Koppel elke terugkerende kostenpost handmatig aan de kaart.',
        tr: 'İnceleme canlı hissettiriyor: onaylanan ve atlanan kartlar uçup giderken sıradaki içeri kayıyor, tahmin gerekçesi doğrudan kategori düzenleyicide duruyor ve "şunlara da uygula" çubuğunun tamamı dokunulabilir. Otomatik algılanan abonelik yok mu? Herhangi bir düzenli ödemeyi karta elle bağla.',
      },
      {
        en: 'The transaction detail listens to you: a bulk recategorize now shows the affected transactions so you pick exactly which ones change, and "Customize this view" reorders or hides the reimbursement, receipt and notes sections per space.',
        nl: 'De transactiedetails luisteren naar je: bulk-hercategoriseren toont nu de geraakte transacties zodat je precies kiest welke veranderen, en "Deze weergave aanpassen" sorteert of verbergt de secties voor terugbetalingen, bonnen en notities per space.',
        tr: 'İşlem detayı seni dinliyor: toplu yeniden kategorileme artık etkilenen işlemleri gösteriyor, böylece tam olarak hangilerinin değişeceğini seçiyorsun; "Bu görünümü özelleştir" ise geri ödeme, fiş ve not bölümlerini alan başına sıralıyor veya gizliyor.',
      },
      {
        en: 'Sign-up now lets you pick your currency (the country only suggests one), split invites share as a normal https link that opens anywhere, category rows glow while you hold them, and the app heals itself after a long sleep instead of asking you to sign in again.',
        nl: 'Bij aanmelden kies je nu je valuta (het land stelt er alleen één voor), split-uitnodigingen delen als een gewone https-link die overal opent, categorierijen lichten op terwijl je ze vasthoudt, en de app herstelt zichzelf na een lange slaap in plaats van je opnieuw te laten inloggen.',
        tr: 'Kayıt olurken artık para birimini sen seçiyorsun (ülke yalnızca öneriyor), bölüşme davetleri her yerde açılan normal bir https bağlantısı olarak paylaşılıyor, kategori satırları basılı tutarken parlıyor ve uygulama uzun uykudan sonra tekrar giriş istemek yerine kendini onarıyor.',
      },
    ],
  },
  {
    version: '2.9.0',
    date: '2026-07-17',
    items: [
      {
        en: 'App flows return home again: connecting a bank brings you back into the app instead of stranding you in the browser, and signing out lands cleanly on the login screen. The encrypted-storage beta can no longer lock the app out — if it fails to open, munni falls back safely and keeps working.',
        nl: 'App-stromen komen weer thuis: een bank koppelen brengt je terug in de app in plaats van je in de browser achter te laten, en uitloggen landt netjes op het inlogscherm. De bèta voor versleutelde opslag kan de app niet meer buitensluiten — als openen mislukt, valt munni veilig terug en blijft alles werken.',
        tr: 'Uygulama akışları eve dönüyor: banka bağlamak seni tarayıcıda bırakmak yerine uygulamaya geri getiriyor ve çıkış yapmak düzgünce giriş ekranına iniyor. Şifreli depolama betası artık uygulamayı kilitleyemez — açılamazsa munni güvenle geri döner ve çalışmaya devam eder.',
      },
      {
        en: 'New: your shop logins (Albert Heijn, Jumbo) can now follow you to your other devices — end-to-end encrypted, so munni’s servers can never read them. Turn it on under Shopping connections; new devices join after you compare a 6-digit code and approve them.',
        nl: 'Nieuw: je winkellogins (Albert Heijn, Jumbo) kunnen nu meereizen naar je andere apparaten — end-to-end versleuteld, dus de servers van munni kunnen ze nooit lezen. Zet het aan onder Winkelkoppelingen; nieuwe apparaten doen mee nadat je een 6-cijferige code vergelijkt en ze goedkeurt.',
        tr: 'Yeni: mağaza girişlerin (Albert Heijn, Jumbo) artık diğer cihazlarına da gelebilir — uçtan uca şifreli, yani munni sunucuları onları asla okuyamaz. Alışveriş bağlantıları altından aç; yeni cihazlar 6 haneli kodu karşılaştırıp onaylamanla katılır.',
      },
      {
        en: 'Review reads better: the type and categories share the same larger text, and the card names the account the money left. Recurring cost payments show their dates.',
        nl: 'Beoordelen leest prettiger: het type en de categorieën delen dezelfde grotere tekst, en de kaart toont de rekening waar het geld vandaan kwam. Betalingen van terugkerende kosten tonen hun datum.',
        tr: 'İnceleme daha iyi okunuyor: tür ve kategoriler aynı büyük yazıyı paylaşıyor ve kart paranın çıktığı hesabı gösteriyor. Yinelenen gider ödemeleri tarihlerini gösteriyor.',
      },
    ],
  },
  {
    version: '2.8.0',
    date: '2026-07-17',
    items: [
      {
        en: 'PayPal purchases no longer count twice: when your PayPal account and the bank account that funds it are both connected, the funding debits automatically become transfers and the real purchase is counted once, on the PayPal side. Unmatched PayPal charges pre-select the PayPal counterparty on the review card — one tap confirms.',
        nl: 'PayPal-aankopen tellen niet langer dubbel: wanneer je PayPal-rekening en de bankrekening die haar voedt beide gekoppeld zijn, worden de afschrijvingen automatisch overboekingen en telt de echte aankoop één keer, aan de PayPal-kant. Niet-gematchte PayPal-afschrijvingen krijgen de PayPal-tegenpartij alvast voorgeselecteerd op de beoordelingskaart — één tik bevestigt.',
        tr: 'PayPal alışverişleri artık iki kez sayılmıyor: PayPal hesabın ve onu besleyen banka hesabın ikisi de bağlıyken, besleme çekimleri otomatik olarak transfere dönüşür ve gerçek alışveriş bir kez, PayPal tarafında sayılır. Eşleşmeyen PayPal çekimleri inceleme kartında PayPal karşı tarafını önceden seçili getirir — tek dokunuş onaylar.',
      },
    ],
  },
  {
    version: '2.7.0',
    date: '2026-07-17',
    items: [
      {
        en: 'The central category list is now fully manageable: when a built-in category is retired, its transactions quietly return to review as Uncategorized instead of pointing nowhere. Fresh installs ship with the latest category improvements baked in — offline profiles included.',
        nl: 'De centrale categorielijst is nu volledig beheerbaar: wanneer een ingebouwde categorie wordt uitgefaseerd, keren de transacties netjes terug naar beoordeling als Ongecategoriseerd in plaats van nergens naar te wijzen. Nieuwe installaties bevatten de nieuwste categorieverbeteringen — ook offline profielen.',
        tr: 'Merkezi kategori listesi artık tamamen yönetilebilir: yerleşik bir kategori emekli edildiğinde işlemleri hiçliğe işaret etmek yerine sessizce Kategorisiz olarak incelemeye döner. Yeni kurulumlar en güncel kategori iyileştirmeleriyle gelir — çevrimdışı profiller dahil.',
      },
    ],
  },
  {
    version: '2.6.0',
    date: '2026-07-17',
    items: [
      {
        en: 'The category screen breathes: groups start collapsed and unfold with a tap, hold a group for its actions, and the icon picker now searches the entire 7,000+ icon set — fully offline.',
        nl: 'Het categoriescherm ademt: groepen starten ingeklapt en vouwen open met een tik, houd een groep vast voor de acties, en de icoonkiezer doorzoekt nu de volledige set van 7.000+ iconen — volledig offline.',
        tr: 'Kategori ekranı ferahladı: gruplar kapalı başlar ve dokununca açılır, işlemler için gruba basılı tut, simge seçici artık 7.000+ simgenin tamamında arama yapıyor — tamamen çevrimdışı.',
      },
      {
        en: 'Desktop feels native now: pop-ups open as centered dialogs instead of side panels, transaction details close with an ✕, the list got wider, and receipts say "Upload" where there is no camera. Demo mode announces itself clearly, and the offline notice is friendlier about why munni is unreachable.',
        nl: 'Desktop voelt nu native: pop-ups openen als gecentreerde vensters in plaats van zijpanelen, transactiedetails sluiten met een ✕, de lijst werd breder, en bonnen zeggen "Uploaden" waar geen camera is. De demomodus kondigt zichzelf duidelijk aan, en de offline-melding is vriendelijker over waarom munni onbereikbaar is.',
        tr: 'Masaüstü artık yerli hissettiriyor: pencereler yan panel yerine ortalanmış diyalog olarak açılıyor, işlem detayı ✕ ile kapanıyor, liste genişledi ve kamera olmayan yerde fişler "Yükle" diyor. Demo modu kendini açıkça belli ediyor ve çevrimdışı bildirimi munni’ye neden ulaşılamadığı konusunda daha nazik.',
      },
    ],
  },
  {
    version: '2.5.0',
    date: '2026-07-17',
    items: [
      {
        en: 'The built-in category list and the import prediction rules can now be updated centrally — improvements arrive on your device with the next sync, no app update needed. Nothing changes for you today; your categories and history stay exactly as they are.',
        nl: 'De ingebouwde categorielijst en de voorspellingsregels voor imports kunnen nu centraal worden bijgewerkt — verbeteringen komen bij de volgende synchronisatie op je apparaat, zonder app-update. Er verandert vandaag niets voor jou; je categorieën en geschiedenis blijven precies zoals ze zijn.',
        tr: 'Yerleşik kategori listesi ve içe aktarma tahmin kuralları artık merkezi olarak güncellenebiliyor — iyileştirmeler bir sonraki eşitlemeyle cihazına gelir, uygulama güncellemesi gerekmez. Bugün senin için hiçbir şey değişmiyor; kategorilerin ve geçmişin olduğu gibi kalıyor.',
      },
    ],
  },
  {
    version: '2.4.0',
    date: '2026-07-17',
    items: [
      {
        en: 'Manual transactions grew up: set the type, counter account and recurring cost right in the form, and delete a manual transaction when it was a mistake. Automatically synced bank accounts no longer accept manual entries — the bank is their single source of truth.',
        nl: 'Handmatige transacties zijn volwassen geworden: stel het type, de tegenrekening en de terugkerende kosten direct in het formulier in, en verwijder een handmatige transactie als die een vergissing was. Automatisch gesynchroniseerde bankrekeningen accepteren geen handmatige invoer meer — de bank is hun enige bron van waarheid.',
        tr: 'Manuel işlemler olgunlaştı: türü, karşı hesabı ve yinelenen gideri doğrudan formda seç, yanlışlıkla eklenen manuel işlemi sil. Otomatik eşitlenen banka hesapları artık manuel giriş kabul etmiyor — tek doğruluk kaynağı banka.',
      },
      {
        en: 'Financial accounts are yours to shape: rename any account, pick your own icon, and see exactly where its data comes from (manual, file import or open banking). Signing out of the apps works cleanly again.',
        nl: 'Financiële rekeningen zijn van jou: hernoem elke rekening, kies je eigen icoon en zie precies waar de gegevens vandaan komen (handmatig, bestandsimport of open banking). Uitloggen in de apps werkt weer netjes.',
        tr: 'Finansal hesaplar senin elinde: her hesabı yeniden adlandır, kendi simgeni seç ve verilerin tam olarak nereden geldiğini gör (manuel, dosya içe aktarma veya açık bankacılık). Uygulamalardan çıkış yeniden düzgün çalışıyor.',
      },
    ],
  },
  {
    version: '2.3.0',
    date: '2026-07-17',
    items: [
      {
        en: 'iOS stability: two startup crash sources in the app are fixed, and harmless "no connection" hiccups no longer count as errors. The encrypted database engine is now built into the apps for testing.',
        nl: 'iOS-stabiliteit: twee crashbronnen bij het opstarten van de app zijn verholpen, en onschuldige "geen verbinding"-haperingen tellen niet langer als fouten. De versleutelde database-engine zit nu ter test in de apps ingebouwd.',
        tr: 'iOS kararlılığı: uygulamadaki iki açılış çökme kaynağı düzeltildi ve zararsız "bağlantı yok" takılmaları artık hata sayılmıyor. Şifreli veritabanı motoru test için uygulamalara eklendi.',
      },
    ],
  },
  {
    version: '2.2.0',
    date: '2026-07-17',
    items: [
      {
        en: 'Under the hood: the entire local database now runs behind one storage layer — the groundwork for fully encrypted storage in the iOS and Android apps. Everything works exactly as before, just future-proof.',
        nl: 'Onder de motorkap: de hele lokale database draait nu achter één opslaglaag — het fundament voor volledig versleutelde opslag in de iOS- en Android-apps. Alles werkt precies zoals eerst, maar klaar voor de toekomst.',
        tr: 'Kaputun altında: tüm yerel veritabanı artık tek bir depolama katmanının arkasında çalışıyor — iOS ve Android uygulamalarında tamamen şifreli depolamanın temeli. Her şey eskisi gibi çalışıyor, sadece geleceğe hazır.',
      },
    ],
  },
  {
    version: '2.1.0',
    date: '2026-07-17',
    items: [
      {
        en: 'The review card got its final shape: the type sits on top with its own color, every category edits through one editor (add, remove or split right there), the "why this suggestion" hides behind a small ⓘ, and the queue now runs oldest-to-newest. Transaction types wear icons and colors everywhere.',
        nl: 'De beoordelingskaart kreeg zijn definitieve vorm: het type staat bovenaan met een eigen kleur, elke categorie bewerk je via één editor (toevoegen, verwijderen of splitsen ter plekke), het "waarom deze suggestie" zit achter een kleine ⓘ, en de wachtrij loopt nu van oud naar nieuw. Transactietypes dragen overal iconen en kleuren.',
        tr: 'İnceleme kartı son halini aldı: tür kendi rengiyle üstte, her kategori tek bir düzenleyiciden geçiyor (ekle, kaldır veya orada böl), "neden bu öneri" küçük bir ⓘ arkasında ve kuyruk artık eskiden yeniye akıyor. İşlem türleri her yerde simge ve renk taşıyor.',
      },
      {
        en: 'Changing a category from the transaction detail now offers to apply it to every other transaction of that merchant — reviewed ones included. Recurring cost logos fill their whole tile, and the bulk-review sheets grew taller with a richer read-only preview.',
        nl: 'Een categorie wijzigen vanuit de transactiedetails biedt nu aan die toe te passen op elke andere transactie van die winkel — ook beoordeelde. Logo\'s van terugkerende kosten vullen hun hele tegel, en de bulkbeoordelingsvellen werden hoger met een rijker alleen-lezen voorbeeld.',
        tr: 'İşlem detayından kategori değiştirmek artık o satıcının diğer tüm işlemlerine uygulamayı öneriyor — incelenmişler dahil. Yinelenen gider logoları karelerini tamamen dolduruyor ve toplu inceleme sayfaları daha uzun, daha zengin bir önizlemeyle geldi.',
      },
    ],
  },
  {
    version: '2.0.0',
    date: '2026-07-17',
    items: [
      {
        en: 'Counterparties got smarter: set one yourself when the bank left it empty (the account suggests the type — savings → saving, your credit card → transfer), and connecting a new account automatically links every old transaction that pointed at it.',
        nl: 'Tegenpartijen zijn slimmer: stel er zelf een in wanneer de bank het leeg liet (de rekening stelt het type voor — spaarrekening → sparen, je creditcard → overboeking), en een nieuwe rekening koppelen verbindt automatisch elke oude transactie die ernaar wees.',
        tr: 'Karşı taraflar akıllandı: banka boş bıraktığında kendin seç (hesap türü öneriyor — birikim → birikim, kredi kartın → transfer) ve yeni bir hesap bağlamak ona işaret eden tüm eski işlemleri otomatik bağlar.',
      },
      {
        en: 'Category names now stay tidy: no duplicate main categories, no subcategory that borrows a main\'s name, and no twins inside one parent — the same rules guard drag & drop. Account deletion moved into Global settings, safely away from Sign out.',
        nl: 'Categorienamen blijven netjes: geen dubbele hoofdcategorieën, geen subcategorie met de naam van een hoofdcategorie, en geen tweelingen binnen één hoofdcategorie — dezelfde regels gelden bij slepen. Account verwijderen verhuisde naar Algemene instellingen, veilig weg van Uitloggen.',
        tr: 'Kategori adları düzenli kalıyor: yinelenen ana kategori yok, ana kategori adını alan alt kategori yok, aynı ebeveynde ikiz yok — aynı kurallar sürüklemede de geçerli. Hesap silme, Çıkış yapmadan güvenle uzağa, Genel ayarlara taşındı.',
      },
      {
        en: 'Android fixes: the notification toggle no longer forgets itself after the app is closed, and the user guide opens properly in the app.',
        nl: 'Android-fixes: de meldingenschakelaar vergeet zichzelf niet meer na het sluiten van de app, en de gebruikersgids opent nu goed in de app.',
        tr: 'Android düzeltmeleri: bildirim anahtarı uygulama kapatıldıktan sonra artık kendini unutmuyor ve kullanım kılavuzu uygulamada düzgün açılıyor.',
      },
    ],
  },
  {
    version: '1.24.0',
    date: '2026-07-16',
    items: [
      {
        en: 'The Android/iOS apps feel more at home: long-press the app icon for Review or Transactions shortcuts, exports open the system share sheet (straight to Files or mail), a subtle haptic confirms each review, and tapping a notification lands you on the right screen.',
        nl: 'De Android/iOS-apps voelen meer thuis: houd het app-icoon ingedrukt voor Beoordelen- of Transacties-snelkoppelingen, exports openen het systeemdeelmenu (direct naar Bestanden of mail), een subtiele triltik bevestigt elke beoordeling, en een tik op een melding brengt je naar het juiste scherm.',
        tr: 'Android/iOS uygulamaları daha yerli hissettiriyor: uygulama simgesine uzun bas ve İncele veya İşlemler kısayollarını aç; dışa aktarmalar sistem paylaşım menüsünü açar (doğrudan Dosyalar veya e-posta), her incelemeyi hafif bir titreşim onaylar ve bildirime dokunmak seni doğru ekrana götürür.',
      },
    ],
  },
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
  const { store } = useData();
  const seen = useQuery(store, async () => (await store.metaGet(SEEN_KEY)) ?? null, []);
  if (seen === undefined) return false; // still loading — don't flash
  const latest = latestWhatsNewVersion();
  return !!latest && seen?.value !== latest;
}

export function useMarkWhatsNewSeen(): () => void {
  const { store } = useData();
  return () => {
    const latest = latestWhatsNewVersion();
    if (latest) void store.metaPut(SEEN_KEY, latest);
  };
}
