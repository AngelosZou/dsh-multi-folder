# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] — unreleased

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
