# Changelog

All notable changes to this project are documented in this file.

## [0.2.1] — 2026-08-28

### Fixed

- Fix in DSH 0.1.2 session-creation page folder selection missing.
- Fix in DSH 0.1.2 "Add directory" in an existing session did nothing.

## [0.2.0] — 2026-08-28

### Changed

- Adaptive to DSH 0.1.2 alpha, no longer support DSH 0.1.1 or previous version

## [0.1.6] — 2026-08-22

### Fixed

- **DSH 0.1.1 compatibility: `commands/execute` image argument.** The Remote
  BFF's `commands/execute` now takes three business arguments —
  `(sessionId, line, images)` — plus an optional `AbortSignal`; the client
  gateway validates the count and rejected the previous two-argument call
  with `client api: commands/execute expected 3 business argument(s) plus an
  optional AbortSignal, got 2`. The client now passes `[]` (the plugin never
  attaches composer images). `test/smoke-client.mjs` asserts the new call
  shape.

## [0.1.5] — 2026-08-17

### Changed

- **Session-creation page entry moved above the composer.** The new-session
  entry was a fixed launcher pinned to the bottom-right corner of the page,
  detached from the controls it belongs with. It now renders as a chip row in
  the shipped `conversation.input.dock` band — directly above the composer
  card, indented onto the same left edge as the official workspace/preset chips
  and the git-branch chip — and opens the panel as a popover anchored to the
  chip instead of a panel floating in the opposite corner. The chip also shows
  the configured directory count once its (conversation-row-free) workspace
  read lands.
- The dock row is deliberately **in flow** (`display:flex` + the hero row's
  indent, no absolute positioning, no measurement): the framework arranges
  co-registered `list`-slot entries as sibling rows (sorted by
  `priority`/`order`, one cell per `id`, a loud duplicate-`(id, priority)`
  guard, `display:contents` outlets), so an absolutely positioned row would
  leave that arrangement and silently overlap a neighbour's chip.
- Session-creation seats are now **elected, not stacked**: the three candidate
  surfaces (upstream `conversation.hero.workspaceExtras` chip >
  `conversation.input.dock` row > fixed fallback launcher) each claim a token
  while their slot declaration is live, and only the best live claim renders —
  so the page can never show two Multi-folder entries, whichever shell is
  running. The fallback launcher no longer even wires its `MutationObserver`
  while a declared seat holds the page, and the dock chip reads the hero phase
  and target workspace from framework props (the dock owner share plus the
  standard `useSessions`/`useWorkspaces` hooks) instead of probing the DOM.
- The dock chip renders only on the session-creation page; an active session
  keeps its entry in the session header, so the two never appear at once.
- All client surfaces are restyled from the official `--dsw-alias-*` design
  tokens (`dsh-client-ui-theme`) with inert fallbacks, replacing the previous
  `--color-*` names, which matched no shipped token and therefore always fell
  through to hard-coded greys. Themes and applied skins now restyle this
  plugin's chip and panel along with the shell's own controls.
- The panel body is one shared function spread by whichever wrapper owns it
  (fixed overlay for the session-header path, anchored popover for a chip), so
  both placements render one identical panel and the overlay stands down
  whenever a chip owns the open panel.
- `test/smoke-client.mjs`: the `slots.inject` mock is now declaration-aware
  like the real service (waits fire only while their slot is declared, and a
  collapse disposes the registration), covering all three seats and asserting
  that the other two stand down at each step.

## [0.1.4] — 2026-08-17

### Added

- Failure diagnosis for OS-level permission denials touching secondary
  directories: the Windows ACL runner confines each process tree to ONE writable
  root, so a command whose cwd stays the primary workspace cannot create files
  inside a secondary directory (`git -C <secondary> commit` fails with
  `fatal: Unable to create '.../.git/index.lock': Permission denied`, and the
  failure carries no sandbox marker). A `tools/post-execute` heuristic now
  attaches a workdir-fix hint as an additional context when a failed
  `pwsh`/`bash` run mentions a configured secondary directory and ends in a
  denial; the symmetric case (a run re-rooted to a secondary directory denied a
  write OUTSIDE it) gets its own hint. The plugin's `[sandbox: …]` marker lines
  are excluded from the denial scan.

### Changed

- The injected prompt section now states the single-writable-root constraint
  explicitly: file-creating commands (git included) MUST pass `workdir` inside
  the secondary directory, and `git -C <secondary>` / `cd <secondary>` inside a
  command launched from the primary workspace will be denied.
- `README.md` / `README.zh.md`: new "Permission model / 权限模型" section
  documenting the one-root-per-command rule and the diagnostic hint.
- `docs/design.md`: Known limitations now records the single-writable-root
  constraint, the heuristic hint, and the upstream multi-root direction
  (extra write roots on `SandboxExecutionPolicy` + several workspace write SIDs
  on the ACL runner).

## [0.1.3] — 2026-08-15

### Fixed

- Background `pwsh`/`bash` runs (`run_in_background: true`) whose `workdir` lands in
  a secondary directory were passed through to the default pipeline, which re-rooted
  the sandbox at the PRIMARY workspace — writes inside the secondary directory were
  denied (`[sandbox: file access denied under workspace-write mode]`) even though
  the identical command succeeded in the foreground. The interceptor now registers
  these runs with the generic jobs runtime (`ctx.jobs`) under the same re-rooted
  policy as foreground runs, mirroring the shipped shell tools: `kind` = tool name,
  `owner` = calling agent, streamed reads shaped for `job_output` (loss/spill and
  sandbox markers), and a terminal outcome in the `completed`/`killed` vocabulary.

### Changed

- The injected prompt section now states explicitly that shell tools must pass
  `workdir` inside a secondary directory for both foreground and background runs.
- `docs/design.md`: interception walkthrough and Known limitations updated for the
  background-job path (escalation remains on the default pipeline, rooted at the
  primary workspace).

## [0.1.2] — 2026-08-15

### Changed

- Client UI is now localized through `@deepseek-ai/dsh-client-locale`: the
  bundle registers a `multi-folder` dictionary namespace (zh + en, bilingual
  balance enforced by the locale service), declares `locale:` on every slot
  registration (the renderer supplies the `t` seat and re-renders on locale
  switch), renders all panel/header/hero copy through it, and turns every
  list-entry `label` into a thunk that follows the active locale. The UI
  shows "Multi-folder" in English and 「多工作目录」 in Chinese, following the
  browser language or the Language preference in Settings.

## [0.1.1] — 2026-08-15

### Added

- Session-creation page configuration: a sessionless `multiFolder/*` remote API
  (registered through `ctx.typert.register` with hand-written `src-json`
  descriptors, sharing one validated core with the `/multi-folder` command) lets
  the new-session screen read and edit per-workspace directories before any
  session exists. Client entries: a fixed hero launcher (`shell.overlay`, driven
  by the conversation root's `data-phase` attribute) plus an inline chip for the
  upstream `conversation.hero.workspaceExtras` slot (see docs/upstream-hero-slot.md).

## [0.1.0] — 2026-08-14

### Added

- Secondary working directories per project, user-configured via a session-header UI
  panel or the `/multi-folder` slash command (list / add / remove / set).
- Framework-level tool-pipeline interception (`tools/execute`): `write`, `edit`,
  `pwsh`, `bash` calls landing in a configured secondary directory execute with the
  session's sandbox policy re-rooted to that directory — identical semantics to the
  primary workspace in every sandbox mode. No new tools are added.
- Per-session system-prompt section listing the configured directories.
- Non-interrupting change notifications delivered at the next message boundary
  (`agent/pre-step` and `tools/post-execute` channels), fired only when the directory
  set actually changed.
- Explicit rejection of direct agent writes/edits to the configuration file
  (security boundary: configuration is user-managed).
- Client panel: session-switch auto-sync, per-session caching to avoid redundant
  command rows, add/remove/refresh flows via the Remote BFF.
