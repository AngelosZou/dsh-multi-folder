# Design

Architecture and invariants of `dsh-multi-folder`.

## Goal

One DSH project (workspace) gains a user-managed set of **secondary working
directories**. The agent's core `cwd` stays the primary workspace; framework-level
interception makes the existing tools work inside the secondary directories under the
session's current sandbox mode; prompt injection and boundary notifications keep the
agent informed. No new tools are added.

## Planes

| Half | File | Role |
| ---- | ---- | ---- |
| Host | `lib/index.js` | Config store, tool-pipeline interception, prompt section, notifications, `/multi-folder` command, sessionless `multiFolder/*` remote API (configuration, the browser's `browse`/`makeDir`, and the `@` menu's `listFiles`) |
| Client | `lib/client.js` | Session-header button + overlay panel; session-creation page entry (input-dock chip, upstream hero chip, or fixed fallback launcher — one at a time), all driving the host through the Remote BFF / shared RPC channel; the owned directory browser behind "Add directory"; the companion `@` source |

The package declares both faces: `dsh.bundle.patch` (the host row inserted by
`cordis.patch.yml`) and `dsh.client` (the web bundle at `exports["./client"]`).

## Host: interception

A listener on the `tools/execute` around-dispatch waterfall handles `write`, `edit`,
`pwsh`, and `bash`:

1. Resolve the session's standing policy via
   `sandboxPolicy.resolve({ session: exec.agent.session })`.
2. Canonicalize the target path (`write`/`edit`: `fs.resolve(file_path, { cwd: primary })`
   + `fs.processPath`; `pwsh`/`bash`: the same treatment for the resolved `workdir`).
   This makes `..`, symlinks, and case differences match correctly.
3. **Config guard**: if the canonical path equals the host-owned config file,
   short-circuit with an explicit rejection (see Security).
4. If the canonical path is inside a configured secondary directory, execute the
   operation directly with `{ ...standingPolicy, workspaceRoot: <secondary dir> }`:
   - `write`/`edit` → `fs.writeText` / `fs.editText`;
   - `pwsh`/`bash`, foreground → `shell.resolve({ command, workdir, dshEnv,
     sandboxPolicy })` + the seam's foreground call — `shell.run(spec)` up to
     0.1.6-alpha.1, `(await shell.execute(spec)).result()` from 0.1.7-alpha.1 on —
     with the canonical workdir so the confinement root and the process cwd agree
     exactly;
   - `pwsh`/`bash`, background (`run_in_background: true`) → the same re-rooted
     request registered through the generic jobs runtime (`ctx.jobs`) exactly like
     the shipped shell tools (`kind` = tool name, `owner` = the calling session's id, streamed
     reads shaped for `job_output` with sandbox markers, terminal outcome in the
     `completed`/`killed`/`failed` vocabulary). The launch is **async** (it
     publishes the handle only once launch preparation — Windows ACL grants
     included — succeeded, and rejects when preparation is cancelled or fails), so
     the launch is adapted to the jobs runtime's synchronous `run(): JobHooks`
     contract the same way the shipped tools' `processJob` does: the handle is
     awaited, the job-owned `AbortSignal` travels into `shell.resolve` (a cancelled
     job aborts preparation, not just an already-published process), a rejected
     preparation settles the job as `failed` with the real cause, and a read before
     publication is empty. A caller-aborted call falls through to the
     default pipeline, which raises the canonical abort error.
   - Both shell paths ride one version-adaptive seam (`shellUsesExecute`). DSH
     **0.1.7-alpha.1** (commit `d6bebc5783`, "converge on execute()") deleted
     `ShellExecutor.run` and `ShellExecutor.start` in favour of a single
     `execute(spec): Promise<ShellExecution>`, and turned `JobSpec.owner` from the
     calling `Agent` into its `SessionId` — `jobs-local` resolves that id through
     `agents.get(id)`, so an Agent object throws
     `session "[object Object]" has no live agent`. The retired calls map onto the
     new seam exactly: `await shell.run(spec)` becomes
     `await (await shell.execute(spec)).result()`, and `await shell.start(spec)`
     becomes `await shell.execute({ ...spec, onExpiry: 'none' })` — the retired
     `start` armed no deadline at all, while `resolve()` defaults `onExpiry` to
     `'kill'`, so a background run that inherited the default would be killed at
     the executor's timeout. One probe on the **presence of `execute`** selects the
     shape (never the absence of `run`, so a release that keeps the retired methods
     as shims still takes the modern path), which is what keeps every release from
     0.1.2-alpha through 0.2.0-rc.1+ served by the same code. A `ShellExecution`
     *is* the `ShellProcess` the background path already consumed, so the jobs
     adaptation itself needed no change.
   The result carries the same canonical value/content shapes as the shipped tools, so
   downstream presentation keeps working.
5. Anything else — unknown tools, paths outside every secondary directory, missing
   optional services (`shell`, `jobs`), or a failure **before** the target is
   resolved into a secondary directory (path resolution, config lookup, service
   lookup) — falls through to `next()` and the default pipeline. An explicit
   escalation request (`sandbox_permissions` carrying a non-empty mode string) also
   belongs to the default pipeline, which owns the approval flow; a `null`/empty
   value is not a request and is intercepted normally.

**Why mode parity is free:** the mode field of the standing policy is never touched.
The DSH sandbox backends treat the per-call policy as fully specified and fence by its
`workspaceRoot` + `mode`. `read-only` sessions therefore keep getting denied in
secondary directories exactly as in the primary workspace.

Reads (`read`, `glob`, `grep`) need no interception: the DSH filesystem backend does
not policy-fence read paths.

### Service resolution must be lazy

Loader rows activate in dependency order, and this row deliberately declares no hard
dependency on the shell executor or the command registry. Capturing `ctx.get('shell')`
at apply time can yield `undefined` when the provider row activates later. Therefore:

- `shell` / `shellEnv` are resolved **per call** inside the listener;
- the `/multi-folder` command is registered through
  `ctx.inject(['commands'], ctx => ctx.commands.register(...))`, which activates
  whenever the service appears and is disposed with the plugin fiber.

## Host: configuration store

- Canonical location: `<DSH_HOME>/storages/multi-folder/<workspace-key>.json`
  (`DSH_HOME` falls back to `~/.dsh`), i.e. **outside every agent sandbox root**.
- Writes happen only from user-initiated flows (the `/multi-folder` command
  handler and the `multiFolder/*` remote endpoints) with an explicit
  `workspace-write` policy rooted at the config directory.
- A per-process cache keyed by normalized workspace path hydrates lazily (on
  `agent/created`, `agent/pre-step`, and `tools/execute`). On the interception
  path hydration is **awaited**, not fire-and-forget: a first call that landed
  before the config read resolved would otherwise see an empty cache, fall
  through to the default pipeline, and be fenced against the PRIMARY workspace
  root — a spurious `[sandbox: file access denied under workspace-write mode]`
  for a secondary-directory mutation. `loadDirs` caches, so only the first call
  pays the read. Because `sandbox-policy` realpath-canonicalizes the policy
  workspace root while hydration is keyed by the session cwd **as spelled in
  the header**, a workspace reached through a symlinked/junctioned ancestor can
  spell the two differently; the interception consults BOTH keys (and the
  config guard checks both config-path spellings) before falling through.
- One shared **core** (`coreList` / `coreAdd` / `coreRemove` / `coreSet`)
  implements validation, canonicalization, sanitization, cache write-through,
  and persistence. The command channel and the remote channel both call it, so
  the security surface stays identical on both. Core errors carry bare
  messages; each channel adds its own `multi-folder: ` prefix.

## Host: sessionless remote API

The session-creation page has no session (and no `sessionId`), so the
agent-scoped `commands/execute` remote cannot serve it. Instead the plugin
opens its own **sessionless** endpoints on the shared `/api` RPC channel:

- A **plain-object service** is registered with `ctx.provide('multiFolder', api)`.
  The object carries the gateway-visible binding
  `typertRemote = { service, serviceKey: 'multiFolder', namespace: 'multiFolder' }`
  (frozen), which is exactly what the gateway's `validateBinding` expects.
- A **hand-written Typert contribution** is registered through
  `ctx.inject(['typert'], (t) => t.typert.register(REMOTE_CONTRIBUTION))` —
  the sanctioned manual path documented by `dsh-typert-loader` ("Manual
  `ctx.typert.register()` remains available for contributions that do not use
  a `./typert` artifact"). All nine descriptors use `src-json` codecs (no zod
  schemas needed) with `invocation: { kind: 'direct' }`:

  | Endpoint | Parameters (wire) | Result |
  | -------- | ----------------- | ------ |
  | `multiFolder/list` | `workspace` | `{ workspace, dirs, changed: false }` |
  | `multiFolder/add` | `workspace`, `path` | `{ workspace, dirs, changed }` |
  | `multiFolder/remove` | `workspace`, `path` | `{ workspace, dirs, changed }` |
  | `multiFolder/set` | `workspace`, `dirs` | `{ workspace, dirs, changed }` |
  | `multiFolder/browse` | `path` | `{ path, parent, home, entries, truncated }` |
  | `multiFolder/makeDir` | `parent`, `name` | `{ path, parent }` |
  | `multiFolder/listFiles` | `workspace`, `query` | `{ workspace, dirs, candidates, truncated }` |
  | `multiFolder/pick` | `cwd` (plus transport cancellation) | `{ path, via }` |
  | `multiFolder/reveal` | `path` | `{ path, via }` |

  The four configuration endpoints are keyed by workspace; `browse`/`makeDir`
  serve the plugin's own directory browser and are keyed by path instead;
  `listFiles` serves the `@` menu (see its own section below) and is keyed by
  workspace plus the live query.

  The workspace argument is a **path**, not a session id; the client derives
  it from the workspaces store (`WorkspaceView.path`). Business errors throw
  and arrive at the browser as `{ ok: false, error: { message } }`.
- Gateway mechanics verified against `dsh-api-gateway` + `dsh-typert-registry`:
  `resolveDescriptor` finds the endpoint in `typert.local` (claimable on
  `/api`), direct invocation resolves the receiver through
  `ctx.get('multiFolder')` (global shared store), `validateBinding` reads the
  frozen `typertRemote` property, and src-json parameters tolerate omitted
  wire fields. Both registrations are owned by the plugin fiber, so unloading
  the plugin withdraws them together.
- No notice is armed on the remote channel: pre-session changes have no agent
  to notify. The session created afterwards hydrates the cache on
  `agent/created` and the prompt section renders the directories in the very
  first assembly.
- Note: `src-json` descriptors are boundary-validated only for JSON safety
  (the gateway's `assertJsonValue`), not schema-validated. The service itself
  must therefore treat every argument as hostile — the shared core already
  does (type checks, absolute-path requirement, canonicalization, sanitization,
  primary-workspace exclusion).

## Host: `@` discovery for secondary directories

### Why this exists

DSH's `@` file menu is **single-root by construction**, not by omission. Its
provider (`@deepseek-ai/dsh-file-reference-local`) builds exactly one
`WorkspaceFileSearch` per agent from `agent.session.header.cwd`, and that
searcher refuses every candidate outside its root — a directory query resolves
against the root and answers `undefined` for a path that escapes it (`..`
check). Browser-side, `@deepseek-ai/dsh-client-ui-reference` registers the only
`@` source and forwards each query to `remote.fileReferences.list`. A configured
secondary directory is by definition outside the primary workspace, so no
amount of typing can make the shipped menu offer one.

The plugin therefore does not touch that provider at all. It publishes its own
discovery endpoint over the files it already has read access to and contributes
a companion menu group, which keeps both failure modes separate: a broken
discovery path degrades to an empty group and can never affect the shipped
files/sessions group.

### Index and query rules

`multiFolder/listFiles(workspace, query)` rides the same sessionless remote
namespace as the browser endpoints and the same `fs` seam (`fs.resolve` +
`fs.listDir`), so it needs no session and no new capability:

| Rule | Why |
| ---- | --- |
| Breadth-first, bounded by `MAX_INDEX_ENTRIES` across all directories | one workspace's index cannot grow without limit |
| Canonical-path deduplication (`fs.resolve` + `fs.processPath` per level) | a junction/symlink pointing back up the tree cannot re-enter the walk |
| `INDEX_EXCLUDED` basenames never traversed | mirrors the shipped provider's defaults (`.git`, `node_modules`, build output); `lib` is deliberately absent there and therefore here |
| Hidden entries indexed but invisible to a global query | parity with the shipped provider: `.foo` needs an explicit `.` query |
| Per-workspace index cached with `FILE_INDEX_TTL_MS` (4 s) and a directory signature | config changes invalidate immediately; on-disk changes are caught within the TTL. Autocomplete is advisory, so staleness is invisible while rebuild cost stays bounded to one traversal per window |
| An empty query yields the configured directories themselves | the menu's entry points; `@` alone stays cheap and does not list 30 files |

Ranking mirrors the shipped provider (name beat path, directories win ties,
then shorter paths, then name order) with **one deliberate deviation**: the
path and subsequence rules read the *in-directory relative* path, never the
absolute one. Every absolute path on a host shares its prefix (`D:/…`), so
scoring it would make a one-character query match literally every candidate.
The configured directory's own basename stays searchable at the lowest rank,
which is what lets `@secondary-spike` narrow to that directory.

A query carrying `/` lists a level instead of ranking one, and accepts two
spellings — the absolute path a drill inserted, and a leading basename segment
(`@secondary-spike/src/`). An ambiguous basename (two configured directories
sharing one) resolves to nothing rather than to a guess. The decoded
in-directory path is normalized (redundant separators and `.` segments drop)
but **any `..` segment is refused**: without that, `@secondary/../../etc/` would
list a directory outside every configured root while still claiming the
configured directory as the candidates' owner — a listing that escaped the set
the user granted, wearing a name that lies about it. The shipped provider
refuses the same escape for the same reason.

### Mention semantics

A secondary directory lies outside the workspace root, so no relative path from
that root can reach one: candidates are **absolute** paths (forward-slashed,
which is the spelling the mention grammar and the prompt guidance already use
for host paths). `formatMention` in the client half re-implements the shipped
grammar — whitespace quotes the path, a quoted directory keeps its quote open
so completion can descend, and control characters or an embedded quote make a
path unrepresentable, so that row is dropped rather than inserted broken. The
bundle is standalone (no build step) and cannot import that package's module,
hence the re-implementation.

### Client contribution

| Decision | Reason |
| -------- | ------ |
| A **companion source** (`trigger: '@'`, `name: 'multi-folder'`), not a replacement | the registry keys sources by `(trigger, name)` and throws on a duplicate; the shipped `reference` source keeps answering untouched |
| `order: 10` | the shipped group declares no order and defaults to `0`, so the secondary group sits below it |
| `showGroupTitle: false` | the menu derives a group's title by looking its **source name** up in its own dictionary, so a visible title would read `multi-folder` — and an empty result would render that heading over an empty list |
| A `section` on every row = the directory | rows are headed by the directory they came from, and the abbreviation of a path under the host home (`~`) keeps that heading readable |
| `ctx.inject(['inputTriggers'], …)`, not a hard `inject` entry | a shell composing no trigger service must keep every panel surface; this contribution then simply never activates |
| Own `codec` (identity) | `serializeReference` resolves the owner by **source name** and rejects a codec-less owner, so the source must own one even though the mention IS the model form |
| Failures resolve to `[]` | discovery is advisory: it must never break the composer or the groups beside it |
| Queries are per keystroke, like the shipped source | the host index makes each call an in-memory rank |

## Host: prompt injection and notifications

- One global `systemPrompt.section` (`multi-folder:secondary-dirs`, order 160) whose
  text provider evaluates per assembly: it reads `context.agent.session.header.cwd`
  and renders the configured directories only for sessions that have them.
- Change notifications use the framework's plugin-sourced `notice` context:
  - the command handler arms a pending notice **only when the directory set changed**;
  - the next boundary consumes it — `agent/pre-step` prepends it to the entering
    message batch, or `tools/post-execute` attaches it as `additionalContexts` —
    whichever fires first. No turn is ever interrupted.
  - the notice's `source` declares a **producer-owned kind**
    (`kind: 'plugin:dsh-multi-folder'`, `form: 'notice'`, `summary`). Session
    format v4 admitted only the retired catch-all wrapper `kind: 'plugin'` for
    nothing: `sessionFormatCatalog.encodeCurrentEvent` — which the JSONL writer
    runs on every appended event — throws
    `format v4 message requires a producer-owned source kind` for it, failing the
    run the moment a notice is logged. `plugin:<plugin>` is the spelling the
    format's v3→v4 migration itself produces for a non-first-party producer
    (`session-format-v3-to-v4/src/sources.ts`), so it is also what this plugin's
    older logs migrate to. The `workdir` diagnosis attached at a tool-call
    boundary is built by the same function and fixed with it.

## Client

`lib/client.js` is a **hand-maintained factory bundle** in the DSH client-modules
format — no build toolchain:

```js
window.__ModuleLoader__.load({
  id: 'dsh-multi-folder',
  factory: (require) => { /* CJS-style module body; exports = { name, inject, apply } */ },
})
```

- `inject: ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions', 'locale']`; the package's
  `dsh.client.inject` lists the packages providing them
  (`@deepseek-ai/dsh-api-gateway`, `@deepseek-ai/dsh-api-remotes`,
  `@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-client-locale`,
  `@deepseek-ai/dsh-client-ui-input-trigger`). The trigger registry is
  deliberately **not** in that hard list: the `@` source is contributed through
  `ctx.inject(['inputTriggers'], …)`, so shells without that service keep every
  panel surface (see the `@` discovery section).
- UI registrations: `conversation.session.header.actions` (session-scoped button),
  `shell.overlay` panel, `conversation.input.dock` chip row (session-scoped
  list entry above the composer card — the session-creation page's shipped
  seat), `shell.overlay` hero launcher (root-scoped fixed-position fallback),
  and `conversation.hero.workspaceExtras` (upstream slot; see below). One
  module-level store is shared by all of them, and only ONE session-creation
  entry ever renders (see "hero seat election").
- **Localization (zh / en).** All client copy goes through
  `@deepseek-ai/dsh-client-locale` (always composed by the standard web
  profile). The bundle registers a `multi-folder` dictionary namespace with
  `ctx.effect(() => locale.register(NS, { zh, en }))` — the locale service
  enforces bilingual balance, and the effect ties the dictionaries to the
  plugin fiber. Every slot registration declares `locale: 'multi-folder'`,
  so the renderer synthesizes the `t` seat on component props and
  re-renders mounted outlets on locale switch; list-entry `label`s are
  thunks (`() => t('label')`) that `resolveSlotLabel` re-evaluates per read,
  so registration-time text follows the active locale without
  re-registering. The active locale is the browser language or the user's
  Language preference in Settings; the English UI reads "Multi-folder", the
  Chinese UI keeps 「多工作目录」.
- Host communication, two channels:
  - session mode: `ctx.remote.commands.execute(sessionId, line, [])`. Since
    DSH 0.1.1 the remote takes the composer-images argument as its third
    business argument (empty array for a plain invocation). The return
    value is the RPC envelope `{ ok, value }` where `value` is the
    `CommandExecution`; command result text carries a `[MF:JSON] {…}` line the
    panel parses for structured state.
  - workspace mode (session-creation page): `ctx.connection.rpc.call('/api',
    'multiFolder/<op>', { args })` against the sessionless remote endpoints.
    The panel runs in either mode according to how it was opened; mutations
    and refreshes route per mode, and both modes share the same row/error UI.
- Directory picking: `multiFolder/pick` calls the host's `native` picker with
  the RPC abort signal, then tries a host OS dialog if that picker fails.
  A `browse` capability returns `unavailable` immediately, so remote clients
  open the plugin's browser instead of a dialog on the host. A completed dialog
  returns a path or `null` on cancellation; closing the panel aborts the request.
- The owned browser's listing rides the **`fs` seam** (`fs.resolve` +
  `fs.listDir`), which every composition provides; only directories are
  returned, hidden entries are flagged, the level is capped at 1000 with a
  `truncated` flag, and paths must be fully qualified. Creation mirrors the
  shipped browse backend (`dsh-host-directory-picker-browse`) by calling Node's
  `mkdir` on a validated single segment, because the `fs` seam exposes no
  creation primitive. Neither endpoint touches the configuration store: choosing
  a level still commits through the mode's own channel (`/multi-folder add` in a
  session, `multiFolder/add` on the creation page).
- On Windows, `lib/native-picker.ps1` uses `IFileOpenDialog` on an STA thread,
  sets per-monitor DPI awareness, and closes an unanswered dialog on a deadline.
  It exits 0 for a selection or dismissal and nonzero when `Show()` fails.
  `multiFolder/reveal` checks `fs.stat` before opening an existing directory
  with the host file manager.
- `@` source: registered through `ctx.inject(['inputTriggers'], …)` (see the
  `@` discovery section for the full decision table). It resolves the addressed
  session's workspace from the `sessions` snapshot (`byId[sessionId].cwd`), calls
  `multiFolder/listFiles` over the shared RPC channel, and projects each
  candidate onto a row — a `section` naming its directory, an in-directory
  `description`, and a `value` carrying the mention the pick inserts. Directory
  rows set `drill`, so the shipped drill gesture descends a level.
- Session switch: a `React.useEffect` on `sessionId` re-points the open panel
  to the current session (reusing the per-session cache) — this also folds a
  workspace-mode panel back into session mode once the first message creates
  the session.
- Caching: per-session cache (`sessionCache`) keeps pure reads off the
  conversation; per-workspace cache (`workspaceCache`) plays the same role for
  the sessionless channel.
- Hero (session-creation page) support — **three candidate seats, one visible
  entry**:
  - The **dock chip** (`conversation.input.dock`, id `multi-folder`,
    order 120) is the shipped seat: a `list` slot the rc.6 shell declares and
    renders directly ABOVE the composer card, in the same band as the
    git-branch chip. The entry receives the dock owner share (`{ session,
    input }`) plus the standard `useSessions` / `useWorkspaces` selector hooks,
    so the hero phase and the target workspace come from framework props instead
    of DOM probing. Detection is DSH-version-adaptive: a shell whose
    `SessionSnapshot` carries `composerPhase` uses
    `composerPhase === 'blank' && (openState === 'open' || blank)`, while DSH
    0.1.2 (no `composerPhase`) uses the settled-blank fallback
    `blank && !running && !promptAttempted && (openState === 'open' || blank)`.
    The row stays **in flow** — `display:flex` with the official hero
    row's 20px indent, no absolute positioning — so the framework's list-slot
    arrangement keeps it clear of every other plugin's dock row. It renders
    only on the session-creation page; an active session keeps its entry in the
    session header, so the two never appear together.
  - The **hero chip** registers into `conversation.hero.workspaceExtras` via
    `slots.inject`, which waits for the declaration: with an upstream DSH
    build that declares the slot, the chip renders inline beside the workspace
    picker; without one, the registration contributes nothing.
  - The **hero launcher** (`shell.overlay` entry, `multi-folder-hero`) is the
    last-resort fallback for shells that declare neither slot. Only then does
    it subscribe to `sessions.list` + `workspaces.list` and observe the
    conversation root's `data-phase="hero"` attribute (MutationObserver on
    `document.body`) to render a fixed-position button; the
    workspace path is derived from the current (blank) session's
    `WorkspaceView.path`, falling back to `SessionSummary.cwd`.
  - **Hero seat election.** Each seat claims a token while its slot declaration
    is live (`slots.inject` fires only for declared slots and disposes on
    collapse); the components render only while holding the best live claim
    (`extras` > `dock` > fallback). The framework arranges *different plugins*
    on a shared `list` slot but has no opinion about one plugin holding several
    alternative seats, so this election is the plugin's own duty.
  - Clicking any of them opens the panel in workspace mode; without a selected
    workspace the panel shows the "pick a workspace first" hint.
- Panel placement: one `panelBody(store, t)` function returns the panel's
  children, spread by whichever wrapper owns the panel — the fixed
  `shell.overlay` panel (session-header path) or an `AnchoredPanel` popover
  rendered by the chip itself (opening upward from the dock row, downward from
  the hero row). `store.anchor` names the owner, and the overlay wrapper stands
  down whenever a chip owns it, so the panel never renders twice.
- Styling: all surfaces use the official `--dsw-alias-*` design tokens
  (`dsh-client-ui-theme`) with inert fallbacks, so themes and applied skins
  restyle this plugin's chip and panel along with the shell's own controls.

## Known limitations

- Each confined command runs under exactly ONE writable root: the Windows ACL
  runner grants a single workspace write SID per process tree (`--write-sid`
  must match `--workspace`), and re-rooting replaces the root. A command whose
  cwd stays the primary workspace therefore cannot create files inside a
  secondary directory — `git -C <secondary> commit`, `cd <secondary>` inside a
  script, `git clone <url> <secondary>`, and absolute-path writes fail with an
  OS-level `Permission denied` (`fatal: Unable to create '.../.git/index.lock':
  Permission denied`) that carries no sandbox marker. Symmetrically, a command
  re-rooted to a secondary directory cannot write the primary workspace in the
  same invocation. The injected prompt states the workdir rule, and a
  `tools/post-execute` heuristic attaches a workdir-fix hint when a failed
  `pwsh`/`bash` run both mentions a configured secondary directory and ends in
  a denial (`permission denied` / `access … denied` / `is denied` / `eacces`;
  the plugin's own `[sandbox: …]` marker lines are excluded from the scan).
  Lifting this to real multi-root confinement needs an upstream change
  (`SandboxExecutionPolicy` carrying extra write roots and the ACL runner
  accepting several workspace write SIDs).
- A **relative** `workdir` never re-roots a run: the shipped shell tools resolve
  it against the session workspace (the primary root), so only an ABSOLUTE path
  into a secondary directory is intercepted. Likewise, changing the process
  directory inside the command (`Set-Location` / `cd`) moves the process cwd but
  not the ACL write root — the reported symptom is an OS-level access denial on
  the file write (Windows error 5, e.g. `torch.save`'s
  `open file failed with error code: 5`), not a sandbox marker. On a BACKGROUND
  run that denial surfaces in the job's `job_output` stream after the tool call
  has already returned, so the `tools/post-execute` hint cannot see it; the fix
  is the same — re-run with an absolute `workdir` inside the secondary directory.
- Intercepted secondary-directory mutations do not participate in the
  `fs/write-intent` / `fs/edit-intent` intent guards (the interception calls
  the backend unconditionally, as a full replacement of the tool body), but
  they DO emit `fs/observed` with a presence observation after success, exactly
  like the shipped tools — so the observation layer stays coherent with the
  file content a re-rooted write/edit produced.
- `presentationMeta` is not computed on the short-circuit path; tool cards fall back to
  their default presentation.
- `sandbox_permissions` escalation on `pwsh`/`bash` calls in secondary directories is
  passed through to the default pipeline, which re-roots the escalated run at the
  PRIMARY workspace — escalation never widens a secondary root. (Background runs are
  NOT passed through: they register with `ctx.jobs` under the same re-rooted policy
  as foreground runs.)
- The interceptor registers a background `pwsh`/`bash` job whenever `ctx.jobs` is
  available; it cannot read the shipped shell tools' per-tool
  `enableRunInBackground: false` config, so a deployment that disables background
  execution would still serve secondary-dir background jobs. Deployments that
  disable background execution should also disable this plugin's shell interception
  or accept that exception.
- The `/multi-folder` command lifecycle rows (`command/run`, `command/done`) are
  visible in the conversation UI by framework design; they are log-only and never
  reach the model. Workspace-mode (session-creation page) operations avoid them
  entirely by using the sessionless remote channel.
- The session-creation entry depends on shell internals to different degrees per
  seat. The **dock chip** reads only declared contract surfaces (the
  `conversation.input.dock` declaration, its owner share, and the standard
  selector hooks), but its 20px indent is tuned to the shipped hero row's
  padding — a restyled shell would misalign it, never break it. The **fallback
  launcher** relies on the conversation root's `data-phase="hero"` attribute and
  the `sessions.list`/`workspaces.list` snapshot shapes — DOM and client-runtime
  internals rather than documented APIs; they are guarded defensively (missing
  services or DOM degrade to "launcher hidden") and it only mounts when no
  declared seat exists. The upstream `conversation.hero.workspaceExtras` slot
  (see [upstream-hero-slot.md](upstream-hero-slot.md)) remains the long-term
  surface.
- Sharing the `conversation.input.dock` band is safe by construction (unique
  `id`, explicit `order`, in-flow layout) but `order` is a shared number space,
  not an enforced allocation: another plugin may pick the same `order` and the
  tie is then broken by registration sequence. The rows still stack without
  overlapping — only their vertical sequence is unspecified. Absolute-positioned
  neighbours (the git-branch chip lifts itself into the hero row) are outside
  the framework's arrangement entirely; this plugin deliberately does not do the
  same.
- The `multiFolder/*` endpoints use hand-written `src-json` Typert descriptors
  registered through `ctx.typert.register`. `src-json` gives JSON-safety
  boundary checks, not schema validation; the shared core performs all
  business validation server-side. DSH versions that change the Typert
  registry contract would need this contribution revisited (the tests assert
  the descriptor shape).
- `@` discovery is a **companion group, never a merged list**. The shipped
  provider stays single-root, so a secondary file appears under the plugin's
  own group and its mention is an ABSOLUTE path — a relative one could not
  reach outside the workspace root. Consequences worth knowing: the workspace
  file list and the secondary list are ranked separately (the shipped group's
  relevance order never mixes with ours, and only the first 30 secondary
  candidates of a query are offered), a session whose workspace has no
  configured directories gains an empty group that renders nothing, and the
  index is advisory by design — it is rebuilt lazily (4 s TTL) rather than
  invalidated on every tool result, so a file created in a secondary directory
  can take a few seconds to appear in the menu.
- A **symlinked or junctioned level inside a configured directory is indexed and
  listed through the link**, where the shipped provider skips symlinked
  directories. The fs seam's `listDir` reports only an entry's `type`, so a link
  is not distinguishable from a directory without a second canonicalization per
  child — and rejecting on that basis would also reject junctions that are
  ordinary project structure (and a secondary directory reached through a
  junctioned ancestor). The walk stays bounded regardless: canonical-path
  deduplication prevents a link from re-entering it, and `MAX_INDEX_ENTRIES`
  caps it. Reads are unfenced in DSH, so this grants no access the plugin's own
  directory browser does not already have.
- The `@` group depends on the trigger registry's source contract
  (`trigger`/`name`/`order`/`showGroupTitle`, `candidates`/`onPick`/`codec`,
  candidate `section`/`icon`/`drill`, and the `(trigger, name)` uniqueness key).
  A DSH release that changes that contract would need this contribution
  revisited; because the registration rides `ctx.inject`, a release that drops
  the service entirely degrades to "no `@` group" instead of breaking the
  plugin's panel.

## Tests

`test/smoke-host.mjs`, `test/intercept.mjs`, and `test/smoke-client.mjs` run without
the DSH runtime using mock services and a React shim. They cover interception,
canonicalization, the config guard, both notification channels, notice
gating and the producer-owned notice source kind v4 admits, command flows, the panel's session-switch/caching behavior, the
sessionless remote contribution shape and behavior (list/add/set/remove,
idempotence, sanitization, error prefixing, cross-channel cache coherence),
the owned browser's host half (`browse` filtering/sorting/hidden flags, the
fully-qualified-path fence, `makeDir` segment validation against a real
temporary directory, and that neither endpoint writes the config store),
and the hero/workspace-mode client flows — including the browser's own client
flow (open at the panel workspace, enter a level, commit through the mode's
channel, create a child and enter it, and return without a remote call). The client test's `slots.inject` mock
is declaration-aware like the real service (a wait fires only while its slot is
declared, and a collapse disposes the registration), so it covers all three
session-creation seats: the dock chip on an rc.6-style shell (registration
shape, in-flow row, hero-only visibility, RPC routing, anchored popover), the
upstream hero chip taking over the moment its slot is declared, and the fixed
launcher returning once both declarations collapse — asserting at each step that
the other two surfaces stand down.

`@` discovery is covered on both halves against a fake secondary tree behind the
`fs` seam: the host test asserts the empty-query entry points, bare-fragment
ranking, directory-basename narrowing, level listing by both spellings,
recursion, hidden-entry visibility, `node_modules` exclusion, index caching
inside the TTL, the workspace fence, config-store isolation, and that clearing
the configuration withdraws the surface; the client test asserts the source's
identity/order/`showGroupTitle`, its RPC routing and keying, row projection
(section heading, `~` abbreviation, in-directory description, drill flag,
folder icon), quote handling, the pick inserts, the identity codec, and that
both an unrepresentable path and an RPC failure degrade quietly.
