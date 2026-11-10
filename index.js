/**
 * Memory Vault for DeepSeek Harness.
 *
 * Replaces the old arrangement — a section in `~/.dsh/AGENTS.md` plus the
 * `personal-memory` skill plus a Python script — with one Host plugin:
 *
 * - one short system-prompt section states the recall rule, the credential
 *   discipline, the write flow and the self-check, so no user-instruction file
 *   or skill has to carry them;
 * - four tools (`memory_search`, `memory_write`, `memory_health`,
 *   `memory_maintain`) do the work against the vault folder;
 * - the vault folder is edited in **Settings → 记忆库**, not in the YAML: the
 *   field is `volatile`, so a saved value re-applies this plugin in place and
 *   the tools plus the prompt pick it up without a restart.
 *
 * Failures stay local: a missing or unusable vault leaves the plugin mounted and
 * reports through tool results and one warning, never through a startup error,
 * and never by scanning a directory that is not the vault.
 *
 * @module dsh-memory-vault
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { DEFAULT_SYNC_INTERVAL_SECONDS, createSyncController } from './lib/sync.js'
import { buildTools, loadDefineTool } from './lib/tools.js'

/** Cordis plugin name. */
export const name = 'memory-vault'

/**
 * Prompt and tool registries. Both are mandatory for the plugin to do its job,
 * and both are part of every bundle this plugin is meant to run in.
 */
export const inject = ['tools', 'systemPrompt']

/** Section order: after file references (9000), before structured output (9900). */
export const DEFAULT_PROMPT_ORDER = 9600

/**
 * Config schema.
 *
 * Every field is `.volatile()`: the settings service only exposes volatile
 * fields in its remote form, and a volatile edit re-applies this plugin without
 * remounting it. `vault` defaults to an empty string so the row can load before
 * anyone picks a folder — the prompt section then reports the vault as
 * unavailable instead of the plugin failing to mount.
 */
export const Config = z.object({
  vault: z.string().default('').volatile().description('记忆库文件夹的绝对路径'),
  searchLimit: z.number().default(5).volatile().description('检索最多返回多少条命中'),
  maxExcerpt: z.number().default(120).volatile().description('摘录截断长度（字符）'),
  promptOrder: z.number().default(DEFAULT_PROMPT_ORDER).volatile().description('常驻提示段的排序位置'),
  syncEnabled: z.boolean().default(true).volatile().description('自动与远程同步（启动时拉取一次，之后定时提交并推送）'),
  syncIntervalSeconds: z.number().default(DEFAULT_SYNC_INTERVAL_SECONDS).volatile()
    .description('自动同步的间隔（秒）；小于 60 按 60 处理'),
})

/**
 * Unwrap one config field.
 *
 * A `.volatile()` field does not arrive as its value: schemastery wraps it in a
 * volatile cell, so `config.vault` is `{ … }` and `JSON.stringify` shows `{}`.
 * The value lives behind `get()`. Everything here therefore reads through this
 * helper instead of touching the field directly — reading `.vault` as a string
 * is what made the plugin see an empty path and silently register no tools.
 * @param raw - a config field, volatile cell or plain value.
 * @returns the underlying value, or `undefined` when it cannot be read.
 */
export function fieldOf(raw) {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      return raw.get()
    } catch {
      return undefined
    }
  }
  return raw
}

/**
 * Read the configured vault path, whatever shape the config layer hands over.
 *
 * Only a real string is a path: coercing an object with `String()` yields
 * `"[object Object]"`, which `mkdir -p` happily turns into a directory, so a
 * bad config used to look like a working one-note vault. Unusable values are
 * treated as unset and reported, never coerced.
 * @param raw - the `vault` field as resolved for this entry (volatile cell or string).
 * @returns the trimmed absolute path, or an empty string when nothing usable is set.
 */
export function vaultPathOf(raw) {
  const value = fieldOf(raw)
  const text = typeof value === 'string' ? value : ''
  const trimmed = text.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1').trim()
  if (trimmed.length === 0) return ''
  return isAbsolute(trimmed) ? resolve(trimmed) : ''
}

/**
 * Read one numeric config field, honouring a volatile wrapper.
 * @param raw - the field.
 * @param fallback - value when the field is absent or not a number.
 * @returns the number to use.
 */
export function numberOf(raw, fallback) {
  const value = fieldOf(raw)
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Compose the standing guidance.
 *
 * Deliberately short: the tools carry the mechanics, so this section only has
 * to say when to reach for them, what never to expose, and how to report a
 * write. Every line is a rule the old AGENTS.md section stated, minus the ones
 * the tools now enforce themselves.
 *
 * Line budget is real: this text enters the system prompt of every session, so
 * each entry must stop a specific mistake that has actually happened. Three
 * rules earned their place that way — the source test (filing by vocabulary put
 * a project note into the chip knowledge layer), the meta-document rule (a
 * design note outranked the fact it was describing), and the write rule (an
 * entire refactor bypassed `write()` because it was "not remembering").
 * @param vault - vault folder shown to the model.
 * @param available - whether the folder exists right now.
 * @returns the section text.
 */
export function renderGuide(vault, available) {
  const lines = [
    '## 个人记忆库（memory-vault 插件）',
    '',
    `三层记忆库：\`${vault}\``,
    '',
    '- **分层问「这是谁的东西」**：芯片厂／标准组织／工具作者写的规格与语义 → `kb/`；**我自己干活的经验**（踩坑、移植、优化的做法与结论）→ `work/`；我的生活与设备 → `me/`、`life/`；拿不准 → `inbox/`。不要按词汇归类——出现 HSM、AES 不代表它是芯片知识。',
    '- **判断查不查**：只有「我」的事实才查（凭据、设备、项目经历、偏好）。通用知识直接答；与本人无关的问题也不要为查库道歉。',
    '- **检索**：`memory_search` 返回 `路径:行号` 与摘录，读时带 `offset`/`limit`。知识层默认参与检索，配置层优先，知识层分数达 3 倍时置顶。`score < 0.2` 是噪音，换词重搜。没命中就直说「记忆库里没有这条」，不要用「一般」「通常」填补。',
    '- **凭据**：`me/credentials/` 是明文，查密码、token 就带 `include_credentials: true`，命中行原文即值。拿到值只做两件事：用在用户要办的事上，或原样回给用户；不写进日志、不写进 commit、不主动多说第二条。',
    '- **写入**：改库内任何 `.md` 都走 `memory_write`，不限于「记住 X」——修错、重构、搬迁同样。直改 edit/write 会跳过 domain 门禁、`updated` 刷新与 CHANGELOG。**必须把返回的 `committed` 原文回报**，`committed: false` 时把 `reason` 原样报出，改一处后重试，不要换路径绕开。',
    '- **讨论主题的文档**（方案、复盘、设计说明）一律 `status: archived`：仍在索引里可读，但不参与检索，否则它会靠字面引用抢走真实事实的排名。',
    '- **自检**：回答涉及「我」的事实前先问这条从哪来——来自刚读的文件才算查过库；来自印象或推断就是没查，回去查。',
  ]
  if (!available) {
    lines.push('', `**库当前不可用**：\`${vault}\` 不存在或不可读。涉及「我」的事实要明说「记忆库不可用」，不要用「一般」「通常」填补。`)
  }
  return lines.join('\n')
}

/** The section text for a vault that has not been chosen yet. */
export const UNCONFIGURED_GUIDE = [
  '## 个人记忆库（memory-vault 插件）',
  '',
  '记忆库文件夹还没配置或配置无效（设置 → 记忆库）。涉及本人事实时明说「记忆库不可用」，不要用「一般」「通常」填补。',
].join('\n')

/**
 * Mount the prompt section and the four tools.
 * @param ctx - plugin context.
 * @param config - resolved plugin config (`vault`, `searchLimit`, `maxExcerpt`, `promptOrder`).
 */
export function apply(ctx, config) {
  const vault = vaultPathOf(config?.vault)
  const available = vault.length > 0 && existsSync(vault)
  const order = numberOf(config?.promptOrder, DEFAULT_PROMPT_ORDER)
  const searchLimit = numberOf(config?.searchLimit, 5)
  const maxExcerpt = numberOf(config?.maxExcerpt, 120)

  if (vault.length === 0 && fieldOf(config?.vault) !== undefined && fieldOf(config?.vault) !== '') {
    // A value arrived but is not a usable absolute path. Name it, so a bad
    // settings write is diagnosable instead of silently ignored.
    ctx.logger?.warn?.(`memory-vault: unusable vault config ${JSON.stringify(fieldOf(config.vault))}`)
  }
  if (vault.length > 0 && !available) {
    ctx.logger?.warn?.(`memory-vault: vault folder does not exist — ${vault}`)
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory-vault',
    order,
    // `interpolate: false`: vault paths contain backslashes, and the prompt
    // renderer treats every `{{` as a variable reference.
    interpolate: false,
    text: vault.length === 0 ? UNCONFIGURED_GUIDE : renderGuide(vault, available),
  }), 'memory-vault.section()')

  if (!available) {
    ctx.logger?.warn?.('memory-vault: no usable vault folder — the four memory tools stay unregistered')
    return
  }

  // Automatic sync: one pull at startup (a fresh machine must not answer from a
  // stale checkout), then push+pull on a timer. `syncEnabled: false` turns the
  // timer off but keeps the startup pull out of the way too, so a vault that is
  // not a git repository costs nothing.
  const syncEnabled = fieldOf(config?.syncEnabled) !== false
  const intervalMs = Math.max(60, numberOf(config?.syncIntervalSeconds, DEFAULT_SYNC_INTERVAL_SECONDS)) * 1000
  const sync = syncEnabled
    ? createSyncController({ vault, intervalMs, pushMessage: undefined, timeoutMs: undefined })
    : undefined

  if (sync !== undefined) {
    ctx.effect(() => {
      let disposed = false
      sync.prime().then((outcome) => {
        if (disposed) return
        if (outcome.error !== null || outcome.pull?.ok === false) {
          ctx.logger?.warn?.(`memory-vault: startup pull failed — ${outcome.error ?? outcome.pull?.message}`)
        }
      }).catch(() => {
        // The controller already records its own failures.
      })
      // `timer` is an optional service: without it the startup pull still runs
      // and the tools still work, they just stop syncing on a schedule.
      const timer = ctx.get?.('timer')
      const stop = typeof timer?.interval === 'function'
        ? timer.interval(() => { void sync.runOnce() }, intervalMs)
        : undefined
      if (stop === undefined) {
        ctx.logger?.warn?.('memory-vault: no timer service — periodic sync is off')
      }
      return () => {
        disposed = true
        if (typeof stop === 'function') stop()
      }
    }, 'memory-vault.sync()')
  }

  // The tools module comes from the running installation, so registration is
  // async. One effect owns all four: a reload either publishes every tool or
  // none, and unload disposes exactly what this mount registered.
  ctx.effect(() => {
    let disposed = false
    const tools = []
    loadDefineTool().then((defineTool) => {
      if (disposed) return
      for (const definition of buildTools({
        vault,
        searchLimit,
        maxExcerpt,
        sync,
      }, defineTool)) {
        tools.push(ctx.tools.register(definition))
      }
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.error?.(`memory-vault: tools unavailable — ${message}`)
    })
    return () => {
      disposed = true
      while (tools.length > 0) {
        const off = tools.pop()
        try {
          off()
        } catch {
          // A disposer that already ran is not an error.
        }
      }
    }
  }, 'memory-vault.tools()')
}
