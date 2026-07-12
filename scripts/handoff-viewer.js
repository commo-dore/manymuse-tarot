#!/usr/bin/env node
// Phase 5.66 — manymuse-discover handoff viewer.
//
// Single-user rebuild of sproushi-ops-sandbox's multi-user viewer.
// Stripped: per-user auth, chat backend, Anthropic keys, per-user
// state dirs, git auto-poll. Kept: frontmatter parsing, search,
// category filter chips, time-ago cards, send-to-tmux button,
// analytics, /healthz.
//
//   node.exe scripts/handoff-viewer.js
//
// Binds to the Tailscale IPv4 from `tailscale.exe ip -4`, fallback
// 127.0.0.1 if Tailscale isn't running. Never 0.0.0.0 (would expose
// to every interface). Port 8081.
//
// URL pattern:
//   GET  /                  — index of handoffs (search + cat chips)
//   GET  /h/<filename>.md   — rendered handoff + Send-to-tmux form
//   GET  /<filename>.md     — same as /h/ above (legacy URL, preserves
//                             the notify-link convention in CLAUDE.md)
//   GET  /<filename>.html   — raw passthrough (rendered-HTML eyeball
//                             loop — preserves the existing URL
//                             pattern Captain reads on her phone)
//   GET  /analytics         — totals + per-author breakdown + cost
//   GET  /healthz           — { ok: true }
//   POST /api/send/<file>   — pipes textarea content into the
//                             engineer-tmux pane via send-to-engineer.sh

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execSync, execFile } = require('child_process')
const { splitFrontmatter } = require('./handoff-frontmatter')
const chat = require('./handoff-chat')

// Phase 5.66 iter 3 — minimal .env.local loader so node.exe sees
// ANTHROPIC_API_KEY without needing a Windows-side env var setup.
// Stdlib only. Honors existing process.env (existing wins).
function loadDotEnvLocal() {
  const envPath = path.resolve(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return
  try {
    const raw = fs.readFileSync(envPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      const k = m[1]
      if (k in process.env) continue
      let v = m[2]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      process.env[k] = v
    }
  } catch (e) {
    console.error(`[viewer] failed to load .env.local: ${e.message}`)
  }
}
loadDotEnvLocal()

const PORT = parseInt(process.env.PORT || '8081', 10)
const HANDOFF_DIR = path.resolve(__dirname, '..', 'docs', 'handoff')
const SEND_SCRIPT = path.resolve(__dirname, 'send-to-engineer.sh')
const TAILSCALE_BIN = process.env.TAILSCALE_BIN
  || (process.platform === 'win32'
    ? 'C:\\Program Files\\Tailscale\\tailscale.exe'
    : 'tailscale')

function tailscaleIp() {
  try {
    const cmd = process.platform === 'win32' ? `"${TAILSCALE_BIN}" ip -4` : `${TAILSCALE_BIN} ip -4`
    const out = execSync(cmd, { encoding: 'utf8' }).trim()
    const ip = out.split('\n')[0].trim()
    if (/^100\.\d+\.\d+\.\d+$/.test(ip)) return ip
  } catch {}
  return '127.0.0.1'
}

const BIND_HOST = tailscaleIp()

// ============================================================
// Category + author + hours metadata
// ============================================================

const CATEGORIES = ['feature', 'bugfix', 'infra', 'docs', 'investigation', 'decision', 'refactor']
const CATEGORY_LABELS = {
  feature: 'Feature',
  bugfix: 'Bug fix',
  infra: 'Infra / ops',
  docs: 'Docs / guide',
  investigation: 'Investigation',
  decision: 'Decision / preflight',
  refactor: 'Refactor',
}
const CATEGORY_COLORS = {
  feature: '#1565c0',
  bugfix: '#c62828',
  infra: '#6a1b9a',
  docs: '#00695c',
  investigation: '#ef6c00',
  decision: '#37474f',
  refactor: '#558b2f',
}
const CATEGORY_DEFAULT_HOURS = {
  feature: 4,
  bugfix: 2,
  infra: 3,
  docs: 1,
  investigation: 3,
  decision: 0.5,
  refactor: 2,
}

const SENIOR_DEV_HOURLY_RATE_USD = 35

function formatUsd(amount) {
  if (amount >= 1000) return `$${Math.round(amount).toLocaleString('en-US')}`
  if (amount >= 100) return `$${Math.round(amount)}`
  return `$${amount.toFixed(amount < 10 ? 2 : 0)}`
}

function formatHours(h) {
  if (h >= 10) return `${Math.round(h)} h`
  if (h >= 1) return `${h.toFixed(h % 1 === 0 ? 0 : 1)} h`
  return `${(h * 60).toFixed(0)} min`
}

function getCategoryFor(fm, title, body) {
  if (fm && typeof fm.category === 'string') {
    const c = fm.category.trim().toLowerCase()
    if (CATEGORIES.includes(c)) return c
  }
  // Heuristic fallback — same regex set as the sandbox reference,
  // adapted for manymuse vocabulary (phase numbering instead of D17b).
  const t = `${title} ${body.slice(0, 600)}`.toLowerCase()
  if (/\b(onboard|tester guide|setup guide|read this first|walkthrough|how-to)\b/.test(t)) return 'docs'
  if (/\b(preflight|ratify|recon|stop[- ]gate|option list|decision needed)\b/.test(t)) return 'decision'
  if (/\b(bugfix|broken|crashed|regression|reverted|hotfix)\b/.test(t)) return 'bugfix'
  if (/^fix\b|\bfix\(/.test(t)) return 'bugfix'
  if (/\b(deploy|nginx|systemd|provision|dns|cert|hetzner|tailscale|certbot|migration)\b/.test(t)) return 'infra'
  if (/\b(investigat|diagnostic|probe|trace|root cause|rca|reproduce)\b/.test(t)) return 'investigation'
  if (/\b(refactor|rename|cleanup|tidy|extract|consolidate)\b/.test(t)) return 'refactor'
  return 'feature'
}

function getHoursFor(fm, category) {
  if (fm && fm.senior_dev_hours != null) {
    const n = Number(fm.senior_dev_hours)
    if (Number.isFinite(n) && n >= 0) return { hours: n, estimated: false }
  }
  return { hours: CATEGORY_DEFAULT_HOURS[category] ?? 2, estimated: true }
}

function getAuthorFor(fm) {
  if (fm && typeof fm.author === 'string' && fm.author.trim()) {
    return fm.author.trim().toLowerCase()
  }
  // Single-user default — manymuse-discover is currently single-engineer.
  return 'engineer'
}

function summarisePeek(body) {
  const stripped = body
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > 200 ? stripped.slice(0, 200) + '…' : stripped
}

function extractTitle(body) {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ============================================================
// Handoff listing
// ============================================================

function listHandoffFiles() {
  try {
    return fs.readdirSync(HANDOFF_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort()
  } catch {
    return []
  }
}

function readHandoff(filename) {
  const full = path.join(HANDOFF_DIR, filename)
  if (!fs.existsSync(full)) return null
  const stat = fs.statSync(full)
  const raw = fs.readFileSync(full, 'utf8')
  const { fm, body } = splitFrontmatter(raw)
  const title = extractTitle(body) || filename.replace(/\.md$/, '')
  const category = getCategoryFor(fm, title, body)
  const { hours, estimated } = getHoursFor(fm, category)
  return {
    filename,
    fm,
    body,
    raw,
    mtime: stat.mtimeMs,
    size: stat.size,
    title,
    peek: summarisePeek(body),
    category,
    hours,
    hoursEstimated: estimated,
    author: getAuthorFor(fm),
    tmuxTarget: fm?.engineer?.tmux_target || null,
  }
}

function listHandoffs() {
  return listHandoffFiles()
    .map(readHandoff)
    .filter((h) => h !== null)
    .sort((a, b) => b.mtime - a.mtime)
}

// ============================================================
// Markdown render (subset)
// ============================================================

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(s) {
  s = escapeHtml(s)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  return s
}

function renderMarkdown(md) {
  const lines = md.split('\n')
  let html = ''
  let i = 0
  let para = []
  let inCode = false
  const flushPara = () => { if (para.length) { html += `<p>${renderInline(para.join(' '))}</p>`; para = [] } }
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      flushPara()
      if (inCode) { html += '</code></pre>'; inCode = false } else { html += '<pre><code>'; inCode = true }
      i++; continue
    }
    if (inCode) { html += escapeHtml(line) + '\n'; i++; continue }
    if (/^---+\s*$/.test(line)) { flushPara(); html += '<hr>'; i++; continue }
    let m
    if ((m = line.match(/^(#{1,6})\s+(.+)$/))) {
      flushPara()
      html += `<h${m[1].length}>${renderInline(m[2])}</h${m[1].length}>`
      i++; continue
    }
    if (/^>\s+/.test(line)) {
      flushPara()
      html += `<blockquote>${renderInline(line.replace(/^>\s+/, ''))}</blockquote>`
      i++; continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara()
      let listHtml = '<ul>'
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        listHtml += `<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`
        i++
      }
      listHtml += '</ul>'
      html += listHtml
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      let listHtml = '<ol>'
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        listHtml += `<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`
        i++
      }
      listHtml += '</ol>'
      html += listHtml
      continue
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[-:|\s]+\|\s*$/.test(lines[i + 1])) {
      flushPara()
      const tableLines = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { tableLines.push(lines[i]); i++ }
      if (tableLines.length >= 2) {
        const split = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        const head = split(tableLines[0])
        const body = tableLines.slice(2).map(split)
        let t = '<table><thead><tr>'
        for (const c of head) t += `<th>${renderInline(c)}</th>`
        t += '</tr></thead><tbody>'
        for (const r of body) {
          t += '<tr>'
          for (const c of r) t += `<td>${renderInline(c)}</td>`
          t += '</tr>'
        }
        t += '</tbody></table>'
        html += t
      }
      continue
    }
    if (line.trim() === '') { flushPara(); i++; continue }
    para.push(line)
    i++
  }
  flushPara()
  if (inCode) html += '</code></pre>'
  return html
}

// ============================================================
// CSS
// ============================================================

const CSS = `
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 880px; margin: 0 auto; padding: 1rem; line-height: 1.5; color: #1c1c1c; }
header { display: flex; align-items: center; gap: 1rem; padding-bottom: 0.8rem; border-bottom: 1px solid #ddd; margin-bottom: 1rem; flex-wrap: wrap; }
header h1 { font-size: 1.2rem; margin: 0; flex: 1; }
.tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
.tab { padding: 0.4rem 0.8rem; border: 1px solid #ccc; border-radius: 4px; text-decoration: none; color: inherit; font-size: 0.9rem; }
.tab.active { background: #1c1c1c; color: white; border-color: #1c1c1c; }
.search { width: 100%; padding: 0.5rem 0.7rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95rem; margin-bottom: 0.8rem; }
.cat-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1rem; }
.chip { padding: 0.25rem 0.55rem; border: 1px solid #999; border-radius: 999px; font-size: 0.8rem; text-decoration: none; color: inherit; }
.chip.active { color: #fff; }
.handoff-card { border: 1px solid #ddd; border-radius: 6px; padding: 0.7rem 0.9rem; margin-bottom: 0.6rem; transition: border-color 0.1s; }
.handoff-card:hover { border-color: #aaa; }
.handoff-card a { text-decoration: none; color: inherit; display: block; }
.handoff-card .meta { font-size: 0.72rem; color: #666; margin-bottom: 0.35rem; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.handoff-card .meta .author { background: #efefef; padding: 1px 6px; border-radius: 3px; font-weight: 500; }
.handoff-card .meta .filename { color: #999; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.7rem; }
.handoff-card .meta .when { color: #999; }
.handoff-card .badge { padding: 1px 6px; border-radius: 3px; font-size: 0.68rem; font-weight: 600; border: 1px solid; background: #fff; }
.handoff-card .badge.hours { color: #1b5e20; border-color: #1b5e20; }
.handoff-card .title { font-weight: 600; font-size: 0.98rem; margin-bottom: 0.3rem; }
.handoff-card .peek { font-size: 0.84rem; color: #555; }
.empty { padding: 2rem; text-align: center; color: #888; }
pre { background: #f5f5f5; padding: 0.7rem; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; }
code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
table { border-collapse: collapse; margin: 1rem 0; width: 100%; font-size: 0.9rem; }
th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f5f5f5; }
blockquote { border-left: 4px solid #ccc; margin-left: 0; padding-left: 1rem; color: #555; }
hr { border: 0; border-top: 1px solid #ddd; margin: 1.5rem 0; }
a { color: #0a66c2; }
.send-card { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin-top: 2rem; background: #fafafa; }
.send-card h2 { margin-top: 0; font-size: 1rem; }
.send-card textarea { width: 100%; min-height: 9rem; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; resize: vertical; }
.send-card button { margin-top: 0.6rem; padding: 0.6rem 1rem; background: #1c1c1c; color: #fff; border: 0; border-radius: 4px; font-size: 0.95rem; cursor: pointer; }
.send-card button:disabled { background: #888; cursor: not-allowed; }
.send-card .target { font-size: 0.8rem; color: #666; margin-bottom: 0.5rem; }
.send-card .status { font-size: 0.85rem; margin-top: 0.5rem; min-height: 1.2em; }
.send-card .status.ok { color: #1b5e20; }
.send-card .status.err { color: #c62828; }
.send-card .missing-target { color: #c62828; font-size: 0.85rem; background: #fff3f3; border: 1px solid #f6caca; padding: 0.5rem 0.7rem; border-radius: 4px; }
.chat-card { border: 1px solid #ddd; border-radius: 6px; padding: 0.9rem; margin-top: 1.5rem; background: #fafafa; }
.chat-card h2 { margin: 0 0 0.5rem; font-size: 1rem; }
.chat-thread { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.8rem; }
.chat-msg { padding: 0.55rem 0.75rem; border-radius: 8px; font-size: 0.92rem; line-height: 1.45; position: relative; }
.chat-msg.user { background: #e3f2fd; align-self: flex-end; max-width: 90%; }
.chat-msg.assistant { background: #fff; border: 1px solid #e0e0e0; max-width: 95%; padding-top: 1.6rem; }
.chat-msg.assistant strong { color: #1c1c1c; }
.chat-msg-copy { position: absolute; top: 0.3rem; right: 0.4rem; padding: 0.2rem 0.55rem; border: 1px solid #d0d7e2; background: #f4f7fb; border-radius: 4px; font-size: 0.75rem; cursor: pointer; color: #0a66c2; }
.chat-msg-copy:hover { background: #e1ecf7; }
.chat-msg-copy.copied { background: #2e7d32; color: #fff; border-color: #2e7d32; }
.chat-msg h1, .chat-msg h2, .chat-msg h3, .chat-msg h4 { margin: 0.5rem 0 0.3rem; font-size: 0.95rem; }
.chat-msg ul, .chat-msg ol { margin: 0.3rem 0 0.3rem 1.2rem; padding: 0; }
.chat-msg p { margin: 0.3rem 0; }
.chat-msg code { font-size: 0.86em; }
.chat-msg pre { background: #f5f5f5; padding: 0.5rem; border-radius: 4px; font-size: 0.82rem; overflow-x: auto; margin: 0.4rem 0; }
.chat-options { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.35rem 0; }
.chat-option { padding: 0.4rem 0.7rem; border: 1px solid #1c1c1c; border-radius: 999px; background: #fff; font-size: 0.85rem; cursor: pointer; }
.chat-option:hover { background: #1c1c1c; color: #fff; }
.chat-pills-wrap { border: 1px solid #d0d7e2; border-radius: 6px; padding: 0.55rem 0.7rem; background: #f4f7fb; }
.chat-pills-label { font-size: 0.72rem; color: #5a6470; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.35rem; }
.chat-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.chat-pill { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.55rem 0.25rem 0.7rem; border-radius: 999px; background: #1565c0; color: #fff; font-size: 0.84rem; }
.chat-pill .pill-x { display: inline-flex; align-items: center; justify-content: center; width: 1.1rem; height: 1.1rem; border-radius: 999px; background: rgba(255,255,255,0.25); color: #fff; border: 0; font-size: 0.85rem; cursor: pointer; padding: 0; line-height: 1; }
.chat-pill .pill-x:hover { background: rgba(255,255,255,0.5); color: #0b3d80; }
.chat-input-wrap { display: flex; flex-direction: column; gap: 0.5rem; }
.chat-input { width: 100%; min-height: 4.5rem; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; font-size: 0.9rem; resize: vertical; }
.chat-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.chat-actions button { padding: 0.55rem 0.9rem; border-radius: 4px; border: 0; font-size: 0.9rem; cursor: pointer; }
.chat-actions .send { background: #1c1c1c; color: #fff; }
.chat-actions .generate { background: #1b5e20; color: #fff; }
.chat-actions .reset { background: #fff; color: #c62828; border: 1px solid #c62828; }
.chat-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.chat-status { font-size: 0.82rem; color: #666; margin-left: auto; min-height: 1.2em; }
.chat-status.err { color: #c62828; }
.chat-empty { color: #888; font-size: 0.88rem; padding: 0.8rem; text-align: center; }
.chat-loading { color: #888; font-size: 0.88rem; padding: 0.5rem 0; }
.copy-bar { position: sticky; top: 0; z-index: 10; background: #fff; padding: 0.5rem 0; margin: 0 0 0.6rem; border-bottom: 1px solid #eee; }
.copy-btn { padding: 0.6rem 1rem; font-size: 0.92rem; font-weight: 600; color: #fff; background: #0a66c2; border: 0; border-radius: 4px; cursor: pointer; }
.copy-btn:active { background: #084d92; }
.copy-btn.copied { background: #2e7d32; }
.analytics-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.6rem; margin-bottom: 1.2rem; }
.analytics-tile { border: 1px solid #ddd; border-radius: 6px; padding: 0.8rem; background: #fff; }
.analytics-tile .n { font-size: 1.5rem; font-weight: 700; }
.analytics-tile .lab { font-size: 0.78rem; color: #666; }
.cat-row { display: flex; align-items: center; gap: 0.4rem; margin: 0.25rem 0; font-size: 0.86rem; }
.cat-bar { height: 14px; border-radius: 3px; min-width: 1px; }
.cat-row .label { width: 7.5rem; }
.cat-row .count { color: #666; font-size: 0.78rem; }
.note { font-size: 0.78rem; color: #888; margin-top: 1.5rem; padding-top: 0.8rem; border-top: 1px solid #eee; }
`

// ============================================================
// Pages
// ============================================================

function layout(title, body) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head><body>
${body}
</body></html>`
}

function tabsHtml(active) {
  return `<div class="tabs">
  <a class="tab${active === 'list' ? ' active' : ''}" href="/">Handoffs</a>
  <a class="tab${active === 'analytics' ? ' active' : ''}" href="/analytics">📊 Analytics</a>
</div>`
}

function indexPage({ q, cat }) {
  const all = listHandoffs()
  let items = all
  if (cat && CATEGORIES.includes(cat)) {
    items = items.filter((h) => h.category === cat)
  }
  if (q) {
    const needle = q.toLowerCase()
    items = items.filter((h) =>
      h.title.toLowerCase().includes(needle) ||
      h.body.toLowerCase().includes(needle) ||
      h.filename.toLowerCase().includes(needle) ||
      h.author.toLowerCase().includes(needle) ||
      h.category.toLowerCase().includes(needle))
  }

  const qParam = q ? `&q=${encodeURIComponent(q)}` : ''

  // Counts (after q filter, across all categories) for chip badges.
  const countByCat = {}
  for (const c of CATEGORIES) countByCat[c] = 0
  const itemsForChips = q
    ? all.filter((h) =>
        h.title.toLowerCase().includes(q.toLowerCase()) ||
        h.body.toLowerCase().includes(q.toLowerCase()) ||
        h.filename.toLowerCase().includes(q.toLowerCase()) ||
        h.author.toLowerCase().includes(q.toLowerCase()) ||
        h.category.toLowerCase().includes(q.toLowerCase()))
    : all
  for (const h of itemsForChips) countByCat[h.category] = (countByCat[h.category] || 0) + 1

  const chips = `<div class="cat-chips">
    <a class="chip${!cat ? ' active' : ''}" href="/?cat=${qParam.slice(1)}"
       style="color:#1c1c1c; border-color:#1c1c1c; ${!cat ? 'background:#1c1c1c; color:#fff;' : ''}">
       All categories (${itemsForChips.length})
    </a>
    ${CATEGORIES.map((c) => {
      const isActive = cat === c
      const color = CATEGORY_COLORS[c]
      return `<a class="chip${isActive ? ' active' : ''}" href="/?cat=${c}${qParam}"
        style="color:${isActive ? '#fff' : color}; border-color:${color}; ${isActive ? `background:${color};` : ''}">
        ${CATEGORY_LABELS[c]} (${countByCat[c] || 0})
      </a>`
    }).join('')}
  </div>`

  const cards = items.length === 0
    ? `<div class="empty">No handoffs match.</div>`
    : items.map((h) => `
      <div class="handoff-card">
        <a href="/h/${encodeURIComponent(h.filename)}">
          <div class="meta">
            <span class="author">${escapeHtml(h.author)}</span>
            <span class="filename">${escapeHtml(h.filename)}</span>
            <span class="when">${timeAgo(h.mtime)}</span>
            <span class="badge" style="color:${CATEGORY_COLORS[h.category]}; border-color:${CATEGORY_COLORS[h.category]};">
              ${CATEGORY_LABELS[h.category]}
            </span>
            <span class="badge hours">
              ${formatHours(h.hours)} · ${formatUsd(h.hours * SENIOR_DEV_HOURLY_RATE_USD)}${h.hoursEstimated ? ' (est.)' : ''}
            </span>
          </div>
          <div class="title">${escapeHtml(h.title)}</div>
          <div class="peek">${escapeHtml(h.peek)}</div>
        </a>
      </div>`).join('')

  const body = `
    <header>
      <h1>manymuse handoffs</h1>
      <span class="when" style="font-size:0.78rem; color:#888;">${all.length} total</span>
    </header>
    ${tabsHtml('list')}
    <form method="get" action="/" style="display:flex; gap:0.5rem;">
      <input class="search" type="search" name="q" value="${escapeHtml(q || '')}" placeholder="Search title, body, filename, author, category…">
      ${cat ? `<input type="hidden" name="cat" value="${escapeHtml(cat)}">` : ''}
    </form>
    ${chips}
    ${cards}
  `
  return layout('Captain handoffs', body)
}

function handoffPage(h) {
  // h.effectiveTmux = { target, source } from resolveTmuxTarget(), or null.
  const et = h.effectiveTmux || (h.tmuxTarget ? { target: h.tmuxTarget, source: 'frontmatter' } : null)
  const sourceLabel = et && et.source !== 'frontmatter' ? ` <span style="color:#888;">(${et.source === 'env' ? 'from env' : 'auto-detected'})</span>` : ''
  const tmuxTargetBlock = et
    ? `<div class="target">→ tmux: <code>${escapeHtml(et.target)}</code>${sourceLabel}</div>`
    : `<div class="missing-target">⚠ No tmux target: no <code>engineer.tmux_target</code> frontmatter, no <code>HANDOFF_TMUX_TARGET</code> env, and no claude pane found in the <code>${escapeHtml(TMUX_SESSION)}</code> tmux session.</div>`

  const rawJson = JSON.stringify(h.raw).replace(/<\//g, '<\\/')
  const body = `
    <header>
      <h1 style="font-size:1.05rem; margin:0; flex:1; min-width:0;">
        <a href="/" style="text-decoration:none; color:inherit;">${escapeHtml(h.title)}</a>
      </h1>
    </header>
    ${tabsHtml('list')}
    <div class="copy-bar">
      <button id="copy-btn" class="copy-btn">📋 Copy markdown</button>
      <span style="margin-left:0.6rem; font-size:0.78rem; color:#888;">
        ${escapeHtml(h.author)} · ${timeAgo(h.mtime)} ·
        <span style="color:${CATEGORY_COLORS[h.category]};">${CATEGORY_LABELS[h.category]}</span> ·
        ${formatHours(h.hours)} · ${formatUsd(h.hours * SENIOR_DEV_HOURLY_RATE_USD)}${h.hoursEstimated ? ' (est.)' : ''}
      </span>
    </div>
    ${renderMarkdown(h.body)}

    <div class="chat-card" id="chat-card">
      <h2>🧭 Captain (Phase 1-4 loop)</h2>
      <div class="chat-thread" id="chat-thread">
        <div class="chat-loading" id="chat-loading">Loading Captain's read…</div>
      </div>
      <div class="chat-input-wrap">
        <div class="chat-pills-wrap" id="chat-pills-wrap" style="display:none;">
          <div class="chat-pills-label">Selected answers (tap × to clear, tap a different chip above to swap):</div>
          <div class="chat-pills" id="chat-pills"></div>
        </div>
        <textarea class="chat-input" id="chat-input" placeholder="Free-text notes for Captain (optional). Tap chips above to select answers — they appear as pills."></textarea>
        <div class="chat-actions">
          <button type="button" class="send" id="chat-send">📨 Send</button>
          <button type="button" class="generate" id="chat-generate">🎯 Generate final prompt</button>
          <button type="button" class="reset" id="chat-reset">⟲ Reset</button>
          <span class="chat-status" id="chat-status"></span>
        </div>
      </div>
    </div>

    <div class="send-card">
      <h2>📡 Send Captain's reply to engineer terminal</h2>
      ${tmuxTargetBlock}
      <textarea id="reply" placeholder="Paste Claude Desktop's final reply here, then click Send.${et ? '' : ' (No live engineer tmux pane found.)'}"${et ? '' : ' disabled'}></textarea>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
        <button id="send-btn" type="button"${et ? '' : ' disabled'}>📡 Send to terminal</button>
        <button id="copy-reply-btn" type="button" style="background:#0a66c2;">📋 Copy reply</button>
        <span class="status" id="send-status"></span>
      </div>
    </div>

    <script id="raw-md" type="application/json">${rawJson}</script>
    <script>
      (function() {
        // Copy markdown button.
        var raw = JSON.parse(document.getElementById('raw-md').textContent)
        var btn = document.getElementById('copy-btn')
        async function copy(text) {
          if (navigator.clipboard && window.isSecureContext) {
            try { await navigator.clipboard.writeText(text); return true } catch (_) {}
          }
          var ta = document.createElement('textarea')
          ta.value = text; ta.setAttribute('readonly', '')
          ta.style.position='fixed'; ta.style.top='0'; ta.style.left='0'; ta.style.opacity='0'
          document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length)
          var ok = false; try { ok = document.execCommand('copy') } catch (_) {}
          document.body.removeChild(ta); return ok
        }
        btn.addEventListener('click', async function() {
          var ok = await copy(raw)
          var orig = btn.textContent
          btn.textContent = ok ? '✓ Copied!' : '✗ Copy failed'
          btn.classList.toggle('copied', ok)
          setTimeout(function() { btn.textContent = orig; btn.classList.remove('copied') }, 1500)
        })

        // Copy-reply button — copies whatever's in the textarea.
        var copyReplyBtn = document.getElementById('copy-reply-btn')
        if (copyReplyBtn) {
          copyReplyBtn.addEventListener('click', async function() {
            var t = document.getElementById('reply').value || ''
            if (!t.trim()) { copyReplyBtn.textContent = '✗ Empty'; setTimeout(function(){ copyReplyBtn.textContent = '📋 Copy reply' }, 1200); return }
            var ok = await copy(t)
            var orig = copyReplyBtn.textContent
            copyReplyBtn.textContent = ok ? '✓ Copied reply' : '✗ Copy failed'
            copyReplyBtn.classList.toggle('copied', ok)
            setTimeout(function() { copyReplyBtn.textContent = orig; copyReplyBtn.classList.remove('copied') }, 1500)
          })
        }

        // ============================================================
        // Captain chat panel — auto-fires on first visit, persists per
        // handoff. Decision-point chips parsed from Captain's assistant
        // messages.
        // ============================================================
        var FILENAME = ${JSON.stringify(h.filename)}
        var chatThread = document.getElementById('chat-thread')
        // Radio-button-per-question chip tracking. Keyed by the
        // question heading text; value = the last chip text the CEO
        // tapped for that question. Cleared on Send (the conversation
        // turn flushes) and on Reset.
        var chipMap = {}
        var chatInput = document.getElementById('chat-input')
        var chatSendBtn = document.getElementById('chat-send')
        var chatGenBtn = document.getElementById('chat-generate')
        var chatResetBtn = document.getElementById('chat-reset')
        var chatStatus = document.getElementById('chat-status')
        var chatLoading = document.getElementById('chat-loading')

        function escMd(s) {
          return s
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        }
        function mdInline(s) {
          s = escMd(s)
          s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>')
          s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
          s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>')
          s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
          return s
        }
        // Tiny markdown renderer for chat bubbles — headings, lists,
        // code blocks, blockquotes, paragraphs. Returns { html, chips }
        // where chips is the array of decision-option strings parsed
        // out of "**Q?**\\n- option" patterns.
        function mdChat(text) {
          var lines = text.split('\\n')
          var html = ''
          var i = 0
          var para = []
          var chips = []
          var inCode = false
          function flushPara() { if (para.length) { html += '<p>' + mdInline(para.join(' ')) + '</p>'; para = [] } }
          while (i < lines.length) {
            var line = lines[i]
            if (line.indexOf('\`\`\`') === 0) {
              flushPara()
              if (inCode) { html += '</code></pre>'; inCode = false } else { html += '<pre><code>'; inCode = true }
              i++; continue
            }
            if (inCode) { html += escMd(line) + '\\n'; i++; continue }
            // Decision point = a "question line" followed (after optional
            // blank lines) by an option list. Broadened from the v1
            // bold-question + dash-bullet pattern so Captain's real
            // formats also become tappable answers: the question may be a
            // heading (### …?), bold (**…?**), or a plain line ending in
            // "?"; options may use -, *, 1./1), a./a), or (a) markers.
            // Runs BEFORE the heading branch so a heading-question with a
            // following option list becomes buttons (a heading with no
            // following list falls through to normal heading rendering).
            var optRe = /^\\s*(?:[-*]|\\d+[.)]|\\([A-Za-z0-9]+\\)|[A-Za-z][.)])\\s+/
            var qClean = line.replace(/^#{1,4}\\s+/, '').replace(/^\\*\\*/, '').replace(/\\*\\*\\s*$/, '').trim()
            if (/\\?\\s*$/.test(qClean)) {
              var jq = i + 1
              while (jq < lines.length && lines[jq].trim() === '') jq++
              if (jq < lines.length && optRe.test(lines[jq])) {
                flushPara()
                var qAttr = escMd(qClean).replace(/"/g, '&quot;')
                html += '<p><strong>' + mdInline(qClean) + '</strong></p><div class="chat-options">'
                i = jq
                while (i < lines.length && optRe.test(lines[i])) {
                  var opt = lines[i].replace(optRe, '').trim()
                  chips.push(opt)
                  html += '<button type="button" class="chat-option" data-opt="' + escMd(opt).replace(/"/g, '&quot;') + '" data-question="' + qAttr + '">' + mdInline(opt) + '</button>'
                  i++
                }
                html += '</div>'
                continue
              }
            }
            var h = line.match(/^(#{1,4})\\s+(.+)$/)
            if (h) { flushPara(); html += '<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'; i++; continue }
            if (/^\\s*-\\s+/.test(line)) {
              flushPara()
              var li = '<ul>'
              while (i < lines.length && /^\\s*-\\s+/.test(lines[i])) {
                li += '<li>' + mdInline(lines[i].replace(/^\\s*-\\s+/, '')) + '</li>'
                i++
              }
              li += '</ul>'
              html += li
              continue
            }
            if (/^>\\s+/.test(line)) {
              flushPara()
              html += '<blockquote>' + mdInline(line.replace(/^>\\s+/, '')) + '</blockquote>'
              i++; continue
            }
            if (line.trim() === '') { flushPara(); i++; continue }
            para.push(line)
            i++
          }
          flushPara()
          if (inCode) html += '</code></pre>'
          return { html: html, chips: chips }
        }

        function renderThread(messages) {
          chatThread.innerHTML = ''
          if (!messages || messages.length === 0) {
            chatThread.innerHTML = '<div class="chat-empty">No conversation yet. Tap Send to start Captain.</div>'
            return
          }
          // Skip the first user message (it's the handoff body we
          // injected on Captain's behalf — CEO already read it).
          for (var i = 0; i < messages.length; i++) {
            var m = messages[i]
            if (i === 0 && m.role === 'user') continue
            var div = document.createElement('div')
            div.className = 'chat-msg ' + m.role
            if (m.role === 'assistant') {
              var parsed = mdChat(m.content)
              div.innerHTML = parsed.html
              // Per-message copy button — fallback when Generate Final
              // Reply fails to extract a paste-able block; Captain can
              // copy any Captain message and forward it directly. Stores
              // raw markdown on the button so copy survives DOM updates.
              ;(function (rawText) {
                var cpBtn = document.createElement('button')
                cpBtn.type = 'button'
                cpBtn.className = 'chat-msg-copy'
                cpBtn.textContent = '📋'
                cpBtn.title = 'Copy this Captain message'
                cpBtn.addEventListener('click', async function (e) {
                  e.stopPropagation()
                  var ok = await copy(rawText)
                  cpBtn.textContent = ok ? '✓' : '✗'
                  cpBtn.classList.toggle('copied', ok)
                  setTimeout(function () { cpBtn.textContent = '📋'; cpBtn.classList.remove('copied') }, 1500)
                })
                div.appendChild(cpBtn)
              })(m.content)
            } else {
              div.textContent = m.content
            }
            chatThread.appendChild(div)
          }
          // Wire chip clicks
          var chips = chatThread.querySelectorAll('.chat-option')
          chips.forEach(function (c) {
            c.addEventListener('click', function () {
              var opt = c.getAttribute('data-opt') || c.textContent
              var question = c.getAttribute('data-question') || ''
              // Pills-above-textarea behavior (sproushi-ops parity):
              //   - chipMap stores the selected answer per question
              //   - Tapping a different chip for the SAME question just
              //     replaces the pill (radio-button)
              //   - Tapping × on a pill clears that question's answer
              //   - Textarea stays free-text-only; chip taps never touch it
              chipMap[question] = opt
              renderPills()
            })
          })
          // Scroll latest into view
          chatThread.scrollTop = chatThread.scrollHeight
        }

        // Render the pills strip above the textarea from chipMap.
        // Empty → hide the whole strip. × button on each pill deletes
        // its question entry.
        function renderPills() {
          var wrap = document.getElementById('chat-pills-wrap')
          var pills = document.getElementById('chat-pills')
          var keys = Object.keys(chipMap)
          if (keys.length === 0) {
            wrap.style.display = 'none'
            pills.innerHTML = ''
            return
          }
          wrap.style.display = ''
          pills.innerHTML = ''
          keys.forEach(function (q) {
            var opt = chipMap[q]
            var pill = document.createElement('span')
            pill.className = 'chat-pill'
            pill.title = q + ' → ' + opt
            var text = document.createElement('span')
            text.textContent = opt
            var x = document.createElement('button')
            x.type = 'button'
            x.className = 'pill-x'
            x.setAttribute('aria-label', 'Clear answer')
            x.textContent = '×'
            x.addEventListener('click', function () {
              delete chipMap[q]
              renderPills()
            })
            pill.appendChild(text)
            pill.appendChild(x)
            pills.appendChild(pill)
          })
        }

        // Combine selected pills + free-text notes into one message
        // body Captain sees. Pills go first (one per line), then a blank
        // line, then free-text notes. Either may be empty.
        function buildOutgoingMessage() {
          var picks = Object.values(chipMap).filter(function (v) { return v && v.trim() })
          var notes = (chatInput.value || '').trim()
          if (picks.length === 0) return notes
          if (!notes) return picks.join('\\n')
          return picks.join('\\n') + '\\n\\n' + notes
        }

        function setBusy(busy, msg) {
          chatSendBtn.disabled = busy
          chatGenBtn.disabled = busy
          chatResetBtn.disabled = busy
          chatStatus.textContent = msg || ''
          chatStatus.className = 'chat-status' + (msg && msg.indexOf('✗') === 0 ? ' err' : '')
        }

        // ----- chipMap localStorage persistence -----
        // Captain's server-side history persists across reload (it's
        // saved to docs/handoff/.chat/<file>.json), so persisting the
        // CEO's pill selections to localStorage is consistent — neither
        // side gets ahead of the other on refresh.
        var CHIP_KEY = 'chipMap-' + FILENAME
        function saveChipMap() {
          try { localStorage.setItem(CHIP_KEY, JSON.stringify(chipMap)) } catch (_) {}
        }
        function loadChipMap() {
          try {
            var s = localStorage.getItem(CHIP_KEY)
            if (s) { var j = JSON.parse(s); if (j && typeof j === 'object') chipMap = j }
          } catch (_) {}
        }
        function clearChipMapStorage() {
          try { localStorage.removeItem(CHIP_KEY) } catch (_) {}
        }
        // Wrap the existing renderPills so it also persists state. The
        // chip click handler and pill × already update chipMap; this
        // hook just snapshots after every render.
        var _baseRenderPills = renderPills
        renderPills = function () { _baseRenderPills(); saveChipMap() }

        // ----- SSE streaming -----
        // Consumes the /stream and /generate-final/stream endpoints.
        // Calls onDelta(text) for each text chunk as it arrives, then
        // onDone({history, finalReply}) on the terminal "done" event,
        // or onError(string) on "error" event / network failure.
        async function streamFetch(url, payload, { onDelta, onDone, onError }) {
          try {
            var res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload || {}),
            })
            if (!res.ok) {
              var t = await res.text().catch(function () { return '' })
              onError(t || ('HTTP ' + res.status))
              return
            }
            if (!res.body || !res.body.getReader) {
              // No streaming support — fall back to JSON parse
              var j = await res.json().catch(function () { return null })
              if (j && j.history) onDone(j)
              else onError('streaming unsupported; no fallback body')
              return
            }
            var reader = res.body.getReader()
            var decoder = new TextDecoder()
            var buf = ''
            while (true) {
              var chunk = await reader.read()
              if (chunk.done) break
              buf += decoder.decode(chunk.value, { stream: true })
              var events = buf.split('\\n\\n')
              buf = events.pop()
              for (var i = 0; i < events.length; i++) {
                var lines = events[i].split('\\n')
                var ev = ''
                var data = ''
                for (var k = 0; k < lines.length; k++) {
                  if (lines[k].indexOf('event:') === 0) ev = lines[k].slice(6).trim()
                  else if (lines[k].indexOf('data:') === 0) data += lines[k].slice(5).trim()
                }
                if (!ev) continue
                try {
                  var j = data ? JSON.parse(data) : {}
                  if (ev === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
                    onDelta(j.delta.text || '')
                  } else if (ev === 'done') {
                    onDone(j)
                  } else if (ev === 'error') {
                    onError(j.error || 'unknown stream error')
                  }
                } catch (_) {}
              }
            }
          } catch (e) {
            onError(e && e.message || String(e))
          }
        }

        // Append a streaming-target assistant bubble that receives
        // text deltas. Returns { append(text), finalize(history) }.
        // While streaming, bubble shows raw text in a <pre>-style block.
        // On finalize, swap to rendered markdown + parse chips.
        function appendStreamingBubble() {
          // Hide the loading line if still showing.
          if (chatLoading) { try { chatLoading.remove() } catch (_) {} }
          var div = document.createElement('div')
          div.className = 'chat-msg assistant'
          div.style.whiteSpace = 'pre-wrap'
          var acc = ''
          chatThread.appendChild(div)
          chatThread.scrollTop = chatThread.scrollHeight
          return {
            append: function (t) {
              acc += t
              div.textContent = acc
              chatThread.scrollTop = chatThread.scrollHeight
            },
            finalize: function (history) {
              // Re-render the full thread so this bubble gets proper
              // markdown + chips. Saves having to re-parse manually.
              if (history && history.length > 0) {
                renderThread(history)
              } else {
                // No history (network error before save) — just keep
                // the accumulated text as-is in the bubble.
                div.style.whiteSpace = 'pre-wrap'
                div.textContent = acc
              }
            },
            getText: function () { return acc },
          }
        }

        async function loadOrStart() {
          // First, try to load existing history.
          try {
            var res = await fetch('/api/chat/' + encodeURIComponent(FILENAME))
            if (res.ok) {
              var j = await res.json()
              if (j.messages && j.messages.length > 0) {
                renderThread(j.messages)
                chatLoading.remove()
                return
              }
            }
          } catch (_) {}
          // No history — stream Captain's first turn.
          var bubble = appendStreamingBubble()
          await streamFetch('/api/chat/' + encodeURIComponent(FILENAME) + '/stream', { message: '' }, {
            onDelta: function (t) { bubble.append(t) },
            onDone: function (j) { bubble.finalize(j.history || []) },
            onError: function (msg) {
              chatLoading.textContent = '✗ Captain failed to start: ' + msg
            },
          })
        }

        chatSendBtn.addEventListener('click', async function () {
          var msg = buildOutgoingMessage()
          if (!msg) { setBusy(false, '✗ Tap a chip OR type a reply first'); return }
          setBusy(true, 'Captain thinking…')
          // Clear UI state immediately so the CEO sees their submission flush.
          chatInput.value = ''
          chipMap = {}
          renderPills()
          clearChipMapStorage()
          var bubble = appendStreamingBubble()
          await streamFetch('/api/chat/' + encodeURIComponent(FILENAME) + '/stream', { message: msg }, {
            onDelta: function (t) { bubble.append(t) },
            onDone: function (j) {
              bubble.finalize(j.history || [])
              setBusy(false, '')
            },
            onError: function (m) { setBusy(false, '✗ ' + m) },
          })
        })

        chatGenBtn.addEventListener('click', async function () {
          setBusy(true, 'Captain generating final reply…')
          var bubble = appendStreamingBubble()
          await streamFetch('/api/chat/' + encodeURIComponent(FILENAME) + '/generate-final/stream', {}, {
            onDelta: function (t) { bubble.append(t) },
            onDone: function (j) {
              bubble.finalize(j.history || [])
              if (j.finalReply) {
                document.getElementById('reply').value = j.finalReply
                setBusy(false, '✓ Final reply ready → review in Send-to-terminal block below')
                document.getElementById('reply').scrollIntoView({ behavior: 'smooth', block: 'center' })
              } else {
                // No FINAL REPLY header → still surface a usable path:
                // copy the entire Captain message into the textarea so the
                // 📋 Copy reply + Send to terminal buttons stay functional.
                var last = (j.history || []).slice(-1)[0]
                if (last && last.role === 'assistant' && last.content) {
                  document.getElementById('reply').value = last.content
                  setBusy(false, '⚠ No FINAL REPLY header found — pasted full Captain message into reply box; trim before sending')
                  document.getElementById('reply').scrollIntoView({ behavior: 'smooth', block: 'center' })
                } else {
                  setBusy(false, '⚠ Captain replied empty; check the chat')
                }
              }
            },
            onError: function (m) {
              // Surface the error inline as a chat bubble too, not just
              // in the status text — phone-screen viewers can miss the
              // status line entirely.
              try { bubble.finalize([]) } catch (_) {}
              var errDiv = document.createElement('div')
              errDiv.className = 'chat-msg assistant'
              errDiv.style.borderColor = '#c62828'
              errDiv.style.background = '#fff5f5'
              errDiv.textContent = '⚠ Generate Final Reply failed: ' + m
              chatThread.appendChild(errDiv)
              setBusy(false, '✗ ' + m)
            },
          })
        })

        chatResetBtn.addEventListener('click', async function () {
          if (!confirm('Reset Captain chat for this handoff? Conversation history will be cleared.')) return
          setBusy(true, 'Resetting…')
          try {
            var res = await fetch('/api/chat/' + encodeURIComponent(FILENAME) + '/reset', { method: 'POST' })
            if (!res.ok) { setBusy(false, '✗ HTTP ' + res.status); return }
            chipMap = {}
            renderPills()
            clearChipMapStorage()
            renderThread([])
            setBusy(false, '✓ Reset — refresh to re-fire Captain')
          } catch (e) {
            setBusy(false, '✗ ' + (e && e.message || e))
          }
        })

        // Boot — restore pill selections from localStorage first, then
        // fire Captain (which may pull pre-generated state).
        loadChipMap()
        renderPills()
        loadOrStart()

        // Send-to-terminal button.
        var sendBtn = document.getElementById('send-btn')
        var status = document.getElementById('send-status')
        var reply = document.getElementById('reply')
        if (sendBtn) {
          sendBtn.addEventListener('click', async function() {
            var content = (reply.value || '').trim()
            if (!content) { status.textContent = 'Empty reply — nothing to send.'; status.className = 'status err'; return }
            sendBtn.disabled = true
            status.textContent = 'Piping into tmux…'
            status.className = 'status'
            try {
              var res = await fetch('/api/send/${encodeURIComponent(h.filename)}', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: content }),
              })
              var j = await res.json().catch(function() { return {} })
              if (res.ok && j.ok) {
                status.textContent = '✓ ' + (j.message || ('piped into ' + ${JSON.stringify(et ? et.target : '')}))
                status.className = 'status ok'
              } else {
                status.textContent = '✗ ' + (j.error || ('HTTP ' + res.status))
                status.className = 'status err'
              }
            } catch (e) {
              status.textContent = '✗ ' + (e && e.message || e)
              status.className = 'status err'
            } finally {
              sendBtn.disabled = false
            }
          })
        }
      })()
    </script>
  `
  return layout(h.title, body)
}

function analyticsPage() {
  const items = listHandoffs()
  const totalHours = items.reduce((s, h) => s + h.hours, 0)
  const totalCost = totalHours * SENIOR_DEV_HOURLY_RATE_USD
  // Extra tile data — last 7 days + last 24 hours + average/handoff.
  const now = Date.now()
  const ONE_DAY = 24 * 3600 * 1000
  const last7Items = items.filter((h) => now - h.mtime < 7 * ONE_DAY)
  const last7Hours = last7Items.reduce((s, h) => s + h.hours, 0)
  const last24Items = items.filter((h) => now - h.mtime < ONE_DAY)
  const last24Hours = last24Items.reduce((s, h) => s + h.hours, 0)
  const avgHoursPerHandoff = items.length > 0 ? totalHours / items.length : 0
  // Newest handoff timestamp.
  const newestMs = items.length > 0 ? items[0].mtime : null

  // Per-author breakdown.
  const byAuthor = {}
  for (const h of items) {
    if (!byAuthor[h.author]) {
      byAuthor[h.author] = { count: 0, hours: 0, byCat: {} }
      for (const c of CATEGORIES) byAuthor[h.author].byCat[c] = { count: 0, hours: 0 }
    }
    byAuthor[h.author].count += 1
    byAuthor[h.author].hours += h.hours
    byAuthor[h.author].byCat[h.category].count += 1
    byAuthor[h.author].byCat[h.category].hours += h.hours
  }

  const byCatCombined = {}
  for (const c of CATEGORIES) byCatCombined[c] = { count: 0, hours: 0 }
  for (const h of items) {
    byCatCombined[h.category].count += 1
    byCatCombined[h.category].hours += h.hours
  }
  const maxCatHours = Math.max(1, ...CATEGORIES.map((c) => byCatCombined[c].hours))

  const authors = Object.keys(byAuthor).sort()

  const authorBlocks = authors.map((u) => {
    const s = byAuthor[u]
    const maxBarHours = Math.max(1, ...CATEGORIES.map((c) => s.byCat[c].hours))
    return `
      <div class="analytics-tile" style="margin-top:1rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
          <strong>${escapeHtml(u)}</strong>
          <span style="color:#666; font-size:0.85rem;">
            ${s.count} handoff${s.count === 1 ? '' : 's'} ·
            ${formatHours(s.hours)} senior-dev time ·
            <strong style="color:#1b5e20;">${formatUsd(s.hours * SENIOR_DEV_HOURLY_RATE_USD)}</strong>
          </span>
        </div>
        <div style="margin-top:0.7rem;">
          ${CATEGORIES.map((c) => {
            const v = s.byCat[c]
            const w = (v.hours / maxBarHours) * 100
            return `<div class="cat-row">
              <span class="label" style="color:${CATEGORY_COLORS[c]};">${CATEGORY_LABELS[c]}</span>
              <span class="cat-bar" style="background:${CATEGORY_COLORS[c]}; width:${w}%;"></span>
              <span class="count">${v.count}× · ${formatHours(v.hours)} · ${formatUsd(v.hours * SENIOR_DEV_HOURLY_RATE_USD)}</span>
            </div>`
          }).join('')}
        </div>
      </div>
    `
  }).join('')

  const body = `
    <header>
      <h1>analytics</h1>
    </header>
    ${tabsHtml('analytics')}
    <div class="analytics-tiles">
      <div class="analytics-tile">
        <div class="n">${items.length}</div>
        <div class="lab">handoffs</div>
      </div>
      <div class="analytics-tile">
        <div class="n">${formatHours(totalHours)}</div>
        <div class="lab">senior-dev hours saved</div>
      </div>
      <div class="analytics-tile">
        <div class="n" style="color:#1b5e20;">${formatUsd(totalCost)}</div>
        <div class="lab">cost saved @ $${SENIOR_DEV_HOURLY_RATE_USD}/h</div>
      </div>
      <div class="analytics-tile">
        <div class="n">${last7Items.length}</div>
        <div class="lab">handoffs this week<br><span style="font-size:0.78rem; color:#1b5e20;">${formatHours(last7Hours)} · ${formatUsd(last7Hours * SENIOR_DEV_HOURLY_RATE_USD)}</span></div>
      </div>
      <div class="analytics-tile">
        <div class="n">${last24Items.length}</div>
        <div class="lab">handoffs last 24h<br><span style="font-size:0.78rem; color:#1b5e20;">${formatHours(last24Hours)} · ${formatUsd(last24Hours * SENIOR_DEV_HOURLY_RATE_USD)}</span></div>
      </div>
      <div class="analytics-tile">
        <div class="n">${formatHours(avgHoursPerHandoff)}</div>
        <div class="lab">avg per handoff</div>
      </div>
      <div class="analytics-tile">
        <div class="n" style="font-size:1rem;">${newestMs ? timeAgo(newestMs) : '—'}</div>
        <div class="lab">newest handoff</div>
      </div>
    </div>

    <h2 style="font-size:1.05rem;">Per author</h2>
    ${authors.length === 0 ? '<div class="empty">No handoffs yet.</div>' : authorBlocks}

    <h2 style="font-size:1.05rem; margin-top:1.5rem;">Combined breakdown by category</h2>
    <div class="analytics-tile">
      ${CATEGORIES.map((c) => {
        const v = byCatCombined[c]
        const w = (v.hours / maxCatHours) * 100
        return `<div class="cat-row">
          <span class="label" style="color:${CATEGORY_COLORS[c]};">${CATEGORY_LABELS[c]}</span>
          <span class="cat-bar" style="background:${CATEGORY_COLORS[c]}; width:${w}%;"></span>
          <span class="count">${v.count}× · ${formatHours(v.hours)} · ${formatUsd(v.hours * SENIOR_DEV_HOURLY_RATE_USD)}</span>
        </div>`
      }).join('')}
    </div>

    <p class="note">
      Methodology: each handoff carries an honest <code>senior_dev_hours</code> estimate in the
      frontmatter (engineer's call). When missing, a coarse category default is used and the
      number is marked "(est.)". Cost saved = hours × $${SENIOR_DEV_HOURLY_RATE_USD}/h (single
      senior-dev rate constant — edit <code>SENIOR_DEV_HOURLY_RATE_USD</code> in
      <code>scripts/handoff-viewer.js</code> to change).
    </p>
  `
  return layout('Analytics', body)
}

// ============================================================
// Send-to-tmux endpoint
// ============================================================

function isSafeFilename(name) {
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(name)) return false
  if (name.includes('..')) return false
  const resolved = path.resolve(HANDOFF_DIR, name)
  return resolved.startsWith(HANDOFF_DIR + path.sep)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 1024 * 1024) { reject(new Error('payload too large')); req.destroy() } })
    req.on('end', () => resolve(buf))
    req.on('error', reject)
  })
}

// Convert a Windows path to its WSL-side equivalent. Used when the
// viewer is running under Windows-side node.exe (the canonical setup
// per CLAUDE.md) and needs to invoke a WSL-side bash script via
// `wsl.exe bash`.
//   \\wsl.localhost\<distro>\home\... → /home/...
//   C:\Users\...                      → /mnt/c/Users/...
//   /already/posix                    → unchanged
function winToWslPath(p) {
  const unc = p.match(/^\\\\wsl\.localhost\\[^\\]+\\(.+)$/i)
  if (unc) return '/' + unc[1].replace(/\\/g, '/')
  const drive = p.match(/^([A-Za-z]):\\(.+)$/)
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
  return p
}

function sendToEngineer({ tmuxTarget, content }) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `handoff-send-${crypto.randomBytes(6).toString('hex')}.txt`)
    try {
      fs.writeFileSync(tmpFile, content, { mode: 0o600 })
    } catch (e) {
      resolve({ ok: false, error: `tmpfile write failed: ${e.message}` })
      return
    }
    // On Windows, node.exe can't execFile a .sh directly (EFTYPE).
    // Route through `wsl.exe bash <wsl-path-to-script> <args>` and
    // translate the Windows tmpFile path to its WSL-visible form so
    // bash can read it. On Linux/macOS just call the script directly.
    let cmd, args
    if (process.platform === 'win32') {
      cmd = 'wsl.exe'
      args = ['bash', winToWslPath(SEND_SCRIPT), tmuxTarget, winToWslPath(tmpFile)]
    } else {
      cmd = SEND_SCRIPT
      args = [tmuxTarget, tmpFile]
    }
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile) } catch {}
      if (err) {
        const msg = (stderr && stderr.trim()) || err.message
        resolve({ ok: false, error: `${cmd} failed: ${msg}` })
        return
      }
      resolve({ ok: true, message: stdout.trim() || `piped into ${tmuxTarget}` })
    })
  })
}

// ============================================================
// Tmux target resolution (2026-07-04 long-term fix)
// ============================================================
// "Send to terminal" used to REQUIRE `engineer.tmux_target` in each
// handoff's frontmatter — files without it rendered a disabled button,
// which in practice was every recent handoff. Resolution is now a
// fallback chain, so the button works with zero per-file ceremony:
//   1. frontmatter engineer.tmux_target   (explicit per-file override)
//   2. HANDOFF_TMUX_TARGET env var        (explicit per-viewer override)
//   3. auto-detect: first pane in the project tmux session whose
//      current command is claude (the engineer CLI). Session name from
//      HANDOFF_TMUX_SESSION env, default 'manymuse-discover'. Detection
//      is scoped to the project session ON PURPOSE — other projects'
//      claude panes coexist on this machine and cross-project sends
//      would be worse than a disabled button.
// Detection result is cached 30s so page loads don't shell out per hit.

const TMUX_SESSION = process.env.HANDOFF_TMUX_SESSION || 'manymuse-discover'
let _tmuxDetectCache = { at: 0, target: null }

function detectTmuxTarget() {
  return new Promise((resolve) => {
    if (Date.now() - _tmuxDetectCache.at < 30_000) {
      resolve(_tmuxDetectCache.target)
      return
    }
    const fmt = '#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}'
    let cmd, args
    if (process.platform === 'win32') {
      cmd = 'wsl.exe'
      args = ['tmux', 'list-panes', '-a', '-F', fmt]
    } else {
      cmd = 'tmux'
      args = ['list-panes', '-a', '-F', fmt]
    }
    execFile(cmd, args, { timeout: 5_000 }, (err, stdout) => {
      let target = null
      if (!err && stdout) {
        for (const line of stdout.split('\n')) {
          const [pane, command] = line.trim().split('\t')
          if (!pane || !command) continue
          if (!pane.startsWith(TMUX_SESSION + ':')) continue
          if (/^claude/.test(command)) { target = pane; break }
        }
      }
      _tmuxDetectCache = { at: Date.now(), target }
      resolve(target)
    })
  })
}

// Chain: frontmatter → env → auto-detect. Returns
// { target, source } with source ∈ frontmatter|env|detected, or null.
async function resolveTmuxTarget(h) {
  if (h.tmuxTarget) return { target: h.tmuxTarget, source: 'frontmatter' }
  if (process.env.HANDOFF_TMUX_TARGET) {
    return { target: process.env.HANDOFF_TMUX_TARGET, source: 'env' }
  }
  const detected = await detectTmuxTarget()
  if (detected) return { target: detected, source: 'detected' }
  return null
}

// ============================================================
// Server
// ============================================================

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${BIND_HOST}:${PORT}`)
    const pathname = decodeURIComponent(url.pathname)

    // /healthz
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, host: BIND_HOST, port: PORT, handoff_dir: HANDOFF_DIR }))
      return
    }

    // /
    if (pathname === '/' || pathname === '/index') {
      const q = url.searchParams.get('q') || ''
      const cat = url.searchParams.get('cat') || ''
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(indexPage({ q, cat }))
      return
    }

    // /analytics
    if (pathname === '/analytics') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(analyticsPage())
      return
    }

    // ----- Captain chat routes -----
    // GET  /api/chat/<filename>                 → { messages: [...] }
    // POST /api/chat/<filename>                 → { reply, history }
    // POST /api/chat/<filename>/reset           → { ok }
    // POST /api/chat/<filename>/generate-final  → { reply, finalReply, history }
    // Filename capture is a single path segment ([^/]+, never a slash) so
    // the more-specific routes can't be swallowed by a looser greedy one.
    // (.+) made /generate-final/stream also match the chatStream pattern —
    // it captured "<file>.md/generate-final", failed isSafeFilename, and
    // surfaced as a spurious "bad filename" on the Generate button.
    const chatReset    = pathname.match(/^\/api\/chat\/([^/]+)\/reset$/)
    const chatGenStrm  = pathname.match(/^\/api\/chat\/([^/]+)\/generate-final\/stream$/)
    const chatGen      = pathname.match(/^\/api\/chat\/([^/]+)\/generate-final$/)
    const chatStream   = pathname.match(/^\/api\/chat\/([^/]+)\/stream$/)
    const chatBase     = pathname.match(/^\/api\/chat\/([^/]+)$/)

    // Helper for SSE responses. Anthropic-compatible event shape so
    // the client parser stays simple.
    function startSse() {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
    }
    function sseSend(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // POST /api/chat/<file>/stream  → text deltas + final history
    if (chatStream && req.method === 'POST') {
      const filename = chatStream[1]
      if (!isSafeFilename(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad filename' })); return
      }
      const h = readHandoff(filename)
      if (!h) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return }
      const body = await readBody(req)
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch {}
      const message = String(payload.message || '')
      startSse()
      try {
        // Join in-flight pre-gen if there is one (avoids duplicate calls
        // when the page auto-fires while watcher pre-gen is mid-stream).
        const existing = chat.inflightFor(filename)
        let result
        if (existing && (!message || !message.trim())) {
          // Auto-fire + a pre-gen is already running → wait for it,
          // then replay its reply as deltas in chunks so the client UI
          // still sees streaming behavior.
          result = await existing
          const replyText = result.reply || ''
          // chunk by ~120 char windows for smooth-looking output
          for (let i = 0; i < replyText.length; i += 120) {
            sseSend('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: replyText.slice(i, i + 120) } })
          }
        } else {
          result = await chat.streamMessage({
            filename,
            handoffBody: h.body,
            message,
            onDelta: (t) => sseSend('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }),
          })
        }
        sseSend('done', { reply: result.reply, history: result.history })
      } catch (e) {
        sseSend('error', { error: String(e.message || e) })
      } finally {
        res.end()
      }
      return
    }

    // POST /api/chat/<file>/generate-final/stream  → text deltas + finalReply
    if (chatGenStrm && req.method === 'POST') {
      const filename = chatGenStrm[1]
      if (!isSafeFilename(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad filename' })); return
      }
      const h = readHandoff(filename)
      if (!h) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return }
      startSse()
      try {
        const result = await chat.streamGenerateFinalReply({
          filename,
          handoffBody: h.body,
          onDelta: (t) => sseSend('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }),
        })
        sseSend('done', { reply: result.reply, finalReply: result.finalReply, history: result.history })
      } catch (e) {
        sseSend('error', { error: String(e.message || e) })
      } finally {
        res.end()
      }
      return
    }
    if (chatReset && req.method === 'POST') {
      const filename = chatReset[1]
      if (!isSafeFilename(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad filename' })); return
      }
      chat.clearHistory(filename)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return
    }
    if (chatGen && req.method === 'POST') {
      const filename = chatGen[1]
      if (!isSafeFilename(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad filename' })); return
      }
      const h = readHandoff(filename)
      if (!h) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return }
      try {
        const result = await chat.generateFinalReply({ filename, handoffBody: h.body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e.message || e) }))
      }
      return
    }
    if (chatBase && !chatReset && !chatGen) {
      const filename = chatBase[1]
      if (!isSafeFilename(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad filename' })); return
      }
      if (req.method === 'GET') {
        const hist = chat.loadHistory(filename)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ messages: hist ? hist.messages : [] }))
        return
      }
      if (req.method === 'POST') {
        const h = readHandoff(filename)
        if (!h) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return }
        const body = await readBody(req)
        let payload = {}
        try { payload = JSON.parse(body || '{}') } catch {}
        const message = String(payload.message || '')
        try {
          const result = await chat.sendMessage({ filename, handoffBody: h.body, message })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(e.message || e) }))
        }
        return
      }
    }

    // POST /api/send/<filename>
    const sendMatch = pathname.match(/^\/api\/send\/(.+)$/)
    if (sendMatch && req.method === 'POST') {
      const filename = sendMatch[1]
      if (!isSafeFilename(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'bad filename' }))
        return
      }
      const h = readHandoff(filename)
      if (!h) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'handoff not found' }))
        return
      }
      const resolved = await resolveTmuxTarget(h)
      if (!resolved) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'no tmux target (frontmatter/env empty, no claude pane in session ' + TMUX_SESSION + ')' }))
        return
      }
      const body = await readBody(req)
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }))
        return
      }
      const content = String(payload.content || '').trim()
      if (!content) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'empty content' }))
        return
      }
      const result = await sendToEngineer({ tmuxTarget: resolved.target, content })
      res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    // /h/<filename>.md (new pattern)
    const hMatch = pathname.match(/^\/h\/(.+)$/)
    if (hMatch) {
      const filename = hMatch[1]
      if (!isSafeFilename(filename)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return
      }
      const h = readHandoff(filename)
      if (!h) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return }
      h.effectiveTmux = await resolveTmuxTarget(h)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(handoffPage(h))
      return
    }

    // Legacy URL patterns (preserve CLAUDE.md notify-link convention):
    //   GET /<file>.md   → same as /h/<file>.md
    //   GET /<file>.html → raw passthrough (eyeball-loop render artifacts)
    const name = pathname.replace(/^\//, '')
    if (/^[a-zA-Z0-9._-]+\.html$/.test(name) && !name.includes('..')) {
      const full = path.join(HANDOFF_DIR, name)
      if (full.startsWith(HANDOFF_DIR + path.sep) && fs.existsSync(full)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(fs.readFileSync(full))
        return
      }
    }
    if (/^[a-zA-Z0-9._-]+\.md$/.test(name) && !name.includes('..')) {
      const h = readHandoff(name)
      if (h) {
        h.effectiveTmux = await resolveTmuxTarget(h)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(handoffPage(h))
        return
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  } catch (e) {
    console.error('[viewer] handler error:', e)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: String(e.message || e) }))
  }
})

// ============================================================
// fs.watch — pre-generate Captain's Phase 1 turn the moment a new
// handoff file lands on disk. CEO opens viewer → first bubble is
// already there, no spinner.
// ============================================================
const _debounce = new Map() // filename → timeout handle
function schedulePreGen(filename) {
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(filename)) return
  if (_debounce.has(filename)) clearTimeout(_debounce.get(filename))
  _debounce.set(filename, setTimeout(() => {
    _debounce.delete(filename)
    const h = readHandoff(filename)
    if (!h) return
    chat.preGenerateFirstTurn({ filename, handoffBody: h.body })
      .then((r) => {
        if (r && r.skipped) {
          console.log(`[pre-gen] skipped ${filename}: ${r.skipped}`)
        } else {
          console.log(`[pre-gen] Captain ready for ${filename}`)
        }
      })
      .catch((e) => {
        console.error(`[pre-gen] ${filename}: ${e.message || e}`)
      })
  }, 600)) // 600ms debounce — handles editor save chunks + cross-fs UNC writes
}
// fs.watch is unreliable on WSL UNC paths from Windows-side Node
// (EISDIR on the directory). Fall back to a polling diff: every 3s,
// list .md files and fire schedulePreGen() for any we haven't seen.
// First poll seeds the baseline (so existing handoffs don't all fire
// at startup).
let _seen = null
function pollDir() {
  let files
  try {
    files = fs.readdirSync(HANDOFF_DIR).filter((f) => f.endsWith('.md'))
  } catch {
    return
  }
  if (_seen === null) {
    _seen = new Set(files)
    return
  }
  for (const f of files) {
    if (_seen.has(f)) continue
    _seen.add(f)
    schedulePreGen(f)
  }
}
try {
  // Try fs.watch first — fast path for native filesystems.
  fs.watch(HANDOFF_DIR, { persistent: true }, (eventType, filename) => {
    if (!filename) return
    schedulePreGen(String(filename))
  })
  console.log(`[viewer] fs.watch armed on ${HANDOFF_DIR}`)
} catch (e) {
  console.error(`[viewer] fs.watch unavailable (${e.message}); polling every 3s instead`)
  pollDir() // seed baseline
  setInterval(pollDir, 3000)
}

server.listen(PORT, BIND_HOST, () => {
  console.log(`Handoff viewer: http://${BIND_HOST}:${PORT}/`)
  console.log(`Serving: ${HANDOFF_DIR}`)
  console.log(`Send-to-tmux: ${SEND_SCRIPT}`)
})
