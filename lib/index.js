/**
 * dsh-multi-folder — host half.
 *
 * Secondary working directories for a project, delivered as framework-level
 * and UI-level changes only (no new tools):
 *
 * 1. Per-workspace config in a HOST-OWNED store outside the agent's sandbox
 *    (`<DSH_HOME>/storages/multi-folder/<workspace-key>.json`, JSON array of
 *    absolute secondary directory paths), cached in memory and hydrated
 *    lazily per session. Direct write/edit attempts against the config file
 *    are rejected with an explicit message, so the agent can NEVER
 *    self-grant directories — configuration is user-managed by design.
 * 2. Tool-pipeline interception (`tools/execute` around-dispatch waterfall):
 *    `write` / `edit` / `pwsh` / `bash` calls whose path (or resolved
 *    `workdir`) lands inside a configured secondary directory are serviced
 *    here with the session's standing sandbox policy re-rooted to that
 *    directory — identical semantics to the primary workspace in every mode
 *    (read-only denies, workspace-write allows, danger-full-access allows).
 *    Interception OWNS such a call from the moment its target is resolved
 *    inside a secondary directory: an interception failure is reported as the
 *    call's own error and NEVER falls through to the default pipeline, which
 *    fences every call against the PRIMARY workspace root and would therefore
 *    turn any ordinary failure (a missing `old_string`, a locked target, an
 *    unreadable file) into the spurious
 *    `[sandbox: file access denied under workspace-write mode]` marker.
 *    Interception hydrates the configuration AWAITED (never a fire-and-forget
 *    read) and looks the dirs up by BOTH the policy root and the header cwd
 *    spelling, so a cold first call and a symlinked workspace cannot fall
 *    through to the default pipeline and surface a spurious workspace-write
 *    denial for a secondary-directory mutation. Successful write/edit
 *    short-circuits emit `fs/observed` like the shipped tools.
 *    Background shell runs (`run_in_background: true`) register with the
 *    generic jobs runtime (`ctx.jobs`) under the same re-rooted policy,
 *    mirroring the shipped pwsh/bash tools so `job_output` / `job_kill` and
 *    finish notices keep working. The launch is ASYNC (the handle is published
 *    only once launch preparation, Windows ACL grants included, succeeded), so
 *    the launcher is adapted to the jobs runtime's synchronous hooks contract
 *    exactly like the shipped tools' `processJob`: the job-owned AbortSignal
 *    drives preparation cancellation and a rejected preparation settles the job
 *    as `failed`. Reads (read/glob/grep) are unfenced and already work.
 *    Both shell paths are addressed through the version-adaptive seam
 *    {@link shellUsesExecute}: DSH 0.1.7-alpha.1 retired `shell.run` /
 *    `shell.start` in favour of a single `execute()`, and turned
 *    `JobSpec.owner` from the calling Agent into its SessionId.
 * 3. Prompt injection: one ordered system-prompt section rendered per
 *    assembly from the configured directories of the assembling session.
 * 4. Non-interrupting change notification: configuration changes made via
 *    the `/multi-folder` command arm a pending notice — only when the
 *    directory set actually changed — delivered at the NEXT message
 *    boundary: the next `agent/pre-step` (user send) or the next
 *    `tools/post-execute` (tool-call end), through the framework's native
 *    plugin-sourced `notice` context channel.
 * 5. `/multi-folder` command (list/add/remove/set): the human-command
 *    registry entry the browser UI drives through the Remote BFF.
 * 6. Sessionless remote API: a `multiFolder` namespace registered through
 *    the Typert registry with hand-written `src-json` descriptors and a
 *    plain-object service (`ctx.provide('multiFolder', …)`). Methods are
 *    keyed by workspace PATH (not sessionId), so the session-creation page
 *    — where no session exists yet — can read and edit the configuration
 *    directly. The `/multi-folder` command and the remote methods share
 *    one core so validation, canonicalization, and the config guard are
 *    identical on both channels. `browse` and `makeDir` ride the same
 *    namespace: they serve the plugin's own directory browser (see 8) rather
 *    than the configuration store.
 * 7. Failure diagnosis: a `pwsh`/`bash` run that ends in an OS-level
 *    `Permission denied` touching a secondary working directory (the ACL
 *    runner confines each process tree to ONE writable root, so `git -C
 *    <secondary>` launched from the primary workspace cannot write the
 *    repo) gets a workdir-fix hint attached as an additional context at
 *    the `tools/post-execute` boundary.
 * 8. Owned directory browser: "Add directory" opens a browser drawn by the
 *    client half and served by `browse`/`makeDir` above. Listing rides the
 *    `fs` seam (`fs.listDir`), which — unlike the host's directory-picker
 *    seam — is composed in EVERY deployment, so one interaction covers the
 *    native-chooser composition, the browse composition (LAN / remote
 *    clients / desktop shells) and shells that compose no picker at all.
 *    The framework offers no plugin-facing alternative: `uiWorkspace`'s
 *    `pickDirectory()` is native-only (it answers `directory-picker/unavailable`
 *    under the browse composition), its `listDirectory`/`createDirectory`
 *    twins are browse-only, and the shipped in-app browser is reachable only
 *    by the shell's own workspace surfaces. Directory creation mirrors the
 *    shipped browse backend, which uses Node's `mkdir` (the fs seam has no
 *    creation primitive).
 * 9. `@` file discovery for the configured directories (see the
 *    "secondary-directory file discovery" section). The shipped `@`
 *    file-reference menu is single-root — its provider walks the session cwd
 *    only and refuses candidates outside it — so secondary directories are
 *    invisible to it. `multiFolder/listFiles` indexes them over the `fs` seam
 *    instead, and the client half registers a companion `@` group fed by that
 *    endpoint. The shipped provider is untouched: with no secondary
 *    directories configured, behavior is exactly upstream's.
 */

import { mkdir } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import os from 'node:os'

export const name = 'dsh-multi-folder'
export const inject = ['fs', 'sandboxPolicy', 'systemPrompt']

/** Host-owned store, outside every agent sandbox root. */
const configDir = () => join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'storages', 'multi-folder')
const configFileName = (ws) => String(ws).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json'
const configPathFor = (ws) => join(configDir(), configFileName(ws))
const SECTION_NAME = 'multi-folder:secondary-dirs'
/** Tool guidance sections use orders 100–129; sit clearly after them. */
const SECTION_ORDER = 160
const COMMAND_NAME = 'multi-folder'
const INTERCEPT_TOOLS = new Set(['write', 'edit', 'pwsh', 'bash'])
/** Marker line the browser UI parses out of command results. */
const JSON_MARK = '[MF:JSON]'
const CONFIG_GUARD_TEXT =
  'This file is managed by the dsh-multi-folder plugin. Secondary working directories may only be ' +
  'configured by the user through the UI (session header or session-creation page) or the /multi-folder command; direct edits are rejected.'

/**
 * Which `ctx.shell` seam shape this DSH release exposes.
 *
 * DSH 0.1.7-alpha.1 (commit `d6bebc5783`, "converge on execute()") deleted BOTH
 * `ShellExecutor.run` and `ShellExecutor.start` and replaced them with one
 * `execute(spec): Promise<ShellExecution>`. `ShellExecution` extends
 * `ShellProcess` (status/exitCode/signal/done/kill/readOutput/sandbox) and adds
 * the foreground projection `result(): Promise<ShellRunResult>`, so the two old
 * entry points map onto it exactly:
 *
 *   old `await shell.run(spec)`          -> `await (await shell.execute(spec)).result()`
 *   old `proc = await shell.start(spec)` -> `proc = await shell.execute({ ...spec, onExpiry: 'none' })`
 *                                           (the retired `start` armed no deadline,
 *                                            while `resolve()` defaults `onExpiry` to `'kill'`)
 *
 * The same release changed `JobSpec.owner` from the calling `Agent` to its
 * `SessionId`, and `jobs-local` now resolves that id through `agents.get(id)`
 * (`session "[object Object]" has no live agent`). One probe therefore decides
 * both shapes: an executor old enough to still require `run`/`start` also
 * expects the Agent owner. The probe is the PRESENCE of `execute` — that method
 * was introduced by the same commit that retired the other two, so it can never
 * mean anything else — never the ABSENCE of `run`, so a release that keeps the
 * retired methods as deprecated shims would still take the modern path.
 *
 * @param shell - the resolved `ctx.shell` service, or undefined without one.
 * @returns true when the seam is the post-0.1.7 `execute()` contract.
 */
const shellUsesExecute = (shell) => shell !== undefined && typeof shell.execute === 'function'

export function apply(ctx) {
  const { fs, sandboxPolicy, systemPrompt } = ctx
  // NOTE: shell, shellEnv, and commands are deliberately NOT captured here.
  // Loader rows activate in dependency order, and this row declares no hard
  // dependency on those services — capturing them at apply time can yield
  // `undefined` when their provider rows activate later. The shell executor
  // is resolved per call below, and the command is registered through
  // ctx.inject so it activates whenever the commands service appears.

  let noteSeq = 0
  /** wsKey(primary) -> { dirs: string[] } */
  const dirsCache = new Map()
  /** String(sessionId) -> notice text awaiting the next message boundary. */
  const pendingNotices = new Map()

  // ---------------------------------------------------------------- helpers
  const wsKey = (p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const isAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
  const pathInside = (p, root) => {
    const P = wsKey(p)
    const R = wsKey(root)
    return P === R || P.startsWith(R + '/')
  }
  const displayPathOf = (target, fallback) =>
    target.displayPath !== undefined && target.displayPath !== null ? String(target.displayPath) : fallback
  const longestRootFirst = (dirs) => [...dirs].sort((a, b) => b.length - a.length)

  // ----------------------------------------------------------- config store
  function sanitizeDirs(list, ws) {
    const out = []
    const seen = new Set()
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) continue
      const abs = item.trim()
      if (!isAbsolute(abs)) continue
      if (wsKey(abs) === wsKey(ws)) continue // never the primary workspace itself
      const key = wsKey(abs)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(abs)
    }
    return out
  }

  /** Canonical absolute path for a user-supplied directory (handles `..`, symlinks). */
  async function canonicalizeAbs(path) {
    try {
      const target = await fs.resolve(path.trim())
      return fs.processPath(target)
    } catch {
      return null
    }
  }

  async function loadDirs(ws) {
    if (typeof ws !== 'string' || ws.length === 0) return { dirs: [] }
    const key = wsKey(ws)
    const cached = dirsCache.get(key)
    if (cached !== undefined) return cached
    const fresh = { dirs: [] }
    try {
      const target = await fs.resolve(configPathFor(ws))
      const raw = await fs.readText(target)
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) fresh.dirs = sanitizeDirs(parsed, ws)
    } catch {
      // absent or unreadable config -> empty list
    }
    dirsCache.set(key, fresh)
    return fresh
  }

  function hydrate(ws) {
    if (typeof ws === 'string' && ws.length > 0) void loadDirs(ws)
  }

  async function saveDirs(ws, dirs) {
    const content = JSON.stringify(dirs, null, 2) + '\n'
    const target = await fs.resolve(configPathFor(ws))
    // Config writes are user-initiated (via the UI command); the store lives
    // outside every agent sandbox root, so the explicit policy is rooted at
    // the host-owned config directory itself.
    await fs.writeText(target, content, undefined, undefined, {
      mode: 'workspace-write',
      workspaceRoot: configDir(),
    })
  }

  function dirsForSync(ws) {
    if (typeof ws !== 'string' || ws.length === 0) return null
    const entry = dirsCache.get(wsKey(ws))
    if (entry === undefined || entry.dirs.length === 0) return null
    return entry.dirs
  }

  function dirsText(ws, dirs) {
    if (dirs.length === 0) return 'No secondary working directories configured for ' + ws + '.'
    return 'Secondary working directories for ' + ws + ':\n' + dirs.map((d) => '- ' + d).join('\n')
  }

  // ----------------------------------------------------- shared config core
  // One validated, canonicalizing write-through core shared by the
  // `/multi-folder` command and the sessionless `multiFolder/*` remote
  // endpoints. Errors thrown here carry bare messages; each channel adds
  // its own `multi-folder: ` prefix.

  const requireWorkspace = (ws) => {
    if (typeof ws !== 'string' || ws.length === 0) throw new Error('workspace is required')
    return ws
  }

  const coreList = async (ws) => {
    ws = requireWorkspace(ws)
    const entry = await loadDirs(ws)
    return { workspace: ws, dirs: [...entry.dirs], changed: false }
  }

  const coreAdd = async (ws, path) => {
    ws = requireWorkspace(ws)
    if (typeof path !== 'string' || path.length === 0) throw new Error('add requires a path')
    if (!isAbsolute(path)) throw new Error('add requires an absolute path')
    const canonical = await canonicalizeAbs(path)
    if (canonical === null) throw new Error('cannot resolve path "' + path + '"')
    const entry = await loadDirs(ws)
    const next = sanitizeDirs([...entry.dirs, canonical], ws)
    const changed = next.length !== entry.dirs.length
    entry.dirs = next
    if (changed) await saveDirs(ws, next)
    return { workspace: ws, dirs: [...next], changed }
  }

  const coreRemove = async (ws, path) => {
    ws = requireWorkspace(ws)
    if (typeof path !== 'string' || path.length === 0) throw new Error('remove requires a path')
    const canonical = await canonicalizeAbs(path)
    const key = wsKey(canonical === null ? path : canonical)
    const entry = await loadDirs(ws)
    const next = entry.dirs.filter((d) => wsKey(d) !== key)
    const changed = next.length !== entry.dirs.length
    entry.dirs = next
    if (changed) await saveDirs(ws, next)
    return { workspace: ws, dirs: [...next], changed }
  }

  const coreSet = async (ws, paths) => {
    ws = requireWorkspace(ws)
    if (!Array.isArray(paths)) throw new Error('set requires an array of absolute paths')
    const canon = []
    for (const p of paths) {
      if (!isAbsolute(p)) throw new Error('set requires absolute paths')
      const c = await canonicalizeAbs(p)
      if (c === null) throw new Error('cannot resolve path "' + p + '"')
      canon.push(c)
    }
    const entry = await loadDirs(ws)
    const next = sanitizeDirs(canon, ws)
    const changed = JSON.stringify(next) !== JSON.stringify(entry.dirs)
    entry.dirs = next
    if (changed) await saveDirs(ws, next)
    return { workspace: ws, dirs: [...next], changed }
  }

  // ------------------------------------------------- owned directory picker
  // The plugin owns its picking interaction (see the file header, item 8):
  // one in-app browser over these two endpoints, so "Add directory" behaves
  // identically under every host picker composition instead of depending on
  // the native-only `uiWorkspace.pickDirectory()` service.

  /** Complete-result bound of one listing level (mirrors the shipped browse backend). */
  const MAX_BROWSE_ENTRIES = 1000

  /**
   * Whether a path names one fixed filesystem location regardless of process
   * state: POSIX-absolute on POSIX; on Windows only drive-qualified (`C:\…`)
   * or complete UNC (`\\server\share…`) forms. Rooted drive-less forms
   * (`\foo`, `/foo`) are `isAbsolute` yet still resolve against the host
   * process's current drive, so they are refused rather than rebased.
   */
  const fullyQualified = (path) =>
    process.platform === 'win32'
      ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
      : posix.isAbsolute(path)

  /** The path flavour one fully qualified path belongs to (flavour, never the host platform). */
  const pathApiFor = (path) => (/^[A-Za-z]:[\\/]|^\\\\/.test(path) ? win32 : posix)

  /** The parent level of one absolute path, or null at a filesystem root. */
  const parentOf = (path) => {
    const parent = pathApiFor(path).dirname(path)
    return parent === path ? null : parent
  }

  /**
   * List the direct subdirectories of one level for the plugin's browser.
   * An absent/blank path lists the host user's home directory. Only
   * directories are returned (a file is not addable as a secondary working
   * directory), hidden entries are flagged for the client to style, and the
   * level is capped with a `truncated` flag.
   * @param path - fully qualified directory path, or nothing for the home directory.
   * @returns the level's canonical path, its parent, the home directory, the child directories, and the cap state.
   */
  const coreBrowse = async (path) => {
    const requested = typeof path === 'string' && path.trim().length > 0 ? path.trim() : os.homedir()
    if (!fullyQualified(requested)) {
      throw new Error('browse requires a fully qualified path, got "' + requested + '"')
    }
    const target = await fs.resolve(requested)
    const absolute = fs.processPath(target)
    let children
    try {
      children = await fs.listDir(target)
    } catch (e) {
      throw new Error('cannot list "' + absolute + '": ' + String(e && e.message ? e.message : e))
    }
    const api = pathApiFor(absolute)
    const entries = []
    for (const child of children ?? []) {
      if (child === null || child === undefined || child.type !== 'directory') continue
      const entryName = String(child.name)
      entries.push({ name: entryName, path: api.join(absolute, entryName), hidden: entryName.startsWith('.') })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const truncated = entries.length > MAX_BROWSE_ENTRIES
    if (truncated) entries.length = MAX_BROWSE_ENTRIES
    return { path: absolute, parent: parentOf(absolute), home: os.homedir(), entries, truncated }
  }

  /**
   * Create one child directory for the plugin's browser. Mirrors the shipped
   * browse backend: the parent must be fully qualified, the name one path
   * segment, and the creation non-recursive (the browser shows the parent, so
   * a missing level is a real failure, not a level to invent).
   * @param parent - fully qualified existing parent directory.
   * @param name - single path segment name.
   * @returns the created directory's canonical path.
   */
  const coreMakeDir = async (parent, name) => {
    if (typeof parent !== 'string' || !fullyQualified(parent)) {
      throw new Error('makeDir requires a fully qualified parent path')
    }
    if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new Error('makeDir requires a single path segment name')
    }
    const target = pathApiFor(parent).join(parent, name)
    try {
      await mkdir(target)
    } catch (e) {
      if (e && e.code === 'EEXIST') throw new Error('"' + target + '" already exists')
      throw new Error('cannot create "' + target + '": ' + String(e && e.message ? e.message : e))
    }
    return { path: target, parent }
  }

  // ------------------------------------- secondary-directory file discovery
  // The shipped `@` file-reference menu is SINGLE-ROOT by construction: its
  // provider (`dsh-file-reference-local`) builds one `WorkspaceFileSearch` per
  // agent from `agent.session.header.cwd` and refuses every candidate outside
  // that root (`resolveDisplayDirectory` answers undefined for a path that
  // escapes it). A configured secondary directory is by definition outside the
  // primary workspace, so the shipped menu cannot reach it — no upstream
  // incompatibility, simply a scope the provider does not cover.
  //
  // This plugin therefore publishes its own discovery endpoint over the files
  // it already has read access to (`fs.listDir`, the same seam the owned
  // directory browser uses) and the client half registers a companion `@`
  // group fed by it. Nothing here alters the shipped provider: a workspace with
  // no secondary directories keeps exactly the upstream behavior, and the
  // shipped group keeps answering on its own.

  /**
   * Directory basenames never traversed. Mirrors the shipped provider's
   * defaults (`dsh-file-reference-local`): version-control and dependency
   * stores plus build-output names whose generated files would otherwise
   * spend the entry budget twice and rank beside their own sources. `lib` is
   * deliberately absent there and therefore here.
   */
  const INDEX_EXCLUDED = new Set([
    '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target',
    '.next', '.nuxt', '.turbo', '.venv', '__pycache__', '.pytest_cache',
    '.mypy_cache', '.gradle',
  ])
  /** Entries retained per workspace across every configured directory. */
  const MAX_INDEX_ENTRIES = 20000
  /** Entries retained for one level listing. */
  const MAX_LEVEL_ENTRIES = 500
  /** Candidates one query returns. */
  const MAX_FILE_RESULTS = 30
  /**
   * How long one workspace's index answers before the next query rebuilds it.
   * Autocomplete is advisory, so a few seconds of staleness is invisible while
   * it bounds rebuild cost to one traversal per window — a config change is
   * caught immediately instead, by the directory signature.
   */
  const FILE_INDEX_TTL_MS = 4000
  /** wsKey(workspace) -> { sig, builtAt, entries } */
  const filesCache = new Map()

  const lastSegment = (p) => {
    const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts.length === 0 ? '' : parts[parts.length - 1]
  }
  /** Absolute path in the forward-slash spelling the mention grammar carries. */
  const slashed = (p) => String(p).replace(/\\/g, '/')

  /**
   * Index one workspace's secondary directories: breadth-first, canonical-path
   * deduplicated (a junction/symlink pointing back up the tree cannot re-enter
   * the walk), excluding `INDEX_EXCLUDED` basenames, bounded by
   * `MAX_INDEX_ENTRIES` across all directories.
   * @param dirs - configured secondary directories.
   * @returns entries as `{ dir, rel, kind }`, `rel` forward-slashed inside `dir`.
   */
  const scanFiles = async (dirs) => {
    const entries = []
    const visited = new Set()
    for (const dir of dirs) {
      const queue = [{ abs: dir, rel: '' }]
      for (let cursor = 0; cursor < queue.length && entries.length < MAX_INDEX_ENTRIES; cursor += 1) {
        const level = queue[cursor]
        let target
        let absolute
        try {
          target = await fs.resolve(level.abs)
          absolute = fs.processPath(target)
        } catch {
          continue // an unresolvable level contributes nothing
        }
        const canonical = wsKey(absolute)
        if (visited.has(canonical)) continue
        visited.add(canonical)
        let children
        try {
          children = await fs.listDir(target)
        } catch {
          continue // an unreadable branch costs its own entries; the rest stay useful
        }
        const api = pathApiFor(absolute)
        for (const child of children ?? []) {
          if (child === null || child === undefined) continue
          const childName = String(child.name)
          const rel = level.rel === '' ? childName : level.rel + '/' + childName
          if (child.type === 'directory') {
            if (INDEX_EXCLUDED.has(childName)) continue
            entries.push({ dir, rel, kind: 'directory' })
            queue.push({ abs: api.join(absolute, childName), rel })
          } else if (child.type === 'file') {
            entries.push({ dir, rel, kind: 'file' })
          }
          if (entries.length >= MAX_INDEX_ENTRIES) break
        }
      }
    }
    return entries
  }

  /** One workspace's index, rebuilt when its directory set changes or the TTL lapses. */
  const indexFor = async (ws, dirs) => {
    const key = wsKey(ws)
    const sig = dirs.map(wsKey).join('|')
    const cached = filesCache.get(key)
    if (cached !== undefined && cached.sig === sig && Date.now() - cached.builtAt < FILE_INDEX_TTL_MS) {
      return cached.entries
    }
    const entries = await scanFiles(dirs)
    filesCache.set(key, { sig, builtAt: Date.now(), entries })
    return entries
  }

  /** Longest common subsequence gap score, mirroring the shipped provider. */
  const subsequenceScore = (target, needle) => {
    let at = 0
    let gap = 0
    for (const character of needle) {
      const found = target.indexOf(character, at)
      if (found < 0) return undefined
      gap += found - at
      at = found + 1
    }
    return Math.max(0, 100 - gap)
  }

  /**
   * Score one entry against a query. Ranking mirrors the shipped provider
   * (name beat path, directories win ties) with ONE deliberate deviation: the
   * path/path-subsequence rules read the IN-DIRECTORY relative path, never the
   * absolute one. Every absolute path shares the host prefix (`D:/…`), so
   * scoring it would make a one-character query match every candidate. The
   * directory's own basename stays searchable at the lowest precedence, which
   * is what lets `@secondary-spike` narrow to that directory.
   */
  const scoreEntry = (entry, needle) => {
    if (needle === '') return 0
    const rel = entry.rel.toLowerCase()
    const name = lastSegment(rel).toLowerCase()
    const bonus = entry.kind === 'directory' ? 25 : 0
    if (name === needle) return 1000 + bonus
    if (name.startsWith(needle)) return 900 + bonus
    if (name.includes(needle)) return 700 + bonus
    if (rel.includes(needle)) return 500 + bonus
    const sub = subsequenceScore(rel, needle)
    if (sub !== undefined) return 300 + sub + bonus
    if (lastSegment(entry.dir).toLowerCase().includes(needle)) return 200 + bonus
    return undefined
  }

  /** Rank entries deterministically and project the wire shape. */
  const rankEntries = (entries, query) => {
    const needle = query.toLowerCase()
    const ranked = []
    for (const entry of entries) {
      const score = scoreEntry(entry, needle)
      if (score !== undefined) ranked.push({ entry, score })
    }
    ranked.sort((left, right) =>
      right.score - left.score
      || (left.entry.kind === right.entry.kind ? 0 : left.entry.kind === 'directory' ? -1 : 1)
      || (needle === '' ? 0 : left.entry.rel.length - right.entry.rel.length)
      || (left.entry.rel < right.entry.rel ? -1 : left.entry.rel > right.entry.rel ? 1 : 0))
    return ranked.slice(0, MAX_FILE_RESULTS).map(({ entry }) => ({
      path: entry.rel === '' ? slashed(entry.dir) : slashed(entry.dir) + '/' + entry.rel,
      kind: entry.kind,
      dir: entry.dir,
      rel: entry.rel,
    }))
  }

  /**
   * Decode the in-directory part of a level query into a normalized relative
   * path, or reject it. `.` and empty segments are normalized away, and ANY
   * `..` segment is refused: without that, `@secondary/../../etc/` would list a
   * directory outside every configured root while still claiming the configured
   * directory as its owner — a candidate whose `dir` field lies, and a level
   * listing that escaped the set the user actually granted. The shipped
   * provider refuses the same escape for the same reason.
   * @returns the normalized relative path, or null when the query escapes.
   */
  const decodeInside = (inside) => {
    const segments = String(inside).split('/').filter((segment) => segment !== '' && segment !== '.')
    return segments.includes('..') ? null : segments.join('/')
  }

  /**
   * Resolve the directory part of a query to `(configured dir, in-dir path)`.
   * Two spellings are accepted: a fully qualified path inside a configured
   * directory (what a drill inserts), and a path whose first segment names a
   * configured directory by basename (`@secondary-spike/src/`). An ambiguous
   * basename (two configured directories sharing one) is refused, never
   * guessed.
   * @returns the resolved level, or null when the query names no configured directory.
   */
  const resolveLevel = (dirs, directory) => {
    const trimmed = String(directory).replace(/\/+$/, '')
    if (trimmed === '') return null
    const query = slashed(trimmed).toLowerCase()
    if (fullyQualified(trimmed)) {
      for (const dir of longestRootFirst(dirs)) {
        const root = slashed(dir).toLowerCase()
        if (query === root) return { dir, inside: '' }
        if (query.startsWith(root + '/')) {
          const inside = decodeInside(slashed(trimmed).slice(slashed(dir).length + 1))
          return inside === null ? null : { dir, inside }
        }
      }
      return null
    }
    const cut = trimmed.indexOf('/')
    const head = cut < 0 ? trimmed : trimmed.slice(0, cut)
    const inside = decodeInside(cut < 0 ? '' : trimmed.slice(cut + 1))
    if (inside === null) return null
    const matches = dirs.filter((dir) => lastSegment(dir).toLowerCase() === head.toLowerCase())
    if (matches.length !== 1) return null
    return { dir: matches[0], inside }
  }

  /** List one level of a configured secondary directory (files and directories). */
  const listLevel = async (dirs, directory, fragment) => {
    const empty = { candidates: [], truncated: false }
    const level = resolveLevel(dirs, directory)
    if (level === null) return empty
    const absolute = level.inside === '' ? level.dir : pathApiFor(level.dir).join(level.dir, ...level.inside.split('/'))
    let children
    try {
      children = await fs.listDir(await fs.resolve(absolute))
    } catch {
      return empty
    }
    const shown = []
    for (const child of children ?? []) {
      if (child === null || child === undefined) continue
      const childName = String(child.name)
      const kind = child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : null
      if (kind === null) continue
      if (kind === 'directory' && INDEX_EXCLUDED.has(childName)) continue
      // Hidden entries stay reachable by asking for them explicitly, exactly
      // like the shipped provider (and this plugin's own directory browser).
      if (childName.startsWith('.') && !fragment.startsWith('.')) continue
      shown.push({ dir: level.dir, rel: level.inside === '' ? childName : level.inside + '/' + childName, kind })
    }
    const truncated = shown.length > MAX_LEVEL_ENTRIES
    if (truncated) shown.length = MAX_LEVEL_ENTRIES
    return { candidates: rankEntries(shown, fragment), truncated }
  }

  /**
   * Discover candidates for one `@` query across a workspace's configured
   * secondary directories. An empty query yields the directories themselves
   * (the menu's entry points); a query carrying a separator lists that level;
   * a bare fragment fuzzy-ranks the index.
   * @param ws - primary workspace path (configuration key).
   * @param query - path text following `@` or `@"`.
   * @returns the workspace, its configured directories, and the ranked candidates.
   */
  const coreListFiles = async (ws, query) => {
    ws = requireWorkspace(ws)
    const entry = await loadDirs(ws)
    const dirs = [...entry.dirs]
    const out = { workspace: ws, dirs, candidates: [], truncated: false }
    if (dirs.length === 0) return out
    const q = typeof query === 'string' ? query.replace(/\\/g, '/') : ''
    if (q === '') {
      out.candidates = dirs.map((dir) => ({ path: slashed(dir), kind: 'directory', dir, rel: '' }))
      return out
    }
    const slash = q.lastIndexOf('/')
    if (slash >= 0) {
      const level = await listLevel(dirs, q.slice(0, slash + 1), q.slice(slash + 1))
      out.candidates = level.candidates
      out.truncated = level.truncated
      return out
    }
    const index = await indexFor(ws, dirs)
    const visible = q.startsWith('.') ? index : index.filter((item) => !item.rel.split('/').some((segment) => segment.startsWith('.')))
    out.candidates = rankEntries(visible, q)
    return out
  }

  // ----------------------------------------------- sessionless remote API
  // `multiFolder/*` endpoints over the Typert gateway. Hand-written
  // `src-json` descriptors registered through ctx.typert.register (the
  // sanctioned manual path documented by dsh-typert-loader) plus a
  // plain-object service carrying the gateway's typertRemote binding.
  // No session is involved: parameters are the workspace path and paths.

  const remoteErrorMessage = (e) =>
    'multi-folder: ' + String(e && e.message ? e.message : e).replace(/^multi-folder:\s*/, '')

  const multiFolderApi = {
    async list(workspace) {
      try {
        return await coreList(workspace)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async add(workspace, path) {
      try {
        return await coreAdd(workspace, path)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async remove(workspace, path) {
      try {
        return await coreRemove(workspace, path)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async set(workspace, dirs) {
      try {
        return await coreSet(workspace, dirs)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async browse(path) {
      try {
        return await coreBrowse(path)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async makeDir(parent, name) {
      try {
        return await coreMakeDir(parent, name)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async listFiles(workspace, query) {
      try {
        return await coreListFiles(workspace, query)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
  }
  Object.defineProperty(multiFolderApi, 'typertRemote', {
    value: Object.freeze({
      service: multiFolderApi,
      serviceKey: 'multiFolder',
      namespace: 'multiFolder',
    }),
  })

  const remoteParam = (name) => ({ name, wire: name, source: 'json', codec: { mode: 'src-json' } })
  const remoteInvocation = (method, params) => ({
    id: 'dsh-multi-folder#multiFolder/' + method,
    service: 'multiFolder',
    namespace: 'multiFolder',
    method,
    invocation: { kind: 'direct' },
    parameters: params.map(remoteParam),
    result: { mode: 'src-json' },
  })
  const REMOTE_CONTRIBUTION = {
    package: 'dsh-multi-folder',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      remoteInvocation('list', ['workspace']),
      remoteInvocation('add', ['workspace', 'path']),
      remoteInvocation('remove', ['workspace', 'path']),
      remoteInvocation('set', ['workspace', 'dirs']),
      remoteInvocation('browse', ['path']),
      remoteInvocation('makeDir', ['parent', 'name']),
      remoteInvocation('listFiles', ['workspace', 'query']),
    ],
  }

  // -------------------------------------------------------- notice channel
  // A message's `source.kind` must be a PRODUCER-OWNED kind. Session format v4
  // retired the catch-all `{ kind: 'plugin', plugin: X }` wrapper: the durable
  // log's encoder refuses it with
  // `format v4 message requires a producer-owned source kind`, which surfaces
  // as a failed run the moment a notice is appended. First-party producers name
  // themselves (`plan-mode`, `tool-jobs`, `model-selection`); the format's
  // v3→v4 migration maps every other plugin's legacy wrapper to
  // `plugin:<plugin>` (`session-format-v3-to-v4/sources.ts`), so an external
  // plugin's canonical spelling is that same namespaced kind — and our own
  // earlier logs, which used the retired wrapper, migrate to exactly it.
  const NOTICE_SOURCE_KIND = 'plugin:' + name
  const noticeMessage = (text) => ({
    id: 'mf-note-' + (++noteSeq),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: NOTICE_SOURCE_KIND,
      form: 'notice',
      summary: String(text).split('\n')[0].slice(0, 120),
    },
  })

  const armNotice = (agent, text) => {
    if (!agent || !agent.session) return
    pendingNotices.set(String(agent.session.id), text)
  }

  const takeNotice = (agent) => {
    if (!agent || !agent.session) return undefined
    const key = String(agent.session.id)
    const text = pendingNotices.get(key)
    if (text !== undefined) pendingNotices.delete(key)
    return text
  }

  // -------------------------------------------- failure diagnosis (post-exec)
  // The Windows ACL runner confines each process tree to exactly ONE writable
  // workspace root (a single `--write-sid` that must match `--workspace`). A
  // command that creates files inside a secondary directory while its cwd is
  // confined elsewhere therefore fails with an OS-level `Permission denied`
  // (git: `fatal: Unable to create '.../.git/index.lock': Permission denied`)
  // and carries NO sandbox marker — the sandbox worked as designed. These
  // helpers surface the workdir fix at the next tool-call boundary instead.

  const DENIAL_MARK = /permission denied|access(?: is)? denied|eacces|is denied/i

  const flattenResultText = (result) => {
    const parts = []
    if (result && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
    }
    const value = result && result.value
    if (value && typeof value === 'object') {
      for (const stream of [value.stdout, value.stderr]) {
        if (stream && typeof stream.text === 'string') parts.push(stream.text)
      }
    }
    // The plugin's own `[sandbox: ...]` markers describe runner-level denials,
    // not path-level EACCES; keep them out of the scan.
    return parts
      .join('\n')
      .split('\n')
      .filter((line) => !line.startsWith('[sandbox:'))
      .join('\n')
  }

  /** The configured secondary dir a call's workdir lands in, or null. */
  const workdirHitFor = async (exec) => {
    if (!exec || !exec.agent || !exec.agent.session || !exec.agent.session.header) return null
    const primary = exec.agent.session.header.cwd
    if (typeof primary !== 'string' || primary.length === 0) return null
    const dirs = dirsForSync(primary)
    if (dirs === null) return null
    const args = exec.arguments || {}
    const rawWorkdir = typeof args.workdir === 'string' ? args.workdir : null
    const joined =
      rawWorkdir === null
        ? String(primary)
        : isAbsolute(rawWorkdir)
          ? rawWorkdir
          : String(primary).replace(/[\\/]+$/, '') + '/' + rawWorkdir
    const target = await fs.resolve(joined, { cwd: primary })
    const abs = fs.processPath(target)
    return longestRootFirst(dirs).find((d) => pathInside(abs, d)) ?? null
  }

  /**
   * A user-visible diagnostic for a shell run that ended in an OS-level
   * permission denial touching a secondary working directory. Returns the
   * hint text or undefined. Never throws — a hint failure must never touch
   * the tool pipeline.
   */
  const permissionHint = async (exec, result) => {
    try {
      if (!exec || (exec.name !== 'pwsh' && exec.name !== 'bash')) return undefined
      if (!exec.agent || !exec.agent.session || !exec.agent.session.header) return undefined
      const exitCode =
        result && result.value && typeof result.value.exitCode === 'number' ? result.value.exitCode : null
      if (exitCode !== null && exitCode === 0) return undefined
      if (!DENIAL_MARK.test(flattenResultText(result))) return undefined
      const primary = exec.agent.session.header.cwd
      if (typeof primary !== 'string' || primary.length === 0) return undefined
      const dirs = dirsForSync(primary)
      if (dirs === null) return undefined
      const reRooted = await workdirHitFor(exec)
      if (reRooted !== null) {
        return (
          'This command ran confined to the secondary working directory "' +
          reRooted +
          '", so writes OUTSIDE that directory (for example to the primary workspace or another secondary directory) were denied at the OS level. ' +
          "Split the work into per-directory commands and set each command's `workdir` to the directory it writes into."
        )
      }
      const cmdNorm = wsKey(String((exec.arguments || {}).command || ''))
      const referenced = longestRootFirst(dirs).find((d) => cmdNorm.includes(wsKey(d)))
      if (referenced === undefined) return undefined
      return (
        'This command ran with its cwd confined to the primary workspace, so creating files inside the secondary working directory "' +
        referenced +
        '" was denied at the OS level — each command can write inside only ONE root. ' +
        'Re-run it with `workdir` set to that directory; for git, run the command from inside the repository instead of using `git -C` from the primary workspace.'
      )
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------ prompt injection
  systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const ws =
        context.agent && context.agent.session && context.agent.session.header
          ? context.agent.session.header.cwd
          : undefined
      if (typeof ws !== 'string' || ws.length === 0) return ''
      const dirs = dirsForSync(ws)
      if (dirs === null) return ''
      return (
        'Secondary working directories are available in this session (dsh-multi-folder plugin):\n' +
        dirs.map((d) => '- ' + d).join('\n') +
        '\nYou have the SAME read/write/edit and command-execution permissions on these directories as on the primary workspace under the current sandbox mode, ' +
        'but each command can write inside only ONE root — the directory its workdir resolves to. ' +
        'A command whose cwd stays the primary workspace CANNOT create files inside a secondary directory. ' +
        'For shell tools, pass `workdir` holding the ABSOLUTE path of one of these directories — foreground and background (`run_in_background`) runs alike. ' +
        'A relative `workdir` is resolved against the PRIMARY workspace, never against a secondary directory. ' +
        'File-creating commands, git included, MUST set `workdir` to the secondary directory: do not run `git -C <secondary>` or `cd <secondary>` inside a command launched from the primary workspace — changing the process directory inside the command (`Set-Location` / `cd`) does NOT widen the writable root, so writes into a secondary directory then fail with an OS-level access denial (Windows error 5). ' +
        'Reads from these directories work without `workdir`. The primary workspace remains the default working directory.'
      )
    },
  })

  // ----------------------------------------------- notification (pre-step)
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent && payload.agent.session && payload.agent.session.header) {
      hydrate(payload.agent.session.header.cwd)
    }
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const text = takeNotice(payload.agent)
    if (text === undefined) return decision
    return { kind: 'enter', messages: [noticeMessage(text), ...decision.messages] }
  })

  // --------------------------------------- notification (tool-call boundary)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const extras = []
    const notice = takeNotice(exec.agent)
    if (notice !== undefined) extras.push(notice)
    const hint = await permissionHint(exec, result)
    if (hint !== undefined) extras.push(hint)
    if (extras.length === 0) return decision
    const msgs = extras.map((text) => noticeMessage(text))
    if (decision.kind === 'block') {
      return {
        kind: 'block',
        feedback: decision.feedback,
        additionalContexts: [...msgs, ...(decision.additionalContexts || [])],
      }
    }
    return { ...decision, additionalContexts: [...msgs, ...(decision.additionalContexts || [])] }
  })

  // ------------------------------------------------- tool-pipeline intercept
  const shellRender = (value) => {
    let text = value.stdout && typeof value.stdout.text === 'string' ? value.stdout.text : ''
    if (value.stderr && typeof value.stderr.text === 'string' && value.stderr.text.length > 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += value.stderr.text
    }
    if (value.exitCode !== 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += '[exit code: ' + value.exitCode + ']'
    }
    if (value.sandbox && value.sandbox.denied) {
      text += '\n[sandbox: file access denied under ' + value.sandbox.mode + ' mode]'
    }
    return text
  }

  /** Terminal outcome for a background process, in the jobs-registry vocabulary. */
  const processOutcome = (proc) => {
    if (proc.status === 'killed') {
      return {
        status: 'killed',
        detail: proc.signal !== null && proc.signal !== undefined ? 'signal: ' + proc.signal : 'killed before exit',
      }
    }
    return {
      status: 'completed',
      detail: 'exit code: ' + (proc.exitCode === undefined || proc.exitCode === null ? 0 : proc.exitCode),
    }
  }

  /**
   * Adapt one asynchronous background launch to the jobs runtime's SYNCHRONOUS
   * hooks contract, mirroring the shipped pwsh/bash tools' `processJob`.
   *
   * The launch is ASYNC in every supported release — it resolves the process
   * handle only after launch preparation (Windows ACL grants included) and
   * rejects when preparation is cancelled or fails — so the handle can never be
   * dereferenced from `run()`. Treating it as synchronous made every background
   * run in a secondary directory fail immediately with
   * `Cannot read properties of undefined (reading 'then')` (`proc.done` read
   * off the un-awaited promise). The job-owned AbortSignal travels into
   * `shell.resolve`, so `cancel` stops a launch that has not published a handle
   * yet, and a rejected preparation settles the job as `failed` instead of
   * leaving it running forever. A background process outlives the tool call, so
   * no CALLER signal is forwarded, and it must not inherit a deadline:
   * `onExpiry: 'none'` is what makes the post-0.1.7 `execute()` path ignore
   * `timeoutMs`, which the retired `start()` did by construction. Without it a
   * background command would be killed at the executor's default timeout — a
   * silent behavior regression the shipped tools avoid the same way.
   */
  const startBackgroundJob = (shell, request) => {
    const controller = new AbortController()
    const modern = shellUsesExecute(shell)
    let proc
    const done = (async () => {
      try {
        const spec = shell.resolve({
          ...request,
          signal: controller.signal,
          ...(modern ? { onExpiry: 'none' } : {}),
        })
        proc = modern ? await shell.execute(spec) : await shell.start(spec)
        try {
          if (controller.signal.aborted) proc.kill()
        } finally {
          await proc.done
        }
        return processOutcome(proc)
      } catch (error) {
        return {
          status: controller.signal.aborted && proc === undefined ? 'killed' : 'failed',
          detail: error && error.message !== undefined ? String(error.message) : String(error),
        }
      }
    })()
    return {
      cancel: (reason) => {
        if (controller.signal.aborted) return
        controller.abort(reason)
        if (proc !== undefined) proc.kill()
      },
      done,
      readOutput: () => (proc === undefined ? '' : renderProcessRead(proc.readOutput(), proc.sandbox)),
    }
  }

  /**
   * One consuming background read, shaped for `job_output`: the raw delta plus
   * loss/spill notices and sandbox markers, mirroring the shipped pwsh/bash
   * tools' background rendering. No escalation hint is appended — escalation
   * calls stay on the default pipeline, which re-roots at the primary
   * workspace, so this job can never receive a wider policy.
   */
  const renderProcessRead = (read, sandbox) => {
    const notices = []
    if (read.lossy) {
      const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
      notices.push(
        '[some output was dropped from memory; full output: ' +
          (paths.length > 0 ? paths.join(', ') : '(unavailable)') +
          ']',
      )
    }
    if (sandbox && sandbox.runnerFailed) {
      notices.push(
        '[sandbox: the sandbox runner itself failed under ' + sandbox.mode +
          ' mode — the command did not run; this is a sandbox problem, not a command failure]',
      )
    } else if (sandbox && sandbox.denied) {
      notices.push('[sandbox: file access denied under ' + sandbox.mode + ' mode]')
    }
    if (notices.length === 0) return read.delta
    return read.delta + (read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : '') + notices.join('\n')
  }

  /**
   * Model-facing failure for a call the interception OWNS (see the ownership
   * rule below). A claimed call is never handed back to the default pipeline,
   * so its real error reaches the model in the shipped tools' error envelope —
   * `Error: <message>` plus the `FS_*` code — instead of the primary-rooted
   * sandbox denial. A genuine sandbox denial (read-only mode) keeps the standard
   * marker plus the one-shot escalation hint, exactly as the shipped
   * `write`/`edit` tools render it, so the escalation flow is unchanged.
   */
  const ownedFailure = (error, policy) => {
    const code = error && typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined
    const message =
      code === 'FS_SANDBOX_DENIED'
        ? '[sandbox: file access denied under ' + policy.mode + ' mode]\n' +
          '[sandbox: escalation available \u2014 retry this exact operation once with sandbox_permissions ' +
          '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
        : String(error && error.message ? error.message : error)
    return {
      isError: true,
      error: { message, ...(code === undefined ? {} : { info: { code } }) },
      content: [{ type: 'text', text: 'Error: ' + message }],
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    // Hydration must be AWAITED on the interception path, not fire-and-forget:
    // a first call that arrives before the config read resolves would see an
    // empty dirs cache, fall through to the default pipeline, and be fenced
    // against the PRIMARY workspace root — surfacing as a spurious
    // `[sandbox: file access denied under workspace-write mode]` for a
    // secondary-directory write/edit. `loadDirs` caches, so only the first
    // call pays the read.
    const headerCwd =
      exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd
        : undefined
    if (typeof headerCwd === 'string' && headerCwd.length > 0) {
      await loadDirs(headerCwd)
    }
    if (!INTERCEPT_TOOLS.has(exec.name)) return next()
    // Non-null once the call's target has been resolved into a configured
    // secondary directory: from that point the interception OWNS the call and a
    // failure must be reported as this call's error, never handed back to the
    // default pipeline (which fences against the PRIMARY workspace root and
    // would answer any failure with the spurious workspace-write denial).
    let owned = null
    try {
      const args = exec.arguments
      const standing = sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      const primary = standing.workspaceRoot
      // An explicit escalation request belongs to the default pipeline (it owns
      // the approval flow). Only a non-empty mode string is a request: a
      // null/empty value is not, and must not hand a secondary-directory
      // mutation to the primary-rooted pipeline.
      if (args && typeof args.sandbox_permissions === 'string' && args.sandbox_permissions.length > 0) return next()
      // The policy root is realpath-canonicalized by sandbox-policy while
      // hydration is keyed by the session cwd as spelled in the header; on a
      // workspace reached through a symlinked/junctioned ancestor the two
      // spellings differ, so consult both keys before falling through.
      const dirs =
        dirsForSync(primary) ??
        (typeof headerCwd === 'string' && headerCwd.length > 0 ? dirsForSync(headerCwd) : null)

      if (exec.name === 'write' || exec.name === 'edit') {
        const filePath = args && typeof args.file_path === 'string' ? args.file_path : null
        if (filePath === null) return next()
        // Resolve first so `..`, symlinks, and case differences canonicalize
        // before containment matching (same cwd the shipped tools use).
        let target
        try {
          target = await fs.resolve(filePath, { cwd: primary })
        } catch (error) {
          // An unresolvable ABSOLUTE path that is lexically inside a secondary
          // directory is still this plugin's call to answer: the default pipeline
          // would resolve it against the PRIMARY root and report the sandbox
          // denial, hiding the resolution failure.
          if (dirs !== null && isAbsolute(filePath)) {
            const rawHit = longestRootFirst(dirs).find((d) => pathInside(filePath, d))
            if (rawHit !== undefined) return ownedFailure(error, { ...standing, workspaceRoot: rawHit })
          }
          return next()
        }
        const abs = fs.processPath(target)
        // Security boundary: configuration is user-managed. Reject direct
        // write/edit attempts against the host-owned config file, even before
        // any directory matching. Both spellings of the workspace key are
        // checked (see the dirs lookup above).
        const guardHits = new Set(
          [primary, headerCwd].filter((p) => typeof p === 'string' && p.length > 0).map((p) => wsKey(configPathFor(p))),
        )
        if (guardHits.has(wsKey(abs))) {
          return {
            isError: true,
            error: { message: 'multi-folder configuration is user-managed' },
            content: [{ type: 'text', text: CONFIG_GUARD_TEXT }],
          }
        }
        if (dirs === null) return next()
        const hit = longestRootFirst(dirs).find((d) => pathInside(abs, d))
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }

        if (exec.name === 'write') {
          owned = { policy }
          const outcome = await fs.writeText(target, String(args.content), undefined, exec.signal, policy)
          // Keep the observation layer coherent with the shipped write tool's
          // contract: a successful create/update is a presence observation.
          if (typeof ctx.emit === 'function') {
            ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
          }
          const displayPath = displayPathOf(target, filePath)
          const value = {
            path: displayPath,
            operation: outcome.operation === 'create' ? 'create' : 'update',
            before: outcome.before === undefined || outcome.before === null ? null : outcome.before,
            after: outcome.after === undefined ? null : outcome.after,
          }
          const content = [{
            type: 'text',
            text:
              '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' +
              (outcome.operation === 'create' ? 'Created' : 'Updated') +
              ' file\n</content>',
          }]
          return { isError: false, value, content }
        }

        const oldString = args && typeof args.old_string === 'string' ? args.old_string : null
        const newString = args && typeof args.new_string === 'string' ? args.new_string : null
        if (oldString === null || newString === null) return next()
        const replaceAll = args.replace_all === true
        owned = { policy }
        const outcome = await fs.editText(
          target,
          { oldString, newString, replaceAll },
          undefined,
          exec.signal,
          policy,
        )
        if (typeof ctx.emit === 'function') {
          ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        }
        const displayPath = displayPathOf(target, filePath)
        const value = { path: displayPath, before: outcome.before, after: outcome.after }
        const text = replaceAll
          ? 'The file ' + displayPath + ' has been updated. All occurrences were successfully replaced.'
          : 'The file ' + displayPath + ' has been updated successfully.'
        return { isError: false, value, content: [{ type: 'text', text }] }
      }

      if (exec.name === 'pwsh' || exec.name === 'bash') {
        const shell = ctx.get('shell')
        if (shell === undefined) return next()
        const modernShell = shellUsesExecute(shell)
        if (dirs === null) return next()
        const rawWorkdir = args && typeof args.workdir === 'string' ? args.workdir : null
        const joined = rawWorkdir === null
          ? String(primary)
          : isAbsolute(rawWorkdir)
            ? rawWorkdir
            : String(primary).replace(/[\\/]+$/, '') + '/' + rawWorkdir
        // Canonicalize before containment matching, then run in the canonical
        // directory so confinement root and process cwd agree exactly.
        const workdirTarget = await fs.resolve(joined, { cwd: primary })
        const absWorkdir = fs.processPath(workdirTarget)
        const hit = longestRootFirst(dirs).find((d) => pathInside(absWorkdir, d))
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }
        const shellEnv = ctx.get('shellEnv')
        const request = {
          command: String(args.command),
          workdir: absWorkdir,
          ...(args && args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
          sandboxPolicy: policy,
        }

        // Background runs get the SAME re-rooted policy as foreground runs.
        // They register with the generic jobs runtime (`ctx.jobs`) exactly
        // like the shipped pwsh/bash tools do, so `job_output` / `job_kill`
        // and the finish notice keep working for the intercepted job.
        if (args && args.run_in_background === true) {
          // An aborted call belongs to the default pipeline, which raises the
          // canonical abort error before anything starts.
          if (exec.signal && exec.signal.aborted) return next()
          const jobs = ctx.get('jobs')
          if (jobs === undefined) return next()
          owned = { policy }
          // `JobSpec.owner` is the owner's SessionId since 0.1.7-alpha.1
          // (`jobs-local` resolves it through `agents.get(id)`); the older seam
          // took the Agent itself. Passing the wrong shape throws
          // `session "[object Object]" has no live agent` and the background run
          // never starts. `Agent.id` IS the session id, which is the spelling
          // the shipped pwsh/bash tools register with.
          const jobId = jobs.start({
            kind: exec.name,
            label: String(args.command),
            ...(exec.agent ? { owner: modernShell ? exec.agent.id : exec.agent } : {}),
            run: () => startBackgroundJob(shell, request),
          })
          return {
            isError: false,
            value: { kind: 'background', jobId },
            content: [{ type: 'text', text: 'started background job ' + jobId }],
          }
        }

        owned = { policy }
        // One call site, two release shapes: 0.1.7-alpha.1 replaced
        // `shell.run(spec)` with `execute(spec)` + the handle's foreground
        // projection `result()`. See {@link shellUsesExecute}.
        const result = modernShell
          ? await (await shell.execute(shell.resolve({ ...request, signal: exec.signal }))).result()
          : await shell.run(shell.resolve({ ...request, signal: exec.signal }))
        if (result.aborted) {
          return {
            isError: true,
            error: { message: 'tool call aborted' },
            content: [{ type: 'text', text: '[aborted]' }],
          }
        }
        const stream = (s) => ({
          text: s && typeof s.text === 'string' ? s.text : '',
          truncated: !!(s && s.truncated),
          ...(s && s.spillPath !== undefined ? { spillPath: s.spillPath } : {}),
        })
        const value = {
          kind: 'foreground',
          exitCode: result.exitCode === undefined ? null : result.exitCode,
          signal: result.signal === undefined ? null : result.signal,
          timedOut: !!result.timedOut,
          aborted: false,
          timeoutMs: result.timeoutMs === undefined ? null : result.timeoutMs,
          stdout: stream(result.stdout),
          stderr: stream(result.stderr),
          ...(result.sandbox !== undefined
            ? {
                sandbox: {
                  mode: String(result.sandbox.mode),
                  denied: !!result.sandbox.denied,
                  ...(result.sandbox.enforcement !== undefined
                    ? { enforcement: String(result.sandbox.enforcement) }
                    : {}),
                  ...(result.sandbox.runnerFailed !== undefined
                    ? { runnerFailed: !!result.sandbox.runnerFailed }
                    : {}),
                },
              }
            : {}),
        }
        return { isError: false, value, content: [{ type: 'text', text: shellRender(value) }] }
      }
      return next()
    } catch (error) {
      // A failure BEFORE the call was claimed (path resolution, config lookup,
      // shell service lookup) falls back to the default pipeline. A failure
      // AFTER the claim — the mutation or the shell run itself — does not: the
      // default pipeline fences the call against the PRIMARY workspace root, so
      // it could only answer with the spurious workspace-write denial and would
      // hide the real cause (for example a missing `old_string`).
      return owned === null ? next() : ownedFailure(error, owned.policy)
    }
  })

  // ---------------------------------------------------- hydration on start
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (agent && agent.session && agent.session.header) hydrate(agent.session.header.cwd)
  })

  // ------------------------------------------------------ /multi-folder cmd
  ctx.inject(['commands'], (c) => {
    const commands = c.commands
    const parseArgs = (raw) => {
      const out = []
      let cur = ''
      let inQuote = false
      for (const ch of String(raw)) {
        if (ch === '"') {
          inQuote = !inQuote
        } else if (!inQuote && (ch === ' ' || ch === '\t')) {
          if (cur.length > 0) {
            out.push(cur)
            cur = ''
          }
        } else {
          cur += ch
        }
      }
      if (cur.length > 0) out.push(cur)
      return out
    }

    const jsonLine = (obj) => JSON_MARK + ' ' + JSON.stringify(obj)
    const resultText = (ws, dirs, changed) =>
      dirsText(ws, dirs) + '\n' + jsonLine({ workspace: ws, dirs, changed })

    return commands.register({
      name: COMMAND_NAME,
      description:
        'Manage secondary working directories for this project (list / add <path> / remove <path> / set <paths...>). The agent gains workspace-write-equivalent access to these directories.',
      input: { hint: '[list|add <path>|remove <path>|set <paths...>]' },
      async handler(invocation) {
        try {
          const ws =
            invocation.agent && invocation.agent.session && invocation.agent.session.header
              ? String(invocation.agent.session.header.cwd)
              : undefined
          if (typeof ws !== 'string' || ws.length === 0) {
            return { kind: 'error', text: 'multi-folder: session workspace is unknown' }
          }
          const argv = parseArgs(invocation.rawInput)
          const sub = argv.length === 0 ? 'list' : argv[0].toLowerCase()
          let outcome
          if (sub === 'list') {
            outcome = await coreList(ws)
          } else if (sub === 'add') {
            outcome = await coreAdd(ws, argv.slice(1).join(' '))
          } else if (sub === 'remove') {
            outcome = await coreRemove(ws, argv.slice(1).join(' '))
          } else if (sub === 'set') {
            outcome = await coreSet(ws, argv.slice(1))
          } else {
            return {
              kind: 'error',
              text: 'multi-folder: unknown subcommand "' + sub + '" (use list / add / remove / set)',
            }
          }
          if (outcome.changed) {
            armNotice(
              invocation.agent,
              'Secondary working directories changed (dsh-multi-folder):\n' + dirsText(ws, outcome.dirs),
            )
          }
          return { kind: 'success', text: resultText(outcome.workspace, outcome.dirs, outcome.changed) }
        } catch (e) {
          return {
            kind: 'error',
            text: 'multi-folder: ' + String(e && e.message ? e.message : e).replace(/^multi-folder:\s*/, ''),
          }
        }
      },
    })
  })

  // ------------------------------------------ sessionless remote API mounts
  // The plain-object service must be reachable through ctx.get('multiFolder')
  // with a visible typertRemote binding, and the typert registry entry makes
  // the endpoints claimable on the shared /api channel. Both are owned by
  // this plugin fiber, so unloading the plugin withdraws them together.
  ctx.provide('multiFolder', multiFolderApi)
  ctx.inject(['typert'], (t) => t.typert.register(REMOTE_CONTRIBUTION))
}
