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
| Host | `lib/index.js` | Config store, tool-pipeline interception, prompt section, notifications, `/multi-folder` command |
| Client | `lib/client.js` | Session-header button + overlay panel; drives the host through the Remote BFF |

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
   - `pwsh`/`bash` → `shell.resolve({ command, workdir, dshEnv, sandboxPolicy })` +
     `shell.run`, with the canonical workdir so the confinement root and the process
     cwd agree exactly.
   The result carries the same canonical value/content shapes as the shipped tools, so
   downstream presentation keeps working.
5. Anything else — unknown tools, paths outside every secondary directory, escalation
   arguments (`sandbox_permissions`), `run_in_background`, missing optional services,
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
- Writes happen only from the command handler (user-initiated) with an explicit
  `workspace-write` policy rooted at the config directory.
- A per-process cache keyed by normalized workspace path hydrates lazily (on
  `agent/created`, `agent/pre-step`, and `tools/execute`).

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

- `inject: ['remote', 'remote.commands', 'slots', 'workspaces']`; the package's
  `dsh.client.inject` lists the packages providing them
  (`@deepseek-ai/dsh-api-gateway`, `@deepseek-ai/dsh-api-remotes`,
  `@deepseek-ai/dsh-client-runtime`).
- UI registrations: `conversation.session.header.actions` (session-scoped button) and
  `shell.overlay` (root-scoped panel). One module-level store is shared by both.
- Host communication: `ctx.remote.commands.execute(sessionId, line)`. The return value
  is the RPC envelope `{ ok, value }` where `value` is the `CommandExecution`; command
  result text carries a `[MF:JSON] {…}` line the panel parses for structured state.
- Session switch: a `React.useEffect` on `sessionId` re-points the open panel to the
  current session, reusing the per-session cache (no command row) or refreshing.
- Per-session caching keeps pure reads (`list`) off the conversation: the command runs
  only on first open per session or on explicit refresh; mutations return their data
  directly and remain visible change records (command lifecycle events are log-only
  and never reach the model).

## Known limitations

- Intercepted secondary-directory writes bypass the fs observation policy: they emit
  no `fs/observed` event and do not participate in the `fs/write-intent` intent guard.
  This is deliberate — secondary directories sit outside the primary workspace's
  observation domain.
- `presentationMeta` is not computed on the short-circuit path; tool cards fall back to
  their default presentation.
- `run_in_background` and `sandbox_permissions` escalation on `pwsh`/`bash` calls in
  secondary directories are passed through to the default pipeline.
- The `/multi-folder` command lifecycle rows (`command/run`, `command/done`) are
  visible in the conversation UI by framework design; they are log-only and never
  reach the model.

## Tests

`test/smoke-host.mjs`, `test/intercept.mjs`, and `test/smoke-client.mjs` run without
the DSH runtime using mock services and a React shim. They cover interception,
canonicalization, the config guard, both notification channels, notice
gating, command flows, and the panel's session-switch/caching behavior.
