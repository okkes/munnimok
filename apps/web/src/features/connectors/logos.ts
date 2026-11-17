import type { ProviderKind } from './types';

// the catalogue only HINTS a logo (logoRef): resolved against shipped brand assets, else a kind icon;
// the user's own pick wins over both
const BRAND_ASSETS: Record<string, string> = {
  lidl: 'brands/lidl.svg',
  mediamarkt: 'brands/mediamarkt.svg',
};

export const partyLogo = (logoRef: string | undefined): string | null => (logoRef ? (BRAND_ASSETS[logoRef] ?? null) : null);

const KIND_ICON: Record<ProviderKind, string> = {
  store: 'storefront-outline',
  bank: 'bank-outline',
  registry: 'file-document-outline',
};

export const kindIcon = (kind: ProviderKind | undefined): string => KIND_ICON[kind ?? 'store'];

/** brands whose id does not spell their name — the aggregators write theirs in one word */
const SPELLED_NAMES: Record<string, string> = {
  gocardless: 'GoCardless',
  enablebanking: 'Enable Banking',
};

// a party's name where no catalogue is at hand (demo receipt source, account source line, group header);
// brand names are not translated
export const partyName = (providerId: string): string =>
  SPELLED_NAMES[providerId] ??
  providerId
    .replace(/-nl$/, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
