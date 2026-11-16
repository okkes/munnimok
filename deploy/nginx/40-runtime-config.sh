#!/bin/sh
# Lets ONE public web/admin image serve every stack: the app prefers window.__MUNNI_CONFIG__ over its
# baked Vite env; no MUNNI_* vars -> empty overlay -> the baked config wins.
# Also renders the app-link files (assetlinks.json, apple-app-site-association) so every environment
# claims exactly its own app; MUNNI_ANDROID_CERT_SHA256 is the Play signing certificate, comma-separated.
set -eu
ROOT="${MUNNI_HTML_ROOT:-/usr/share/nginx/html}"
OUT="$ROOT/runtime-config.js"
[ -w "$ROOT" ] || { echo "40-runtime-config: $ROOT not writable — skipping" >&2; exit 0; }

json=""
for name in API_URL LOGTO_ENDPOINT LOGTO_APP_ID LOGTO_RESOURCE GLITCHTIP_DSN TRACES_SAMPLE_RATE CHANNEL NATIVE_SCHEME PUBLIC_ORIGIN LAB_URL; do
  eval "val=\${MUNNI_${name}:-}"
  [ -n "$val" ] || continue
  esc=$(printf '%s' "$val" | sed 's/\\/\\\\/g; s/"/\\"/g')
  json="${json}${json:+,}\"${name}\":\"${esc}\""
done

printf 'window.__MUNNI_CONFIG__={%s};\n' "$json" > "$OUT"
echo "40-runtime-config: rendered $OUT ($([ -n "$json" ] && echo 'overlay active' || echo 'empty — baked config applies'))"

WK="$ROOT/.well-known"
mkdir -p "$WK"
if [ -n "${MUNNI_ANDROID_PACKAGE:-}" ] && [ -n "${MUNNI_ANDROID_CERT_SHA256:-}" ]; then
  fps=$(printf '%s' "$MUNNI_ANDROID_CERT_SHA256" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' | tr 'a-f' 'A-F' | sed 's/.*/"&"/' | paste -sd, -)
  printf '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"%s","sha256_cert_fingerprints":[%s]}}]\n' "$MUNNI_ANDROID_PACKAGE" "$fps" > "$WK/assetlinks.json"
  echo "40-runtime-config: assetlinks.json claims $MUNNI_ANDROID_PACKAGE"
else
  printf '[]\n' > "$WK/assetlinks.json"
  echo "40-runtime-config: assetlinks.json claims no app (package or certificate fingerprint not set)"
fi
if [ -n "${MUNNI_APPLE_TEAM_ID:-}" ] && [ -n "${MUNNI_IOS_BUNDLE_ID:-}" ]; then
  printf '{"applinks":{"details":[{"appIDs":["%s.%s"],"components":[{"/":"/gc-callback*"},{"/":"/splits/join/*"},{"/":"/invite*"}]}]}}\n' "$MUNNI_APPLE_TEAM_ID" "$MUNNI_IOS_BUNDLE_ID" > "$WK/apple-app-site-association"
  echo "40-runtime-config: apple-app-site-association claims $MUNNI_APPLE_TEAM_ID.$MUNNI_IOS_BUNDLE_ID"
else
  printf '{"applinks":{"details":[]}}\n' > "$WK/apple-app-site-association"
  echo "40-runtime-config: apple-app-site-association claims no app (team id or bundle id not set)"
fi

# the baked CSP img-src blocks the vendored bank logos served by a plain-http API (the LOCAL twin):
# admit exactly that one origin
SNIPPET="${MUNNI_CSP_SNIPPET:-/etc/nginx/snippets/security-headers.conf}"
case "${MUNNI_API_URL:-}" in
  http://*)
    if [ -w "$SNIPPET" ] && ! grep -q "img-src 'self' data: blob: https: ${MUNNI_API_URL}" "$SNIPPET"; then
      sed -i "s|img-src 'self' data: blob: https:|img-src 'self' data: blob: https: ${MUNNI_API_URL}|" "$SNIPPET"
      echo "40-runtime-config: CSP img-src extended with ${MUNNI_API_URL} (http deployment)"
    fi
    ;;
esac
