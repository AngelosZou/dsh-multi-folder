# dsh-multi-folder

**English** | [中文](README.zh.md)

> Secondary working directories for a DeepSeek Harness project — edit a source repo, a test repo, and a docs repo side by side without leaving the primary workspace.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-brightgreen)](https://nodejs.org/)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundle that gives one project (workspace) a set of **secondary working directories**:

- The agent's core `cwd` and every other core attribute keep pointing at the **primary workspace**.
- Under **Workspace Write** mode the agent gains the **same read / write / edit / execute permissions** on the configured secondary directories as on the primary workspace — enforced by re-rooting the session's own sandbox policy, so every mode keeps its semantics (`read-only` still denies, `workspace-write` allows, `danger-full-access` allows).
- The directory list is **injected into the system prompt** and re-rendered per session assembly.
- Configuration changes notify the agent through a **non-interrupting message queue** — delivered at the next message boundary (user send or tool-call end), and **only when the directory set actually changed**.
- Configurable **before the session starts**: the session-creation page (new-session screen) offers a 「多工作目录」 entry that reads and edits the same per-workspace configuration through a **sessionless remote API** (`multiFolder/*` endpoints) — no session id required.
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

## Usage

A **「多工作目录 / Multi-folder」** button appears in the session header, and a second entry appears on the **session-creation page** (fixed launcher in the bottom-right corner while the new-session screen is shown; an inline chip beside the workspace picker once the upstream `conversation.hero.workspaceExtras` slot is available). The panel lets you:

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
| `lib/client.js` | Client plugin (factory bundle): session-header button + overlay panel + session-creation page entry (hero launcher / upstream hero chip) |
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
