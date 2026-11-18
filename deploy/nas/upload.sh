#!/usr/bin/env bash
# VERSION is uploaded LAST so the NAS poller never sees a stamp before its bundle has landed.
set -euo pipefail

: "${SYNOLOGY_URL:?}" "${SYNOLOGY_USER:?}" "${SYNOLOGY_PASS:?}" "${SYNOLOGY_PATH:?}"
URL="${SYNOLOGY_URL%/}"
# shellcheck source=deploy/nas/session.sh
. "$(dirname "$0")/session.sh"

upload_one() {
  local sid="$1" file="$2" resp
  # _sid must ride the query string: as a multipart field the API answers error 119
  resp=$(curl -sS "$URL/webapi/entry.cgi?_sid=$sid" \
    -F "api=SYNO.FileStation.Upload" \
    -F "version=2" \
    -F "method=upload" \
    -F "path=$SYNOLOGY_PATH" \
    -F "create_parents=true" \
    -F "overwrite=true" \
    -F "file=@$file;filename=$(basename "$file")")
  if ! echo "$resp" | grep -q '"success":true'; then
    echo "upload of $(basename "$file") failed: $resp" >&2
    exit 1
  fi
  echo "uploaded $(basename "$file")"
}

SID=$(dsm_login)
trap 'dsm_logout "$SID"' EXIT
for f in "$@"; do
  upload_one "$SID" "$f"
done
