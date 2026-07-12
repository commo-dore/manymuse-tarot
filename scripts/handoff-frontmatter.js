// Tiny YAML frontmatter parser for handoff files. Only handles the
// reply_fields schema (list of maps with string or inline-list values).
// No external deps. Exported for use by handoff-viewer.js and tested
// directly via handoff-viewer.test.js.

function splitFrontmatter(md) {
  // Only treat a frontmatter block when the file starts with `---` on
  // its own line and the next `---` line follows within the first 200
  // lines. Otherwise return { fm: null, body: md } so existing handoffs
  // are unchanged.
  if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) {
    return { fm: null, body: md }
  }
  const lines = md.split('\n')
  let end = -1
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    if (lines[i].trim() === '---') { end = i; break }
  }
  if (end < 0) return { fm: null, body: md }
  const fmText = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n')
  return { fm: parseYaml(fmText), body }
}

function parseYaml(text) {
  // Sufficient for the reply_fields schema. Handles:
  //   key: value             string scalar
  //   key:                   then nested block (list or map)
  //   - item                 list item (string or map opener)
  //   key: [a, b, c]         inline list (string items only)
  //   key: "..."             quoted scalar
  // Indentation = 2 spaces.
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''))
  let i = 0

  function parseBlock(indent) {
    const out = {}
    let listMode = null
    let listArr = null
    while (i < lines.length) {
      const raw = lines[i]
      if (!raw.trim()) { i++; continue }
      const cur = raw.match(/^(\s*)/)[1].length
      if (cur < indent) break

      const trimmed = raw.slice(cur)

      if (trimmed.startsWith('- ')) {
        if (listMode === null) listMode = 'list'
        if (listMode !== 'list') break
        if (listArr === null) listArr = []
        const after = trimmed.slice(2)
        if (after.includes(':') && !/^-/.test(after)) {
          // first key of a map item
          i++
          const item = { [after.split(':')[0].trim()]: parseScalarOrBlock(after.slice(after.indexOf(':') + 1).trim(), cur + 2) }
          while (i < lines.length) {
            const r = lines[i]
            if (!r.trim()) { i++; continue }
            const nx = r.match(/^(\s*)/)[1].length
            if (nx < cur + 2) break
            if (nx > cur + 2) { i++; continue }
            const t = r.slice(nx)
            if (t.startsWith('- ')) break
            const colon = t.indexOf(':')
            if (colon < 0) { i++; continue }
            const k = t.slice(0, colon).trim()
            const rest = t.slice(colon + 1).trim()
            i++
            item[k] = parseScalarOrBlock(rest, nx + 2)
          }
          listArr.push(item)
          continue
        } else {
          listArr.push(unquote(after))
          i++
          continue
        }
      }

      const colon = trimmed.indexOf(':')
      if (colon < 0) { i++; continue }
      const k = trimmed.slice(0, colon).trim()
      const rest = trimmed.slice(colon + 1).trim()
      if (listMode === 'list') break
      listMode = 'map'
      i++
      out[k] = parseScalarOrBlock(rest, cur + 2)
    }
    return listMode === 'list' ? listArr : out
  }

  function parseScalarOrBlock(rest, nestedIndent) {
    if (rest === '') {
      return parseBlock(nestedIndent)
    }
    const inlineList = rest.match(/^\[(.*)\]$/)
    if (inlineList) {
      const inner = inlineList[1].trim()
      if (inner === '') return []
      return inner.split(',').map((s) => unquote(s.trim()))
    }
    return unquote(rest)
  }

  function unquote(s) {
    if (!s) return s
    const m = s.match(/^["'](.*)["']$/)
    if (m) return m[1]
    return s
  }

  const result = parseBlock(0)
  return Array.isArray(result) ? null : result
}

module.exports = { splitFrontmatter, parseYaml }
