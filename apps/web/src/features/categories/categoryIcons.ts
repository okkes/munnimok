import { MDI_NAMES } from '@/generated/mdiNames';

/** the curated icons a custom category is offered first — the whole font follows them (#563) */
export const CATEGORY_ICONS: readonly string[] = [
  'silverware-fork-knife', 'coffee-outline', 'cart-outline', 'cash', 'gift-outline', 'home-outline',
  'car-outline', 'bus', 'bike', 'airplane', 'gamepad-variant-outline', 'music',
  'movie-open-outline', 'book-open-outline', 'school-outline', 'heart-outline', 'medical-bag', 'pill',
  'dumbbell', 'run', 'tshirt-crew-outline', 'shoe-sneaker', 'laptop', 'cellphone',
  'sofa-outline', 'flower-outline', 'paw', 'baby-carriage', 'beach', 'tent',
  'tools', 'lightning-bolt-outline', 'water-outline', 'fire', 'leaf', 'tag-outline',
];

/** #389: the first icon no sibling wears — a curated one while any is free, else the first free glyph of the font */
export const firstFreeIcon = (taken: ReadonlySet<string>): string =>
  CATEGORY_ICONS.find((icon) => !taken.has(icon)) ?? MDI_NAMES.find((icon) => !taken.has(icon)) ?? CATEGORY_ICONS[0];
