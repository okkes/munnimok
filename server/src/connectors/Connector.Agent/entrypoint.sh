#!/bin/sh
# Virtual display so Chromium runs truly headed: a headless browser is detectable (no display, compositor, distinct
# GPU paths) and Albert Heijn's edge answered "Access Denied" to a screenless agent. No fingerprint patching, by policy.
# ConnectorAgent__Headless=true ignores the display, so one image serves both modes.
set -eu

: "${AGENT_DISPLAY:=:99}"
: "${AGENT_SCREEN:=1920x1080x24}"

# 24-bit: xvfb defaults to 8-bit, which renders wrong colours into screenshots.
# -nolisten tcp only: also adding -nolisten unix would kill the /tmp/.X11-unix socket Chromium connects through.
display_number="${AGENT_DISPLAY#:}"
socket="/tmp/.X11-unix/X${display_number}"
lock="/tmp/.X${display_number}-lock"

# the Playwright base image ships a stale lock/socket in /tmp; Xvfb then refuses ("already active for display 99")
# and the agent runs screenless, failing every browser job
rm -f "$lock" "$socket" 2>/dev/null || true

Xvfb "$AGENT_DISPLAY" -screen 0 "$AGENT_SCREEN" -nolisten tcp &
xvfb_pid=$!

# Chromium against a display that is not listening yet fails at launch instead of retrying
i=0
while [ "$i" -lt 100 ]; do
    [ -S "$socket" ] && kill -0 "$xvfb_pid" 2>/dev/null && break
    i=$((i + 1))
    sleep 0.1
done

# both checks: a socket can be a stale leftover, a live process may not have bound yet
if [ -S "$socket" ] && kill -0 "$xvfb_pid" 2>/dev/null; then
    export DISPLAY="$AGENT_DISPLAY"
else
    # fatal when headed: an agent without a display would lease jobs for every provider and fail them all
    if [ "${ConnectorAgent__Headless:-true}" = "false" ]; then
        echo "agent-entrypoint: FATAL: no X server on $AGENT_DISPLAY and Headless=false" >&2
        exit 1
    fi

    echo "agent-entrypoint: WARNING: no X server on $AGENT_DISPLAY; running headless" >&2
fi

# exec (not xvfb-run): the agent must get SIGTERM directly or its shutdown drain never runs
exec "$@"
