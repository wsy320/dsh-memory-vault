/**
 * Locate and import a package from the running Harness installation.
 *
 * A plugin is loaded by the Host, but `import('@deepseek-ai/...')` resolves from
 * this file: the plugin lives in the profile (or a workspace), the packages it
 * needs live in the application bundle. Probing the installation explicitly is
 * what `dsh-sync` does for the same reason; importing a second copy of
 * `@deepseek-ai/cordis` would split the process into two service graphs.
 *
 * @module dsh-memory-vault/harness
 */
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Module URLs this loader already resolved. */
const loadedModules = new Set()

/** Module URLs the Host already resolved; reusing one keeps a single Cordis. */
const SHARED_MODULES = (globalThis.__DSH_SHARED_MODULES__ instanceof Set
  ? [...globalThis.__DSH_SHARED_MODULES__]
  : []).filter((value) => typeof value === 'string')

/** Why `original-fs` could not be loaded, kept for the failure message. */
let asarLoadError = null

/**
 * Probe the packaged `app.asar` (and an unpacked `app/`) for one specifier.
 *
 * `process.execPath` is the app binary in the Host and plain `node` under a
 * test runner, so the LOCALAPPDATA install location is tried as well — a
 * plugin living in a workspace has no other way to find the packaged modules.
 * @param specifier - package specifier.
 * @param execDirectory - directory of the running executable.
 * @param push - collector for candidate paths that exist.
 */
function resourceRoots(specifier, execDirectory, push) {
  const resources = [
    join(execDirectory, 'resources'),
    join(execDirectory, '..', 'resources'),
    typeof process.env.LOCALAPPDATA === 'string'
      ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources')
      : undefined,
  ]
  for (const root of resources) {
    if (root === undefined) continue
    for (const base of [join(root, 'app.asar', 'dsh', 'node_modules'), join(root, 'app', 'dsh', 'node_modules')]) {
      for (const file of ['lib/index.js', 'index.js']) push(join(base, specifier, file))
    }
  }
}

/**
 * Probe whether Electron's asar-aware `original-fs` is reachable.
 *
 * Nothing depends on the answer any more — candidates are tried by `import()`
 * rather than by a stat — but the result is worth reporting: when it is missing,
 * a failed import inside `app.asar` is a filesystem-visibility problem rather
 * than a missing package.
 * @returns void; the outcome lands in `asarLoadError`.
 */
function probeAsarSupport() {
  try {
    const original = createRequire(import.meta.url)('original-fs')
    asarLoadError = typeof original?.existsSync === 'function' ? null : 'original-fs has no existsSync'
  } catch (error) {
    asarLoadError = error instanceof Error ? error.message : String(error)
  }
}
probeAsarSupport()

/**
 * Entry-point candidates for one package, most specific layout first.
 *
 * Existence is deliberately NOT checked here. Under Electron an asar path can
 * only be probed with `original-fs`, and when that module is unavailable every
 * candidate looks absent even though `import()` would load it fine. Returning
 * the candidate list unverified and letting `import()` decide removes that
 * failure mode; a wrong guess costs one rejected promise.
 * @param specifier - package specifier.
 * @returns absolute file paths to try, in order.
 */
function installationCandidates(specifier) {
  const entries = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !entries.includes(value)) entries.push(value)
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const execDirectory = dirname(process.execPath)
  // The profile's own node_modules first: those are plain files on disk, so they
  // import without touching `app.asar`. Reaching into the archive works for some
  // packages but can leave `import()` pending forever for others.
  const profileModules = typeof process.env.DSH_PROFILE_DIR === 'string'
    ? join(process.env.DSH_PROFILE_DIR, 'node_modules')
    : undefined
  if (profileModules !== undefined) {
    for (const file of ['lib/index.js', 'index.js']) push(join(profileModules, specifier, file))
  }
  resourceRoots(specifier, execDirectory, push)
  push(join(here, '..', '..', 'node_modules', specifier, 'lib', 'index.js'))
  push(join(here, '..', 'node_modules', specifier, 'lib', 'index.js'))
  // Walk every modules directory between this file and the drive root, so a
  // linked plugin also finds packages hoisted above its real path.
  const segments = here.split(sep)
  for (let index = segments.length - 1; index > 0; index -= 1) {
    if (segments[index] !== 'node_modules') continue
    const base = segments.slice(0, index + 1).join(sep)
    for (const file of ['lib/index.js', 'index.js']) push(join(base, specifier, file))
  }
  return entries
}

/**
 * Import one package from the running installation.
 * @param specifier - package specifier.
 * @param accept - predicate selecting the right module shape.
 * @returns the module namespace.
 */
export async function probeHarnessModule(specifier, accept) {
  const tried = installationCandidates(specifier)
  // Re-import paths this loader already resolved: cheapest win, and it keeps the
  // exact module instance the Host graph is using.
  for (const candidate of tried) {
    const name = pathToFileURL(candidate).href
    if (!loadedModules.has(name)) continue
    const loaded = await import(name).catch(() => undefined)
    if (accept(loaded)) return loaded
  }
  const marker = `/${specifier.replace(/^@[^/]+\//, '')}/`
  for (const name of SHARED_MODULES) {
    if (!name.includes(marker)) continue
    const loaded = await import(name).catch(() => undefined)
    if (accept(loaded)) {
      loadedModules.add(name)
      return loaded
    }
  }
  // Record why each candidate failed: under Electron an asar path can list as
  // existing yet refuse to import, and the bare "0 locations" message hides that.
  const failures = []
  for (const candidate of tried) {
    const name = pathToFileURL(candidate).href
    const loaded = await import(name).catch((error) => {
      failures.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      return undefined
    })
    if (!accept(loaded)) {
      if (loaded !== undefined) failures.push(`${candidate}: loaded but wrong shape`)
      continue
    }
    loadedModules.add(name)
    return loaded
  }
  const fromHost = await import(specifier).catch(() => undefined)
  if (accept(fromHost)) return fromHost
  const diagnostics = [
    `tried ${tried.length} locations`,
    `execPath ${process.execPath}`,
    `shared modules ${SHARED_MODULES.length}`,
    asarLoadError === null ? 'original-fs loaded' : `original-fs unavailable: ${asarLoadError}`,
    failures.length > 0 ? `failures: ${failures.slice(0, 3).join(' | ')}` : 'no candidate existed',
  ].join('; ')
  throw new Error(`dsh-memory-vault cannot load ${specifier} from the running Host (${diagnostics})`)
}

/**
 * The Host's `@deepseek-ai/dsh-tools`, which owns `defineTool`.
 * @returns that module namespace.
 */
export function loadToolsModule() {
  return probeHarnessModule('@deepseek-ai/dsh-tools', (loaded) => typeof loaded?.defineTool === 'function')
}
