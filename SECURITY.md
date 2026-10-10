# Security Policy

## Security model

`dsh-multi-folder` widens the agent's filesystem reach **only** to directories that the
**user explicitly configured**, and **only** within the sandbox mode the user already
granted the session. The design enforces four boundaries:

1. **User-only configuration.** Secondary directories can only be added or removed by
   the user, through the session-header panel, the session-creation page panel, or
   the `/multi-folder` slash command. The two panels are backed by a sessionless
   `multiFolder/*` remote API on the trusted browser→host RPC channel — endpoints
   that exist only for the web UI and are never exposed as agent tools. The agent
   has no tool, command, or file path through which it can change the configuration.

2. **Host-owned configuration store.** Per-workspace configuration lives in
   `<DSH_HOME>/storages/multi-folder/<workspace-key>.json` — outside every agent
   sandbox root. The agent's own tools cannot read-write there under `read-only` or
   `workspace-write` (the sandbox fences the write path by the workspace root).

3. **Explicit write guard.** `write` / `edit` calls targeting the configuration
   file are short-circuited by the tool-pipeline interception with an explicit
   rejection message, independent of the session mode. This turns any attempt at
   self-escalation into a visible, explainable error instead of a silent no-op or a
   silent success.

4. **Mode parity, never escalation.** An intercepted secondary-directory operation runs
   under the session's standing sandbox policy with only the `workspaceRoot` re-pointed
   at the configured directory. The mode is preserved verbatim: a `read-only` session
   is still denied in secondary directories, a `workspace-write` session gains the same
   write/exec rights it has in its primary workspace, and only `danger-full-access`
   bypasses confinement (as it already does for the primary workspace, by the user's
   explicit choice).

### Host-side UI actions (`pick` / `reveal`)

Two sessionless endpoints ask the **host machine** to show UI instead of reading or
writing a path:

- `multiFolder/pick` asks the host's composed directory picker first, and only a
  `native` composition (a loopback, attended, non-SSH host — the framework's own
  `directory-picker-auto` decision) may fall back to this plugin's own OS dialog:
  `lib/native-picker.ps1` on Windows, `osascript` on macOS. A `browse` composition
  never reaches a dialog — the client is sent to the browser this plugin draws.
- `multiFolder/reveal` opens one **existing directory** in the host file manager
  (`explorer.exe` / `open` / `xdg-open`). It refuses anything that is not an existing
  directory, so a stale entry cannot launch a file.

Both ride the same trusted browser→host RPC channel as every other `multiFolder/*`
endpoint (the `connection` Host/Origin fence plus browser authentication) and are
never exposed as agent tools. They act on the host by design — the host owns the
filesystem the session is configured against — which is exactly why a remote client
must never be routed to them: the UI would appear on a display nobody clicked from.
The `native`-only gate above is what enforces that.

### What is deliberately out of scope

- In a `danger-full-access` session the agent can already touch the whole filesystem;
  this plugin neither adds nor removes anything there.
- The agent can *read* the configuration file (reads are not policy-fenced in the DSH
  filesystem backend). Reading reveals nothing the system prompt does not already list
  for that session.
