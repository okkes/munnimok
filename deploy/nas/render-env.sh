#!/usr/bin/env bash
# Render an env TEMPLATE into a real .env for a NAS bundle.
#   render-env.sh TEMPLATE OUTPUT
# Every ${NAME} placeholder in the template is filled from the
# environment variable of the same name — the workflow names each one
# explicitly (deploy-nas.yml `env:`), never the whole secrets context
# (user ruling 2026-09-16: toJSON(secrets) is the pattern GitHub's
# scanner holds public-repo runs for). A placeholder the workflow does
# not pass renders EMPTY (its feature stays off) — and
# infra/tests/deploy-nas.test.mjs fails on such a gap before it ships.
# Used by the live channels (deploy/env/.env.nas) and the iac channels
# (infra/rendered/<stack>/.env.<stack>, which also reference ${VITE_*}
# VARIABLES the logto/glitchtip modules wrote back).
set -euo pipefail

TEMPLATE="$1"; OUTPUT="$2"

# every ${NAME} placeholder the template mentions
mapfile -t NAMES < <(grep -o '\${[A-Z][A-Z0-9_]*}' "$TEMPLATE" | tr -d '${}' | sort -u)

VARLIST=""
for name in "${NAMES[@]}"; do
  # unset → empty, so envsubst never leaves a literal ${NAME} behind
  export "$name"="${!name:-}"
  VARLIST="$VARLIST \${$name}"
done

envsubst "$VARLIST" < "$TEMPLATE" > "$OUTPUT"

# a stack cannot run without these — fail loudly, not at 3am on the NAS.
# Only enforced when the template actually references the name (the iac
# templates bake DOMAIN at render time, so NAS_DOMAIN never appears there).
# NAS_GHCR_PAT is deliberately absent: the munni images are public and
# update.sh only logs into ghcr.io when a token is present (2026-09-10)
for required in NAS_POSTGRES_PASSWORD NAS_DOMAIN; do
  printf '%s\n' "${NAMES[@]}" | grep -qx "$required" || continue
  if [ -z "${!required:-}" ]; then
    echo "::error::required secret $required is missing or empty" >&2
    exit 1
  fi
done

# optional values may be empty (the feature just stays off) — but say so
for name in "${NAMES[@]}"; do
  [ -z "${!name}" ] && echo "note: $name is empty — its feature stays disabled"
done

echo "rendered $OUTPUT from $TEMPLATE (${#NAMES[@]} placeholders)"
