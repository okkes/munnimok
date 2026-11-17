// #552: modules leave as `.js`: nginx's stock mime map serves pdf.js's `.mjs` worker as octet-stream (a module script is
// refused) and the precache glob skipped it; the new name also retires the copy browsers cached under the old one for a year
export function assetFileName(asset: { readonly names: readonly string[] }): string {
  return asset.names.some((name) => name.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]';
}
