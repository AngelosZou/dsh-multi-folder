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
| Add directory | Opens the native directory picker |
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

## Permission model

Each confined command runs under **exactly ONE writable root** — the workspace root the call is re-rooted to (the Windows ACL runner grants a single workspace write SID per process tree). Consequences:

- A command whose cwd stays the **primary workspace cannot create files inside a secondary directory**. `git -C <secondary> commit`, `cd <secondary>` inside a script, `git clone <url> <secondary>`, or absolute-path writes all fail with an OS-level `Permission denied` (e.g. `fatal: Unable to create '.../.git/index.lock': Permission denied`).
- Symmetrically, a command re-rooted to a secondary directory cannot write to the **primary workspace** (or another secondary directory) in the same invocation.
- **Rule for file-creating commands: set `workdir` to the directory the command writes into.** For git, run the command from inside the repository (pass `workdir` pointing at it) instead of using `git -C` from the primary workspace.
- Reads are unrestricted and need no `workdir`.

When a shell run ends in such a denial and references a configured secondary directory, the plugin attaches a short diagnostic hint to the tool result explaining the workdir fix.

## How it works

- **Interception** — a listener on the `tools/execute` around-dispatch waterfall short-circuits `write` / `edit` / `pwsh` / `bash` calls whose resolved path (or `workdir`) lands inside a configured secondary directory, and executes them with the session's standing sandbox policy **re-rooted to that directory** (`{ ...standingPolicy, workspaceRoot: secondaryDir }`). The mode itself is untouched, which is what gives every sandbox mode its identical primary-workspace semantics for free. Paths are canonicalized through `fs.resolve` + `processPath` before matching, so `..`, symlinks, and case differences behave correctly.
- **Prompt injection** — one ordered `systemPrompt` section with a text provider evaluated per assembly, rendering only for sessions whose workspace has configured directories.
- **Notifications** — a pending notice armed by the command handler (only on actual change) is consumed at the next boundary by either the `agent/pre-step` waterfall (prepend into the entering message batch) or the `tools/post-execute` waterfall (attach as `additionalContexts`), whichever fires first — the framework's native plugin-sourced `notice` context.
- **Configuration & security boundary** — per-workspace config lives in a host-owned store outside every agent sandbox root (`<DSH_HOME>/storages/multi-folder/<workspace-key>.json`). Direct `write`/`edit` attempts against the config file are rejected with an explicit message — **the agent can never self-grant directories; configuration is user-managed by design**. See [SECURITY.md](SECURITY.md).
- **Sessionless remote API** — a `multiFolder` namespace registered through `ctx.typert.register` (hand-written `src-json` descriptors) plus a plain-object service provided as `multiFolder`. Its `list`/`add`/`remove`/`set` methods are keyed by workspace **path** and share one validated core with the `/multi-folder` command, so the creation page can configure directories before any session exists.
- **Client** — a hand-maintained factory bundle (`window.__ModuleLoader__.load`), no build toolchain required. The panel drives the host through two channels: the Remote BFF (`ctx.remote.commands.execute`) for sessions, and the shared `/api` RPC channel (`ctx.connection.rpc.call`) for the sessionless endpoints.

## Project layout

| Path | Purpose |
| ---- | ------- |
| `cordis.patch.yml` | Profile patch layer inserting the `dsh-multi-folder` row |
| `lib/index.js` | Host plugin: config store, tool-pipeline interception, prompt injection, dual-channel notifications, `/multi-folder` command, sessionless `multiFolder/*` remote API |
| `lib/client.js` | Client plugin (factory bundle): session-header button + overlay panel + session-creation page entry (input-dock chip / upstream hero chip / fixed fallback launcher) |
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
