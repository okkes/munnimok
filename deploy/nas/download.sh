#!/usr/bin/env bash
#   download.sh REMOTE_PATH LOCAL_PATH   (a trailing slash on REMOTE lists the folder instead)
# Used by the NAS-diagnostics workflow to pull deploy.log without SSH.
set -euo pipefail

: "${SYNOLOGY_URL:?}" "${SYNOLOGY_USER:?}" "${SYNOLOGY_PASS:?}"
URL="${SYNOLOGY_URL%/}"
REMOTE="$1"; LOCAL="$2"

# shellcheck source=deploy/nas/session.sh
. "$(dirname "$0")/session.sh"
SID=$(dsm_login)
trap 'dsm_logout "$SID"' EXIT

if [ "${REMOTE%/}" != "$REMOTE" ]; then
  FOLDER=$(printf '%s' "$REMOTE" | sed 's:/*$::')
  curl -sS -G "$URL/webapi/entry.cgi" \
    --data-urlencode "api=SYNO.FileStation.List" \
    --data-urlencode "version=2" \
    --data-urlencode "method=list" \
    --data-urlencode "folder_path=$FOLDER" \
    --data-urlencode "additional=[\"size\",\"time\"]" \
    --data-urlencode "_sid=$SID" \
    -o "$LOCAL"
else
  curl -sS -G "$URL/webapi/entry.cgi" \
    --data-urlencode "api=SYNO.FileStation.Download" \
    --data-urlencode "version=2" \
    --data-urlencode "method=download" \
    --data-urlencode "path=$REMOTE" \
    --data-urlencode "mode=download" \
    --data-urlencode "_sid=$SID" \
    -o "$LOCAL"
fi

# a JSON or HTML body instead of file content means the API refused (bad path, permission, DSM 404 page)
if head -c 1 "$LOCAL" | grep -q '{' && grep -q '"success":false' "$LOCAL" 2>/dev/null; then
  echo "download of $REMOTE failed: $(cat "$LOCAL")" >&2
  exit 1
fi
if head -c 15 "$LOCAL" | grep -qi '<!DOCTYPE\|<html'; then
  echo "download of $REMOTE returned an HTML error page (path wrong or file missing)" >&2
  exit 1
fi
echo "downloaded $REMOTE -> $LOCAL ($(wc -c <"$LOCAL") bytes)"
