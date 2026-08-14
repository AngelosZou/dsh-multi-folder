# Contributing

Thanks for your interest in `dsh-multi-folder`!

## Development loop

There is **no build step**:

- The host half (`lib/index.js`) is plain ESM.
- The client half (`lib/client.js`) is a hand-maintained factory bundle in the DSH
  client-modules format (see [docs/design.md](docs/design.md)). Edit it in place —
  do not reformat it into source that a bundler would need to rebuild.

Run the runtime-free tests with Node directly:

```bash
node test/smoke-host.mjs
node test/intercept.mjs
node test/smoke-client.mjs
```

## Trying changes locally

Link the repository into a DSH profile and restart the backend:

```bash
dsh plugin --profile web add link:<path-to-this-repo>
# restart the DSH backend, then refresh the browser page
```

Host changes need a backend restart; client changes are picked up on page refresh
(the bundle route serves `cache-control: no-cache`).

## Before submitting

- Keep the three test files green and extend them for new behavior.
- Update `CHANGELOG.md` under the current unreleased section.
- Update `docs/design.md` if invariants change (especially anything touching the
  security boundary described in `SECURITY.md`).
- Keep `README.md` and `README.zh.md` in sync.

## Commit style

Small, focused commits with a clear imperative summary. No enforced format beyond
that.
