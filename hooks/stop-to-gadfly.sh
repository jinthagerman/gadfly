#!/usr/bin/env bash
# Claude Code Stop hook: forwards the last assistant message of the *subject*
# session to gadfly. The subject is the Claude Code session whose gadfly
# subprocess won the role race; gadfly writes its PID and the chosen
# ephemeral port to ~/.cache/gadfly/subject.json on startup.
#
# The hook walks its own process tree to find a `claude` ancestor and only
# POSTs if that PID matches subject.json's claude_pid. Critic sessions have
# the same hook installed but their claude PID won't match, so they no-op
# and the loop is broken at the source. No env-var gating needed.
#
# Always exits 0 so a hook failure cannot block the host session.
set -u

RUNTIME_DIR="${HOME}/.cache/gadfly"
SUBJECT_JSON="${RUNTIME_DIR}/subject.json"

# No subject file → no live subject → nothing to do.
[ -f "$SUBJECT_JSON" ] || exit 0

# Need jq to parse both the Stop hook payload and subject.json.
command -v jq >/dev/null 2>&1 || exit 0

SUBJECT_CLAUDE_PID=$(jq -r '.claude_pid // empty' "$SUBJECT_JSON")
SUBJECT_PORT=$(jq -r '.port // empty' "$SUBJECT_JSON")
[ -z "$SUBJECT_CLAUDE_PID" ] && exit 0
[ -z "$SUBJECT_PORT" ] && exit 0

# Walk our own process tree until we find a `claude` ancestor (or hit pid 1).
# We compare its PID to subject.claude_pid; only the subject session fires.
find_claude_ancestor() {
  local pid=$$
  local guard=0
  while [ "$pid" != "1" ] && [ "$pid" != "0" ] && [ "$guard" -lt 64 ]; do
    local line ppid comm
    line=$(ps -o ppid=,comm= -p "$pid" 2>/dev/null) || return 1
    ppid=$(printf '%s' "$line" | awk '{print $1}')
    comm=$(printf '%s' "$line" | awk '{$1=""; sub(/^ /,""); print}')
    # `comm` may be a path; match the basename.
    case "${comm##*/}" in
      claude|claude-*)
        printf '%s' "$pid"
        return 0
        ;;
    esac
    pid=$ppid
    guard=$((guard + 1))
  done
  return 1
}

MY_CLAUDE_PID=$(find_claude_ancestor) || exit 0
[ "$MY_CLAUDE_PID" != "$SUBJECT_CLAUDE_PID" ] && exit 0

# We are the subject — read the Stop hook payload and forward.
payload=$(cat)
msg=$(printf '%s' "$payload" | jq -r '.last_assistant_message // empty')
sid=$(printf '%s' "$payload" | jq -r '.session_id // empty')
[ -z "$msg" ] && exit 0

curl -sS --max-time 2 -X POST \
  -H "X-Source-Session: ${sid}" \
  --data-binary "$msg" \
  "http://127.0.0.1:${SUBJECT_PORT}/publish" >/dev/null 2>&1 || true

exit 0
