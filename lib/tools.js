/**
 * The four model-facing memory tools.
 *
 * Each tool is a thin adapter over `lib/vault.js`: the engine owns the vault
 * layout and the safety rules, the tools own the model-facing contract
 * (`name`, `description`, `parameters`, `output`).
 *
 * @module dsh-memory-vault/tools
 */
import { existsSync } from 'node:fs'

import { loadToolsModule } from './harness.js'
import { lint, newFromTemplate, rebuildIndex, scan, search, vaultRootReason, write } from './vault.js'

const moduleCache = new Map()

/**
 * The Host's `defineTool`, resolved once per process.
 * @returns the `defineTool` export of `@deepseek-ai/dsh-tools`.
 */
export async function loadDefineTool() {
  const cached = moduleCache.get('defineTool')
  if (cached !== undefined) return cached
  const promise = loadToolsModule().then((loaded) => loaded.defineTool)
  moduleCache.set('defineTool', promise)
  // Never poison the cache: a later reload may find the installation.
  promise.catch(() => moduleCache.delete('defineTool'))
  return promise
}

/** Render one tool result as a single text block. */
const textResult = (text) => [{ type: 'text', text }]

/** Output schema shared by every tool here: a JSON object the renderer flattens. */
const OBJECT_OUTPUT = { type: 'object', additionalProperties: true }

/**
 * Build the four tool definitions.
 *
 * Options are read from the vault on every call, so renaming the vault folder
 * in the profile config is enough — no tool redeclaration.
 * @param options - `vault` path, `searchLimit`, `maxExcerpt`, and the optional
 *   `sync` controller whose last outcome `memory_health` reports.
 * @param defineTool - the Host's `defineTool`.
 * @returns the definitions, ready for `ctx.tools.register`.
 */
export function buildTools(options, defineTool) {
  const vault = options.vault
  const limit = options.searchLimit
  const maxExcerpt = options.maxExcerpt
  const sync = options.sync

  const memorySearch = defineTool({
    name: 'memory_search',
    description:
      'Search the user\'s personal memory vault (their credentials, devices, network, projects, career, preferences). '
      + 'Call it before answering any fact about the user that someone else would answer differently. '
      + 'Returns ranked hits with vault-relative path, line number, summary, and an excerpt; read the note with '
      + '`read` using that path and `offset`/`limit`. Terms are matched loosely: a note matching any term is returned, '
      + 'ranked by how many terms it covers and by literal phrase matches, so try the 2-3 key words and skim the top hits. '
      + 'Excerpts are quoted verbatim, credential notes included. '
      + 'Credential notes (`me/credentials/`) are skipped unless `include_credentials: true`; when the user asks for '
      + 'a password, token or key, search with that flag and give back only the item they asked for. '
      + 'An empty result means the vault does not have this fact: say so plainly instead of guessing.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Text to match, case-insensitively, anywhere in the vault (a keyword, host name, project, or phrase).',
      },
      include_credentials: {
        type: 'boolean',
        description: 'Also search `me/credentials/` notes. Needed to reach a password, token or key, which come back in plain text.',
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => textResult(renderSearch(value)),
    },
    execute: (args, exec) => search(vault, String(args.query), {
      limit,
      maxExcerpt,
      includeCredentials: args.include_credentials === true,
    }).then((result) => {
      exec.signal.throwIfAborted()
      return result
    }),
    presentCall: (args) => ({ card: 'generic', title: `Search memory: ${args.query}`, kind: 'search', rawInput: args }),
    isConcurrencySafe: () => true,
  })

  const memoryWrite = defineTool({
    name: 'memory_write',
    description:
      'Write one note into the personal memory vault. Use it when the user says "记住/remember X", or when you learned a '
      + 'durable personal fact that passes three checks: it is true only for this user, it stays useful long-term, and '
      + 'forgetting it costs a repeated mistake. Search first and append to an existing note rather than creating a '
      + 'near-duplicate. The call validates the path, creates the frontmatter for a new note, refreshes `updated`, '
      + 'rebuilds INDEX.md and the MEMORY.md coverage block, and appends a CHANGELOG line. '
      + 'Relay the returned `committed` result to the user verbatim — when it is false, report `reason` unfiltered.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description:
          'Vault-relative path with `/` separators, ending in `.md`. The first segment must be one of '
          + 'me / work / life / memory / inbox; INDEX.md, MEMORY.md and CHANGELOG.md are owned by the tool. '
          + 'Examples: `me/偏好与习惯.md`, `me/credentials/账号密码.md`, `work/problems/CAN 掉线.md`, '
          + '`memory/2026-11/对话沉淀.md`, `inbox/拿不准的东西.md`.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Markdown to write. For an existing note with `append`, it is added after the frontmatter.',
      },
      append: {
        type: 'boolean',
        description: 'Append instead of replacing the note body. Ignored for a new note.',
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => textResult(renderWrite(value)),
    },
    execute: async (args) => {
      // `write()` refuses a non-vault root on its own; checking here keeps the
      // reason specific to the tool the model called.
      const unusable = await vaultRootReason(vault)
      if (unusable !== undefined) return { committed: false, reason: unusable }
      const result = await write(vault, String(args.path), String(args.text), { append: args.append === true })
      // Name this write in the next automatic commit; the controller holds it
      // until a sync actually commits, so a failed push keeps the description.
      if (result.committed === true && sync !== undefined) {
        sync.note(String(args.path), args.append === true)
      }
      return result
    },
  })

  const memoryHealth = defineTool({
    name: 'memory_health',
    description:
      'Report the health of the personal memory vault: where it lives, how many notes each domain holds, and the first '
      + 'problems `lint` finds. Use it before a maintenance pass, or when a write behaved unexpectedly.',
    parameters: {},
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => textResult(renderHealth(value)),
    },
    execute: async () => {
      if (!existsSync(vault)) return { available: false, vault, reason: `vault 不存在: ${vault}` }
      // Report a non-vault root instead of scanning it: `lint` and `scan` would
      // otherwise describe an unrelated directory as a tiny vault.
      const unusable = await vaultRootReason(vault)
      if (unusable !== undefined) return { available: false, vault, reason: unusable }
      const [result, notes] = await Promise.all([lint(vault), scan(vault)])
      const counts = {}
      for (const note of notes) counts[note.domain] = (counts[note.domain] ?? 0) + 1
      return {
        available: true,
        vault,
        notes: result.notes,
        counts,
        problems: result.problems.length,
        samples: result.problems.slice(0, 20),
        sync: sync === undefined ? undefined : sync.status(),
      }
    },
    isConcurrencySafe: () => true,
  })

  const memoryMaintain = defineTool({
    name: 'memory_maintain',
    description:
      'Maintenance operations on the personal memory vault. `index` rebuilds the derived INDEX.md and the MEMORY.md '
      + 'coverage block after a manual edit; `lint` lists every frontmatter, link and supersession problem; `new` '
      + 'creates a draft note in `inbox/` from a vault template.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['index', 'lint', 'new'],
        description: 'index: rebuild derived files. lint: report all problems. new: create a draft from a template.',
      },
      type: {
        type: 'string',
        description: 'Template name for `new`, matching a file in `templates/` (falls back to `通用.md`).',
      },
      title: {
        type: 'string',
        description: 'Note title for `new`; also the file name under `inbox/`.',
      },
    },
    output: {
      schema: OBJECT_OUTPUT,
      render: (_args, value) => textResult(renderMaintain(value)),
    },
    execute: async (args) => {
      if (!existsSync(vault)) return { op: args.op, available: false, reason: `vault 不存在: ${vault}` }
      const unusable = await vaultRootReason(vault)
      if (unusable !== undefined) return { op: args.op, available: false, reason: unusable }
      if (args.op === 'index') {
        const result = await rebuildIndex(vault)
        return { op: 'index', available: true, notes: result.notes, coverage: result.coverage }
      }
      if (args.op === 'lint') {
        const result = await lint(vault)
        return { op: 'lint', available: true, notes: result.notes, problems: result.problems }
      }
      return { op: 'new', available: true, ...await newFromTemplate(vault, String(args.type ?? ''), String(args.title ?? '')) }
    },
  })

  return [memorySearch, memoryWrite, memoryHealth, memoryMaintain]
}

/** Model-facing text for an empty search. */
function renderSearch(value) {
  if (value.found === false) return `${value.reason}`
  const lines = [`${value.hits.length} hits / ${value.total} matched notes`]
  for (const hit of value.hits) {
    const where = hit.line === null ? hit.path : `${hit.path}:${hit.line}`
    lines.push(`- ${where} — ${hit.summary || hit.title} (${hit.type}·${hit.scope}, score ${hit.score})`)
    if (hit.excerpt) lines.push(`  摘录: ${hit.excerpt}`)
    if (hit.matchedIn === 'head') lines.push('  （命中标题/摘要，此处给出首行；按行号往下读）')
    if (hit.credential) lines.push('  （凭据行，原文照录）')
  }
  return lines.join('\n')
}

/** Model-facing text for a write result. */
function renderWrite(value) {
  if (value.committed !== true) return `committed: false — ${value.reason}`
  return `committed: true · ${value.path}:${value.line} · verify ${value.verify} · index ${value.index}`
}

/** Model-facing text for the health report. */
function renderHealth(value) {
  if (value.available === false) return `记忆库不可用：${value.reason}`
  const domains = Object.entries(value.counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([domain, count]) => `${domain} ${count}`)
    .join(' · ')
  const head = `vault ${value.vault} · ${value.notes} 篇（${domains || '空'}）· lint ${value.problems} 个问题`
  const lines = [head, ...value.samples.map((problem) => `- ${problem}`)]
  const sync = value.sync
  if (sync !== undefined) {
    if (sync.at === null) lines.push('同步：尚未运行')
    else {
      const parts = []
      if (sync.push !== null) parts.push(`push ${sync.push.ok === true ? '成功' : '失败'}${sync.push.message ? `（${sync.push.message}）` : ''}`)
      if (sync.pull !== null) parts.push(`pull ${sync.pull.ok === true ? '成功' : '失败'}${sync.pull.message ? `（${sync.pull.message}）` : ''}`)
      if (sync.error !== null) parts.push(`错误：${sync.error}`)
      const every = typeof sync.intervalMs === 'number' ? `，每 ${Math.round(sync.intervalMs / 1000)} 秒` : ''
      lines.push(`同步（${sync.at}${every}）：${parts.join(' · ') || '无操作'}`)
    }
  }
  return lines.join('\n')
}

/** Model-facing text for a maintenance result. */
function renderMaintain(value) {
  if (value.available === false) return `记忆库不可用：${value.reason}`
  if (value.op === 'index') return `index 重建完成：${value.notes} 篇${value.coverage ? '，MEMORY.md 覆盖段已更新' : ''}`
  if (value.op === 'lint') {
    return value.problems.length === 0
      ? `lint: 干净（${value.notes} 篇）`
      : [`lint: ${value.problems.length} 个问题`, ...value.problems.map((problem) => `- ${problem}`)].join('\n')
  }
  return value.created === true ? `已创建 ${value.path} · index ${value.index}` : `未创建：${value.reason}`
}
