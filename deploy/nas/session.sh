#!/usr/bin/env bash
# Sourced by upload.sh and download.sh: one File Station session. Needs URL, SYNOLOGY_USER and SYNOLOGY_PASS.

# DSM 7.3 answers about one login in fifty with a sid it does not know itself: the first call with it is refused with 119,
# and so is every later one (measured with nothing else signed in, #638). A login counts once DSM answers a call with it.
dsm_login() {
  local resp sid check attempt
  for attempt in 1 2 3 4; do
    resp=$(curl -sS "$URL/webapi/auth.cgi" \
      --data-urlencode "api=SYNO.API.Auth" \
      --data-urlencode "version=6" \
      --data-urlencode "method=login" \
      --data-urlencode "account=$SYNOLOGY_USER" \
      --data-urlencode "passwd=$SYNOLOGY_PASS" \
      --data-urlencode "session=FileStation" \
      --data-urlencode "format=sid")
    if ! echo "$resp" | grep -q '"success":true'; then
      echo "Synology login failed: $resp" >&2
      return 1
    fi
    sid=$(echo "$resp" | sed -n 's/.*"sid" *: *"\([^"]*\)".*/\1/p')
    [ -n "$sid" ] || { echo "no sid in login response" >&2; return 1; }
    # a check that cannot be made proves nothing: the call that follows says what is wrong
    check=$(curl -sS -G "$URL/webapi/entry.cgi" \
      --data-urlencode "api=SYNO.FileStation.Info" \
      --data-urlencode "version=2" \
      --data-urlencode "method=get" \
      --data-urlencode "_sid=$sid" || true)
    if ! echo "$check" | grep -Eq '"code" *: *119([^0-9]|$)'; then
      echo "$sid"
      return 0
    fi
    echo "DSM does not know the session it just handed out (119) — signing in again (attempt $attempt of 4)" >&2
  done
  echo "Synology login: four sessions in a row were not recognised by DSM (119)" >&2
  return 1
}

dsm_logout() {
  curl -sS "$URL/webapi/auth.cgi" \
    --data-urlencode "api=SYNO.API.Auth" \
    --data-urlencode "version=6" \
    --data-urlencode "method=logout" \
    --data-urlencode "session=FileStation" \
    --data-urlencode "_sid=$1" >/dev/null || true
}
