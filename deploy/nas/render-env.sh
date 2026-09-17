#!/usr/bin/env bash
# Render an env TEMPLATE into a real .env for a NAS bundle.
#   render-env.sh TEMPLATE OUTPUT
# Every ${NAME} placeholder in the template is filled from the environment
# variable of the same name — the workflow names each one explicitly
# (deploy-nas.yml `env:`), never the whole secrets context (the pattern
# GitHub's scanner holds public-repo runs for). A placeholder the workflow
# does not pass renders EMPTY (its feature stays off) — and
# infra/tests/deploy-nas.test.mjs fails on such a gap before it ships.
set -euo pipefail

TEMPLATE="$1"; OUTPUT="$2"

mapfile -t NAMES < <(grep -o '\${[A-Z][A-Z0-9_]*}' "$TEMPLATE" | tr -d '${}' | sort -u)

VARLIST=""
for name in "${NAMES[@]}"; do
  export "$name"="${!name:-}"
  VARLIST="$VARLIST \${$name}"
done

envsubst "$VARLIST" < "$TEMPLATE" > "$OUTPUT"

# a stack cannot run without these — fail loudly, not at 3am on the NAS
for required in POSTGRES_PASSWORD; do
  printf '%s\n' "${NAMES[@]}" | grep -qx "$required" || continue
  if [ -z "${!required:-}" ]; then
    echo "::error::required secret $required is missing or empty" >&2
    exit 1
  fi
done

for name in "${NAMES[@]}"; do
  [ -z "${!name}" ] && echo "note: $name is empty — its feature stays disabled"
done

echo "rendered $OUTPUT from $TEMPLATE (${#NAMES[@]} placeholders)"
