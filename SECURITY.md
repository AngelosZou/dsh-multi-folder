# Security Policy

## Security model

`dsh-multi-folder` widens the agent's filesystem reach **only** to directories that the
**user explicitly configured**, and **only** within the sandbox mode the user already
granted the session. The design enforces four boundaries:

1. **User-only configuration.** Secondary directories can only be added or removed by
   the user through the UI panel or the `/multi-folder` slash command. The agent has no
   tool, command, or file path through which it can change the configuration.

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

### What is deliberately out of scope

- In a `danger-full-access` session the agent can already touch the whole filesystem;
  this plugin neither adds nor removes anything there.
- The agent can *read* the configuration file (reads are not policy-fenced in the DSH
  filesystem backend). Reading reveals nothing the system prompt does not already list
  for that session.

## Reporting a vulnerability

If you believe you have found a security issue in this plugin, please report it
privately by opening a GitHub Security Advisory on the repository instead of a public
issue. Please include:

- the affected version,
- a minimal reproduction,
- the expected vs. observed behavior.

We will acknowledge the report within 7 days and aim to publish a fix (or a
documented mitigation) before public disclosure.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
