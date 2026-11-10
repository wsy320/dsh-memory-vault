/**
 * The personal memory vault, as a small file-backed engine.
 *
 * Straight port of `memory.py` (the script that used to live in
 * `~/.agents/skills/personal-memory/scripts/`): same frontmatter dialect, same
 * index and coverage layout, same weighted recall, same lint rules. A vault
 * written by either side stays readable by the other.
 *
 * Deliberate deviations, each one a fix:
 *
 * - `write()` returns the line of the first written line *after* the `updated:`
 *   refresh, so an append no longer reports a line one off.
 * - `append` lands after the frontmatter instead of re-emitting the block, so a
 *   note cannot end up with two frontmatters.
 * - Credential excerpts are returned verbatim, same as any other note: the agent
 *   has to be able to read the password it is asked to use. Credential notes are
 *   still skipped unless `include_credentials: true`, so a credentials hit stays
 *   an explicit act. (They used to be reduced to their label; that hid the value
 *   from a `read` that followed and made "get me the NAS password" undeliverable.)
 * - Writes are atomic (sibling temp file + rename).
 *
 * @module dsh-memory-vault/vault
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

export const EXCLUDE_DIRS = new Set(['.obsidian', '.git', '.trash', 'templates', 'assets'])
export const ROOT_META_FILES = new Set(['INDEX.md', 'MEMORY.md', 'CHANGELOG.md', 'KB.md'])
export const TYPES = new Set([
  'credential', 'device', 'network', 'service', 'project', 'problem',
  'career', 'finance', 'preference', 'memory', 'note',
  // Knowledge-layer types. `kb` notes hold facts whose authority is external
  // to the user (chip vendor, standards body, tool author), so they can name
  // their kind instead of defaulting to `note`.
  'silicon', 'protocol', 'tooling',
])
export const DOMAINS = new Set(['me', 'work', 'life', 'memory', 'inbox', 'kb'])
/** Domains whose notes are the user's own facts; ranked before `kb` on ties. */
export const INSTANCE_DOMAINS = ['me', 'work', 'life', 'memory', 'inbox']
export const SCOPES = new Set(['instance', 'method', 'reference'])
export const STATUSES = new Set(['active', 'superseded', 'draft', 'archived'])
/**
 * Statuses that keep a note in the index but out of recall.
 *
 * `archived` is for notes still worth reading on purpose — a design document, a
 * retired plan — that would outrank real answers if searched. A note *about* a
 * topic quotes the very words people search for, so it wins by being meta
 * rather than by being the fact. Measured: the scheme document outranked the
 * HSM note on a query about HSM boot, because it contains that phrase verbatim
 * as an example.
 */
export const UNSEARCHABLE_STATUSES = new Set(['archived'])
export const REQUIRED = ['title', 'type', 'domain', 'scope', 'summary', 'status', 'created', 'updated']
export const COVERAGE_START = '<!-- coverage:start -->'
export const COVERAGE_END = '<!-- coverage:end -->'
export const INVALID_PATH = '非法路径'
/**
 * Floor below which a hit is noise, not a weak answer.
 *
 * Calibrated once against a real miss: searching 「芯片手册」 returned two notes
 * scoring 0.1875 and 0.125 whose content was unrelated, and the old rule
 * ("any hit, answer it") would have read them as the answer. Needs more samples
 * to settle.
 */
export const DEFAULT_MIN_SCORE = 0.2
/**
 * How much stronger the best knowledge hit must be before it may outrank the
 * instance tier. 3 leaves the usual case (comparable scores) on the instance
 * side while letting an unmistakably knowledge question through.
 */
export const KB_OVERRIDE_FACTOR = 3
/**
 * Things the knowledge layer must never contain: private addresses, URLs with
 * credentials, and `key: value` shapes that look like a secret.
 *
 * Deliberately narrow. A false positive on a chip register name is cheap to
 * silence; a false negative means a real value is reachable through a search
 * nobody opted into.
 */
export const INSTANCE_VALUE_RE = /(?:https?:\/\/[^\s)]*:[^\s)@]+@|\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})/gu

const SECRET_RE = /[A-Za-z0-9_\-.]{16,}/g
const LINK_RE = /!?\[\[([^\]|#]+)/g
const LABEL_RE = /^[-*]\s*([^：:]{1,24})[：:]/
const HEADING_RE = /^#{1,6}\s*(.+)$/

/** The local calendar day, `YYYY-MM-DD`. */
export function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Local `YYYY-MM-DD HH:MM`. */
function stamp() {
  const now = new Date()
  return `${today()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/**
 * The local calendar day of an instant, `YYYY-MM-DD`.
 *
 * Deliberately local, not UTC: `today()` writes a local date into `updated:`,
 * so comparing against a UTC day would flag every note written after local
 * midnight in a positive-offset zone.
 * @param date - any `Date`.
 * @returns `YYYY-MM-DD` in the machine's time zone.
 */
function localDateOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Read a file as UTF-8, or `undefined` when it does not exist. */
async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw error
  }
}

/** Write one file atomically, creating its directory first. */
async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await writeFile(tmp, text, { encoding: 'utf8' })
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

/** Strip one matching pair of surrounding quotes, like the Python parser did. */
function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parse the vault's simple YAML frontmatter.
 *
 * Only `key: value` lines and `[a, b]` lists are understood — the same subset
 * the Python parser accepted; these notes never use flow mappings.
 * @param text - whole file.
 * @returns `[meta, body]`, where `body` excludes the frontmatter block.
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return [{}, text]
  const lines = text.split('\n')
  if (lines[0].trim() !== '---') return [{}, text]
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return [{}, text]
  const meta = {}
  for (const raw of lines.slice(1, end)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes(':')) continue
    const at = trimmed.indexOf(':')
    const key = trimmed.slice(0, at).trim()
    let value = trimmed.slice(at + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean).map(unquote)
    } else {
      value = unquote(value)
    }
    meta[key] = value
  }
  return [meta, lines.slice(end + 1).join('\n')]
}

/** Collect every `.md` below `dir`, as POSIX-style vault-relative paths. */
async function walkMarkdown(root, rel, out) {
  // A relative root would resolve against `process.cwd()` — the plugin's own
  // install directory — and report a plausible-looking wrong vault.
  if (rel === '' && !isAbsolute(root)) return
  const directory = rel === '' ? root : join(root, rel.split('/').join(sep))
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      await walkMarkdown(root, childRel, out)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(childRel)
    }
  }
}

/** Collect every file below `dir`; the link checker needs non-Markdown targets too. */
async function walkAll(root, rel, out) {
  // Same rule as `walkMarkdown`: never resolve a relative root against the cwd.
  if (rel === '' && !isAbsolute(root)) return
  const directory = rel === '' ? root : join(root, rel.split('/').join(sep))
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      await walkAll(root, childRel, out)
    } else if (entry.isFile()) {
      out.add(childRel)
    }
  }
}

/**
 * Every note in the vault, sorted by vault-relative path.
 * @param root - vault directory.
 * @returns note records (`rel`, `body`, `meta`, `lineOffset`, and the index fields).
 */
export async function scan(root) {
  const found = []
  await walkMarkdown(root, '', found)
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const notes = []
  for (const rel of found) {
    if (rel.split('/').some((part) => EXCLUDE_DIRS.has(part))) continue
    if (!rel.includes('/') && ROOT_META_FILES.has(rel)) continue
    const text = await readFile(join(root, rel.split('/').join(sep)), 'utf8')
    const [meta, body] = parseFrontmatter(text)
    // The body drops the frontmatter; reported line numbers add those lines back.
    const lineOffset = text.split('\n').length - body.split('\n').length
    notes.push({
      rel,
      // Carried so callers can stat the file without being handed the root again.
      root,
      body,
      meta,
      lineOffset,
      title: meta.title || basename(rel).replace(/\.md$/, ''),
      domain: meta.domain || 'inbox',
      type: meta.type || 'note',
      scope: meta.scope || '',
      summary: meta.summary || '',
      keywords: Array.isArray(meta.keywords) ? meta.keywords : meta.keywords ? [String(meta.keywords)] : [],
      status: meta.status || '',
    })
  }
  return notes
}

/**
 * Render `INDEX.md`: one line per note, grouped by domain.
 * @param notes - scanned notes.
 * @returns file content.
 */
export function buildIndex(notes) {
  const instance = notes.filter((note) => note.domain !== 'kb')
  const out = ['# 全库索引', '', `> ${instance.length} 篇 · ${today()} 生成，勿手改。`, '', '> 知识层另有 `KB.md`，此处不列。', '']
  const groups = new Map()
  for (const note of instance) {
    if (!groups.has(note.domain)) groups.set(note.domain, [])
    groups.get(note.domain).push(note)
  }
  const known = INSTANCE_DOMAINS
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
  for (const domain of known) {
    const list = groups.get(domain)
    if (list === undefined) continue
    out.push(`## ${domain}`)
    for (const note of [...list].sort(byRel)) {
      const keywords = Array.isArray(note.keywords) ? note.keywords.join('、') : String(note.keywords)
      const meta = [note.type, note.scope].filter(Boolean).join('·')
      out.push(`- \`${note.rel}\` — ${note.summary} | ${meta} | ${keywords}`)
    }
    out.push('')
  }
  for (const domain of [...groups.keys()].filter((name) => !known.includes(name)).sort()) {
    out.push(`## ${domain}`)
    for (const note of [...groups.get(domain)].sort(byRel)) out.push(`- \`${note.rel}\` — ${note.summary}`)
    out.push('')
  }
  return `${out.join('\n').replace(/\s+$/, '')}\n`
}

/**
 * Render `KB.md`: the knowledge-layer index, grouped by `kb/` subdirectory.
 *
 * Grouping follows the on-disk tree (`kb/silicon/ti`, `kb/tooling`, …) rather
 * than a fixed enum, so adding a category is a `mkdir` and not a code change.
 * @param notes - scanned notes.
 * @returns file content.
 */
export function buildKbIndex(notes) {
  const kbNotes = notes.filter((note) => note.domain === 'kb')
  const out = ['# 知识库索引', '', `> ${kbNotes.length} 篇 · ${today()} 生成，勿手改。`, '']
  if (kbNotes.length === 0) {
    out.push('（空）')
    return `${out.join('\n').replace(/\s+$/, '')}\n`
  }
  const groups = new Map()
  for (const note of kbNotes) {
    const parts = note.rel.split('/')
    const group = parts.length > 2 ? parts.slice(0, -1).join('/') : 'kb'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(note)
  }
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
  for (const group of [...groups.keys()].sort()) {
    out.push(`## ${group}`)
    for (const note of [...groups.get(group)].sort(byRel)) {
      const keywords = Array.isArray(note.keywords) ? note.keywords.join('、') : String(note.keywords)
      const source = note.meta.source ? ` | 源: ${note.meta.source}` : ''
      out.push(`- \`${note.rel}\` — ${note.summary} | ${note.status || '?'} | ${keywords}${source}`)
    }
    out.push('')
  }
  return `${out.join('\n').replace(/\s+$/, '')}\n`
}

/**
 * Render the `MEMORY.md` coverage block.
 *
 * Titles are ordered by vault-relative path inside each domain, matching
 * `memory.py`, whose `scan()` iterated `sorted(vault.rglob("*.md"))` and whose
 * `build_coverage()` therefore saw path order.
 *
 * That is a case-insensitive order, not a code-point one. `rglob` yields
 * `WindowsPath` objects, and `WindowsPath.__lt__` folds case (it compares
 * `ntpath.normcase`d strings), so `me/Tailscale.md` sorts *after*
 * `me/credentials/API密钥.md` — `normcase` turns the `T` into `t`, and `t`
 * (0x74) follows `c` (0x63). A raw `<` on `rel` gets this backwards: `T` is
 * 0x54, so `me/Tailscale.md` would lead the `me` line. Lowercasing before the
 * comparison reproduces the Python order on every line of the live block,
 * including `work`, where the `H` of `HSM启动流程` must precede `启动时间优化`.
 * `INDEX.md` groups by domain and sorts the same way, so the two agree.
 * @param notes - scanned notes, in any order.
 * @returns block body, without the surrounding markers.
 */
export function buildCoverage(notes) {
  // Case-insensitive by path: `WindowsPath` ordering in `memory.py`, not `<`.
  const byRel = (a, b) => {
    const left = a.rel.toLowerCase()
    const right = b.rel.toLowerCase()
    if (left !== right) return left < right ? -1 : 1
    // Distinct notes can still differ in case; fall back to exact bytes so the
    // order is total and independent of the input order.
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  }
  const lines = []
  for (const domain of [...INSTANCE_DOMAINS, 'kb']) {
    const titles = [...notes]
      .filter((note) => note.domain === domain)
      .sort(byRel)
      .map((note) => note.title)
    if (titles.length === 0) {
      lines.push(`- ${domain}：0 篇`)
      continue
    }
    const extra = titles.length > 8 ? ` 等 ${titles.length} 篇` : ''
    lines.push(`- ${domain}（${titles.length} 篇）：${titles.slice(0, 8).join(' · ')}${extra}`)
  }
  return lines.join('\n')
}

/**
 * Replace the text between two markers.
 * @param text - whole file.
 * @param start - opening marker.
 * @param end - closing marker.
 * @param content - replacement body.
 * @returns the file with the block replaced, unchanged when a marker is missing.
 */
export function updateBlock(text, start, end, content) {
  const startAt = text.indexOf(start)
  const endAt = text.indexOf(end)
  if (startAt < 0 || endAt < 0 || endAt < startAt) return text
  return `${text.slice(0, startAt + start.length)}\n${content}\n${text.slice(endAt)}`
}

/** 1-based line number of the first line containing `needle`, or `null`. */
export function findLine(text, needle) {
  const wanted = needle.trim()
  if (!wanted) return null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(wanted)) return i + 1
  }
  return null
}

/** Refresh the `updated:` field, adding it when the frontmatter lacks one. */
export function touchUpdated(text) {
  const day = today()
  if (/^updated:.*$/m.test(text)) return text.replace(/^updated:.*$/m, `updated: ${day}`)
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (match === null) return text
  return `---\n${match[1]}\nupdated: ${day}\n---\n${text.slice(match[0].length)}`
}

/**
 * Whether a note's file is newer than the `updated:` date it declares.
 *
 * The date is a claim, the mtime is evidence, and a mismatch means the note was
 * touched outside `write()` — bypassing the domain guard, `touchUpdated()` and
 * the CHANGELOG line together. Comparison is by whole local days: a same-day
 * edit is fine, and only a file dated strictly after its own `updated` is
 * reported, so a stale checkout (files older than their dates) never trips it.
 * @param note - a scanned note with `rel`, `root` and `meta`.
 * @returns a problem line, or `undefined` when the two agree.
 */
export async function staleUpdated(note) {
  const claimed = String(note.meta?.updated ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(claimed)) return undefined
  let stats
  try {
    stats = await stat(join(note.root, note.rel.split('/').join(sep)))
  } catch {
    return undefined
  }
  const fileDay = localDateOf(stats.mtime)
  if (fileDay <= claimed) return undefined
  return `${note.rel}: 文件修改于 ${fileDay}，但 updated 仍是 ${claimed}——绕过插件直改了文件？`
}

/**
 * The label part of a note line, without its value.
 * Table rows give their first cell, headings their text, `- label:` bullets
 * their label. Search no longer needs it (credential lines come back verbatim),
 * so it stays exported for callers that only want the label side.
 * @param line - one trimmed line.
 * @returns the label, or `''` when the line has none.
 */
export function labelOf(line) {
  const trimmed = line.trim()
  if (trimmed.startsWith('|')) {
    const cells = trimmed.replace(/^\|+|\|+$/g, '').split('|').map((cell) => cell.trim()).filter(Boolean)
    return cells.length > 0 ? cells[0] : ''
  }
  const heading = HEADING_RE.exec(trimmed)
  if (heading !== null) return heading[1].trim()
  const labelled = LABEL_RE.exec(trimmed)
  if (labelled !== null) return labelled[1].trim()
  return ''
}

/** Replace any 16+ character secret-looking run with `***`. */
export function redact(line) {
  return line.replace(SECRET_RE, '***')
}

/**
 * Whether a vault path is a credential note.
 * Values are no longer hidden, but these notes are only searched on request:
 * `search` skips them unless `includeCredentials` is set.
 */
export function isCredential(rel) {
  return rel.split('/').some((part) => part === 'credentials')
}

/**
 * Weighted recall over the vault.
 *
 * Title 5, keywords 4, summary 3, path 2, exact type 2, body occurrences up to
 * 3 — the weights the Python script used, plus the path, so familiar results
 * keep their ranking.
 *
 * The query is read as a list of whitespace-separated terms. Two rules keep
 * recall wide enough to answer a real question:
 *
 * - **Any term may hit**, not every term. "PT 登录" used to return nothing as
 *   soon as one word was missing from a note, so a note that only said 登录 in
 *   `PT站点.md` was unreachable. Coverage still ranks: a note holding all the
 *   terms scores `coverage²`, a note holding one of four scores 0.0625 of that,
 *   so the right note stays on top while near-misses are still reachable.
 * - **The whole phrase counts too.** A literal match of the joined terms (path,
 *   title or body) is worth 9: a table cell written `navigation console` and the
 *   same note written `navigation consoles` both match, the literal one first.
 *
 * `path` is matched as the vault-relative path with `/` and `_` read as spaces,
 * so the file name answers: `me/credentials/PT站点.md` holds "pt".
 * @param root - vault directory.
 * @param query - free text; terms are matched case-insensitively.
 * @param options - `limit` (default 5), `maxExcerpt` (default 120), `includeCredentials`.
 * @returns `{ found: true, hits, total }` or `{ found: false, reason }`.
 */
export async function search(root, query, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 5
  const maxExcerpt = Number.isInteger(options.maxExcerpt) && options.maxExcerpt > 0 ? options.maxExcerpt : 120
  const includeCredentials = options.includeCredentials === true
  // The knowledge layer is searched by default: it holds no instance values
  // (a hard rule in the scheme), so scanning it cannot leak anything. The
  // credential layer stays opt-in for the opposite reason.
  const includeKb = options.includeKb !== false
  const minScore = Number.isFinite(options.minScore) ? options.minScore : DEFAULT_MIN_SCORE
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { found: false, reason: '查询为空' }
  const phrase = terms.join(' ')
  const scored = []
  for (const note of await scan(root)) {
    const secretFile = isCredential(note.rel)
    if (secretFile && !includeCredentials) continue
    if (note.domain === 'kb' && !includeKb) continue
    // Archived notes stay indexed and readable on purpose, but never answer a
    // query: they are about topics rather than facts about them.
    if (UNSEARCHABLE_STATUSES.has(note.status)) continue
    const body = note.body.toLowerCase()
    const title = note.title.toLowerCase()
    const summary = note.summary.toLowerCase()
    // The path without its `.md`, separators read as spaces, so the file name
    // answers a query term: `me/credentials/PT站点.md` holds `pt`.
    const path = note.rel.toLowerCase().replace(/\.md$/, '').replace(/[\\/_]+/g, ' ')
    const keywords = note.keywords.map((keyword) => String(keyword).toLowerCase())
    let score = 0
    let occurrences = 0
    let hits = 0
    for (const term of terms) {
      const inTitle = title.includes(term)
      const inKeywords = keywords.some((keyword) => keyword.includes(term))
      const inSummary = summary.includes(term)
      const inPath = path.includes(term)
      const count = body.split(term).length - 1
      if (!inTitle && !inKeywords && !inSummary && !inPath && count === 0) continue
      hits += 1
      if (inTitle) score += 5
      if (inKeywords) score += 4
      if (inSummary) score += 3
      if (inPath) score += 2
      if (term === note.type.toLowerCase()) score += 2
      score += Math.min(count, 3)
      occurrences = Math.max(occurrences, count)
    }
    // One term out of four is a fifth of the query, not a fifth of a hit: square
    // the coverage so a full match outranks a partial one by a wide margin.
    if (hits > 0) score *= (hits / terms.length) ** 2
    // The literal phrase beats any loose collection of the same terms.
    if (terms.length > 1 && (title.includes(phrase) || summary.includes(phrase) || path.includes(phrase) || body.includes(phrase))) {
      score += 9
    }
    if (score > 0) scored.push({ note, score, occurrences })
  }
  // Two tiers, instance facts ahead of knowledge. Within a tier the score
  // decides; across tiers it normally does not, so "my NAS address" is not
  // outranked by a chip note that happens to mention local-network addressing.
  // Below the floor a note is noise rather than a weak answer: returning it
  // would let the caller read an unrelated note as the answer.
  const tierOf = (note) => (note.domain === 'kb' ? 1 : 0)
  const kept = scored.filter(({ score }) => score >= minScore)
  // The one exception to the tier rule: when the best knowledge hit is far
  // stronger than the best instance hit, the query is plainly about knowledge
  // and burying it would be wrong. Measured case — searching 「HSM 启动流程」
  // scored the HSM note 37.0 and the top instance note 1.75; strict tiering put
  // a 21x-better answer sixth behind four weak ones.
  const bestInstance = Math.max(0, ...kept.filter(({ note }) => tierOf(note) === 0).map(({ score }) => score))
  const bestKb = Math.max(0, ...kept.filter(({ note }) => tierOf(note) === 1).map(({ score }) => score))
  const knowledgeOverrides = bestKb > 0 && bestKb >= bestInstance * KB_OVERRIDE_FACTOR
  kept.sort((a, b) => (knowledgeOverrides ? 0 : tierOf(a.note) - tierOf(b.note))
    || b.score - a.score
    || (a.note.rel < b.note.rel ? -1 : a.note.rel > b.note.rel ? 1 : 0))
  if (kept.length === 0) {
    return scored.length === 0
      ? { found: false, reason: '记忆库里没有这条' }
      : { found: false, reason: `记忆库里没有匹配度够的条目（最高分 ${scored[0].score.toFixed(3)}，阈值 ${minScore}）` }
  }
  const hits = kept.slice(0, limit).map(({ note, score }) => {
    const secretFile = isCredential(note.rel)
    const lines = note.body.split('\n')
    let line = null
    let excerpt = ''
    let matchedIn = 'body'
    // Prefer a line holding the whole phrase, then any line holding a term.
    const findBy = (wanted) => {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(wanted)) return i
      }
      return -1
    }
    let found = terms.length > 1 ? findBy(phrase) : -1
    if (found >= 0) matchedIn = 'phrase'
    else found = findBy(terms[0])
    if (found < 0) {
      for (const term of terms.slice(1)) {
        found = findBy(term)
        if (found >= 0) break
      }
    }
    if (found >= 0) {
      line = found + 1 + note.lineOffset
      excerpt = lines[found].trim()
    }
    // A note can match on its title, summary, keywords or path and have no line
    // of its own to quote (a title like "宽带账号" over a body that says
    // "账号：…"). Fall back to the first non-empty body line, so the caller
    // always gets an address to read at instead of `line: null` with no excerpt.
    if (line === null) {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].trim().length > 0) {
          line = i + 1 + note.lineOffset
          excerpt = lines[i].trim()
          matchedIn = 'head'
          break
        }
      }
    }
    // Credential lines come back as written: the caller already opted in with
    // `include_credentials`, and a label-only excerpt cannot answer "密码是多少".
    if (excerpt) excerpt = redact(excerpt)
    if (excerpt.length > maxExcerpt) excerpt = `${excerpt.slice(0, maxExcerpt)}…`
    return {
      path: note.rel,
      line,
      type: note.type,
      scope: note.scope,
      status: note.status,
      score,
      title: note.title,
      summary: note.summary,
      excerpt,
      matchedIn,
      ...(secretFile ? { credential: true } : {}),
      // The caller decides whether a knowledge hit may be quoted outward, so
      // say which layer the hit came from instead of leaving it to the path.
      ...(note.domain === 'kb' ? { kb: true } : {}),
    }
  })
  return { found: true, hits, total: kept.length }
}

/**
 * Whether `root` is an existing directory that looks like a vault.
 *
 * A write used to `mkdir -p` whatever path it was handed, so a bad config value
 * silently became a new "vault" (`[object Object]` was literally created as a
 * directory this way). Only `root` itself may be missing-and-created by the
 * caller; here it has to exist, be a directory, and carry at least one of the
 * vault's own markers.
 * @param root - vault directory.
 * @returns `undefined` when usable, otherwise the reason a write must refuse.
 */
export async function vaultRootReason(root) {
  let stats
  try {
    stats = await stat(root)
  } catch {
    return `库目录不存在：${root}`
  }
  if (!stats.isDirectory()) return `库目录不是文件夹：${root}`
  const markers = ['MEMORY.md', 'INDEX.md', 'CHANGELOG.md', 'templates']
  for (const marker of markers) {
    if (existsSync(join(root, marker))) return undefined
  }
  return `目录不像记忆库（缺 MEMORY.md / INDEX.md / CHANGELOG.md / templates）：${root}`
}

/**
 * Validate a write target against the vault layout.
 * @param rel - candidate vault-relative path with `/` separators.
 * @returns a failure reason, or `undefined` when acceptable.
 */
export function invalidPathReason(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return INVALID_PATH
  if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return INVALID_PATH
  if (!rel.endsWith('.md')) return `${INVALID_PATH}：路径必须以 .md 结尾`
  const parts = rel.split('/')
  if (parts.some((part) => part === '..' || part === '.' || part.length === 0)) return INVALID_PATH
  if (!DOMAINS.has(parts[0])) return `${INVALID_PATH}：一级目录只能是 ${[...DOMAINS].join(' / ')}`
  if (parts.length === 1 && ROOT_META_FILES.has(parts[0])) return `${INVALID_PATH}：${parts[0]} 由工具维护`
  return undefined
}

/**
 * Whether a note's folder and its declared `domain` disagree.
 *
 * Only a real conflict counts: an unknown folder or an absent `domain` is not
 * this check's business (`invalidPathReason` and the required-field rule cover
 * those). The point is to make the two claims meet.
 * @param folder - first path segment.
 * @param claimed - the `domain:` value from the content, if any.
 * @returns a failure reason, or `undefined` when they agree.
 */
export function claimDomainMismatch(folder, claimed) {
  if (!claimed || !DOMAINS.has(folder)) return undefined
  if (folder === claimed) return undefined
  return `domain 与路径不符：写在 ${folder}/ 下却声明 domain: ${claimed}。二选一改一处，别让它们各说各的。`
}

/**
 * Append a body after the frontmatter block.
 *
 * The old script appended to the whole file, so a body that carried its own
 * frontmatter produced a second one. Both cases now converge on one block.
 * @param existing - current file content.
 * @param body - text to append.
 * @returns the merged content.
 */
function appendBody(existing, body) {
  // A caller that pastes a whole note — frontmatter and body — appends its body,
  // not the frontmatter a second time.
  const [, incoming] = parseFrontmatter(body)
  const tail = incoming.replace(/\s+$/, '')
  const [meta, rest] = parseFrontmatter(existing)
  if (Object.keys(meta).length === 0) return `${existing.replace(/\s+$/, '')}\n\n${tail}\n`
  const close = existing.indexOf('\n---\n', 3)
  if (close < 0) return `${existing.replace(/\s+$/, '')}\n\n${tail}\n`
  const head = existing.slice(0, close + 5)
  const content = rest.replace(/\s+$/, '')
  return content.length === 0 ? `${head}\n${tail}\n` : `${head}${content}\n\n${tail}\n`
}

/** Append one line to `CHANGELOG.md`. */
async function appendChangelog(root, rel, action, text) {
  const file = join(root, 'CHANGELOG.md')
  const line = `- ${stamp()} \`${rel}\` ${action} — ${text.slice(0, 60)}`
  const old = await readIfExists(file)
  await writeText(file, old === undefined ? `# 变更日志\n\n${line}\n` : `${old.replace(/\s+$/, '')}\n${line}\n`)
}

/**
 * Rebuild the derived files: `INDEX.md` and the `MEMORY.md` coverage block.
 * @param root - vault directory.
 * @returns the note count and whether the coverage block changed.
 */
export async function rebuildIndex(root) {
  // `writeText` creates directories, so an unvetted root would be born here even
  // without a note write — refuse instead of manufacturing a derived file into
  // whatever path the config happens to hold.
  const unusable = await vaultRootReason(root)
  if (unusable !== undefined) return { notes: 0, coverage: false, refused: unusable }
  const notes = await scan(root)
  await writeText(join(root, 'INDEX.md'), buildIndex(notes))
  // Only maintain `KB.md` once the layer exists: a vault that never opted into
  // a knowledge layer should not grow a stub file it never asked for.
  if (notes.some((note) => note.domain === 'kb') || existsSync(join(root, 'KB.md'))) {
    await writeText(join(root, 'KB.md'), buildKbIndex(notes))
  }
  const memory = await readIfExists(join(root, 'MEMORY.md'))
  let coverage = false
  if (memory !== undefined) {
    const next = updateBlock(memory, COVERAGE_START, COVERAGE_END, buildCoverage(notes))
    if (next !== memory) {
      await writeText(join(root, 'MEMORY.md'), next)
      coverage = true
    }
  }
  return { notes: notes.length, coverage }
}

/**
 * Write one note, refresh the derived index, and log the change.
 *
 * Write (template for a new note, append after the frontmatter, or replace) →
 * read back and locate the first written line → refresh `updated:` → rebuild
 * `INDEX.md` and the coverage block → append CHANGELOG.
 * @param root - vault directory.
 * @param rel - vault-relative target path.
 * @param text - Markdown to write.
 * @param options - `append` (default false).
 * @returns the `committed` report the caller must relay verbatim.
 */
export async function write(root, rel, text, options = {}) {
  const append = options.append === true
  const invalid = invalidPathReason(rel)
  if (invalid !== undefined) return { committed: false, reason: invalid }
  // Refuse a root that is not a vault: `writeText` would `mkdir -p` it and turn
  // a bad config value into a convincing-looking one-note vault.
  const unusable = await vaultRootReason(root)
  if (unusable !== undefined) return { committed: false, reason: unusable }
  const body = typeof text === 'string' ? text : ''
  if (body.trim().length === 0) return { committed: false, reason: '内容为空，未写入' }
  // Catch a mis-filed note at the moment it is written, not at the next lint.
  // The folder is the claim the caller just made; a contradicting `domain:`
  // in the text means one of the two is wrong, and the caller should decide
  // now — while it still remembers why it picked that path.
  const claimed = parseFrontmatter(body)[0].domain
  const mismatch = claimDomainMismatch(rel.split('/')[0], claimed)
  if (mismatch !== undefined) return { committed: false, reason: mismatch }
  // Landing text and read-back needle: for `append`, a pasted whole note
  // contributes only its body, and its own frontmatter never reaches the file.
  const landing = append ? parseFrontmatter(body)[1] : body
  const needle = landing.trim().split('\n')[0]
  if (!needle) return { committed: false, reason: '内容为空，未写入' }
  const file = join(root, rel.split('/').join(sep))
  const existing = await readIfExists(file)
  const existed = existing !== undefined
  const day = today()
  if (!existed) {
    const title = basename(rel).replace(/\.md$/, '')
    const header = [
      '---', `title: ${title}`, 'type: note', 'domain: inbox', 'scope: instance',
      'summary: ', 'keywords: []', 'status: draft', `created: ${day}`, `updated: ${day}`,
      '---', '', '',
    ].join('\n')
    await writeText(file, `${header}${body.replace(/\s+$/, '')}\n`)
  } else if (append) {
    await writeText(file, appendBody(existing, body))
  } else {
    await writeText(file, `${body.replace(/\s+$/, '')}\n`)
  }

  const written = await readFile(file, 'utf8')
  if (!written.includes(needle)) {
    return { committed: false, reason: '读回校验失败，写入内容未在文件中找到' }
  }
  const refreshed = touchUpdated(written)
  if (refreshed !== written) await writeText(file, refreshed)
  const finalText = await readFile(file, 'utf8')
  const line = findLine(finalText, needle)

  const { notes, coverage } = await rebuildIndex(root)
  await appendChangelog(root, rel, append && existed ? '追加' : '写入', needle)
  return {
    committed: true,
    path: rel,
    line,
    verify: 'ok',
    index: `${notes} files`,
    refreshed: { index: true, coverage },
  }
}

/**
 * Check frontmatter, links, and supersession markers.
 * @param root - vault directory.
 * @returns problems and the note count.
 */
export async function lint(root) {
  const notes = await scan(root)
  const problems = []
  const files = new Set()
  await walkAll(root, '', files)
  const names = new Set([...files].map((rel) => basename(rel)))
  const stems = new Set([...names].map((name) => name.replace(/\.[^.]*$/, '')))
  for (const note of notes) {
    const meta = note.meta
    for (const field of REQUIRED) {
      if (!meta[field]) problems.push(`${note.rel}: 缺字段 ${field}`)
    }
    if (meta.type && !TYPES.has(meta.type)) problems.push(`${note.rel}: type 越界 ${meta.type}`)
    if (meta.domain && !DOMAINS.has(meta.domain)) problems.push(`${note.rel}: domain 越界 ${meta.domain}`)
    if (meta.scope && !SCOPES.has(meta.scope)) problems.push(`${note.rel}: scope 越界 ${meta.scope}`)
    if (meta.status && !STATUSES.has(meta.status)) problems.push(`${note.rel}: status 越界 ${meta.status}`)
    if (note.summary.length > 80) problems.push(`${note.rel}: summary ${note.summary.length} 字，超过 80`)
    if (!Array.isArray(meta.keywords) || meta.keywords.length < 3) problems.push(`${note.rel}: keywords 少于 3 个`)
    if (meta.status === 'superseded' && !meta.superseded_by) problems.push(`${note.rel}: superseded 但缺 superseded_by`)
    // `updated:` is a claim; the file's own mtime is evidence. When the file is
    // newer than the date it carries, someone edited it outside `write()` —
    // which skips the domain guard, the CHANGELOG line, and `touchUpdated()`
    // alike. Nothing else would notice: the note reads and searches fine.
    const edited = await staleUpdated(note)
    if (edited !== undefined) problems.push(edited)
    // The frontmatter and the folder are two independent claims about the same
    // thing. Nothing else in the system compares them, so a note written
    // `domain: work` while sitting in `me/` reads and searches fine — it is
    // simply filed wrong, silently, until someone notices by accident.
    if (meta.domain) {
      const mismatch = claimDomainMismatch(note.rel.split('/')[0], meta.domain)
      if (mismatch !== undefined) problems.push(`${note.rel}: ${mismatch}`)
    }
    // Knowledge notes carry an authority outside the user, so an unattributed
    // note is not knowledge yet — it is a claim. `source:` is what makes it one.
    if (note.domain === 'kb' && !meta.source) problems.push(`${note.rel}: kb 笔记缺 source`)
    // Instance values in the knowledge layer are an escape route: `kb` is
    // searched without an opt-in, so an address or secret parked here becomes
    // reachable that no scan was supposed to reach.
    if (note.domain === 'kb') {
      for (const match of note.body.matchAll(INSTANCE_VALUE_RE)) {
        problems.push(`${note.rel}: kb 笔记含实例值 ${match[0]}`)
      }
    }
    for (const match of note.body.matchAll(LINK_RE)) {
      const link = match[1].trim()
      if (!link) continue
      if (files.has(link) || names.has(link) || stems.has(link)) continue
      problems.push(`${note.rel}: 链接未命中 [[${link}]]`)
    }
  }
  return { problems, notes: notes.length }
}

/**
 * Create a note in `inbox/` from a vault template.
 * @param root - vault directory.
 * @param type - template name; falls back to `通用.md`.
 * @param title - note title, used for the frontmatter and the file name.
 * @returns the created path, or a failure reason.
 */
export async function newFromTemplate(root, type, title) {
  const cleanTitle = String(title ?? '').trim()
  if (!cleanTitle) return { created: false, reason: '标题为空' }
  if (/[\\/:*?"<>|]/.test(cleanTitle)) return { created: false, reason: '标题含非法字符' }
  let source = await readIfExists(join(root, 'templates', `${type}.md`))
  if (source === undefined) source = await readIfExists(join(root, 'templates', '通用.md'))
  if (source === undefined) return { created: false, reason: 'templates 里没有可用模板' }
  const rendered = source.replaceAll('{{date}}', today()).replace(/^title:.*$/m, `title: ${cleanTitle}`)
  const dest = join(root, 'inbox', `${cleanTitle}.md`)
  if (existsSync(dest)) return { created: false, reason: `已存在: inbox/${cleanTitle}.md` }
  await writeText(dest, rendered)
  const { notes } = await rebuildIndex(root)
  return { created: true, path: `inbox/${cleanTitle}.md`, index: `${notes} files` }
}
