# gadfly

A [Claude Code channel](https://code.claude.com/docs/en/channels-reference) that
forwards every assistant turn from one Claude Code session into a *second*
Claude Code session, where it gets read by a configurable persona — by default
a devil's advocate — that pushes back on it.

No API keys, no separate model: the critic is just another Claude Code
instance, primed by the channel's `instructions` block.

```
 ┌──────────────────────────┐                       ┌──────────────────────────┐
 │ Claude Code Instance A   │                       │ Claude Code Instance B   │
 │ (the one being critiqued)│                       │ (devil's advocate)       │
 │                          │   POST localhost:8788 │                          │
 │ Stop hook fires after ───┼───────────────────▶   │ gadfly MCP server        │
 │ every assistant turn     │   last_assistant_msg  │   │                      │
 │                          │                       │   ▼                      │
 │                          │                       │ <channel> tag lands in   │
 │                          │                       │ B's context, B reacts    │
 │                          │                       │ in its own terminal      │
 └──────────────────────────┘                       └──────────────────────────┘
```

## Requirements

- [Bun](https://bun.sh)
- `jq` (used by the Stop hook)
- Claude Code v2.1.80 or later, signed in with claude.ai (channels do not
  work with API key auth)
- On Team / Enterprise plans, an admin must
  [enable channels](https://code.claude.com/docs/en/channels#enterprise-controls)

## Install

```bash
cd /path/to/gadfly
bun install
```

## Use

### 1. Start the critic (Instance B)

```bash
cd /path/to/gadfly
claude --dangerously-load-development-channels server:gadfly
```

The dev flag is required throughout the channels research preview because
custom channels aren't on the Anthropic-curated allowlist.

In that Claude session, run `/mcp` to confirm `gadfly` shows as connected.
Leave this terminal open — this is where critiques will appear.

### 2. Wire the Stop hook into the session you want critiqued (Instance A)

Add this to `~/.claude/settings.json` (or a project-level
`.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "/path/to/gadfly/hooks/stop-to-gadfly.sh",
        "timeout": 5
      }
    ]
  }
}
```

Now start a normal Claude Code session in any project. Every time it
finishes a turn, the Stop hook POSTs the assistant message to gadfly, and a
critique appears in Instance B's terminal a moment later.

If gadfly isn't running, the hook fails silently — it won't block your
session.

## Personalities

The critic's persona is set via the `instructions` field on the MCP server,
which Claude Code adds to the system prompt of Instance B. You can swap it
without touching code.

Loader priority (first one wins):

1. `GADFLY_PERSONALITY` environment variable
2. `personalityFile` field in `gadfly.config.json` (path to a text file)
3. `personality` field in `gadfly.config.json` (inline string)
4. Built-in default

A fixed preamble explaining the channel mechanics is *always* prepended, so
you can write a personality file that's purely about tone and focus —
nothing about `<channel>` tags or "don't call tools" needs to be in your
persona text.

### Switching personalities

Edit `gadfly.config.json`:

```json
{
  "personalityFile": "./personalities/pedant.md"
}
```

Then restart Instance B (the critic). The new persona takes effect on the
next channel event.

### Shipped examples

| File                              | Tone                                                  |
| --------------------------------- | ----------------------------------------------------- |
| `personalities/devils-advocate.md`| Pushback in good faith, strongest counter-argument    |
| `personalities/pedant.md`         | Three most likely production failure modes            |
| `personalities/optimist-check.md` | Sympathetic but rigorous; one biggest risk only       |

### Writing your own

Drop a `.md` (or `.txt`) file into `personalities/`, point `personalityFile`
at it, restart Instance B. The file is treated as raw text — no frontmatter,
no templating. Keep it focused on tone, format, and what to look for; the
preamble already handles the plumbing.

## Troubleshooting

**`/mcp` shows gadfly as "failed to connect"** — there's an import or
runtime error in `gadfly.ts`. Check `~/.claude/debug/<session-id>.txt` for
the stderr trace.

**Critique never appears in Instance B** — confirm Instance B is running
and `/mcp` shows gadfly connected. Then test gadfly in isolation by piping
a fake Stop payload through the hook script:

```bash
printf '{"last_assistant_message":"We should rewrite auth in Rust.","session_id":"test"}' \
  | /path/to/gadfly/hooks/stop-to-gadfly.sh
```

If that doesn't trigger Instance B, gadfly isn't bound — check
`lsof -i :8788`.

**`curl: connection refused` from the hook** — gadfly / Instance B isn't
running. The hook is designed to swallow this; your host session is fine.

**Stop hook never fires** — check the path in your `settings.json`, and
make sure the script is executable (`chmod +x hooks/stop-to-gadfly.sh`).

**Port 8788 already in use** — set `GADFLY_PORT=9999` in the environment
where you launch Instance B (and the same value for the hook script in
Instance A's settings if you use a non-default port).

## Security notes

- gadfly binds to `127.0.0.1` only. It is not reachable from off-host.
- It is **one-way and unauthenticated**. Anything that can write to
  `localhost:8788` on your machine can put text in front of Instance B.
  Don't run it on a shared machine without adding sender gating (see the
  [channels reference](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)).
- Critiques stay in Instance B's terminal. Nothing is sent back to
  Instance A. (Two-way relay is a possible future extension.)
