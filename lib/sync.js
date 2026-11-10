/**
 * Automatic git sync for the memory vault.
 *
 * **Pull at startup, pull and push on a timer.** The vault is shared between
 * machines, so a stale checkout silently answers questions with old facts. The
 * schedule is deliberately simple: one immediate pull when the plugin mounts,
 * then a repeating tick that pushes local edits and pulls remote ones.
 *
 * Everything here follows one rule: **sync failure must never break the plugin.**
 * A memory tool that worked a second ago must keep working when the LAN is down,
 * so every failure is recorded in `status` and surfaced through `memory_health`
 * rather than thrown into the Host.
 *
 * Sharing one lock is what keeps two ticks from interleaving git commands in the
 * same working tree.
 *
 * @module dsh-memory-vault/sync
 */
import { pullVault, pushVault } from './git.js'

/** Default interval between automatic sync ticks. */
export const DEFAULT_SYNC_INTERVAL_SECONDS = 300

/**
 * Build the controller that owns the schedule and its state.
 *
 * @param options - `vault`, `intervalMs`, `pushMessage`, `timeoutMs`.
 * @returns the controller: `start()`, `stop()`, `runOnce()`, `status()`.
 */
export function createSyncController(options) {
  const { vault, intervalMs, pushMessage, timeoutMs } = options
  /** One in-flight sync; a second tick during a run is skipped, not queued. */
  let running = null
  /**
   * Notes touched since the last successful push, newest last.
   *
   * `memory_write` records what it actually wrote, so the commit subject names the
   * real change instead of a generic "automatic sync". Nothing here calls a model:
   * the description comes from the write that caused it.
   */
  let pending = []
  /** Last outcome, read by `memory_health`. */
  let last = {
    at: null,
    pull: null,
    push: null,
    error: null,
  }

  /**
   * Compose a commit subject from the recorded writes.
   *
   * One note is named directly; several are summarised with the first and a
   * count, which keeps the subject a single readable line.
   * @param notes - recorded `{ path, append }` entries.
   * @returns the subject line.
   */
  const describe = (notes) => {
    if (notes.length === 0) return pushMessage
    if (notes.length === 1) {
      const [only] = notes
      return `memory: ${only.append ? '追加' : '写入'} ${only.path}`
    }
    const [first] = notes
    return `memory: ${first.append ? '追加' : '写入'} ${first.path} 等 ${notes.length} 篇`
  }

  /**
   * Run one sync pass: pull remote work first, then publish local edits.
   *
   * Pull first is required, not preferred. A push attempted while the remote has
   * moved is rejected as non-fast-forward, so pushing before pulling would fail
   * every tick where another machine committed. Committing is local and happens
   * inside `pushVault`, so uncommitted edits survive the pull: a dirty tree makes
   * `pullVault` report "skipped" rather than rebasing over them.
   * @returns the recorded outcome.
   */
  const runOnce = async () => {
    if (running !== null) return running
    running = (async () => {
      // Snapshot and clear before the work: a write landing mid-sync belongs to
      // the next tick, not to a commit that already captured its message.
      const batch = pending
      pending = []
      const outcome = { at: new Date().toISOString(), pull: null, push: null, error: null, subject: describe(batch) }
      try {
        // Pull, then push. A push attempted before the pull is rejected as
        // non-fast-forward whenever another machine has committed.
        outcome.pull = await pullVault(vault, { timeoutMs, autoStash: false })
        outcome.push = await pushVault(vault, outcome.subject, { timeoutMs })
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error)
      }
      // Keep the batch unless the work actually landed on the remote. A commit
      // that succeeded locally but failed to push still represents unpushed work,
      // and the next tick — which only pushes — needs this description for it.
      if (outcome.push === null || outcome.push.ok !== true) {
        pending = [...batch, ...pending]
      }
      last = outcome
      return outcome
    })()
    try {
      return await running
    } finally {
      running = null
    }
  }

  return {
    /** Run the startup pull without touching the timer. */
    async prime() {
      if (running !== null) return running
      running = (async () => {
        const outcome = { at: new Date().toISOString(), pull: null, push: null, error: null }
        try {
          // Startup pull only: a fresh machine may have nothing to push, and
          // pushing before reading could publish a half-edited note.
          outcome.pull = await pullVault(vault, { timeoutMs, autoStash: false })
        } catch (error) {
          outcome.error = error instanceof Error ? error.message : String(error)
        }
        last = outcome
        return outcome
      })()
      try {
        return await running
      } finally {
        running = null
      }
    },
    runOnce,
    /**
     * Record one successful write, so the next commit names it.
     *
     * Called by `memory_write` after the file is on disk. Recording the same path
     * twice collapses to one entry with the later action, which keeps a burst of
     * appends in one note from producing a repeated list.
     * @param path - vault-relative path that changed.
     * @param append - whether the write appended rather than replaced.
     */
    note(path, append) {
      const entry = { path, append: append === true }
      const existing = pending.findIndex((candidate) => candidate.path === path)
      if (existing >= 0) pending[existing] = entry
      else pending.push(entry)
    },
    /** A snapshot for reporting; never triggers work. */
    status() {
      return { ...last, intervalMs, running: running !== null, pending: pending.length }
    },
  }
}
