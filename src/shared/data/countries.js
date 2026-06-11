// Country names: en = English, nl = Dutch, tr = Turkish, native = local name
export const COUNTRIES = [
  { code:'NL', en:'Netherlands',     nl:'Nederland',              tr:'Hollanda',                    native:'Nederland',         emoji:'🇳🇱' },
  { code:'DE', en:'Germany',         nl:'Duitsland',              tr:'Almanya',                     native:'Deutschland',       emoji:'🇩🇪' },
  { code:'BE', en:'Belgium',         nl:'België',                 tr:'Belçika',                     native:'België',            emoji:'🇧🇪' },
  { code:'TR', en:'Turkey',          nl:'Turkije',                tr:'Türkiye',                     native:'Türkiye',           emoji:'🇹🇷' },
  { code:'GB', en:'United Kingdom',  nl:'Verenigd Koninkrijk',    tr:'Birleşik Krallık',            native:'United Kingdom',    emoji:'🇬🇧' },
  { code:'FR', en:'France',          nl:'Frankrijk',              tr:'Fransa',                      native:'France',            emoji:'🇫🇷' },
  { code:'ES', en:'Spain',           nl:'Spanje',                 tr:'İspanya',                     native:'España',            emoji:'🇪🇸' },
  { code:'IT', en:'Italy',           nl:'Italië',                 tr:'İtalya',                      native:'Italia',            emoji:'🇮🇹' },
  { code:'PT', en:'Portugal',        nl:'Portugal',               tr:'Portekiz',                    native:'Portugal',          emoji:'🇵🇹' },
  { code:'PL', en:'Poland',          nl:'Polen',                  tr:'Polonya',                     native:'Polska',            emoji:'🇵🇱' },
  { code:'SE', en:'Sweden',          nl:'Zweden',                 tr:'İsveç',                       native:'Sverige',           emoji:'🇸🇪' },
  { code:'NO', en:'Norway',          nl:'Noorwegen',              tr:'Norveç',                      native:'Norge',             emoji:'🇳🇴' },
  { code:'DK', en:'Denmark',         nl:'Denemarken',             tr:'Danimarka',                   native:'Danmark',           emoji:'🇩🇰' },
  { code:'FI', en:'Finland',         nl:'Finland',                tr:'Finlandiya',                  native:'Suomi',             emoji:'🇫🇮' },
  { code:'AT', en:'Austria',         nl:'Oostenrijk',             tr:'Avusturya',                   native:'Österreich',        emoji:'🇦🇹' },
  { code:'CH', en:'Switzerland',     nl:'Zwitserland',            tr:'İsviçre',                     native:'Schweiz',           emoji:'🇨🇭' },
  { code:'LU', en:'Luxembourg',      nl:'Luxemburg',              tr:'Lüksemburg',                  native:'Luxembourg',        emoji:'🇱🇺' },
  { code:'IE', en:'Ireland',         nl:'Ierland',                tr:'İrlanda',                     native:'Ireland',           emoji:'🇮🇪' },
  { code:'CZ', en:'Czech Republic',  nl:'Tsjechië',               tr:'Çekya',                       native:'Česká republika',   emoji:'🇨🇿' },
  { code:'SK', en:'Slovakia',        nl:'Slowakije',              tr:'Slovakya',                    native:'Slovensko',         emoji:'🇸🇰' },
  { code:'HU', en:'Hungary',         nl:'Hongarije',              tr:'Macaristan',                  native:'Magyarország',      emoji:'🇭🇺' },
  { code:'RO', en:'Romania',         nl:'Roemenië',               tr:'Romanya',                     native:'România',           emoji:'🇷🇴' },
  { code:'BG', en:'Bulgaria',        nl:'Bulgarije',              tr:'Bulgaristan',                 native:'България',          emoji:'🇧🇬' },
  { code:'GR', en:'Greece',          nl:'Griekenland',            tr:'Yunanistan',                  native:'Ελλάδα',            emoji:'🇬🇷' },
  { code:'HR', en:'Croatia',         nl:'Kroatië',                tr:'Hırvatistan',                 native:'Hrvatska',          emoji:'🇭🇷' },
  { code:'SI', en:'Slovenia',        nl:'Slovenië',               tr:'Slovenya',                    native:'Slovenija',         emoji:'🇸🇮' },
  { code:'US', en:'United States',   nl:'Verenigde Staten',       tr:'Amerika Birleşik Devletleri', native:'United States',     emoji:'🇺🇸' },
  { code:'CA', en:'Canada',          nl:'Canada',                 tr:'Kanada',                      native:'Canada',            emoji:'🇨🇦' },
  { code:'AU', en:'Australia',       nl:'Australië',              tr:'Avustralya',                  native:'Australia',         emoji:'🇦🇺' },
  { code:'SG', en:'Singapore',       nl:'Singapore',              tr:'Singapur',                    native:'Singapore',         emoji:'🇸🇬' },
  { code:'JP', en:'Japan',           nl:'Japan',                  tr:'Japonya',                     native:'日本',               emoji:'🇯🇵' },
  { code:'AE', en:'UAE',             nl:'VAE',                    tr:'Birleşik Arap Emirlikleri',   native:'الإمارات',           emoji:'🇦🇪' },
  { code:'ZA', en:'South Africa',    nl:'Zuid-Afrika',            tr:'Güney Afrika',                native:'South Africa',      emoji:'🇿🇦' },
  { code:'MA', en:'Morocco',         nl:'Marokko',                tr:'Fas',                         native:'المغرب',             emoji:'🇲🇦' },
];

// Returns the display name for a country in the given language code
export function countryName(c, lang) {
  return c[lang] || c.en;
}
