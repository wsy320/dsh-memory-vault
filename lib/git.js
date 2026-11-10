/**
 * Git operations for the memory vault's automatic sync.
 *
 * The vault is its own git repository, so keeping machines consistent is a
 * matter of commit/push/pull, not of a bespoke merge. Three rules shape every
 * function here:
 *
 * 1. **Never strand the repository.** Any operation that leaves git mid-state
 *    (a conflicting rebase, a failed merge) is rolled back before returning, so
 *    the next read or write still works.
 * 2. **Never lose work.** A push commits first: a commit is local and always
 *    succeeds, while a push needs the network. A failed push therefore leaves the
 *    work recorded rather than discarded.
 * 3. **Never block on the network longer than a timeout.** The Gitea remote here
 *    answers in ~12s when reachable and never when offline; without a timeout a
 *    sync attempt would hang the caller.
 *
 * @module dsh-memory-vault/git
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Default ceiling for one network-touching git command. */
export const DEFAULT_NETWORK_TIMEOUT_MS = 20000

/**
 * Run one git command in the vault.
 *
 * `git` is spawned without a shell so paths containing spaces or quotes cannot be
 * re-interpreted, and with prompting disabled so a missing credential fails fast
 * instead of waiting for a terminal that will never answer.
 * @param vault - repository working tree.
 * @param args - git arguments.
 * @param timeoutMs - kill the process after this long.
 * @returns `{ code, stdout, stderr, timedOut }`.
 */
export function runGit(vault, args, timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', vault, ...args], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_ASKPASS: 'echo' },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: String(error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/** Whether the folder is the top level of a git repository. */
export async function isRepository(vault) {
  if (!existsSync(join(vault, '.git'))) return false
  const { code, stdout } = await runGit(vault, ['rev-parse', '--is-inside-work-tree'], 5000)
  return code === 0 && stdout.trim() === 'true'
}

/**
 * Parse `git status --porcelain=v1 -z` into one record per changed path.
 *
 * Porcelain v1 puts the two-letter code first, a space, then the path; `-z`
 * replaces the newline separator with NUL and leaves paths unquoted, so non-ASCII
 * names survive intact. A rename carries its source as a second NUL field.
 * @param raw - NUL-separated status output.
 * @returns change records in git's order.
 */
export function parseStatus(raw) {
  const fields = raw.split('\0').filter((field) => field.length > 0)
  const changes = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    const renamed = code.includes('R') || code.includes('C')
    const from = renamed ? fields[index + 1] : undefined
    if (renamed) index += 1
    changes.push({ path, from, code })
  }
  return changes
}

/**
 * Read the vault's current sync state without touching the network.
 * @param vault - repository working tree.
 * @returns branch, upstream, ahead/behind, and the pending changes.
 */
export async function readState(vault) {
  if (!(await isRepository(vault))) return { isRepository: false }
  const [branchResult, upstreamResult, statusResult, remoteResult] = await Promise.all([
    runGit(vault, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000),
    runGit(vault, ['rev-parse', '--abbrev-ref', '@{upstream}'], 5000),
    runGit(vault, ['status', '--porcelain=v1', '-z'], 5000),
    runGit(vault, ['remote', 'get-url', 'origin'], 5000),
  ])
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : ''
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : ''
  const changes = statusResult.code === 0 ? parseStatus(statusResult.stdout) : []
  // A fresh clone has `origin` but may have no upstream configured, so sync
  // decisions key off the remote's presence rather than a tracking branch.
  const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : ''
  let ahead = 0
  let behind = 0
  if (upstream.length > 0) {
    const counts = await runGit(vault, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], 5000)
    if (counts.code === 0) {
      const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/)
      ahead = Number(aheadRaw) || 0
      behind = Number(behindRaw) || 0
    }
  }
  return { isRepository: true, branch, upstream, remote, ahead, behind, changes }
}

/**
 * Whether any path is in an unresolved conflict state.
 *
 * `git pull --autostash` reports success even when restoring the stash conflicts,
 * leaving `UU` entries and conflict markers in the files. That is still a broken
 * tree, so every pull checks for it rather than trusting the exit code.
 * @param vault - repository working tree.
 * @returns the conflicting paths, empty when the tree is clean of conflicts.
 */
export async function conflictedPaths(vault) {
  const { code, stdout } = await runGit(vault, ['diff', '--name-only', '--diff-filter=U'], 5000)
  if (code !== 0) return []
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

/**
 * Undo any half-finished rebase, merge, or leftover stash conflict.
 *
 * Called after every failure path: a repository left mid-rebase refuses later
 * commits, so the rollback matters more than the original error message.
 * @param vault - repository working tree.
 * @returns whether the repository still has a rebase/merge in progress.
 */
export async function rollback(vault) {
  // A stash conflict is not covered by `rebase --abort`; drop the stash entry the
  // autostash created and reset the conflicted index back to HEAD.
  if ((await conflictedPaths(vault)).length > 0) {
    await runGit(vault, ['reset', '--merge'], 10000)
    await runGit(vault, ['stash', 'drop'], 10000)
  }
  for (const args of [['rebase', '--abort'], ['merge', '--abort']]) {
    await runGit(vault, args, 10000)
  }
  const inProgress = await runGit(vault, ['rev-parse', '--git-dir'], 5000)
  if (inProgress.code !== 0) return true
  const gitDir = inProgress.stdout.trim()
  const markers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']
  return markers.some((marker) => existsSync(join(vault, gitDir, marker)) || existsSync(join(vault, '.git', marker)))
}

/**
 * Turn a rebase attempt into a sync result, rolling back anything broken.
 *
 * The exit code alone is not enough: `--autostash` returns success after the
 * rebase while the stash restore itself conflicts, so the tree is checked for
 * conflict markers as well.
 * @param vault - repository working tree.
 * @param result - the finished rebase command.
 * @param label - what to name in the success message.
 * @returns `{ ok, message, changed }`.
 */
async function settleRebase(vault, result, label) {
  const conflicts = await conflictedPaths(vault)
  if (result.code === 0 && conflicts.length === 0) {
    return { ok: true, message: `拉取 ${label}`, changed: true }
  }
  const detail = conflicts.length > 0
    ? `冲突文件：${conflicts.slice(0, 5).join('、')}${conflicts.length > 5 ? ' 等' : ''}`
    : result.stderr.trim() || result.stdout.trim()
  const stuck = await rollback(vault)
  return {
    ok: false,
    message: stuck
      ? `拉取冲突且回滚未完成，请到终端处理：${detail}`
      : `拉取冲突，已回滚：${detail}`,
    changed: false,
  }
}

/**
 * Fetch from origin and fast-forward or rebase onto it.
 *
 * Refuses to run with a dirty tree: rebasing onto a moved remote would either
 * fail halfway or silently stash uncommitted work, and neither is acceptable for
 * a vault the user is actively editing.
 * @param vault - repository working tree.
 * @param options - `timeoutMs`, and `autoStash` to carry pending edits across.
 * @returns `{ ok, message, changed }`.
 */
export async function pullVault(vault, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS
  if (!(await isRepository(vault))) return { ok: false, message: '库目录不是 git 仓库', changed: false }

  const before = await readState(vault)
  if (before.remote.length === 0) return { ok: false, message: '没有配置 origin 远程', changed: false }

  const fetched = await runGit(vault, ['fetch', '--prune', 'origin'], timeoutMs)
  if (fetched.code !== 0) {
    return {
      ok: false,
      message: fetched.timedOut
        ? `拉取超时（${timeoutMs / 1000} 秒无响应，远程可能不可达）`
        : `fetch 失败：${fetched.stderr.trim() || fetched.stdout.trim()}`,
      changed: false,
    }
  }

  const after = await readState(vault)
  const dirty = after.changes.length > 0
  if (dirty && options.autoStash !== true) {
    // A dirty tree with a moved remote: report instead of rebasing over edits.
    if (after.behind === 0) return { ok: true, message: '已是最新（工作区有未提交改动）', changed: false }
    return {
      ok: false,
      message: `远程有 ${after.behind} 个新提交，但工作区有未提交改动，已跳过拉取`,
      changed: false,
    }
  }
  if (after.upstream.length === 0) {
    // No tracking branch (a fresh clone): rebase onto the remote branch directly.
    const remoteRef = `origin/${after.branch}`
    const counts = await runGit(vault, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], 5000)
    if (counts.code !== 0) {
      return { ok: false, message: `无法比较 ${remoteRef}，请检查远程分支名`, changed: false }
    }
    const [, behindRaw] = counts.stdout.trim().split(/\s+/)
    if ((Number(behindRaw) || 0) === 0) return { ok: true, message: '已是最新', changed: false }
    const rebased = await runGit(vault, ['rebase', '--no-edit', remoteRef], timeoutMs)
    return settleRebase(vault, rebased, `${behindRaw} 个提交`)
  }
  if (after.behind === 0) return { ok: true, message: '已是最新', changed: false }

  const args = ['pull', '--rebase', '--no-edit']
  if (options.autoStash === true) args.push('--autostash')
  const rebased = await runGit(vault, args, timeoutMs)
  return settleRebase(vault, rebased, `${after.behind} 个提交`)
}

/**
 * Stage everything, commit if there is anything to commit, then push.
 *
 * The commit happens even when the push fails, so no work is lost to a network
 * problem. An empty working tree still pushes, because an earlier push may have
 * failed after its commit.
 * @param vault - repository working tree.
 * @param message - optional commit message.
 * @param options - `timeoutMs`.
 * @returns `{ ok, message, committed, pushed }`.
 */
export async function pushVault(vault, message, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS
  if (!(await isRepository(vault))) {
    return { ok: false, message: '库目录不是 git 仓库', committed: false, pushed: false }
  }
  const before = await readState(vault)
  if (before.remote.length === 0) {
    return { ok: false, message: '没有配置 origin 远程', committed: false, pushed: false }
  }

  let committed = false
  if (before.changes.length > 0) {
    const added = await runGit(vault, ['add', '-A'], 15000)
    if (added.code !== 0) {
      return { ok: false, message: `暂存失败：${added.stderr.trim()}`, committed: false, pushed: false }
    }
    const text = typeof message === 'string' && message.trim().length > 0
      ? message.trim()
      : 'memory: 自动同步'
    const commit = await runGit(vault, ['commit', '-m', text], 15000)
    if (commit.code !== 0) {
      return {
        ok: false,
        message: `提交失败：${commit.stderr.trim() || commit.stdout.trim()}`,
        committed: false,
        pushed: false,
      }
    }
    committed = true
  }

  const pushed = await runGit(vault, ['push', 'origin', 'HEAD'], timeoutMs)
  if (pushed.code !== 0) {
    const detail = pushed.timedOut
      ? `推送超时（${timeoutMs / 1000} 秒无响应，远程可能不可达）`
      : pushed.stderr.trim() || pushed.stdout.trim()
    return {
      ok: false,
      committed,
      pushed: false,
      message: committed ? `已提交但推送失败：${detail}` : `推送失败：${detail}`,
    }
  }
  return {
    ok: true,
    committed,
    pushed: true,
    message: committed ? '已提交并推送' : '已推送',
  }
}
