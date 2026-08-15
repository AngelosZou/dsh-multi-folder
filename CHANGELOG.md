# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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
