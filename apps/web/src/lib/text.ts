/**
 * Bank data hygiene: ING (and others) embed literal "<br>" separators in
 * remittance text. Strip markup-ish noise for display — covers rows that
 * were imported before server-side sanitation existed.
 */
export function cleanBankText(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
