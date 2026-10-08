# dsh-multi-folder

**English** | [中文](README.zh.md)

> Secondary working directories for a DeepSeek Harness project — edit a source repo, a test repo, and a docs repo side by side without leaving the primary workspace.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-brightgreen)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/dsh-multi-folder)](https://www.npmjs.com/package/dsh-multi-folder)
[![GitHub issues](https://img.shields.io/github/issues/AngelosZou/dsh-multi-folder)](https://github.com/AngelosZou/dsh-multi-folder/issues)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundle that gives one project (workspace) a set of **secondary working directories**:

- The agent's core `cwd` and every other core attribute keep pointing at the **primary workspace**.
- Under **Workspace Write** mode the agent gains the **same read / write / edit / execute permissions** on the configured secondary directories as on the primary workspace — enforced by re-rooting the session's own sandbox policy, so every mode keeps its semantics (`read-only` still denies, `workspace-write` allows, `danger-full-access` allows).
- The directory list is **injected into the system prompt** and re-rendered per session assembly.
- Configuration changes notify the agent through a **non-interrupting message queue** — delivered at the next message boundary (user send or tool-call end), and **only when the directory set actually changed**.
- Configurable **before the session starts**: the session-creation page (new-session screen) offers a Multi-folder entry that reads and edits the same per-workspace configuration through a **sessionless remote API** (`multiFolder/*` endpoints) — no session id required.
- The **`@` file menu finds files in the configured directories**. The shipped `@` menu only ever searches the primary workspace, so this plugin contributes its own `@` group listing the secondary directories — headed by each directory.
- **"Add directory" asks the system for a folder** whenever the host can offer one: its own composed native picker first, then the OS dialog of the host machine. The plugin's own browser stays as the interaction that works in every deployment.
- **No new tools.** Everything is a framework-level change (tool-pipeline interception) plus a UI-level change (a session-scoped header entry).

## Requirements

- Node.js >= 20
- A DSH profile composed from `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`

## Install

Link this repository into a DSH profile:

```bash
dsh plugin --profile web add dsh-multi-folder
```

Then **restart the DSH backend** (host composition loads at process start) and **refresh the browser page** (the client bundle is served `no-cache`).

## Compatibility

Choose the plugin version that matches your DeepSeek Harness release:

| DeepSeek Harness | Install |
| --- | --- |
| 0.1.1 or earlier | `dsh-multi-folder@0.1.7` |
| 0.1.2-alpha or later | the latest `dsh-multi-folder` |

## Usage

A Multi-folder button appears in the session header, and a second entry appears on the **session-creation page**: a chip row directly above the composer card (the same band the git-branch chip uses), aligned with the workspace/preset chips of the new-session screen. Clicking it opens the panel as a popover anchored to the chip. Exactly one session-creation entry is ever shown — the plugin registers three candidate seats and elects the best available one (upstream `conversation.hero.workspaceExtras` chip > `conversation.input.dock` row > fixed bottom-right launcher for shells declaring neither). The panel lets you:

| Action | Behavior |
| ------ | -------- |
| Add directory | Opens the **system folder dialog** — the host's composed native picker when it has one, otherwise the OS dialog of the host machine — and falls back to the plugin's own browser (path field, one level of child directories, optional new folder) when a deployment has no system picker |
| Open in file manager | Opens the host's file manager (Explorer / Finder) at a configured directory |
| Remove / refresh | Applies immediately |
| Switch session | The panel auto-switches to that session's directories |
| Reopen panel | Uses the per-session cache — no redundant command rows |

Equivalent slash command for the user:

```
/multi-folder list
/multi-folder add "D:\path\to\repo"
/multi-folder remove "D:\path\to\repo"
/multi-folder set "D:\a" "D:\b"
```

The agent needs nothing extra: `read` / `glob` / `grep` work everywhere, and `write` / `edit` / `pwsh` / `bash` are intercepted and re-rooted automatically when the target path (or `workdir`) falls inside a configured secondary directory.

### Finding secondary files with `@`

Typing `@` in the composer offers the usual primary-workspace files **and** a group per configured secondary directory, fed by the plugin's own `multiFolder/listFiles` endpoint:

| You type | You get |
| -------- | ------- |
| `@` | one row per configured directory — the entry points |
| `@probe` | any matching file or directory across every configured directory, headed by its directory |
| `@secondary-spike/src/` | that level, listed (directories first) |
| `@D:/repos/other/src/` | the same level by its absolute spelling |

Picking a row inserts an **absolute-path** mention (`@D:/repos/other/src/main.ts`), because a secondary directory lies outside the primary workspace and no relative path from it can reach one. Directory rows offer the usual `Tab` drill to descend.

This is a **companion group, not a change to the shipped menu**: DSH's own `@` provider searches the session workspace only, and it is left exactly as it is. A workspace with no secondary directories configured behaves precisely as before.

## Permission model

Each confined command runs under **exactly ONE writable root** — the workspace root the call is re-rooted to (the Windows ACL runner grants a single workspace write SID per process tree). Consequences:

- A command whose cwd stays the **primary workspace cannot create files inside a secondary directory**. `git -C <secondary> commit`, `cd <secondary>` inside a script, `git clone <url> <secondary>`, or absolute-path writes all fail with an OS-level `Permission denied` (e.g. `fatal: Unable to create '.../.git/index.lock': Permission denied`).
- Symmetrically, a command re-rooted to a secondary directory cannot write to the **primary workspace** (or another secondary directory) in the same invocation.
- **Rule for file-creating commands: set `workdir` to the directory the command writes into**, and pass it as an **absolute** path — a relative `workdir` is resolved against the primary workspace, and changing the process directory inside the command (`Set-Location` / `cd`) does not widen the writable root (the write then fails with an OS-level denial, Windows error 5). For git, run the command from inside the repository (pass `workdir` pointing at it) instead of using `git -C` from the primary workspace. The rule applies to `run_in_background: true` runs exactly as to foreground ones.
- Reads are unrestricted and need no `workdir`.

When a shell run ends in such a denial and references a configured secondary directory, the plugin attaches a short diagnostic hint to the tool result explaining the workdir fix. A **background** run's denial surfaces later instead — in that job's `job_output` stream, after the tool call has already returned — so read the job output and re-run it with an absolute `workdir`.

## How it works

- **Interception** — a listener on the `tools/execute` around-dispatch waterfall short-circuits `write` / `edit` / `pwsh` / `bash` calls whose resolved path (or `workdir`) lands inside a configured secondary directory, and executes them with the session's standing sandbox policy **re-rooted to that directory** (`{ ...standingPolicy, workspaceRoot: secondaryDir }`). The mode itself is untouched, which is what gives every sandbox mode its identical primary-workspace semantics for free. Paths are canonicalized through `fs.resolve` + `processPath` before matching, so `..`, symlinks, and case differences behave correctly.
- **Prompt injection** — one ordered `systemPrompt` section with a text provider evaluated per assembly, rendering only for sessions whose workspace has configured directories.
- **Notifications** — a pending notice armed by the command handler (only on actual change) is consumed at the next boundary by either the `agent/pre-step` waterfall (prepend into the entering message batch) or the `tools/post-execute` waterfall (attach as `additionalContexts`), whichever fires first — the framework's native plugin-sourced `notice` context.
- **Configuration & security boundary** — per-workspace config lives in a host-owned store outside every agent sandbox root (`<DSH_HOME>/storages/multi-folder/<workspace-key>.json`). Direct `write`/`edit` attempts against the config file are rejected with an explicit message — **the agent can never self-grant directories; configuration is user-managed by design**. See [SECURITY.md](SECURITY.md).
- **Sessionless remote API** — a `multiFolder` namespace registered through `ctx.typert.register` (hand-written `src-json` descriptors) plus a plain-object service provided as `multiFolder`. Its `list`/`add`/`remove`/`set` methods are keyed by workspace **path** and share one validated core with the `/multi-folder` command, so the creation page can configure directories before any session exists. `browse`/`makeDir` ride the same namespace: they serve the plugin's own directory browser and never touch the configuration store. So do `pick` and `reveal` — one asks the system for a folder, the other opens the host's file manager at a configured directory.
- **System folder picker, owned browser as the floor** — `multiFolder/pick` tries, in order: the host's composed `directoryPicker` service **only when its capability is `native`** (under the browse composition it answers `directory-picker/unavailable`, and the shipped Windows chooser worker has been observed to exit mid-call), then the OS dialog of the host machine — the Vista+ common item dialog with `FOS_PICKFOLDERS` on Windows, Finder on macOS — and finally reports `unavailable`, which is the client half's cue to open the browser this plugin draws itself. Deciding on the **host** side is what makes one flow cover every deployment: the host can swallow a crashing chooser and continue to the next attempt, while a client-side `uiWorkspace.pickDirectory()` call cannot. The Windows helper (`lib/native-picker.ps1`) sets a per-monitor DPI awareness context on its own STA thread, so the dialog renders at the display's real DPI instead of being bitmap-stretched, and a watchdog dismisses it on a deadline so an unanswered dialog cannot hold a request open. Listing in the owned browser rides the host `fs` seam (`fs.resolve` + `fs.listDir`).
- **`@` discovery** — a second reader of that same `fs` seam: `multiFolder/listFiles` indexes the configured directories (breadth-first, canonical-path deduplicated so a junction cannot re-enter the walk, generated/vendor basenames excluded, capped and cached per workspace with a short TTL) and the client half registers a companion `@` source over it. The shipped single-root provider is not modified, and the shipped files/sessions group is not disturbed: the trigger registry keys sources by `(trigger, name)` and renders one group each.
- **Client** — a hand-maintained factory bundle (`window.__ModuleLoader__.load`), no build toolchain required. The panel drives the host through two channels: the Remote BFF (`ctx.remote.commands.execute`) for sessions, and the shared `/api` RPC channel (`ctx.connection.rpc.call`) for the sessionless endpoints.

## Project layout

| Path | Purpose |
| ---- | ------- |
| `cordis.patch.yml` | Profile patch layer inserting the `dsh-multi-folder` row |
| `lib/index.js` | Host plugin: config store, tool-pipeline interception, prompt injection, dual-channel notifications, `/multi-folder` command, sessionless `multiFolder/*` remote API (configuration, the owned browser's `browse`/`makeDir`, `listFiles` for the `@` menu, and `pick`/`reveal` for the system picker and the file manager) |
| `lib/client.js` | Client plugin (factory bundle): session-header button + overlay panel + session-creation page entry (input-dock chip / upstream hero chip / fixed fallback launcher) + the system-first "Add directory" flow with the owned browser behind it + the companion `@` source |
| `lib/native-picker.ps1` | Windows-only helper that shows the Vista+ folder chooser (`IFileOpenDialog` + `FOS_PICKFOLDERS`) on an STA thread, with a foreground assist, a per-monitor DPI awareness context and a watchdog that dismisses the dialog on its deadline |
| `test/` | Runtime-free behavior tests (see Development) |
| `docs/` | Design and analysis documents |

## Development

No build step: the host half is plain ESM and `lib/client.js` is a hand-maintained factory bundle in the DSH client-modules format. Tests run with Node directly:

```bash
node test/smoke-host.mjs    # host apply smoke test + remote API behavior
node test/intercept.mjs     # interception / command / notification behavior
node test/smoke-client.mjs  # client bundle + panel flows (React shim)
```

Before modifying `lib/client.js`, see [docs/design.md](docs/design.md) for the bundle contract.

## Documentation

- [docs/design.md](docs/design.md) — architecture and security model
- [docs/upstream-hero-slot.md](docs/upstream-hero-slot.md) — the upstream `conversation.hero.workspaceExtras` slot change (B1) and its plugin-side consumption

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

[MIT](LICENSE)
