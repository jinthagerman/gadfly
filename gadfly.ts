#!/usr/bin/env bun
// gadfly — a Claude Code channel that relays assistant responses from one
// Claude Code session into another, so the second session can react as a
// devil's advocate (or whatever persona the user configures).
//
// Architecture: Instance A has a Stop hook that POSTs its last assistant
// message to this server on 127.0.0.1:8788. This server then emits a
// `notifications/claude/channel` event to Instance B (which spawned it
// as a stdio subprocess), and Instance B reacts in its own terminal.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
      // stderr is captured by Claude Code's debug log, stdout is reserved for MCP
      console.error(`[gadfly] failed to load gadfly.config.json: ${(err as Error).message}`)
    }
  }

  return { text: DEFAULT_PERSONALITY, source: 'built-in default' }
}

const { text: personality, source: personalitySource } = loadPersonality()
console.error(`[gadfly] personality loaded from: ${personalitySource}`)

// --- MCP server -------------------------------------------------------------

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

// --- HTTP listener ----------------------------------------------------------
// Localhost-only. The Stop hook from Instance A POSTs last_assistant_message
// to `/`, and we forward it to Instance B as a channel notification.

const PORT = Number(process.env.GADFLY_PORT ?? 8788)

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response('ok')
    }

    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }

    const body = await req.text()
    if (!body.trim()) return new Response('empty', { status: 400 })

    // Meta keys must be identifiers (letters, digits, underscores) per the
    // channels reference — anything else is silently dropped by Claude Code.
    const meta: Record<string, string> = {}
    const sourceSession = req.headers.get('X-Source-Session')
    if (sourceSession) meta.source_session = sourceSession.replace(/[^A-Za-z0-9_]/g, '_')

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: body, meta },
    })

    return new Response('ok')
  },
})

console.error(`[gadfly] listening on http://127.0.0.1:${PORT}`)
