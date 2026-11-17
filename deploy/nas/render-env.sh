#!/usr/bin/env bash
# Every ${NAME} in the template comes from the env var of the same name. The workflow names each one
# (deploy-nas.yml `env:`), never the whole secrets context (GitHub's scanner holds public-repo runs
# for that). An unpassed placeholder renders EMPTY (feature off); infra/tests/deploy-nas.test.mjs
# fails on such a gap.
set -euo pipefail

TEMPLATE="$1"; OUTPUT="$2"

mapfile -t NAMES < <(grep -o '\${[A-Z][A-Z0-9_]*}' "$TEMPLATE" | tr -d '${}' | sort -u)

VARLIST=""
for name in "${NAMES[@]}"; do
  export "$name"="${!name:-}"
  VARLIST="$VARLIST \${$name}"
done

envsubst "$VARLIST" < "$TEMPLATE" > "$OUTPUT"

# the stack cannot run without these: fail at render time, not on the NAS
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
