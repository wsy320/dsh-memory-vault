/**
 * Index equivalence: the port must reproduce the vault's existing derived
 * files byte for byte, or every write would churn the repository.
 *
 * The test copies the live vault into a temp directory, then compares
 * `buildIndex()` with `INDEX.md` and the coverage block inside `MEMORY.md`.
 * Set DSH_MEMORY_VAULT to point at a different vault.
 *
 * @module dsh-memory-vault/test/vault
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildCoverage,
  buildIndex,
  invalidPathReason,
  labelOf,
  lint,
  newFromTemplate,
  parseFrontmatter,
  rebuildIndex,
  scan,
  search,
  today,
  updateBlock,
  write,
  COVERAGE_END,
  COVERAGE_START,
} from '../lib/vault.js'

// Point this at a real vault to run the live-vault cases; when unset they are
// skipped instead of failing, so the suite runs on any machine.
const LIVE_VAULT = process.env.DSH_MEMORY_VAULT ?? ''

/** Copy the live vault to a temp directory. */
async function copyVault() {
  const root = await mkdtemp(join(tmpdir(), 'memory-vault-'))
  await cp(LIVE_VAULT, root, { recursive: true })
  return root
}

/**
 * Blank the generation date stamped into INDEX.md's header.
 *
 * `buildIndex()` writes today's date, so a byte-for-byte comparison against a
 * committed INDEX.md only holds on the day it was last rebuilt. The generator
 * line is the one thing that legitimately changes daily; everything else in the
 * file is the invariant these tests are about.
 * @param text - INDEX.md content.
 * @returns the content with the `YYYY-MM-DD` in the header line replaced.
 */
function withoutBuildDate(text) {
  return text.replace(/(^> \d+ 篇 · )\d{4}-\d{2}-\d{2}( 生成)/m, '$1<date>$2')
}

/** Extract the coverage block body from MEMORY.md. */
function coverageBlock(text) {
  const start = text.indexOf(COVERAGE_START)
  const end = text.indexOf(COVERAGE_END)
  assert.ok(start >= 0 && end > start, 'MEMORY.md must keep both coverage markers')
  return text.slice(start + COVERAGE_START.length, end).replace(/^\n/, '').replace(/\n$/, '')
}

test('buildIndex reproduces the live INDEX.md', { skip: !existsSync(LIVE_VAULT) }, async () => {
  const notes = await scan(LIVE_VAULT)
  const expected = await readFile(join(LIVE_VAULT, 'INDEX.md'), 'utf8')
  assert.equal(withoutBuildDate(buildIndex(notes)), withoutBuildDate(expected))
})

test('buildCoverage reproduces the MEMORY.md coverage block', { skip: !existsSync(LIVE_VAULT) }, async () => {
  const notes = await scan(LIVE_VAULT)
  const memory = await readFile(join(LIVE_VAULT, 'MEMORY.md'), 'utf8')
  assert.equal(buildCoverage(notes), coverageBlock(memory))
})

test('buildCoverage orders titles by case-insensitive path', () => {
  // Deliberately scrambled: the walk puts `me/credentials/*` first, and the
  // nested folders of `work` arrive in their own walk order. Coverage must not
  // inherit either — it sorts by path the way `memory.py` did, which means
  // `WindowsPath` order: case-insensitive, so `me/credentials/…` beats
  // `me/Tailscale.md` (`t` 0x74 > `c` 0x63) even though `T` is 0x54 < `c`.
  const note = (rel, title, domain) => ({ rel, domain, title })
  const notes = [
    note('me/credentials/API密钥.md', 'API密钥', 'me'),
    note('me/credentials/金融账户.md', '金融账户', 'me'),
    note('me/Tailscale.md', 'Tailscale', 'me'),
    note('me/设备与主机.md', '设备与主机', 'me'),
    note('work/projects/ti-2944/启动时间优化.md', '启动时间优化', 'work'),
    note('work/projects/ti-2944/HSM启动流程.md', 'HSM启动流程', 'work'),
    note('work/career/个人简历.md', '个人简历', 'work'),
    note('life/finances/账本说明.md', '账本说明', 'life'),
  ]
  assert.equal(buildCoverage(notes), [
    '- me（4 篇）：API密钥 · 金融账户 · Tailscale · 设备与主机',
    // `hs` (normcased) < `启` (U+542F), so the HSM note precedes 启动时间优化.
    '- work（3 篇）：个人简历 · HSM启动流程 · 启动时间优化',
    '- life（1 篇）：账本说明',
    '- memory：0 篇',
    '- inbox：0 篇',
    '- kb：0 篇',
  ].join('\n'))
  // Input order must not matter: the same notes reversed give the same block.
  assert.equal(buildCoverage([...notes].reverse()), buildCoverage(notes))
})

test('buildCoverage puts a case-variant path after its lowercase sibling', () => {
  // Without case folding `me/Tailscale.md` would lead the line, because `T`
  // (0x54) precedes `c` (0x63). Pin the folded order, and the byte fallback
  // that keeps two notes differing only in case deterministic.
  const notes = [
    { rel: 'me/Tailscale.md', title: 'Tailscale', domain: 'me' },
    { rel: 'me/credentials/API密钥.md', title: 'API密钥', domain: 'me' },
    { rel: 'me/note.md', title: 'note', domain: 'me' },
    { rel: 'me/Note.md', title: 'Note', domain: 'me' },
  ]
  const line = buildCoverage(notes).split('\n')[0]
  assert.equal(line, '- me（4 篇）：API密钥 · Note · note · Tailscale')
  assert.equal(buildCoverage([...notes].reverse()).split('\n')[0], line)
})

test('rebuildIndex on a copy leaves INDEX.md and MEMORY.md unchanged', { skip: !existsSync(LIVE_VAULT) }, async () => {
  const root = await copyVault()
  try {
    const beforeIndex = await readFile(join(root, 'INDEX.md'), 'utf8')
    const beforeMemory = await readFile(join(root, 'MEMORY.md'), 'utf8')
    const result = await rebuildIndex(root)
    assert.ok(result.notes > 0)
    assert.equal(withoutBuildDate(await readFile(join(root, 'INDEX.md'), 'utf8')), withoutBuildDate(beforeIndex))
    assert.equal(await readFile(join(root, 'MEMORY.md'), 'utf8'), beforeMemory)
    assert.equal(result.coverage, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('frontmatter parsing matches the simple YAML subset', () => {
  const [meta, body] = parseFrontmatter('---\ntitle: 设备\ntype: device\nkeywords: [a, "b", c]\nsummary:\n---\n正文\n')
  assert.equal(meta.title, '设备')
  assert.deepEqual(meta.keywords, ['a', 'b', 'c'])
  assert.equal(body, '正文\n')
  const [none, whole] = parseFrontmatter('# 没有 frontmatter\n')
  assert.deepEqual(none, {})
  assert.equal(whole, '# 没有 frontmatter\n')
})

test('updateBlock replaces only the marked region', () => {
  const text = `head\n${COVERAGE_START}\nold\n${COVERAGE_END}\ntail\n`
  assert.equal(updateBlock(text, COVERAGE_START, COVERAGE_END, 'new'), `head\n${COVERAGE_START}\nnew\n${COVERAGE_END}\ntail\n`)
  assert.equal(updateBlock('no markers', COVERAGE_START, COVERAGE_END, 'x'), 'no markers')
})

test('invalidPathReason rejects escapes and unknown roots', () => {
  assert.equal(invalidPathReason('me/偏好与习惯.md'), undefined)
  assert.equal(invalidPathReason('memory/2026-11/对话沉淀.md'), undefined)
  assert.equal(invalidPathReason('../outside.md'), '非法路径')
  assert.match(invalidPathReason('C:/abs.md'), /非法路径/)
  assert.match(invalidPathReason('elsewhere/note.md'), /一级目录/)
  // Root-level meta files are outside DOMAINS, so the domain check fires first.
  assert.match(invalidPathReason('INDEX.md'), /一级目录/)
  assert.match(invalidPathReason('inbox/note.txt'), /\.md/)
})

test('labelOf exposes a label and never the value', () => {
  assert.equal(labelOf('- NAS 密码：hunter2'), 'NAS 密码')
  assert.equal(labelOf('| 站点 | 账号 | 密码 |'), '站点')
  assert.equal(labelOf('## 路由器'), '路由器')
})

test('write, index refresh and changelog on a scratch vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-scratch-'))
  try {
    await writeFile(join(root, 'MEMORY.md'), `# 库\n\n${COVERAGE_START}\n${COVERAGE_END}\n`, 'utf8')
    const created = await write(root, 'inbox/测试条目.md', '- 第一条记忆\n- 第二条')
    assert.equal(created.committed, true)
    assert.equal(created.path, 'inbox/测试条目.md')
    const text = await readFile(join(root, 'inbox/测试条目.md'), 'utf8')
    assert.ok(text.startsWith('---\ntitle: 测试条目\n'))
    // The reported line is the final file's line, after `updated:` was rewritten.
    assert.equal(created.line, text.split('\n').findIndex((line) => line.includes('- 第一条记忆')) + 1)

    const appended = await write(root, 'inbox/测试条目.md', '- 第三条记忆', { append: true })
    assert.equal(appended.committed, true)
    const merged = await readFile(join(root, 'inbox/测试条目.md'), 'utf8')
    assert.equal(merged.match(/^---$/gm).length, 2)
    assert.ok(merged.endsWith('- 第三条记忆\n'))
    assert.equal(appended.line, merged.split('\n').findIndex((line) => line.includes('- 第三条记忆')) + 1)

    const index = await readFile(join(root, 'INDEX.md'), 'utf8')
    assert.match(index, /inbox\/测试条目\.md/)
    const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    assert.match(changelog, /追加/)
    const memory = await readFile(join(root, 'MEMORY.md'), 'utf8')
    assert.match(memory, /inbox（1 篇）/)

    const rejected = await write(root, '../escape.md', 'x')
    assert.deepEqual(rejected, { committed: false, reason: '非法路径' })
    const empty = await write(root, 'inbox/空.md', '   ')
    assert.equal(empty.committed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('credential notes are searched only on request and return values verbatim', { skip: !existsSync(LIVE_VAULT) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-secret-'))
  try {
    await writeFile(join(root, 'MEMORY.md'), `# 库\n\n${COVERAGE_START}\n${COVERAGE_END}\n`, 'utf8')
    const token = 'sk-live-abcdefghijklmnop'
    await write(root, 'me/credentials/测试凭据.md', `- NAS 密码：hunter2\n- API 令牌：${token}`, { append: false })
    const hidden = await search(root, 'NAS', {})
    assert.equal(hidden.found, false)
    const included = await search(root, 'NAS', { includeCredentials: true })
    assert.equal(included.found, true)
    assert.equal(included.hits[0].path, 'me/credentials/测试凭据.md')
    assert.equal(included.hits[0].credential, true)
    // The agent must be able to read the value it was asked for.
    assert.equal(included.hits[0].excerpt, '- NAS 密码：hunter2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a title-only match falls back to the first body line, not to nothing', { skip: !existsSync(LIVE_VAULT) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-head-'))
  try {
    await writeFile(join(root, 'MEMORY.md'), `# 库\n\n${COVERAGE_START}\n${COVERAGE_END}\n`, 'utf8')
    // `宽带账号` lives only in the frontmatter; the body never repeats the
    // joined phrase, so a term-by-term body scan finds no line to quote.
    const front = '---\ntitle: 宽带账号\ntype: credential\ndomain: me\nscope: instance\nsummary: 宽带登录\nkeywords: []\nstatus: active\ncreated: 2026-11-06\nupdated: 2026-11-06\n---\n'
    await mkdir(join(root, 'me', 'credentials'), { recursive: true })
    await writeFile(join(root, 'me', 'credentials', '宽带.md'), `${front}\n- 账号：\`ad51299856\`\n- 密码：\`hunter2\`\n`, 'utf8')
    const result = await search(root, '宽带账号', { includeCredentials: true })
    assert.equal(result.found, true)
    const hit = result.hits.find((entry) => entry.path === 'me/credentials/宽带.md')
    assert.ok(hit, 'the credential note must be among the hits')
    assert.equal(hit.matchedIn, 'head')
    assert.equal(typeof hit.line, 'number')
    assert.equal(hit.excerpt, '- 账号：`ad51299856`')
    // The reported line must actually address that text in the file on disk.
    const lines = (await readFile(join(root, hit.path), 'utf8')).split('\n')
    assert.equal(lines[hit.line - 1].trim(), hit.excerpt)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a partial term match still reaches the note, and coverage keeps ranking honest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-any-'))
  try {
    await writeFile(join(root, 'MEMORY.md'), `# 库\n\n${COVERAGE_START}\n${COVERAGE_END}\n`, 'utf8')
    // The file name carries `PT`, its body never spells it out.
    await write(root, 'me/credentials/PT站点.md', '- 站名：极客站\n- 登录方式：浏览器密码保存', { append: false })
    // A different note holds only `登录`, away from the word `PT`.
    await write(root, 'work/problems/登录失败.md', '登录失败的排查记录', { append: false })
    const partial = await search(root, 'PT 登录', { includeCredentials: true })
    assert.equal(partial.found, true)
    assert.equal(partial.hits[0].path, 'me/credentials/PT站点.md', 'the path counts as a hit and holds 2 of 2 terms')
    assert.ok(partial.hits.some((hit) => hit.path === 'work/problems/登录失败.md'), 'a one-term match stays reachable')

    // The literal phrase outranks a loose word match. The note that holds both
    // words outranks the notes that hold only one.
    await write(root, 'me/设备与主机.md', '| NAS | 192.168.1.10 | 家庭存储 |', { append: false })
    await write(root, 'me/网络代理.md', 'NAS 上的代理日志，登录入口见路由器', { append: false })
    const ranked = await search(root, 'NAS 登录', {})
    assert.equal(ranked.hits[0].path, 'me/网络代理.md')
    assert.ok(ranked.hits.some((hit) => hit.path === 'me/设备与主机.md'), 'the one-term note is still listed')

    // A blank-term query finds nothing rather than everything.
    const empty = await search(root, '   ', {})
    assert.equal(empty.found, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the literal phrase is quoted, not just a word from it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-phrase-'))
  try {
    await writeFile(join(root, 'MEMORY.md'), `# 库\n\n${COVERAGE_START}\n${COVERAGE_END}\n`, 'utf8')
    await write(root, 'work/note.md', '无关的一行\n这里是 navigation console 的用法\n又一行 console 字样', { append: false })
    const result = await search(root, 'navigation console', {})
    assert.equal(result.found, true)
    assert.equal(result.hits[0].matchedIn, 'phrase')
    assert.equal(result.hits[0].excerpt, '这里是 navigation console 的用法')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lint reports the same problem classes on a scratch vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lint-'))
  try {
    await writeFile(join(root, 'bad.md'), '---\ntitle: 坏\ntype: unknown-domain\n---\n见 [[不存在]]\n', 'utf8')
    const result = await lint(root)
    assert.ok(result.problems.some((problem) => problem.includes('缺字段')))
    assert.ok(result.problems.some((problem) => problem.includes('type 越界')))
    assert.ok(result.problems.some((problem) => problem.includes('链接未命中')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('newFromTemplate creates an inbox note once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-new-'))
  try {
    await writeFile(join(root, 'MEMORY.md'), `# 库\n\n${COVERAGE_START}\n${COVERAGE_END}\n`, 'utf8')
    const template = '---\ntitle: 模板\ntype: note\ndomain: inbox\nscope: instance\nsummary: \nkeywords: [a, b, c]\nstatus: draft\ncreated: {{date}}\nupdated: {{date}}\n---\n\n# 标题\n'
    await mkdir(join(root, 'templates'), { recursive: true })
    await writeFile(join(root, 'templates', '通用.md'), template, 'utf8')
    const created = await newFromTemplate(root, '问题', '重启后 CAN 掉线')
    assert.equal(created.created, true)
    assert.equal(created.path, 'inbox/重启后 CAN 掉线.md')
    const again = await newFromTemplate(root, '问题', '重启后 CAN 掉线')
    assert.equal(again.created, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lint flags a note whose folder and domain disagree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-mismatch-'))
  try {
    await mkdir(join(root, 'me'), { recursive: true })
    const misfiled = '---\ntitle: 放错了\ntype: note\ndomain: work\nscope: instance\nsummary: 写在 me 下却声明 work\nkeywords: [错位, 归档, 校验]\nstatus: active\ncreated: 2026-11-09\nupdated: 2026-11-09\n---\n\n正文。\n'
    await writeFile(join(root, 'me', '放错了.md'), misfiled, 'utf8')
    const { problems } = await lint(root)
    assert.ok(problems.some((p) => p.includes('domain 与路径不符')), `expected mismatch problem, got ${problems.join(' | ')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search ranks instance facts ahead of knowledge on a tie', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-kb-'))
  try {
    const fm = (title, domain, type) => `---\ntitle: ${title}\ntype: ${type}\ndomain: ${domain}\nscope: reference\nsummary: 关于 NAS 地址的说明\nkeywords: [NAS, 地址, 局域网]\nstatus: active\ncreated: 2026-11-09\nupdated: 2026-11-09\nsource: 实测\n---\n\nNAS 地址记在这里。\n`
    await mkdir(join(root, 'me'), { recursive: true })
    await mkdir(join(root, 'kb', 'tooling'), { recursive: true })
    await writeFile(join(root, 'me', '设备.md'), fm('设备', 'me', 'device'), 'utf8')
    await writeFile(join(root, 'kb', 'tooling', '网络.md'), fm('网络', 'kb', 'tooling'), 'utf8')
    const result = await search(root, 'NAS 地址', {})
    assert.equal(result.found, true)
    assert.equal(result.hits[0].path, 'me/设备.md')
    assert.equal(result.hits[1].kb, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a far stronger knowledge hit may outrank the instance tier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-override-'))
  try {
    const mk = (title, domain, type, summary, body) => `---\ntitle: ${title}\ntype: ${type}\ndomain: ${domain}\nscope: reference\nsummary: ${summary}\nkeywords: [寄存器, 启动, HSM]\nstatus: active\ncreated: 2026-11-09\nupdated: 2026-11-09\nsource: 实测\n---\n\n${body}\n`
    await mkdir(join(root, 'me'), { recursive: true })
    await mkdir(join(root, 'kb', 'silicon'), { recursive: true })
    await writeFile(join(root, 'me', '随手记.md'), mk('随手记', 'me', 'note', '一句带过', '偶尔提到 HSM 一次。'), 'utf8')
    await writeFile(join(root, 'kb', 'silicon', '启动.md'), mk('HSM 启动', 'kb', 'silicon', 'HSM 启动流程', 'HSM 启动流程 HSM 启动流程 HSM 启动流程 HSM 启动流程'), 'utf8')
    const result = await search(root, 'HSM 启动', {})
    assert.equal(result.found, true)
    assert.equal(result.hits[0].kb, true)
    assert.equal(result.hits[0].path, 'kb/silicon/启动.md')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an archived note stays indexed but never answers a query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-archived-'))
  try {
    const mk = (title, status, body) => `---\ntitle: ${title}\ntype: note\ndomain: me\nscope: instance\nsummary: 关于 ${title} 的说明\nkeywords: [${title}, 说明, 笔记]\nstatus: ${status}\ncreated: 2026-11-09\nupdated: 2026-11-09\n---\n\n${body}\n`
    await mkdir(join(root, 'me'), { recursive: true })
    await writeFile(join(root, 'me', '有效.md'), mk('有效', 'active', '这条是真实事实。'), 'utf8')
    await writeFile(join(root, 'me', '方案.md'), mk('方案', 'archived', '讨论 有效 这个词该怎么用。'), 'utf8')
    const result = await search(root, '有效', {})
    assert.equal(result.found, true)
    assert.ok(result.hits.every((h) => h.path !== 'me/方案.md'), `archived note must not answer`)
    const notes = await scan(root)
    assert.ok(notes.some((n) => n.rel === 'me/方案.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lint flags a file edited after the date its updated field claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-stale-'))
  try {
    await mkdir(join(root, 'me'), { recursive: true })
    // Body edited now, frontmatter still claiming a past date: the shape a
    // direct `edit` leaves behind, since it never runs touchUpdated().
    const stale = '---\ntitle: 旧\ntype: note\ndomain: me\nscope: instance\nsummary: 测试过期检测\nkeywords: [过期, 校验, 测试]\nstatus: active\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n正文。\n'
    await writeFile(join(root, 'me', '旧.md'), stale, 'utf8')
    // A note whose declared date is today must stay quiet: same-day edits are legal.
    // Uses today() rather than a literal date so the case cannot go stale.
    const fresh = `---\ntitle: 新\ntype: note\ndomain: me\nscope: instance\nsummary: 当天写入不应报警\nkeywords: [今天, 校验, 测试]\nstatus: active\ncreated: ${today()}\nupdated: ${today()}\n---\n\n正文。\n`
    await writeFile(join(root, 'me', '新.md'), fresh, 'utf8')
    const { problems } = await lint(root)
    assert.ok(problems.some((p) => p.includes('me/旧.md') && p.includes('updated 仍是')), `expected stale problem, got ${problems.join(' | ')}`)
    assert.ok(!problems.some((p) => p.includes('me/新.md')), 'a same-day note must not be flagged')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('write refreshes updated but leaves created alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-touch-'))
  try {
    await mkdir(join(root, 'templates'), { recursive: true })
    await mkdir(join(root, 'me'), { recursive: true })
    await writeFile(join(root, 'MEMORY.md'), `# 库\n\n${COVERAGE_START}\n${COVERAGE_END}\n`, 'utf8')
    const old = '---\ntitle: 测试\ntype: note\ndomain: me\nscope: instance\nsummary: 校验 updated 自动刷新\nkeywords: [刷新, 日期, 测试]\nstatus: active\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n\n第一行。\n'
    await writeFile(join(root, 'me', '测试.md'), old, 'utf8')
    const result = await write(root, 'me/测试.md', '追加的一行。', { append: true })
    assert.equal(result.committed, true)
    const after = await readFile(join(root, 'me', '测试.md'), 'utf8')
    assert.match(after, new RegExp(`^updated: ${today()}$`, 'm'))
    assert.match(after, /^created: 2020-01-01$/m)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
