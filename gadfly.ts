#!/usr/bin/env bun
// gadfly — a Claude Code channel that relays assistant responses from one
// Claude Code session into another, so the second session can react as a
// devil's advocate (or whatever persona the user configures).
//
// Both sessions launch Claude Code identically. Each spawned gadfly races
// for a PID-file lock at ~/.cache/gadfly/subject.lock:
//
//   * Winner = subject side. Runs an HTTP server on an ephemeral port,
//     accepts POSTs from its session's Stop hook on /publish, and broadcasts
//     them to all connected critics over an SSE stream on /events. Writes
//     {claude_pid, gadfly_pid, port} to ~/.cache/gadfly/subject.json so the
//     Stop hook and any critics can find it. Does NOT call mcp.notification —
//     events that arrive from its own session are forwarded out, not back in.
//
//   * Loser = critic side. Reads subject.json, opens an SSE connection to
//     the subject's /events, and forwards each message into its own MCP
//     session as a notifications/claude/channel event. Exits when the SSE
//     stream closes (the subject died).
//
// The Stop hook walks its own process tree to find its claude ancestor and
// only fires if that PID matches subject.json's claude_pid. This is what
// stops critics from feeding their reactions back into the loop.

import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// --- Personality loading ----------------------------------------------------
// Priority: GADFLY_PERSONALITY env > config.personalityFile > config.personality > built-in default.

const HERE = dirname(fileURLToPath(import.meta.url))

const DEFAULT_PERSONALITY =
  "You are a devil's advocate. Identify the strongest counter-arguments, hidden " +
  'assumptions, unstated trade-offs, and failure modes in the response. Be specific ' +
  'and concrete — cite exact claims. Do not be contrarian for its own sake: if a ' +
  'response is genuinely sound, say so briefly and move on.'

const PREAMBLE =
  'Events on this channel arrive as <channel source="gadfly" ...> tags and contain ' +
  'raw assistant responses from another Claude Code session. Read each event and ' +
  'write your reaction to your terminal. Do not call tools in response to channel ' +
  'events. Your persona for these reactions is defined below:\n\n---\n\n'

function loadPersonality(): { text: string; source: string } {
  const envVal = process.env.GADFLY_PERSONALITY
  if (envVal && envVal.trim()) {
    return { text: envVal.trim(), source: 'GADFLY_PERSONALITY env' }
  }

  const configPath = resolve(HERE, 'gadfly.config.json')
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
        personality?: string
        personalityFile?: string
      }
      if (cfg.personalityFile) {
        const filePath = resolve(HERE, cfg.personalityFile)
        if (existsSync(filePath)) {
          const text = readFileSync(filePath, 'utf8').trim()
          if (text) return { text, source: `file ${cfg.personalityFile}` }
        }
      }
      if (cfg.personality && cfg.personality.trim()) {
        return { text: cfg.personality.trim(), source: 'config.personality' }
      }
    } catch (err) {
      console.error(`[gadfly] failed to load gadfly.config.json: ${(err as Error).message}`)
    }
  }

  return { text: DEFAULT_PERSONALITY, source: 'built-in default' }
}

// --- Runtime paths ----------------------------------------------------------

const RUNTIME_DIR = join(homedir(), '.cache', 'gadfly')
const LOCK_PATH = join(RUNTIME_DIR, 'subject.lock')
const SUBJECT_JSON_PATH = join(RUNTIME_DIR, 'subject.json')
mkdirSync(RUNTIME_DIR, { recursive: true })

// --- PID-file lock ----------------------------------------------------------
// Acquire by O_CREAT|O_EXCL on subject.lock. On contention, read the PID
// inside, kill(pid, 0) to test liveness; if dead, unlink and retry once.
// Returns true if we acquired, false if a live holder exists.

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    // ESRCH = no such process; EPERM = exists but we can't signal it (still alive)
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function tryAcquireLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_PATH, 'wx') // O_CREAT | O_EXCL
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Lock exists. Is the holder alive?
      try {
        const holderPid = Number(readFileSync(LOCK_PATH, 'utf8').trim())
        if (isAlive(holderPid)) return false
        // Stale lock — remove and retry once.
        unlinkSync(LOCK_PATH)
        continue
      } catch {
        // Race: someone else cleaned it up. Retry.
        continue
      }
    }
  }
  return false
}

function releaseLock(): void {
  try {
    const holderPid = Number(readFileSync(LOCK_PATH, 'utf8').trim())
    if (holderPid === process.pid) unlinkSync(LOCK_PATH)
  } catch {
    /* nothing to release */
  }
}

function cleanupSubjectJson(): void {
  try {
    const cur = JSON.parse(readFileSync(SUBJECT_JSON_PATH, 'utf8')) as { gadfly_pid?: number }
    if (cur.gadfly_pid === process.pid) unlinkSync(SUBJECT_JSON_PATH)
  } catch {
    /* nothing to clean */
  }
}

function readSubjectJson(): { claude_pid: number; gadfly_pid: number; port: number } | null {
  try {
    const raw = JSON.parse(readFileSync(SUBJECT_JSON_PATH, 'utf8')) as {
      claude_pid: number
      gadfly_pid: number
      port: number
    }
    if (!isAlive(raw.gadfly_pid)) return null
    return raw
  } catch {
    return null
  }
}

// --- MCP server -------------------------------------------------------------

const { text: personality, source: personalitySource } = loadPersonality()

const mcp = new Server(
  { name: 'gadfly', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions: PREAMBLE + personality,
  },
)

await mcp.connect(new StdioServerTransport())

// --- Race for the role ------------------------------------------------------

const acquired = tryAcquireLock()
const role: 'subject' | 'critic' = acquired ? 'subject' : 'critic'

console.error(`[gadfly] role=${role} pid=${process.pid} personality=${personalitySource}`)

// Ensure cleanup runs on the common exit paths.
function shutdown(reason: string): never {
  console.error(`[gadfly] shutting down: ${reason}`)
  if (role === 'subject') {
    cleanupSubjectJson()
    releaseLock()
  }
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('beforeExit', () => {
  if (role === 'subject') {
    cleanupSubjectJson()
    releaseLock()
  }
})

// --- Subject side -----------------------------------------------------------
// Tiny HTTP server: POST /publish forwards a message to all SSE subscribers,
// GET /events is the SSE stream critics connect to.

if (role === 'subject') {
  type Subscriber = (frame: string) => void
  const subscribers = new Set<Subscriber>()

  function broadcast(payload: { content: string; sourceSession: string }) {
    // SSE frame: each data: line, terminated by a blank line.
    const json = JSON.stringify(payload)
    const frame = `data: ${json}\n\n`
    for (const sub of subscribers) sub(frame)
  }

  const server = Bun.serve({
    port: 0, // ephemeral
    hostname: '127.0.0.1',
    idleTimeout: 0, // don't close idle SSE streams
    async fetch(req) {
      const url = new URL(req.url)

      if (req.method === 'GET' && url.pathname === '/health') {
        return new Response('ok')
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        const stream = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(': connected\n\n')
            const sub: Subscriber = chunk => {
              try {
                ctrl.enqueue(chunk)
              } catch {
                subscribers.delete(sub)
              }
            }
            subscribers.add(sub)
            req.signal.addEventListener('abort', () => subscribers.delete(sub))
          },
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      }

      if (req.method === 'POST' && url.pathname === '/publish') {
        const body = await req.text()
        if (!body.trim()) return new Response('empty', { status: 400 })
        const sourceSession = (req.headers.get('X-Source-Session') ?? '').replace(
          /[^A-Za-z0-9_]/g,
          '_',
        )
        broadcast({ content: body, sourceSession })
        return new Response('ok')
      }

      return new Response('not found', { status: 404 })
    },
  })

  // ppid is our claude parent — we want the hook to compare against this.
  const claudePid = process.ppid
  const subjectInfo = {
    claude_pid: claudePid,
    gadfly_pid: process.pid,
    port: server.port,
  }
  writeFileSync(SUBJECT_JSON_PATH, JSON.stringify(subjectInfo, null, 2))
  console.error(
    `[gadfly] subject ready on http://127.0.0.1:${server.port} (claude_pid=${claudePid})`,
  )
}

// --- Critic side ------------------------------------------------------------
// Open SSE connection to the subject and forward each event into MCP.
// Exit when the stream closes (subject died).

if (role === 'critic') {
  const subject = readSubjectJson()
  if (!subject) {
    console.error('[gadfly] critic: no live subject found in subject.json; exiting')
    process.exit(0)
  }

  const url = `http://127.0.0.1:${subject.port}/events`
  console.error(`[gadfly] critic: connecting to ${url}`)

  let cancelled = false
  process.on('SIGTERM', () => {
    cancelled = true
  })
  process.on('SIGINT', () => {
    cancelled = true
  })

  try {
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) {
      console.error(`[gadfly] critic: bad response ${res.status}; exiting`)
      process.exit(0)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (!cancelled) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // Split into SSE events on blank lines.
      let sep
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        // We only care about `data: <json>` lines (skip the `: connected` comment).
        const dataLines = event
          .split('\n')
          .filter(l => l.startsWith('data: '))
          .map(l => l.slice(6))
        if (dataLines.length === 0) continue
        try {
          const payload = JSON.parse(dataLines.join('\n')) as {
            content: string
            sourceSession: string
          }
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: payload.content,
              meta: payload.sourceSession ? { source_session: payload.sourceSession } : {},
            },
          })
        } catch (err) {
          console.error(`[gadfly] critic: bad SSE payload: ${(err as Error).message}`)
        }
      }
    }
  } catch (err) {
    console.error(`[gadfly] critic: SSE connection failed: ${(err as Error).message}`)
  }

  console.error('[gadfly] critic: subject stream closed; exiting')
  process.exit(0)
}
