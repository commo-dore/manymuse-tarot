// Phase 5.66 iter 3 — Captain chat backend.
//
// Lightweight Anthropic Messages-API client for the embedded Captain
// chat panel. State is persisted per-handoff under docs/handoff/.chat/
// (gitignored). The system prompt is captain-persona.md verbatim;
// the handoff body is prepended to the first user turn so Captain
// reads it as Phase 1 input.
//
// Public surface (used by handoff-viewer.js):
//   loadHistory(filename)              → { messages: [...] } | null
//   saveHistory(filename, messages)    → void
//   clearHistory(filename)             → void
//   sendMessage({ filename, handoffBody, message, opts? })
//                                       → { reply, history }
//   generateFinalReply({ filename, handoffBody, opts? })
//                                       → { reply, finalReply, history }
//
// Each message in `messages` is { role: 'user' | 'assistant', content: '...' }.
// The state JSON is just `{ messages: [...] }` so future fields can slot in
// without a schema migration.

const fs = require('fs')
const path = require('path')

const STATE_DIR = path.resolve(__dirname, '..', 'docs', 'handoff', '.chat')
const PERSONA_PATH = path.resolve(__dirname, 'captain-persona.md')

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
// Latest stable Sonnet at time of writing (2026-06-10). Override via
// CAPTAIN_MODEL env var to test newer/older snapshots without code
// changes. Old default was 'claude-sonnet-4-5-20250929' which may have
// been deprecated — caused 404 responses from Anthropic and silently
// failed the Generate Final Reply path in the viewer.
const DEFAULT_MODEL = process.env.CAPTAIN_MODEL || 'claude-sonnet-4-6'
const DEFAULT_MAX_TOKENS = parseInt(process.env.CAPTAIN_MAX_TOKENS || '4096', 10)

// ----- persistence -----

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
}

function statePath(filename) {
  // Strip ../ defensively; same whitelist as the viewer's isSafeFilename
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(filename)) {
    throw new Error('bad filename')
  }
  return path.join(STATE_DIR, filename.replace(/\.md$/, '.json'))
}

function loadHistory(filename) {
  try {
    const full = statePath(filename)
    if (!fs.existsSync(full)) return null
    const raw = fs.readFileSync(full, 'utf8')
    const j = JSON.parse(raw)
    if (!Array.isArray(j.messages)) return null
    return { messages: j.messages }
  } catch {
    return null
  }
}

function saveHistory(filename, messages) {
  ensureStateDir()
  const full = statePath(filename)
  fs.writeFileSync(full, JSON.stringify({ messages }, null, 2), 'utf8')
}

function clearHistory(filename) {
  try { fs.unlinkSync(statePath(filename)) } catch {}
}

// ----- system prompt -----

let _personaCache = null
function loadPersona() {
  if (_personaCache != null) return _personaCache
  try {
    _personaCache = fs.readFileSync(PERSONA_PATH, 'utf8')
  } catch {
    _personaCache = 'You are Captain — a strategic advisor sitting between an engineer and a CEO.'
  }
  return _personaCache
}

// ----- Anthropic call -----

async function callAnthropic({ messages, system, model, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in environment')
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
      system,
      messages,
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 500)}`)
  }
  const j = await res.json()
  // Anthropic responses: content is an array of { type, text } blocks.
  // We only want the text concatenated.
  const text = (j.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return text.trim()
}

// Streaming version. onDelta(text) fires for each token block as it
// arrives. Returns the final accumulated text. Throws on non-2xx or
// network error. Server-sent-events from Anthropic look like:
//   event: content_block_delta
//   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
//
//   event: message_stop
//   data: {"type":"message_stop"}
async function streamAnthropic({ messages, system, model, maxTokens, onDelta }) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in environment')
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
      system,
      messages,
      stream: true,
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 500)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let acc = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE events are double-newline separated.
    const events = buf.split('\n\n')
    buf = events.pop() // last fragment may be incomplete
    for (const evt of events) {
      // each event is `event: foo\ndata: <json>` lines.
      const lines = evt.split('\n')
      let data = ''
      for (const line of lines) {
        if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) continue
      try {
        const j = JSON.parse(data)
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
          const t = j.delta.text || ''
          if (t) {
            acc += t
            if (onDelta) onDelta(t)
          }
        }
        // ignore other event types (message_start, content_block_start, ping, etc.)
      } catch {
        // bad JSON — Anthropic sometimes sends keep-alive pings without data
      }
    }
  }
  return acc.trim()
}

// ----- send / generate -----

function buildFirstUserTurn(handoffBody) {
  // The handoff is what Captain reads in Phase 1. Wrap it so Captain
  // sees clearly that this is the engineer's handoff and not a CEO
  // message.
  return `Engineer just shipped this handoff. Read it and follow the Phase 1 protocol in your persona (your read + Captain's Concerns + Questions for the CEO + On the horizon, each only when there's something to add). The CEO is about to review.

---

${handoffBody}`
}

async function sendMessage({ filename, handoffBody, message, opts = {} }) {
  const existing = loadHistory(filename)
  const messages = existing ? existing.messages.slice() : []
  if (messages.length === 0) {
    // First turn — engineer's handoff is the system context the CEO
    // already saw. Build the first user turn as the read-instruction.
    messages.push({ role: 'user', content: buildFirstUserTurn(handoffBody) })
    if (message && message.trim().length > 0) {
      // The CEO already typed something before Captain's first turn —
      // append it as a second user turn so Captain knows.
      // (Anthropic accepts consecutive user messages.)
      messages.push({ role: 'user', content: message })
    }
  } else {
    if (!message || message.trim().length === 0) {
      throw new Error('empty message')
    }
    messages.push({ role: 'user', content: message })
  }
  const reply = await callAnthropic({
    system: loadPersona(),
    messages,
    model: opts.model,
    maxTokens: opts.maxTokens,
  })
  messages.push({ role: 'assistant', content: reply })
  saveHistory(filename, messages)
  return { reply, history: messages }
}

async function generateFinalReply({ filename, handoffBody, opts = {} }) {
  // Phase 3 trigger. Per the persona, Captain only generates the final
  // reply on an explicit signal — we use the literal string the persona
  // names: GENERATE_FINAL_REPLY.
  const existing = loadHistory(filename)
  const messages = existing ? existing.messages.slice() : []
  if (messages.length === 0) {
    // Edge case: CEO hits Generate before any chat. Seed first turn so
    // Captain has read the handoff, then issue the trigger.
    messages.push({ role: 'user', content: buildFirstUserTurn(handoffBody) })
  }
  messages.push({
    role: 'user',
    content: 'GENERATE_FINAL_REPLY. Output the paste-back prompt for the engineer per Phase 3 of your persona, starting with the literal `**FINAL REPLY TO ENGINEER:**` header.',
  })
  const reply = await callAnthropic({
    system: loadPersona(),
    messages,
    model: opts.model,
    maxTokens: opts.maxTokens,
  })
  messages.push({ role: 'assistant', content: reply })
  saveHistory(filename, messages)
  // Extract the body after the **FINAL REPLY TO ENGINEER:** header.
  const finalReply = extractFinalReply(reply)
  return { reply, finalReply, history: messages }
}

function extractFinalReply(text) {
  // Tolerant: match `**FINAL REPLY TO ENGINEER:**` (case-insensitive,
  // various amounts of whitespace). Return everything after, trimmed.
  // If not found, return the whole reply trimmed (graceful — Captain
  // might have phrased the header differently and we'd rather drop
  // something into the textarea than nothing).
  const m = text.match(/\*\*\s*FINAL\s+REPLY\s+TO\s+ENGINEER\s*:?\s*\*\*\s*\n?/i)
  if (!m) return text.trim()
  return text.slice(m.index + m[0].length).trim()
}

// ----- streaming variants -----

async function streamMessage({ filename, handoffBody, message, onDelta, opts = {} }) {
  const existing = loadHistory(filename)
  const messages = existing ? existing.messages.slice() : []
  if (messages.length === 0) {
    messages.push({ role: 'user', content: buildFirstUserTurn(handoffBody) })
    if (message && message.trim().length > 0) {
      messages.push({ role: 'user', content: message })
    }
  } else {
    if (!message || message.trim().length === 0) {
      throw new Error('empty message')
    }
    messages.push({ role: 'user', content: message })
  }
  const reply = await streamAnthropic({
    system: loadPersona(),
    messages,
    model: opts.model,
    maxTokens: opts.maxTokens,
    onDelta,
  })
  messages.push({ role: 'assistant', content: reply })
  saveHistory(filename, messages)
  return { reply, history: messages }
}

async function streamGenerateFinalReply({ filename, handoffBody, onDelta, opts = {} }) {
  const existing = loadHistory(filename)
  const messages = existing ? existing.messages.slice() : []
  if (messages.length === 0) {
    messages.push({ role: 'user', content: buildFirstUserTurn(handoffBody) })
  }
  messages.push({
    role: 'user',
    content: 'GENERATE_FINAL_REPLY. Output the paste-back prompt for the engineer per Phase 3 of your persona, starting with the literal `**FINAL REPLY TO ENGINEER:**` header.',
  })
  const reply = await streamAnthropic({
    system: loadPersona(),
    messages,
    model: opts.model,
    maxTokens: opts.maxTokens,
    onDelta,
  })
  messages.push({ role: 'assistant', content: reply })
  saveHistory(filename, messages)
  return { reply, finalReply: extractFinalReply(reply), history: messages }
}

// ----- pre-generation (idempotent + in-flight lock) -----
//
// Fired by the viewer's fs.watch when a new handoff lands. Goal: when
// the CEO opens the page, Captain's Phase 1 turn is already done so
// there's no spinner. Idempotent: skips if history already exists.
// In-flight lock: dedupes against the page's auto-fire on first open
// in case both race.

const _inflight = new Map()

async function preGenerateFirstTurn({ filename, handoffBody, opts = {} }) {
  // Already in flight → return that promise so callers can await it
  // instead of starting a fresh call.
  if (_inflight.has(filename)) return _inflight.get(filename)
  // Already generated → no-op.
  const existing = loadHistory(filename)
  if (existing && existing.messages && existing.messages.length > 0) {
    return { reply: null, history: existing.messages, skipped: 'history exists' }
  }
  // Fire + register the promise so concurrent callers join in.
  const p = (async () => {
    try {
      const result = await sendMessage({ filename, handoffBody, message: '', opts })
      return result
    } finally {
      _inflight.delete(filename)
    }
  })()
  _inflight.set(filename, p)
  return p
}

// Get the in-flight promise (if any) for a filename. Used by the route
// handlers so the auto-fire POST can join the pre-gen call instead of
// firing a duplicate.
function inflightFor(filename) {
  return _inflight.get(filename) || null
}

module.exports = {
  loadHistory,
  saveHistory,
  clearHistory,
  sendMessage,
  generateFinalReply,
  streamMessage,
  streamGenerateFinalReply,
  preGenerateFirstTurn,
  inflightFor,
  extractFinalReply, // exported for tests
}
