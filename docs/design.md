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
| Host | `lib/index.js` | Config store, tool-pipeline interception, prompt section, notifications, `/multi-folder` command, sessionless `multiFolder/*` remote API |
| Client | `lib/client.js` | Session-header button + overlay panel; session-creation page entry (input-dock chip, upstream hero chip, or fixed fallback launcher — one at a time), all driving the host through the Remote BFF / shared RPC channel |

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
     sandboxPolicy })` + `shell.run`, with the canonical workdir so the confinement
     root and the process cwd agree exactly;
   - `pwsh`/`bash`, background (`run_in_background: true`) → the same re-rooted
     request registered through the generic jobs runtime (`ctx.jobs`) exactly like
     the shipped shell tools (`kind` = tool name, `owner` = calling agent, streamed
     reads shaped for `job_output` with sandbox markers, terminal outcome in the
     `completed`/`killed` vocabulary). A caller-aborted call falls through to the
     default pipeline, which raises the canonical abort error.
   The result carries the same canonical value/content shapes as the shipped tools, so
   downstream presentation keeps working.
5. Anything else — unknown tools, paths outside every secondary directory, escalation
   arguments (`sandbox_permissions`), missing optional services (`shell`, `jobs`),
   or any error — falls through to `next()` and the default pipeline.

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
  `agent/created`, `agent/pre-step`, and `tools/execute`).
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
  a `./typert` artifact"). All four descriptors use `src-json` codecs (no zod
  schemas needed) with `invocation: { kind: 'direct' }`:

  | Endpoint | Parameters (wire) | Result |
  | -------- | ----------------- | ------ |
  | `multiFolder/list` | `workspace` | `{ workspace, dirs, changed: false }` |
  | `multiFolder/add` | `workspace`, `path` | `{ workspace, dirs, changed }` |
  | `multiFolder/remove` | `workspace`, `path` | `{ workspace, dirs, changed }` |
  | `multiFolder/set` | `workspace`, `dirs` | `{ workspace, dirs, changed }` |

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

## Host: prompt injection and notifications

- One global `systemPrompt.section` (`multi-folder:secondary-dirs`, order 160) whose
  text provider evaluates per assembly: it reads `context.agent.session.header.cwd`
  and renders the configured directories only for sessions that have them.
- Change notifications use the framework's plugin-sourced `notice` context:
  - the command handler arms a pending notice **only when the directory set changed**;
  - the next boundary consumes it — `agent/pre-step` prepends it to the entering
    message batch, or `tools/post-execute` attaches it as `additionalContexts` —
    whichever fires first. No turn is ever interrupted.

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
  `@deepseek-ai/dsh-client-runtime`).
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
  - session mode: `ctx.remote.commands.execute(sessionId, line)`. The return
    value is the RPC envelope `{ ok, value }` where `value` is the
    `CommandExecution`; command result text carries a `[MF:JSON] {…}` line the
    panel parses for structured state.
  - workspace mode (session-creation page): `ctx.connection.rpc.call('/api',
    'multiFolder/<op>', { args })` against the sessionless remote endpoints.
    The panel runs in either mode according to how it was opened; mutations
    and refreshes route per mode, and both modes share the same row/error UI.
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
    so the hero phase (`composerPhase === 'blank' && (openState === 'open' ||
    blank)`) and the target workspace come from framework props instead of DOM
    probing. The row stays **in flow** — `display:flex` with the official hero
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
- Intercepted secondary-directory writes bypass the fs observation policy: they emit
  no `fs/observed` event and do not participate in the `fs/write-intent` intent guard.
  This is deliberate — secondary directories sit outside the primary workspace's
  observation domain.
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

## Tests

`test/smoke-host.mjs`, `test/intercept.mjs`, and `test/smoke-client.mjs` run without
the DSH runtime using mock services and a React shim. They cover interception,
canonicalization, the config guard, both notification channels, notice
gating, command flows, the panel's session-switch/caching behavior, the
sessionless remote contribution shape and behavior (list/add/set/remove,
idempotence, sanitization, error prefixing, cross-channel cache coherence),
and the hero/workspace-mode client flows. The client test's `slots.inject` mock
is declaration-aware like the real service (a wait fires only while its slot is
declared, and a collapse disposes the registration), so it covers all three
session-creation seats: the dock chip on an rc.6-style shell (registration
shape, in-flow row, hero-only visibility, RPC routing, anchored popover), the
upstream hero chip taking over the moment its slot is declared, and the fixed
launcher returning once both declarations collapse — asserting at each step that
the other two surfaces stand down.
