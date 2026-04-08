#!/usr/bin/env bash
# Claude Code Stop hook: forwards the last assistant message to a gadfly
# channel server running on 127.0.0.1:8788, where another Claude Code session
# is listening as a devil's advocate. Designed to fail silently so it never
# blocks the host session — even if gadfly is down or jq is missing.
set -u

# Explicit opt-in gate. Without this env var, the hook is a no-op. This
# prevents the critic session (Instance B) from critiquing its own replies
# and creating a feedback loop when both sessions share a settings.json or
# when the critic is launched from a directory that registers this hook.
if [ "${GADFLY_CRITIQUE_ME:-}" != "1" ]; then
  exit 0
fi

PORT="${GADFLY_PORT:-8788}"

payload=$(cat)

# Pull last_assistant_message and session_id out of the Stop hook JSON.
# If jq is missing, fall back to a best-effort sed and exit cleanly on failure.
if command -v jq >/dev/null 2>&1; then
  msg=$(printf '%s' "$payload" | jq -r '.last_assistant_message // empty')
  sid=$(printf '%s' "$payload" | jq -r '.session_id // empty')
else
  msg=""
  sid=""
fi

# Nothing to forward — exit clean so we don't block Stop.
[ -z "$msg" ] && exit 0

curl -sS --max-time 2 -X POST \
  -H "X-Source-Session: ${sid}" \
  --data-binary "$msg" \
  "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true

exit 0
