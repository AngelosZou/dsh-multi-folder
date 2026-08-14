/**
 * dsh-multi-folder — client half (hand-written factory bundle, no build step).
 *
 * Session-scoped UI: a "多工作目录" button in the conversation session header
 * (`conversation.session.header.actions`, scope: session) that opens a panel in
 * `shell.overlay` listing the project's secondary working directories.
 * Mutations go through the Host `/multi-folder` command via the Remote BFF
 * (`ctx.remote.commands.execute(sessionId, line)`); the Host answers with a
 * human-readable result carrying a `[MF:JSON]` line the panel parses for
 * structured state.
 *
 * Session-creation page UI (no session exists yet):
 * - a hero-phase launcher in `shell.overlay` (fixed-position entry) whose
 *   visibility follows the conversation root's `data-phase="hero"` attribute;
 * - an inline chip registered into the upstream `conversation.hero.workspaceExtras`
 *   slot when that slot exists (the `slots.inject` wait is a no-op until the
 *   DSH core declares it).
 * Both open the same panel in WORKSPACE mode and drive the sessionless
 * `multiFolder/*` endpoints over the shared RPC channel
 * (`ctx.connection.rpc.call('/api', endpoint, { args })`), keyed by workspace
 * path instead of sessionId.
 *
 * Layout shape: an entry in the session header action row plus a frame-wide
 * overlay panel. Both read one tiny module-scoped store; opening the panel
 * refreshes the list from the Host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-folder',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    // ------------------------------------------------------------- store
    var listeners = new Set();
    var state = { open: false, mode: null, sessionId: null, dirs: [], workspace: null, busy: false, error: null, hero: false, heroWorkspace: null };
    function patch(next) {
      state = Object.assign({}, state, next);
      listeners.forEach(function (fn) { fn(); });
    }
    function subscribe(fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }
    function getSnapshot() { return state; }
    function useStore() { return React.useSyncExternalStore(subscribe, getSnapshot); }
    /** sessionId -> { dirs, workspace }: avoids re-running the list command
     *  (and its conversation row) on every panel open. */
    var sessionCache = {};
    /** workspacePathKey -> { dirs, workspace }: the workspace-mode twin of
     *  sessionCache, keyed by the sessionless remote's workspace argument. */
    var workspaceCache = {};

    function workspacePathKey(path) {
      return String(path).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    }

    function parseJsonLine(text) {
      if (typeof text !== 'string') return null;
      var m = /\[MF:JSON\]\s*(\{.*\})\s*$/s.exec(text);
      if (!m) return null;
      try { return JSON.parse(m[1]); } catch (_) { return null; }
    }

    // ------------------------------------------------------------- plugin
    var name = 'dsh-multi-folder';
    var inject = ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions'];

    function apply(ctx) {
      var slots = ctx.slots;
      var remote = ctx.remote;
      var workspaces = ctx.workspaces;
      var connection = ctx.connection;
      var sessions = ctx.sessions;

      // -------------------------------------------------- sessionless RPC
      /** Call one `multiFolder/*` endpoint over the shared /api channel.
       *  The Host gateway answers with the same `{ ok, value }` envelope as
       *  the command remote; business errors surface as thrown Errors. */
      function remoteCall(endpoint, args) {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error('multi-folder: the shared RPC channel (connection service) is unavailable'));
        }
        return connection.rpc.call('/api', endpoint, { args: args }).then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            var message = envelope && envelope.error !== undefined
              ? String(envelope.error.message !== undefined ? envelope.error.message : envelope.error)
              : 'remote call failed';
            throw new Error('multi-folder: ' + String(message).replace(/^multi-folder:\s*/, ''));
          }
          return envelope.value;
        });
      }

      function refreshWorkspace(workspacePath) {
        if (!workspacePath) return;
        patch({ busy: true, error: null });
        remoteCall('multiFolder/list', { workspace: workspacePath }).then(function (value) {
          workspaceCache[workspacePathKey(workspacePath)] = value || { workspace: workspacePath, dirs: [] };
          var current = getSnapshot();
          if (!current.sessionId && current.mode === 'workspace' && current.workspace && workspacePathKey(current.workspace) === workspacePathKey(workspacePath)) {
            patch({ busy: false, workspace: value.workspace, dirs: value.dirs || [] });
          } else {
            patch({ busy: false });
          }
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      function mutateWorkspace(workspacePath, endpoint, args) {
        if (!workspacePath) return Promise.resolve();
        patch({ busy: true, error: null });
        var payload = Object.assign({ workspace: workspacePath }, args);
        return remoteCall(endpoint, payload).then(function (value) {
          workspaceCache[workspacePathKey(workspacePath)] = value || { workspace: workspacePath, dirs: [] };
          var current = getSnapshot();
          if (!current.sessionId && current.mode === 'workspace' && current.workspace && workspacePathKey(current.workspace) === workspacePathKey(workspacePath)) {
            patch({ busy: false, workspace: value.workspace, dirs: value.dirs || [] });
          } else {
            patch({ busy: false });
          }
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      /** Open the panel in WORKSPACE mode (session-creation page): a null
       *  workspace shows the "pick a workspace first" hint instead. */
      function openForWorkspace(workspacePath) {
        if (!workspacePath) {
          patch({ open: true, mode: 'workspace', sessionId: null, workspace: null, dirs: [], error: null });
          return;
        }
        var cached = workspaceCache[workspacePathKey(workspacePath)];
        patch({
          open: true,
          mode: 'workspace',
          sessionId: null,
          workspace: workspacePath,
          dirs: cached ? cached.dirs : [],
          error: null,
        });
        if (!cached) refreshWorkspace(workspacePath);
      }

      function runCommand(sessionId, line) {
        return remote.commands.execute(sessionId, line).then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            throw new Error('multi-folder: ' + (envelope && envelope.error !== undefined ? String(envelope.error) : 'remote call failed'));
          }
          var execution = envelope.value;
          if (execution === undefined || execution === null) {
            throw new Error('multi-folder: command did not match — is the host plugin loaded?');
          }
          var result = execution.result;
          if (!result) throw new Error('multi-folder: command returned no result');
          if (result.kind === 'error') throw new Error(result.text || 'multi-folder: command failed');
          return result.text || '';
        });
      }

      function refresh(sessionId) {
        if (!sessionId) return;
        patch({ busy: true, error: null });
        runCommand(sessionId, '/multi-folder list').then(function (text) {
          var parsed = parseJsonLine(text);
          if (parsed) {
            sessionCache[sessionId] = { workspace: parsed.workspace, dirs: parsed.dirs };
          }
          patch({
            busy: false,
            workspace: parsed ? parsed.workspace : null,
            dirs: parsed ? parsed.dirs : [],
          });
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      function mutate(sessionId, line) {
        patch({ busy: true, error: null });
        return runCommand(sessionId, line).then(function (text) {
          var parsed = parseJsonLine(text);
          if (parsed) {
            sessionCache[sessionId] = { workspace: parsed.workspace, dirs: parsed.dirs };
            patch({
              busy: false,
              workspace: parsed.workspace,
              dirs: parsed.dirs,
            });
          } else {
            refresh(sessionId);
          }
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
          refresh(sessionId);
        });
      }

      function addDirectory() {
        workspaces.pickDirectory().then(function (path) {
          if (path === null || path === undefined) return;
          var snapshot = getSnapshot();
          if (snapshot.sessionId) {
            mutate(snapshot.sessionId, '/multi-folder add "' + path.replace(/"/g, '\\"') + '"');
          } else if (snapshot.workspace) {
            mutateWorkspace(snapshot.workspace, 'multiFolder/add', { path: path });
          }
        }).catch(function (e) {
          patch({ error: String(e && e.message ? e.message : e) });
        });
      }

      /** Open the panel for a session, reusing cached data when present so
       *  pure reads do not produce conversation rows. */
      function openFor(sessionId) {
        if (!sessionId) return;
        var cached = sessionCache[sessionId];
        patch({
          open: true,
          mode: 'session',
          sessionId: sessionId,
          dirs: cached ? cached.dirs : [],
          workspace: cached ? cached.workspace : null,
          error: null,
        });
        if (cached === undefined) refresh(sessionId);
      }

      // Header button -----------------------------------------------------
      function HeaderButton(props) {
        var store = useStore();
        var sessionId = props.sessionId;
        var open = store.open && store.sessionId === sessionId;
        // Session switch: keep the panel in sync with the session this
        // header belongs to. On a changed sessionId (or first mount) with
        // the panel open, switch the panel content to this session, reusing
        // cached data (no conversation row) or refreshing from the Host.
        React.useEffect(
          function () {
            var current = getSnapshot();
            if (current.open && current.sessionId !== sessionId) {
              openFor(sessionId);
            }
          },
          [sessionId],
        );
        var btn = React.createElement(
          'button',
          {
            type: 'button',
            title: '多工作目录（副工作目录）',
            onClick: function () {
              var current = getSnapshot();
              var isOpen = current.open && current.sessionId === sessionId;
              if (isOpen) {
                patch({ open: false });
              } else {
                openFor(sessionId);
              }
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 8,
              border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
              background: open ? 'var(--color-bg-accent, rgba(80,120,255,0.18))' : 'transparent',
              color: 'var(--color-text, inherit)',
              fontSize: 13,
              cursor: 'pointer',
            },
          },
          open ? '多工作目录 ▾' : '多工作目录',
        );
        return btn;
      }

      // Overlay panel ------------------------------------------------------
      function Panel() {
        var store = useStore();
        if (!store.open || !store.mode) return null;
        var sessionMode = store.mode === 'session';
        var usable = sessionMode || !!store.workspace;
        var rows = (store.dirs || []).map(function (dir, index) {
          return React.createElement(
            'div',
            {
              key: index,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 6,
                background: 'var(--color-bg-subtle, rgba(127,127,127,0.08))',
                marginBottom: 6,
              },
            },
            React.createElement(
              'div',
              {
                title: dir,
                style: { flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              },
              dir,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                title: '移除此副工作目录',
                disabled: !usable,
                onClick: function () {
                  if (sessionMode) {
                    mutate(store.sessionId, '/multi-folder remove "' + dir.replace(/"/g, '\\"') + '"');
                  } else if (store.workspace) {
                    mutateWorkspace(store.workspace, 'multiFolder/remove', { path: dir });
                  }
                },
                style: { padding: '2px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', color: 'var(--color-danger, #c62828)', cursor: 'pointer' },
              },
              '移除',
            ),
          );
        });
        return React.createElement(
          'div',
          {
            style: {
              position: 'fixed',
              top: 64,
              right: 20,
              width: 380,
              maxWidth: 'calc(100vw - 40px)',
              zIndex: 400,
              background: 'var(--color-bg-elevated, #ffffff)',
              color: 'var(--color-text, #1a1a1a)',
              border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
              padding: 14,
              fontSize: 13,
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 14 } }, '多工作目录（副工作目录）'),
            React.createElement(
              'button',
              {
                type: 'button',
                title: '关闭',
                onClick: function () { patch({ open: false }); },
                style: { padding: '2px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', cursor: 'pointer' },
              },
              '✕',
            ),
          ),
          store.workspace
            ? React.createElement(
                'div',
                { style: { marginBottom: 8, color: 'var(--color-text-muted, #6b6b6b)', fontSize: 12, wordBreak: 'break-all' } },
                '项目：' + store.workspace,
              )
            : (!sessionMode
                ? React.createElement(
                    'div',
                    { style: { marginBottom: 8, color: 'var(--color-text-muted, #6b6b6b)' } },
                    '尚未选择工作区。请先在上方选择项目，再配置多工作目录。',
                  )
                : null),
          usable
            ? (rows.length > 0 ? rows : React.createElement('div', { style: { marginBottom: 8, color: 'var(--color-text-muted, #6b6b6b)' } }, '尚未配置副工作目录。'))
            : React.createElement('div', { style: { marginBottom: 8, color: 'var(--color-text-muted, #6b6b6b)' } }, '选择工作区后可在此添加副工作目录。'),
          store.error
            ? React.createElement('div', { style: { marginBottom: 8, color: 'var(--color-danger, #c62828)', whiteSpace: 'pre-wrap' } }, String(store.error))
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 4 } },
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: !!store.busy || !usable,
                onClick: function () { addDirectory(); },
                style: {
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
                  background: 'var(--color-bg-accent, rgba(80,120,255,0.14))',
                  color: 'var(--color-text, inherit)',
                  cursor: store.busy || !usable ? 'default' : 'pointer',
                  opacity: store.busy || !usable ? 0.6 : 1,
                },
              },
              store.busy ? '处理中…' : '+ 添加目录',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: !!store.busy || !usable,
                onClick: function () {
                  if (sessionMode) {
                    refresh(store.sessionId);
                  } else if (store.workspace) {
                    refreshWorkspace(store.workspace);
                  }
                },
                style: {
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
                  background: 'transparent',
                  color: 'var(--color-text, inherit)',
                  cursor: store.busy || !usable ? 'default' : 'pointer',
                  opacity: store.busy || !usable ? 0.6 : 1,
                },
              },
              '刷新',
            ),
          ),
          React.createElement(
            'div',
            {
              style: {
                marginTop: 10,
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--color-text-muted, #6b6b6b)',
              },
            },
            'Agent 的主工作目录不变；在 Workspace Write 模式下，Agent 对上述目录拥有与主工作目录同等的读写与命令执行权限。配置变更会在下一条消息或工具调用结束时通知 Agent。',
          ),
        );
      }

      // Hero (session-creation page) support --------------------------------
      /** Workspace path of the current session (blank-session hero), or null
       *  while no session/workspace is selected at all. */
      function heroWorkspacePath() {
        var sessionList = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        var id = sessionList && sessionList.current;
        if (!id) return null;
        var workspaceList = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
        var items = workspaceList && workspaceList.items ? workspaceList.items : [];
        for (var i = 0; i < items.length; i++) {
          var workspace = items[i];
          if (workspace && workspace.path && Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(id) >= 0) {
            return workspace.path;
          }
        }
        var row = sessionList && sessionList.byId ? sessionList.byId[id] : undefined;
        return row && row.cwd ? row.cwd : null;
      }

      /** Re-read the conversation root's `data-phase` attribute (authoritative
       *  hero signal) and the derivable workspace, then patch the store. */
      function syncHero() {
        var phaseEl = null;
        try {
          if (typeof document !== 'undefined') phaseEl = document.querySelector('[data-phase]');
        } catch (_) { /* no DOM (tests) */ }
        var hero = !!phaseEl && phaseEl.getAttribute && phaseEl.getAttribute('data-phase') === 'hero';
        var workspacePath = hero ? heroWorkspacePath() : null;
        var current = getSnapshot();
        if (current.hero !== hero || current.heroWorkspace !== workspacePath) {
          patch({ hero: hero, heroWorkspace: workspacePath });
        }
      }

      /** Fixed-position hero launcher (B2): visible only while the
       *  conversation root reports the hero phase. */
      function HeroLauncher() {
        var store = useStore();
        React.useEffect(
          function () {
            var disposers = [];
            if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
              disposers.push(sessions.list.subscribe(syncHero));
            }
            if (workspaces && workspaces.list && typeof workspaces.list.subscribe === 'function') {
              disposers.push(workspaces.list.subscribe(syncHero));
            }
            syncHero();
            var observer = null;
            if (typeof document !== 'undefined' && document.body && typeof MutationObserver !== 'undefined') {
              observer = new MutationObserver(syncHero);
              observer.observe(document.body, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['data-phase'],
              });
            }
            return function () {
              disposers.forEach(function (dispose) { dispose(); });
              if (observer) observer.disconnect();
            };
          },
          [],
        );
        if (!store.hero) return null;
        return React.createElement(
          'button',
          {
            type: 'button',
            title: store.heroWorkspace ? '配置此项目的副工作目录（多工作目录）' : '请先选择工作区，再配置多工作目录',
            onClick: function () { openForWorkspace(store.heroWorkspace); },
            style: {
              position: 'fixed',
              bottom: 24,
              right: 24,
              zIndex: 300,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 999,
              border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
              background: 'var(--color-bg-elevated, #ffffff)',
              color: 'var(--color-text, inherit)',
              fontSize: 13,
              cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.14)',
              opacity: store.heroWorkspace ? 1 : 0.7,
            },
          },
          '多工作目录',
        );
      }

      /** Inline chip for the upstream `conversation.hero.workspaceExtras`
       *  slot (B1): rendered beside the workspace picker once the DSH core
       *  declares the slot; a no-op registration until then. */
      function HeroChip(props) {
        var store = useStore();
        var workspacePath = props && props.workspacePath ? props.workspacePath : store.heroWorkspace;
        return React.createElement(
          'button',
          {
            type: 'button',
            title: '配置此项目的副工作目录（多工作目录）',
            onClick: function () { openForWorkspace(workspacePath); },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 999,
              border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
              background: 'transparent',
              color: 'var(--color-text, inherit)',
              fontSize: 13,
              cursor: 'pointer',
            },
          },
          '多工作目录',
        );
      }

      // Registrations ------------------------------------------------------
      slots.inject('conversation.session.header.actions', function () {
        return slots.register(
          { name: 'conversation.session.header.actions', id: 'multi-folder', order: 30, label: '多工作目录' },
          function (props) { return React.createElement(HeaderButton, props); },
        );
      });
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'multi-folder', order: 100, label: '多工作目录' },
          function () { return React.createElement(Panel); },
        );
      });
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'multi-folder-hero', order: 200, label: '多工作目录（新会话）' },
          function () { return React.createElement(HeroLauncher); },
        );
      });
      // Upstream slot (B1): the callback fires only once a DSH build declares
      // `conversation.hero.workspaceExtras`; until then this contributes nothing.
      slots.inject('conversation.hero.workspaceExtras', function () {
        return slots.register(
          { name: 'conversation.hero.workspaceExtras', id: 'multi-folder', order: 30, label: '多工作目录' },
          function (props) { return React.createElement(HeroChip, props); },
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
