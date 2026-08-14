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
    var state = { open: false, sessionId: null, dirs: [], workspace: null, busy: false, error: null };
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

    function parseJsonLine(text) {
      if (typeof text !== 'string') return null;
      var m = /\[MF:JSON\]\s*(\{.*\})\s*$/s.exec(text);
      if (!m) return null;
      try { return JSON.parse(m[1]); } catch (_) { return null; }
    }

    // ------------------------------------------------------------- plugin
    var name = 'dsh-multi-folder';
    var inject = ['remote', 'remote.commands', 'slots', 'workspaces'];

    function apply(ctx) {
      var slots = ctx.slots;
      var remote = ctx.remote;
      var workspaces = ctx.workspaces;

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

      function addDirectory(sessionId) {
        workspaces.pickDirectory().then(function (path) {
          if (path === null || path === undefined) return;
          mutate(sessionId, '/multi-folder add "' + path.replace(/"/g, '\\"') + '"');
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
        if (!store.open || !store.sessionId) return null;
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
                onClick: function () { mutate(store.sessionId, '/multi-folder remove "' + dir.replace(/"/g, '\\"') + '"'); },
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
            : null,
          rows.length > 0 ? rows : React.createElement('div', { style: { marginBottom: 8, color: 'var(--color-text-muted, #6b6b6b)' } }, '尚未配置副工作目录。'),
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
                disabled: !!store.busy,
                onClick: function () { addDirectory(store.sessionId); },
                style: {
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
                  background: 'var(--color-bg-accent, rgba(80,120,255,0.14))',
                  color: 'var(--color-text, inherit)',
                  cursor: store.busy ? 'default' : 'pointer',
                  opacity: store.busy ? 0.6 : 1,
                },
              },
              store.busy ? '处理中…' : '+ 添加目录',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: !!store.busy,
                onClick: function () { refresh(store.sessionId); },
                style: {
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--color-border, rgba(127,127,127,0.35))',
                  background: 'transparent',
                  color: 'var(--color-text, inherit)',
                  cursor: store.busy ? 'default' : 'pointer',
                  opacity: store.busy ? 0.6 : 1,
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
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
