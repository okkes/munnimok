/**
 * #552: an emitted asset keeps its extension, and pdf.js's worker is an
 * `.mjs` — which nginx's stock mime map serves as octet-stream (a browser
 * refuses that for a module script; the native shells' servers know the
 * type, so only the web failed) and the precache glob skipped. Modules
 * leave as `.js`; the new name also retires the copy browsers cached under
 * the old one for a year.
 */
export function assetFileName(asset: { readonly names: readonly string[] }): string {
  return asset.names.some((name) => name.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]';
}
