#!/bin/sh
# Render /runtime-config.js from MUNNI_* container env vars at startup
# (nginx:alpine runs /docker-entrypoint.d/*.sh before serving). This is
# what lets ONE public web/admin image serve every stack: the app prefers
# window.__MUNNI_CONFIG__ over its baked Vite env (apps/*/src config).
# No MUNNI_* vars set -> an empty overlay -> the baked config wins, so
# the live stacks behave exactly as before this file existed.
#
# The same start renders the app-link files of THIS deployment's own app:
#   /.well-known/assetlinks.json            (Android App Links)
#   /.well-known/apple-app-site-association (iOS universal links)
# from MUNNI_ANDROID_PACKAGE + MUNNI_ANDROID_CERT_SHA256 (the certificate
# Play signs the installed app with — one or more, comma-separated) and
# MUNNI_APPLE_TEAM_ID + MUNNI_IOS_BUNDLE_ID. Nothing static, nothing per
# channel: every environment claims exactly its own app.
set -eu
ROOT="${MUNNI_HTML_ROOT:-/usr/share/nginx/html}"
OUT="$ROOT/runtime-config.js"
[ -w "$ROOT" ] || { echo "40-runtime-config: $ROOT not writable — skipping" >&2; exit 0; }

json=""
for name in API_URL LOGTO_ENDPOINT LOGTO_APP_ID LOGTO_RESOURCE GLITCHTIP_DSN CHANNEL NATIVE_SCHEME PUBLIC_ORIGIN; do
  eval "val=\${MUNNI_${name}:-}"
  [ -n "$val" ] || continue
  esc=$(printf '%s' "$val" | sed 's/\\/\\\\/g; s/"/\\"/g')
  json="${json}${json:+,}\"${name}\":\"${esc}\""
done

printf 'window.__MUNNI_CONFIG__={%s};\n' "$json" > "$OUT"
echo "40-runtime-config: rendered $OUT ($([ -n "$json" ] && echo 'overlay active' || echo 'empty — baked config applies'))"

# ── app links ───────────────────────────────────────────────────────────
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
  printf '{"applinks":{"details":[{"appIDs":["%s.%s"],"components":[{"/":"/gc-callback*"},{"/":"/splits/join/*"},{"/":"/native-auth*"},{"/":"/native-signed-out*"}]}]}}\n' "$MUNNI_APPLE_TEAM_ID" "$MUNNI_IOS_BUNDLE_ID" > "$WK/apple-app-site-association"
  echo "40-runtime-config: apple-app-site-association claims $MUNNI_APPLE_TEAM_ID.$MUNNI_IOS_BUNDLE_ID"
else
  printf '{"applinks":{"details":[]}}\n' > "$WK/apple-app-site-association"
  echo "40-runtime-config: apple-app-site-association claims no app (team id or bundle id not set)"
fi

# The baked CSP allows img-src 'self' data: blob: https: — enough for every
# https deployment, but a plain-http API origin (the LOCAL twin) serves the
# vendored institution logos from http://localhost:<api-port>, which that
# policy blocks (34 blank bank logos, found live 2026-08-27). When THIS
# deployment's API is http, admit exactly that one origin.
SNIPPET="${MUNNI_CSP_SNIPPET:-/etc/nginx/snippets/security-headers.conf}"
case "${MUNNI_API_URL:-}" in
  http://*)
    if [ -w "$SNIPPET" ] && ! grep -q "img-src 'self' data: blob: https: ${MUNNI_API_URL}" "$SNIPPET"; then
      sed -i "s|img-src 'self' data: blob: https:|img-src 'self' data: blob: https: ${MUNNI_API_URL}|" "$SNIPPET"
      echo "40-runtime-config: CSP img-src extended with ${MUNNI_API_URL} (http deployment)"
    fi
    ;;
esac
