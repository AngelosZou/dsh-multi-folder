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
 *    Reads (read/glob/grep) are unfenced and already work.
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
 *    identical on both channels.
 */

import { join } from 'node:path'
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
    ],
  }

  // -------------------------------------------------------- notice channel
  const noticeMessage = (text) => ({
    id: 'mf-note-' + (++noteSeq),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: name,
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
        '\nYou have the SAME read/write/edit and command-execution permissions on these directories as on the primary workspace under the current sandbox mode. ' +
        'Use absolute paths inside them (or pass `workdir` to shell tools). The primary workspace remains the default working directory.'
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
    const text = takeNotice(exec.agent)
    if (text === undefined) return decision
    const msg = noticeMessage(text)
    if (decision.kind === 'block') {
      return {
        kind: 'block',
        feedback: decision.feedback,
        additionalContexts: [msg, ...(decision.additionalContexts || [])],
      }
    }
    return { ...decision, additionalContexts: [msg, ...(decision.additionalContexts || [])] }
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

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent && exec.agent.session && exec.agent.session.header) {
      hydrate(exec.agent.session.header.cwd)
    }
    if (!INTERCEPT_TOOLS.has(exec.name)) return next()
    try {
      const args = exec.arguments
      const standing = sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      const primary = standing.workspaceRoot
      // An explicit escalation request belongs to the default pipeline.
      if (args && args.sandbox_permissions !== undefined) return next()

      if (exec.name === 'write' || exec.name === 'edit') {
        const filePath = args && typeof args.file_path === 'string' ? args.file_path : null
        if (filePath === null) return next()
        // Resolve first so `..`, symlinks, and case differences canonicalize
        // before containment matching (same cwd the shipped tools use).
        const target = await fs.resolve(filePath, { cwd: primary })
        const abs = fs.processPath(target)
        // Security boundary: configuration is user-managed. Reject direct
        // write/edit attempts against the host-owned config file, even before
        // any directory matching.
        if (wsKey(abs) === wsKey(configPathFor(primary))) {
          return {
            isError: true,
            error: { message: 'multi-folder configuration is user-managed' },
            content: [{ type: 'text', text: CONFIG_GUARD_TEXT }],
          }
        }
        const dirs = dirsForSync(primary)
        if (dirs === null) return next()
        const hit = longestRootFirst(dirs).find((d) => pathInside(abs, d))
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }

        if (exec.name === 'write') {
          const outcome = await fs.writeText(target, String(args.content), undefined, exec.signal, policy)
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
        const outcome = await fs.editText(
          target,
          { oldString, newString, replaceAll },
          undefined,
          exec.signal,
          policy,
        )
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
        if (args && args.run_in_background === true) return next()
        const dirs = dirsForSync(primary)
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
        const result = await shell.run(shell.resolve({ ...request, signal: exec.signal }))
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
    } catch {
      // Any interception failure falls back to the default pipeline.
      return next()
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
