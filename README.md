# gadfly

**Combat sycophancy.** An LLM in a code editor can become an echo chamber — the
model agrees with your half-baked ideas, reinforces your assumptions, and never
pushes back. Gadfly fixes this by spawning a devil's advocate into a second Claude
Code session that reads every response you get and argues against it in good faith.

Structurally: a [Claude Code channel](https://code.claude.com/docs/en/channels-reference)
that forwards every assistant turn from one Claude Code session into a *second*
Claude Code session, where it gets read by a configurable persona — by default
a devil's advocate — that pushes back on it.

No API keys, no separate model, no special launch incantations: the critic is
just another Claude Code instance, and role assignment is decided by the order
the two sessions start up.

```
 ┌──────────────────────────┐                        ┌──────────────────────────┐
 │ Claude Code "subject"    │                        │ Claude Code "critic"     │
 │ (first to start)         │                        │ (started later)          │
 │                          │                        │                          │
 │ Stop hook ─POST /publish─┼──▶ gadfly (subject) ──▶│──▶ gadfly (critic) ──▶   │
 │                          │    subject.json        │    <channel> tag into    │
 │                          │    ephemeral port      │    critic's context      │
 │                          │    SSE /events ────────┘                          │
 └──────────────────────────┘                        └──────────────────────────┘
```

## How role assignment works

Both sessions launch Claude Code identically (just `claude` from this
directory). Each one's `gadfly.ts` subprocess races for a PID-file lock at
`~/.cache/gadfly/subject.lock`:

- **Winner = subject.** Starts a localhost HTTP server on an ephemeral port,
  writes `{claude_pid, gadfly_pid, port}` to `~/.cache/gadfly/subject.json`,
  and broadcasts POSTed messages to all SSE subscribers. It does *not* push
  events into its own MCP session.
- **Loser = critic.** Reads `subject.json`, opens a long-lived SSE connection
  to the subject's `/events`, and forwards each message into its own MCP
  session as a `notifications/claude/channel` event. Exits when the SSE
  stream closes.

The Stop hook walks its own process tree to find its `claude` ancestor and
only POSTs if that PID matches `subject.json`'s `claude_pid`. Critic sessions
have the same hook installed but their claude PID won't match, so the hook
no-ops and the self-critique loop is broken at the source. No env vars, no
opt-in flags, no separate `.mcp.json` files.

If the subject session exits, the critic's SSE connection closes and its
gadfly subprocess exits cleanly — you'll see it disappear from `/mcp`.
Restart whichever session you want to be the new subject; whichever gadfly
wins the next lock race takes over.

## Requirements

- [Bun](https://bun.sh)
- `jq` (used by the Stop hook)
- Claude Code v2.1.80 or later, signed in with claude.ai (channels do not
  work with API key auth)
- On Team / Enterprise plans, an admin must
  [enable channels](https://code.claude.com/docs/en/channels#enterprise-controls)

## Install

Clone or download gadfly to a directory on your machine. Then install dependencies:

```bash
bun install
```

## Use

### Quick start

Register the Stop hook globally using `claude mcp add`:

```bash
claude mcp add gadfly -- bun /path/to/gadfly/gadfly.ts
```

Then add the Stop hook to your user-level `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/gadfly/hooks/stop-to-gadfly.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Now, open two Claude Code windows (works in any project):

**Terminal 1 — the subject (work in any project):**
```bash
cd ~/my-project
claude
```

**Terminal 2 — the critic:**
```bash
claude --dangerously-load-development-channels server:gadfly
```

(The `--dangerously-load-development-channels` flag is required because custom channels aren't on the Anthropic allowlist during the research preview.)

Whichever starts first becomes the subject (being critiqued). The second becomes the critic (pushing back).

## Personalities

The critic's persona is set via the `instructions` field on the MCP server,
which Claude Code adds to the system prompt of the critic session. You can
swap it without touching code.

Loader priority (first one wins):

1. `GADFLY_PERSONALITY` environment variable
2. `personalityFile` field in `gadfly.config.json` (path to a text file)
3. `personality` field in `gadfly.config.json` (inline string)
4. Built-in default

A fixed preamble explaining the channel mechanics is always prepended, so
you can write a personality file that's purely about tone and focus —
nothing about `<channel>` tags or "don't call tools" needs to be in your
persona text.

### Switching personalities

Edit `gadfly.config.json` in the gadfly directory:

```json
{
  "personalityFile": "./personalities/pedant.md"
}
```

Then restart the critic window (the one running `--dangerously-load-development-channels`).
The new persona takes effect on the next channel event. (The subject doesn't 
need restarting — it doesn't use the personality.)

### Shipped examples

| File                              | Tone                                                  |
| --------------------------------- | ----------------------------------------------------- |
| `personalities/devils-advocate.md`| Pushback in good faith, strongest counter-argument    |
| `personalities/pedant.md`         | Three most likely production failure modes            |
| `personalities/optimist-check.md` | Sympathetic but rigorous; one biggest risk only       |

### Writing your own

Drop a `.md` (or `.txt`) file into `personalities/`, point `personalityFile`
at it, restart the critic. The file is treated as raw text — no frontmatter,
no templating. Keep it focused on tone, format, and what to look for; the
preamble already handles the plumbing.

## Runtime state

gadfly writes a couple of files to `~/.cache/gadfly/`:

| File            | Purpose                                                      |
| --------------- | ------------------------------------------------------------ |
| `subject.lock`  | PID file — existence + liveness decides subject-vs-critic    |
| `subject.json`  | `{claude_pid, gadfly_pid, port}` for the current subject     |

Both are cleaned up on clean exit (SIGTERM / SIGINT / normal shutdown). If
gadfly gets `kill -9`'d the files are left behind; the next startup detects
the stale PID via `kill(pid, 0)` and takes over automatically.

## Troubleshooting

**`/mcp` shows gadfly as "failed to connect"** — check
`~/.claude/debug/<session-id>.txt` for the stderr trace. The most common
cause is that a stale `subject.lock` from a previous `kill -9` is pointing
at a PID that was recycled by the OS to another process, so the liveness
check succeeds but the port in `subject.json` goes nowhere. Nuke
`~/.cache/gadfly/` and restart both sessions.

**Both windows think they're the critic** — means neither acquired the lock
cleanly. Usually caused by a leftover gadfly process you didn't kill. Check
`pgrep -fl "bun.*gadfly"` and kill stragglers.

**Subject window is sending but critic doesn't react** — confirm the critic
still has gadfly attached (`/mcp` in the critic), then `cat
~/.cache/gadfly/subject.json` and `curl -N http://127.0.0.1:<port>/events`
in a spare terminal to watch the SSE stream directly. If curl sees events
but the critic doesn't react, the critic's gadfly subprocess has likely
died — restart the critic window.

**Stop hook never fires** — check the `matcher` + `hooks` wrapper shape in
your `settings.json` (Claude Code will reject the whole file silently if
the shape is wrong) and make sure the script is executable
(`chmod +x hooks/stop-to-gadfly.sh`).

## Security notes

- gadfly binds to `127.0.0.1` only. It is not reachable from off-host.
- It is **unauthenticated**. Anything local that can write to the subject's
  ephemeral port can put text in front of the critic. Don't run gadfly on a
  shared machine without adding sender gating (see the
  [channels reference](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)).
- Critiques stay in the critic's terminal. Nothing is sent back to the
  subject. (Two-way relay is a possible future extension.)
