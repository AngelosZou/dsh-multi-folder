# Upstream slot: `conversation.hero.workspaceExtras` (B1)

The session-creation page (the hero phase of `ConversationRoot`) currently
declares only two root-scope slots — `conversation.hero.workspace` and
`conversation.hero.agentPreset` — and both are `single`-kind (occupying them
replaces the built-in control). There is no additive seat for a plugin to
place configuration UI next to the workspace picker.

This document specifies the small upstream change to
`@deepseek-ai/dsh-client-ui-conversation` that adds one, and explains how the
plugin consumes it. Until this lands in a DSH release, the plugin's fixed
`shell.overlay` hero launcher covers the same page (B2); the slot registration
below is a waiting no-op (`slots.inject` fires only once the declaration
exists), so the plugin works with and without the upstream change.

## 1. Declare the slot

File: `packages/client/ui-conversation/src/client/contract/slots.ts`

Add to the `SlotMap` declaration merging:

```ts
        /**
         * Additive row beside the hero workspace picker and the agent-preset
         * chip on the new-session screen. Root scope: no session exists yet,
         * so entries address the pending/selected workspace by its canonical
         * path rather than by a session id.
         */
        'conversation.hero.workspaceExtras': {
            kind: 'list';
            scope: 'root';
            owner: HeroWorkspaceExtrasOwnerProps;
        };
```

And the owner share:

```ts
/** Owner share of the hero workspace-extras row: the canonical target path. */
export interface HeroWorkspaceExtrasOwnerProps {
    /**
     * Absolute canonical path of the workspace the hero targets (the pending
     * pick or the blank session's workspace); undefined until one is chosen.
     */
    workspacePath?: string | undefined;
}
```

## 2. Render the slot in the hero row

File: `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`

The `heroWorkspaceRow` element currently renders
`WorkspaceChip` → `renderSlot('conversation.hero.workspace', …)` →
`renderSlot('conversation.hero.agentPreset', {})`. Append the new seat:

```tsx
                    renderSlot('conversation.hero.workspaceExtras', {
                        workspacePath: pendingWorkspace?.path ?? sessionWorkspace?.path,
                    }),
```

(`pendingWorkspace` and `sessionWorkspace` are the `WorkspaceView` values the
root already resolves; `path` is their canonical host path.)

## 3. Declare the slot on the `conversation` registration

In the same file, the `slots.register({ name: 'conversation', children: { … } })`
table must gain the child declaration (declaring is claiming — the render site
above is only authorized once it is listed):

```ts
                    'conversation.hero.workspaceExtras': {
                        kind: 'list',
                        scope: 'root',
                    },
```

## 4. Plugin side (already implemented)

`lib/client.js` registers into the slot the moment it is declared. The entry
declares the plugin's `multi-folder` locale namespace, so the chip renders
through the framework `t` seat and its `label` is a thunk that follows the
active locale (English: "Multi-folder", Chinese: 「多工作目录」):

```js
slots.inject('conversation.hero.workspaceExtras', function () {
  return slots.register(
    { name: 'conversation.hero.workspaceExtras', id: 'multi-folder', order: 30, label: () => t('label'), locale: NS },
    function (props) { return React.createElement(HeroChip, props); },
  );
});
```

(`NS` is the plugin's `multi-folder` namespace and `t` its bound translator —
see the localization section of [design.md](design.md).)

`HeroChip` prefers the owner-supplied `props.workspacePath` and falls back to
the store-derived hero workspace. It opens the same overlay panel in workspace
mode, which reads and writes the configuration through the sessionless
`multiFolder/*` endpoints (see [design.md](design.md)).

## Compiled-bundle equivalent (for local patching)

The shipped `lib/client.js` of `dsh-client-ui-conversation` is a compiled
bundle; the same change there is three touchpoints:

1. `SlotMap` declaration — the `declare module` block compiles into the
   registration data; add the `'conversation.hero.workspaceExtras': { kind:
   'list', scope: 'root' }` child entry to the `children` table of the
   `conversation` registration (around the existing
   `"conversation.hero.agentPreset"` entry).
2. The render site — inside `heroWorkspaceRow`, after
   `renderSlot("conversation.hero.agentPreset", {})`, add
   `renderSlot("conversation.hero.workspaceExtras", { workspacePath: (pendingWorkspace ?? sessionWorkspace)?.path })`.
3. Rebuild the web bundle and refresh the page (bundled shell changes require
   a rebuild; the plugin's own bundle is served no-cache).

## Verification

- Unit: the plugin's `test/smoke-client.mjs` registers and drives `HeroChip`
  with a mock owner share (`workspacePath`), asserting the panel opens in
  workspace mode and reuses the per-workspace cache.
- Manual: with the patched build, the Multi-folder chip (「多工作目录」 in the
  Chinese UI) renders in the hero workspace row between the preset chip and
  the composer; clicking it lists the workspace's secondary directories
  before any message is sent.
