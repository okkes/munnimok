import type { ProviderKind } from './types';

/**
 * A party's picture: the catalogue only HINTS a logo (`logoRef`); the app
 * resolves it against the brand assets it ships and falls back to an icon
 * per kind. The user's own pick (BrandIconPicker) always wins over both.
 */
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

/**
 * A party's name where no catalogue is at hand (a receipt row's `source`
 * on a demo device, a group header): the receipt's own merchant when it
 * carries one, else the id spelled out — brand names are not translated.
 */
export const partyName = (providerId: string): string =>
  providerId
    .replace(/-nl$/, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
