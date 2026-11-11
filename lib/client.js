/**
 * dsh-multi-folder — client half (hand-written factory bundle, no build step).
 *
 * Workspace-scoped management surfaces: a localized "Multi-folder" tab in the
 * Conversation View switcher (`conversation.view`, scope: session), a compact
 * session-header shortcut, and additive workspace-row entries in both the
 * official and homepage workspace browsers. The list itself belongs to the WORKSPACE: it is keyed by the
 * durable WorkspaceId, so every session of the project shows one list. All copy
 * goes through the framework locale service
 * (`@deepseek-ai/dsh-client-locale`) — see the "i18n" section below.
 * Mutations go through the Host `/multi-folder` command via the Remote BFF
 * (`ctx.remote.commands.execute(sessionId, line, [])` — DSH 0.1.1 added the
 * composer-images business argument, empty for a plain invocation); the Host
 * answers with a
 * human-readable result carrying a `[MF:JSON]` line the panel parses for
 * structured state (including the resolved `workspaceId`).
 *
 * Session-creation page UI (no message sent yet). Three candidate seats are
 * registered, best first, and EXACTLY ONE renders — see "hero seat election":
 * - `conversation.hero.workspaceExtras` (upstream additive hero row; the
 *   `slots.inject` wait is a no-op until a DSH core declares it);
 * - `conversation.input.dock` (shipped since 0.1.9, declared by rc.6): an
 *   in-flow chip row directly ABOVE the composer card, left-aligned with the
 *   official hero chip row — the same band the git-branch chip uses;
 * - `shell.overlay` fixed-position launcher: last-resort fallback for shells
 *   that declare neither slot.
 * All three open the same panel in WORKSPACE mode and drive the sessionless
 * `multiFolder/*` endpoints over the shared RPC channel
 * (`ctx.connection.rpc.call('/api', endpoint, { args })`), keyed by workspace
 * path instead of sessionId.
 *
 * "Add directory" first calls the shell's official `uiWorkspace.pickDirectory()`.
 * If the composed backend has no native chooser (or its call fails), the plugin
 * falls back to `multiFolder/pick` and then to its browser through
 * `multiFolder/browse` and `multiFolder/makeDir`. Closing the panel invalidates a
 * pending official pick. Dismissing a picker adds nothing.
 *
 * Every configured row also carries "open in the host file manager"
 * (`multiFolder/reveal`), which puts the directory in Explorer/Finder where the
 * user's own shell integrations live.
 *
 * `@` discovery for the configured directories. The shipped `@` menu is
 * SINGLE-ROOT: `ui-reference` feeds it from `remote.fileReferences.list`, whose
 * provider walks the addressed session's cwd and refuses every candidate
 * outside that root, so a secondary directory can never appear there. This
 * bundle therefore registers a COMPANION source on the same trigger (see "@
 * discovery for secondaries" in `apply`) and answers it from
 * `multiFolder/listFiles`. Sources are keyed by `(trigger, name)` and rendered
 * one group each, so the shipped files/sessions group is untouched. The
 * registration rides `ctx.inject` — a shell composing no input-trigger service
 * keeps every panel surface and simply gains no `@` group.
 *
 * Layout shape: a Conversation View page, a compact session-header shortcut
 * (transitional), one chip row above the composer card on the session-creation
 * page, and a frame-wide overlay panel. Every surface reads one tiny
 * module-scoped store; opening a surface refreshes the list from the Host.
 *
 * ## Hero seat election (multi-plugin coexistence)
 *
 * `conversation.input.dock` is a `list` slot, so the framework already
 * arranges co-registered entries for us: entries are sorted by
 * `(priority, order)`, a duplicate `(id, priority)` pair is rejected at
 * registration with an error naming the sitting occupant, and the outlet
 * renders `display:contents` so each entry becomes its own row of the
 * composer stack. This plugin therefore stays a good citizen by construction:
 * one unique `id`, one explicit `order`, and NO absolute positioning that
 * would escape the framework's arrangement and overlap a neighbour.
 *
 * What the framework does NOT do is stop ONE plugin from occupying several
 * alternative seats at once (each is a legitimate, differently-declared
 * slot). That is this plugin's own duty: each seat claims a token when its
 * declaration arrives (`slots.inject` fires only for declared slots), and the
 * components render only while they hold the best live claim, so the
 * session-creation page never shows two Multi-folder entries.
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-folder',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var SESSION_MODES = { inherit: true, extend: true, replace: true }
    var FOLDER_PATH = 'M1.75 4.25a1 1 0 0 1 1-1h3.1l1.35 1.5h6.05a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z'
    // ------------------------------------------------------------- store
    var listeners = new Set();
    var state = {
      open: false,
      mode: null,
      sessionId: null,
      dirs: [],
      baseDirs: [],
      sessionDirs: [],
      excludeDirs: [],
      sessionMode: 'inherit',
      workspace: null,
      /** Durable WorkspaceId of `workspace`, when the shell exposes one. */
      workspaceId: null,
      busy: false,
      error: null,
      /** Fallback launcher only: hero visibility derived from the DOM. */
      hero: false,
      heroWorkspace: null,
      /** Live hero-seat claims, in claim order (see "hero seat election"). */
      heroClaims: [],
      /** Which surface owns the open panel: 'overlay' | 'dock' | 'extras'. */
      anchor: 'overlay',
      /** The owned directory browser (the "Add directory" interaction). */
      browseOpen: false,
      /** The level on display: { path, parent, home, entries, truncated } | null. */
      browse: null,
      browseBusy: false,
      browseError: null,
      /** Editable path field, seeded from the level on display. */
      browseDraft: '',
      /** "new folder" name draft. */
      newDirName: '',
      /** A system pick is in flight. */
      pickBusy: false,
      /** Muted reason shown when the system picker FAILED and the browser took over. */
      notice: null,
      /** Bumped on every workspaceCache write so chips re-read their count. */
      cacheRev: 0,
    };
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
    /** sessionId -> normalized session overlay and effective list. */
    var sessionCache = {};
    /** workspacePathKey -> { dirs, workspace, workspaceId }: the workspace-mode
     *  twin of sessionCache, keyed by the sessionless remote's workspace argument. */
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

    /** Stand-in for an absent standard-kit selector hook: runs the selector
     *  against no snapshot, so callers keep one unconditional call site. */
    function selectNothing(selector) { return selector(undefined); }

    // -------------------------------------------------- hero seat election
    /** Candidate seats for the session-creation page, best first. */
    var HERO_SEATS = ['extras', 'dock'];
    /** Order of this plugin's `conversation.input.dock` row. The shipped band
     *  already carries other plugins' entries (the aionui drop inlay at 90/91
     *  and the git-branch chip at 100); 120 keeps this row closest to the
     *  composer card without contesting theirs. */
    var DOCK_ORDER = 120;

    /** The best seat currently claimed, or null when only the fallback is left. */
    function bestHeroSeat(claims) {
      for (var i = 0; i < HERO_SEATS.length; i++) {
        if (claims.indexOf(HERO_SEATS[i]) >= 0) return HERO_SEATS[i];
      }
      return null;
    }

    /** Claim a seat for as long as its slot declaration lives. */
    function claimHeroSeat(kind) {
      patch({ heroClaims: getSnapshot().heroClaims.concat([kind]) });
      return function () {
        var claims = getSnapshot().heroClaims.slice();
        var at = claims.indexOf(kind);
        if (at >= 0) claims.splice(at, 1);
        patch({ heroClaims: claims });
      };
    }

    // ------------------------------------------------------------- theme
    /** Official `--dsw-alias-*` design tokens (dsh-client-ui-theme) with inert
     *  fallbacks, so the surfaces follow the active theme and any applied skin
     *  instead of guessing a palette. */
    var TOKEN = {
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.20))',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      subtle: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
      fill: 'var(--dsw-alias-button-tool-bar-fill, rgba(127,127,127,0.10))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))',
      ink: 'var(--dsw-alias-label-primary, #1a1a1a)',
      inkSoft: 'var(--dsw-alias-label-secondary, #4a4a4a)',
      inkMuted: 'var(--dsw-alias-label-tertiary, #6b6b6b)',
      inkFaint: 'var(--dsw-alias-label-caption, #8a8a8a)',
      danger: 'var(--dsw-alias-state-error-primary, #c62828)',
      accent: 'var(--dsw-alias-brand-primary, #4c6ef5)',
      shadow: '0 8px 24px var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.18))',
    };

    // ------------------------------------------------------------- i18n
    /** Locale namespace owned by this plugin. Dictionaries are registered
     *  with the `locale` service (`@deepseek-ai/dsh-client-locale`, always
     *  composed by the standard web profile), which enforces bilingual
     *  balance: both shipped locales (zh, en) must be registered together. */
    var NS = 'multi-folder';
    /** Simplified Chinese dictionary — the key-set source of truth. */
    var zhDict = {
      'label': '多工作目录',
      'label.open': '多工作目录 ▾',
      'label.withCount': '多工作目录 · {count}',
      'label.heroLauncher': '多工作目录（新会话）',
      'label.heroDock': '多工作目录（输入框上方）',
      'title.header': '多工作目录（副工作目录）',
      'title.remove': '移除此副工作目录',
      'title.close': '关闭',
      'title.heroLauncher.hasWorkspace': '配置此项目的副工作目录（多工作目录）',
      'title.heroLauncher.noWorkspace': '请先选择工作区，再配置多工作目录',
      'title.heroChip': '配置此项目的副工作目录（多工作目录）',
      'panel.title': '多工作目录（副工作目录）',
      'panel.project': '项目：{path}',
      'panel.noWorkspaceHint': '尚未选择工作区。请先在上方选择项目，再配置多工作目录。',
      'panel.empty': '尚未配置副工作目录。',
      'panel.pickWorkspaceHint': '选择工作区后可在此添加副工作目录。',
      'view.workspaceSection': '工作区级',
      'view.workspaceHint': '这些目录按工作区（WorkspaceId）存储，该工作区的所有会话共享同一份。',
      'view.sessionSection': '本会话',
      'view.sessionHint': '会话级覆盖只影响当前会话：可继承、追加或替换工作区目录。',
      'session.title': '会话目录覆盖',
      'session.row.action': '会话目录设置（多工作目录）',
      'session.mode': '会话目录模式',
      'session.mode.inherit': '继承工作区',
      'session.mode.extend': '追加到工作区',
      'session.mode.replace': '替换工作区',
      'session.mode.inheritHint': '本会话使用工作区的全部副目录。',
      'session.mode.extendHint': '保留工作区目录，可追加本会话目录，也可排除部分工作区目录。',
      'session.mode.replaceHint': '本会话只使用下面列出的目录，不再继承工作区列表。',
      'session.workspaceDirs': '工作区目录',
      'session.excluded': '已排除',
      'session.sessionDirs': '本会话追加',
      'session.replaceDirs': '本会话替换目录',
      'session.effective': '最终生效',
      'session.exclude': '排除',
      'session.include': '恢复',
      'session.add': '+ 添加会话目录',
      'session.reset': '恢复继承',
      'session.empty': '尚无目录。',
      'session.inheritCount': '继承 {count} 个工作区目录。',
      'session.replaceEmpty': '替换模式当前为空。添加目录后本会话才有副目录。',
      'panel.add': '+ 添加目录',
      'panel.adding': '处理中…',
      'panel.remove': '移除',
      'panel.refresh': '刷新',
      'panel.footnote': 'Agent 的主工作目录不变；在 Workspace Write 模式下，Agent 对上述目录拥有与主工作目录同等的读写与命令执行权限。配置变更会在下一条消息或工具调用结束时通知 Agent。',
      'browse.title': '选择目录',
      'browse.pathLabel': '目录路径',
      'browse.go': '前往',
      'browse.up': '↑ 上级',
      'browse.use': '选择此目录',
      'browse.back': '← 返回',
      'browse.loading': '读取中…',
      'browse.empty': '此目录下没有子目录。',
      'browse.truncated': '仅显示前 {count} 个子目录。',
      'browse.enter': '进入此目录',
      'browse.newDirPlaceholder': '新建文件夹名称',
      'browse.newDirCreate': '创建',
      'browse.hint': '浏览宿主机文件系统；选中的目录将作为副工作目录添加。',
      'panel.addBusy': '等待系统对话框…',
      'panel.addBrowse': '改用内置浏览器选择…',
      'panel.reveal': '在资源管理器中打开（宿主机）',
      'panel.pickFailed': '系统目录选择器调用失败，已改用内置浏览器：{message}',
      'panel.officialPickFailed': '官方目录选择器不可用，已改用内置浏览器：{message}',
      'workspace.setup.title': '工作区目录设置',
      'workspace.setup.firstRun': '新工作区已创建。你还可以为它添加附加目录，让该工作区的所有会话共享这些目录。',
      'workspace.setup.skip': '稍后再说',
      'workspace.row.action': '工作区目录设置（多工作目录）',
    };
    /** English dictionary — checked complete against the zh key set. */
    var enDict = {
      'label': 'Multi-folder',
      'label.open': 'Multi-folder ▾',
      'label.withCount': 'Multi-folder · {count}',
      'label.heroLauncher': 'Multi-folder (new session)',
      'label.heroDock': 'Multi-folder (above the composer)',
      'title.header': 'Multi-folder (secondary working directories)',
      'title.remove': 'Remove this secondary working directory',
      'title.close': 'Close',
      'title.heroLauncher.hasWorkspace': 'Configure secondary working directories for this project (Multi-folder)',
      'title.heroLauncher.noWorkspace': 'Pick a workspace first, then configure Multi-folder',
      'title.heroChip': 'Configure secondary working directories for this project (Multi-folder)',
      'panel.title': 'Multi-folder (secondary working directories)',
      'panel.project': 'Workspace: {path}',
      'panel.noWorkspaceHint': 'No workspace selected yet. Pick a project above first, then configure secondary directories.',
      'panel.empty': 'No secondary working directories configured yet.',
      'panel.pickWorkspaceHint': 'Pick a workspace first — secondary directories can be added here afterwards.',
      'view.workspaceSection': 'Workspace',
      'view.workspaceHint': 'These directories are keyed by the durable WorkspaceId; every session in this workspace shares them.',
      'view.sessionSection': 'This session',
      'view.sessionHint': 'The session overlay affects only this session: inherit, extend, or replace the workspace directories.',
      'session.title': 'Session directory overlay',
      'session.row.action': 'Session directory settings (Multi-folder)',
      'session.mode': 'Session directory mode',
      'session.mode.inherit': 'Inherit workspace',
      'session.mode.extend': 'Extend workspace',
      'session.mode.replace': 'Replace workspace',
      'session.mode.inheritHint': 'This session uses every workspace secondary directory.',
      'session.mode.extendHint': 'Keep the workspace directories, add session-only directories, and optionally exclude some workspace directories.',
      'session.mode.replaceHint': 'This session uses only the directories listed below and inherits none from the workspace.',
      'session.workspaceDirs': 'Workspace directories',
      'session.excluded': 'Excluded',
      'session.sessionDirs': 'Session additions',
      'session.replaceDirs': 'Session replacement directories',
      'session.effective': 'Effective for this session',
      'session.exclude': 'Exclude',
      'session.include': 'Restore',
      'session.add': '+ Add session directory',
      'session.reset': 'Reset to inherit',
      'session.empty': 'No directories yet.',
      'session.inheritCount': 'Inheriting {count} workspace directories.',
      'session.replaceEmpty': 'Replace mode is empty. Add a directory before this session has secondary directories.',
      'panel.add': '+ Add directory',
      'panel.adding': 'Working…',
      'panel.remove': 'Remove',
      'panel.refresh': 'Refresh',
      'panel.footnote': "The agent's primary working directory stays unchanged; under Workspace Write mode the agent has the same read/write and command-execution rights on the listed directories as on the primary workspace. Configuration changes are announced at the next message or tool-call boundary.",
      'browse.title': 'Choose a directory',
      'browse.pathLabel': 'Directory path',
      'browse.go': 'Go',
      'browse.up': '↑ Up',
      'browse.use': 'Use this directory',
      'browse.back': '← Back',
      'browse.loading': 'Loading…',
      'browse.empty': 'No subdirectories here.',
      'browse.truncated': 'Showing the first {count} subdirectories.',
      'browse.enter': 'Enter this directory',
      'browse.newDirPlaceholder': 'New folder name',
      'browse.newDirCreate': 'Create',
      'browse.hint': 'Browses the host filesystem; the chosen directory is added as a secondary working directory.',
      'panel.addBusy': 'Waiting for the system dialog…',
      'panel.addBrowse': 'Use the built-in browser instead…',
      'panel.reveal': 'Open in the host file manager',
      'panel.pickFailed': 'The system picker failed; using the built-in browser: {message}',
      'panel.officialPickFailed': 'The official directory picker is unavailable; using the built-in browser: {message}',
      'workspace.setup.title': 'Workspace directory settings',
      'workspace.setup.firstRun': 'The new workspace is ready. You can add extra directories here; every session in this workspace will share them.',
      'workspace.setup.skip': 'Ask me later',
      'workspace.row.action': 'Workspace directory settings (Multi-folder)',
    };

    // ------------------------------------------------------------- plugin
    var name = 'dsh-multi-folder';
    var inject = ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions', 'locale'];

    function apply(ctx) {
      var slots = ctx.slots;
      var remote = ctx.remote;
      var workspaces = ctx.workspaces;
      var connection = ctx.connection;
      var sessions = ctx.sessions;
      var locale = ctx.locale;

      /** Register this plugin's dictionaries for every shipped locale
       *  (bilingual balance is enforced by the locale service). The
       *  registration is an effect on this plugin's fiber, so unloading the
       *  plugin withdraws the dictionaries. */
      ctx.effect(function () {
        return locale.register(NS, { zh: zhDict, en: enDict });
      }, 'dsh-multi-folder: client dictionaries');

      /** Bound translator for slot labels: label thunks re-evaluate per read
       *  (`resolveSlotLabel`), so registration-time text follows the active
       *  locale without re-registering. Components themselves render through
       *  the `t` seat the renderer synthesizes from the declared
       *  `locale:` namespace (which also re-renders them on locale switch). */
      var t = locale.bind(NS);
      /** Official workspace controls are detected through their public locale
       *  keys, so a non-English/Chinese shell can follow its own official labels. */
      var wt = locale.bind('workspace');
      var ht = locale.bind('homepage');
      var activePick = null;
      /** Invalidates official pick results when the owning panel closes. */
      var officialPickSeq = 0;

      function cancelPick() {
        officialPickSeq += 1;
        if (!activePick) {
          patch({ pickBusy: false });
          return;
        }
        activePick.abort();
        activePick = null;
        patch({ pickBusy: false });
      }

      function closePanel() {
        cancelPick();
        patch({ open: false });
      }

      ctx.effect(function () {
        return function () {
          var controller = activePick;
          activePick = null;
          if (controller) controller.abort();
        };
      }, 'dsh-multi-folder: cancel picker on unload');

      // -------------------------------------------------- sessionless RPC
      /** Call one `multiFolder/*` endpoint over the shared /api channel.
       *  The Host gateway answers with the same `{ ok, value }` envelope as
       *  the command remote; business errors surface as thrown Errors. */
      function remoteCall(endpoint, args, signal) {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error('multi-folder: the shared RPC channel (connection service) is unavailable'));
        }
        return connection.rpc.call('/api', endpoint, { args: args }, signal).then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            var message = envelope && envelope.error !== undefined
              ? String(envelope.error.message !== undefined ? envelope.error.message : envelope.error)
              : 'remote call failed';
            throw new Error('multi-folder: ' + String(message).replace(/^multi-folder:\s*/, ''));
          }
          return envelope.value;
        });
      }

      /** Normalize one `/multi-folder session ...` JSON payload. */
      function normalizeSessionPayload(parsed, sessionId) {
        var mode = parsed && typeof parsed.mode === 'string' ? parsed.mode : 'inherit'
        return {
          sessionId: String(sessionId),
          workspace: parsed && parsed.workspace ? parsed.workspace : null,
          workspaceId: parsed && parsed.workspaceId ? String(parsed.workspaceId) : null,
          mode: SESSION_MODES[mode] ? mode : 'inherit',
          baseDirs: parsed && Array.isArray(parsed.baseDirs) ? parsed.baseDirs : [],
          sessionDirs: parsed && Array.isArray(parsed.sessionDirs) ? parsed.sessionDirs : [],
          excludeDirs: parsed && Array.isArray(parsed.excludedDirs) ? parsed.excludedDirs : [],
          dirs: parsed && Array.isArray(parsed.effectiveDirs) ? parsed.effectiveDirs : (parsed && Array.isArray(parsed.dirs) ? parsed.dirs : []),
        }
      }

      function storeSession(sessionId, parsed) {
        var normalized = normalizeSessionPayload(parsed, sessionId)
        sessionCache[sessionId] = normalized
        return normalized
      }

      /** Write one workspace's list into the cache and return it normalized. */
      function storeWorkspace(workspacePath, value) {
        var normalized = value && Array.isArray(value.dirs)
          ? {
              workspace: value.workspace || workspacePath,
              workspaceId: value.workspaceId ? String(value.workspaceId) : null,
              dirs: value.dirs,
            }
          : { workspace: workspacePath, workspaceId: null, dirs: [] };
        workspaceCache[workspacePathKey(workspacePath)] = normalized;
        return normalized;
      }

      /** Whether the open panel is the one showing `workspacePath`. */
      function panelTargets(workspacePath) {
        var current = getSnapshot();
        return !current.sessionId
          && current.mode === 'workspace'
          && !!current.workspace
          && workspacePathKey(current.workspace) === workspacePathKey(workspacePath);
      }

      /** Patch after a workspace-mode read/write: always publish the new cache
       *  revision (chips show the configured count), and refresh the panel
       *  body only when it is the panel for this workspace. */
      function publishWorkspace(workspacePath, value) {
        var normalized = storeWorkspace(workspacePath, value);
        var next = { busy: false, cacheRev: getSnapshot().cacheRev + 1 };
        if (panelTargets(workspacePath)) {
          next.workspace = normalized.workspace;
          next.workspaceId = normalized.workspaceId;
          next.dirs = normalized.dirs || [];
        }
        patch(next);
      }

      /** The durable identity for a workspace path, when the shell exposes it. */
      function identityOf(workspacePath, explicit) {
        return explicit || workspaceIdForPath(workspacePath) || null;
      }

      function refreshWorkspace(workspacePath, workspaceId) {
        if (!workspacePath) return;
        patch({ busy: true, error: null });
        var id = identityOf(workspacePath, workspaceId);
        var payload = { workspace: workspacePath };
        if (id) payload.workspaceId = id;
        remoteCall('multiFolder/list', payload).then(function (value) {
          publishWorkspace(workspacePath, value);
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      function mutateWorkspace(workspacePath, endpoint, args, workspaceId) {
        if (!workspacePath) return Promise.resolve();
        patch({ busy: true, error: null });
        var id = identityOf(workspacePath, workspaceId);
        var payload = Object.assign({ workspace: workspacePath }, args);
        if (id) payload.workspaceId = id;
        return remoteCall(endpoint, payload).then(function (value) {
          publishWorkspace(workspacePath, value);
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      /** Configured directory count for a workspace, or null while unread. */
      function dirCountOf(workspacePath) {
        if (!workspacePath) return null;
        var cached = workspaceCache[workspacePathKey(workspacePath)];
        return cached && Array.isArray(cached.dirs) ? cached.dirs.length : null;
      }

      /** Open the panel in WORKSPACE mode (session-creation page): a null
       *  workspace shows the "pick a workspace first" hint instead.
       *  `anchor` names the surface that owns the panel — an inline chip
       *  renders it as its own popover, everything else uses the overlay. */
      function openForWorkspace(workspacePath, anchor, workspaceId, options) {
        var seat = anchor || 'overlay';
        cancelPick();
        patch(browserReset());
        if (!workspacePath) {
          patch({ open: true, mode: 'workspace', sessionId: null, workspace: null, workspaceId: null, dirs: [], error: null, anchor: seat });
          return;
        }
        var id = workspaceId || workspaceIdForPath(workspacePath);
        var cached = workspaceCache[workspacePathKey(workspacePath)];
        patch({
          open: true,
          mode: 'workspace',
          sessionId: null,
          workspace: workspacePath,
          workspaceId: id || null,
          dirs: cached ? cached.dirs : [],
          error: null,
          notice: options && options.firstRun ? t('workspace.setup.firstRun') : null,
          anchor: seat,
        });
        if (!cached) refreshWorkspace(workspacePath, id);
      }

      function runCommand(sessionId, line) {
        // DSH 0.1.1: commands/execute takes three business arguments —
        // (sessionId, line, images) — plus an optional AbortSignal. The
        // plugin never attaches composer images, so the third is `[]`.
        return remote.commands.execute(sessionId, line, []).then(function (envelope) {
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

      /** Store fields derived from one normalized session payload. */
      function sessionFields(normalized) {
        return {
          workspace: normalized.workspace,
          workspaceId: normalized.workspaceId,
          dirs: normalized.dirs,
          baseDirs: normalized.baseDirs,
          sessionDirs: normalized.sessionDirs,
          excludeDirs: normalized.excludeDirs,
          sessionMode: normalized.mode,
        };
      }

      function refresh(sessionId) {
        if (!sessionId) return;
        patch({ busy: true, error: null });
        runCommand(sessionId, '/multi-folder session list').then(function (text) {
          var parsed = parseJsonLine(text);
          if (parsed) {
            var normalized = storeSession(sessionId, parsed);
            patch(Object.assign({ busy: false }, sessionFields(normalized)));
          } else {
            patch({ busy: false });
          }
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      function mutate(sessionId, line) {
        patch({ busy: true, error: null });
        return runCommand(sessionId, line).then(function (text) {
          var parsed = parseJsonLine(text);
          if (parsed) {
            var normalized = storeSession(sessionId, parsed);
            patch(Object.assign({ busy: false }, sessionFields(normalized)));
          } else {
            refresh(sessionId);
          }
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
          refresh(sessionId);
        });
      }

      // -------------------------------------------- owned directory browser
      // The owned browser reads levels over `multiFolder/browse` and creates
      // directories through `multiFolder/makeDir`.

      /** Read one level into the store. A blank path asks the host for its
       *  home directory, so the browser always has somewhere to start. */
      function browseTo(path) {
        patch({ browseBusy: true, browseError: null });
        return remoteCall('multiFolder/browse', { path: typeof path === 'string' ? path : '' }).then(function (value) {
          var level = value && typeof value === 'object'
            ? value
            : { path: '', parent: null, home: '', entries: [], truncated: false };
          patch({
            browseBusy: false,
            browse: level,
            browseDraft: level.path,
            browseError: null,
            newDirName: '',
          });
          return level;
        }).catch(function (e) {
          patch({ browseBusy: false, browseError: String(e && e.message ? e.message : e) });
          return null;
        });
      }

      /** Open the OWNED browser at the panel's workspace (or the host home when
       *  the panel has no workspace path yet) and read its first level. Reachable
       *  from the panel at all times, and the automatic destination whenever the
       *  system picker cannot answer. */
      function openOwnedBrowser() {
        var snapshot = getSnapshot();
        patch({
          browseOpen: true,
          browse: null,
          browseBusy: false,
          browseError: null,
          browseDraft: snapshot.workspace || '',
          newDirName: '',
        });
        browseTo(snapshot.workspace || '');
      }

      /** Pick a directory through the shell's composed official picker. The
       *  plugin's host helper and owned browser remain fallbacks for profiles
       *  that compose neither a native chooser nor a browse picker. */
      function addDirectory() {
        var snapshot = getSnapshot();
        if (snapshot.pickBusy) return Promise.resolve();
        patch({ pickBusy: true, error: null, notice: null });

        var official = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace', false) : undefined;
        if (official && typeof official.pickDirectory === 'function') {
          var officialSeq = officialPickSeq;
          return Promise.resolve().then(function () { return official.pickDirectory(); }).then(
            function (picked) {
              if (officialSeq !== officialPickSeq) return undefined;
              patch({ pickBusy: false });
              if (typeof picked !== 'string' || picked === '') return undefined;
              return commitBrowsePath(picked);
            },
            function (error) {
              if (officialSeq !== officialPickSeq) return undefined;
              patch({
                pickBusy: false,
                notice: t('panel.officialPickFailed', { message: String(error && error.message ? error.message : error) }),
              });
              return openOwnedBrowser();
            },
          );
        }

        var controller = new AbortController();
        activePick = controller;
        return remoteCall('multiFolder/pick', { cwd: snapshot.workspace || '' }, controller.signal).then(
          function (value) {
            if (activePick !== controller) return undefined;
            activePick = null;
            patch({ pickBusy: false });
            var picked = value && typeof value.path === 'string' && value.path !== '' ? value.path : null;
            if (picked) return commitBrowsePath(picked);
            if (value && (value.via === 'host-native' || value.via === 'os-dialog')) return undefined;
            return openOwnedBrowser();
          },
          function (error) {
            if (activePick !== controller) return undefined;
            activePick = null;
            patch({
              pickBusy: false,
              notice: t('panel.pickFailed', { message: String(error && error.message ? error.message : error) }),
            });
            return openOwnedBrowser();
          },
        );
      }

      /** Leave the browser without adding anything. */
      function closeBrowser() {
        patch(browserReset());
      }

      /** The store fields that put the panel back on its directory list. Any
       *  fresh open of the panel (header button, chip, launcher) starts there,
       *  so a browser left open by a dismissed panel never comes back stale. */
      function browserReset() {
        return { browseOpen: false, browse: null, browseBusy: false, browseError: null, newDirName: '', notice: null };
      }

      /** Adopt one path as a secondary working directory through the channel
       *  the panel already uses: the `/multi-folder add` command inside a
       *  session, the sessionless `multiFolder/add` endpoint on the
       *  session-creation page. The browser stays open when the Host refused,
       *  so the error sits beside the path the user was looking at. */
      function commitBrowsePath(path) {
        var snapshot = getSnapshot();
        var settled;
        if (snapshot.sessionId) {
          settled = mutate(snapshot.sessionId, '/multi-folder session add "' + String(path).replace(/"/g, '\\"') + '"');
        } else if (snapshot.workspace) {
          settled = mutateWorkspace(snapshot.workspace, 'multiFolder/add', { path: path });
        } else {
          return Promise.resolve();
        }
        return Promise.resolve(settled).then(function () {
          if (!getSnapshot().error) closeBrowser();
        });
      }

      /** Create one child directory and enter it. */
      function createBrowseDir() {
        var snapshot = getSnapshot();
        var name = String(snapshot.newDirName || '').trim();
        if (!snapshot.browse || name === '') return Promise.resolve();
        patch({ browseBusy: true, browseError: null });
        return remoteCall('multiFolder/makeDir', { parent: snapshot.browse.path, name: name }).then(function (created) {
          patch({ browseBusy: false, newDirName: '' });
          return browseTo(created && created.path ? created.path : snapshot.browse.path);
        }).catch(function (e) {
          patch({ browseBusy: false, browseError: String(e && e.message ? e.message : e) });
          return null;
        });
      }

      /** Open the panel for a session, reusing cached data when present so
       *  pure reads do not produce conversation rows. */
      function openFor(sessionId) {
        if (!sessionId) return;
        var cached = sessionCache[sessionId];
        cancelPick();
        patch(browserReset());
        patch(Object.assign({
          open: true,
          mode: 'session',
          sessionId: sessionId,
          error: null,
          anchor: 'overlay',
        }, cached === undefined ? {} : sessionFields(cached)));
        if (cached === undefined) refresh(sessionId);
      }

      /** Point the shared store at one session without opening the overlay:
       *  the conversation view renders the same body as a full page. */
      function focusSession(sessionId) {
        if (!sessionId) return;
        var cached = sessionCache[sessionId];
        cancelPick();
        patch(browserReset());
        patch(Object.assign({
          mode: 'session',
          sessionId: sessionId,
          open: false,
          error: null,
          anchor: 'view',
        }, cached === undefined ? {} : sessionFields(cached)));
        if (cached === undefined) refresh(sessionId);
      }

      // Session-row shortcut -----------------------------------------------
      /** A compact entry on one Session row; opens the same session panel. */
      function SessionRowButton(props) {
        var store = useStore();
        var sessionId = props.sessionId;
        var t = props.t;
        var active = store.open && store.mode === 'session' && store.sessionId === sessionId;
        return React.createElement(
          'button',
          {
            type: 'button',
            title: t('session.row.action'),
            'aria-label': t('session.row.action'),
            onClick: function () { openFor(sessionId); },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 20,
              height: 20,
              padding: 0,
              border: 0,
              borderRadius: 5,
              background: active ? TOKEN.hover : 'transparent',
              color: active ? TOKEN.ink : TOKEN.inkMuted,
              fontSize: 13,
              lineHeight: 1,
              cursor: 'pointer',
            },
          },
          '⚙',
        );
      }

      /** The workspace row's folder glyph, reused in the menu so both entry
       *  points read as directory settings. */
      function FolderIcon(props) {
        var size = props && props.size ? props.size : 13;
        return React.createElement(
          'svg',
          { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', 'aria-hidden': true },
          React.createElement('path', { d: FOLDER_PATH }),
        );
      }

      /** The same action as a Session menu row (touch devices hide hover
       *  actions, so the menu stays the reachable path). */
      function SessionMenuRow(props) {
        var t = props.t;
        var menu = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : [false, function () {}];
        return React.createElement(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            onClick: function () {
              menu[1](false);
              openFor(props.sessionId);
            },
            style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', border: 0, background: 'transparent', color: TOKEN.ink, textAlign: 'left', fontSize: 13, cursor: 'pointer' },
          },
          React.createElement(FolderIcon, { size: 13 }),
          t('session.row.action'),
        );
      }

      // Header shortcut ----------------------------------------------------
      // Transitional in T1: the Conversation View tab is the management
      // surface, and this compact header button stays as a shortcut until the
      // view has been verified against the shipped shell. Removing it is one
      // registration deletion, not a data change.
      function HeaderButton(props) {
        var store = useStore();
        var sessionId = props.sessionId;
        var t = props.t;
        var open = store.open && store.sessionId === sessionId;
        React.useEffect(
          function () {
            var current = getSnapshot();
            if (current.open && current.sessionId !== sessionId) {
              openFor(sessionId);
            }
          },
          [sessionId],
        );
        return React.createElement(
          'button',
          {
            type: 'button',
            title: t('title.header'),
            onClick: function () {
              var current = getSnapshot();
              var isOpen = current.open && current.sessionId === sessionId;
              if (isOpen) {
                closePanel();
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
              border: '1px solid ' + TOKEN.border,
              background: open ? TOKEN.hover : 'transparent',
              color: TOKEN.ink,
              fontSize: 13,
              cursor: 'pointer',
            },
          },
          open ? t('label.open') : t('label'),
        );
      }

      /** The owned browser, rendered in place of the directory list: an
       *  editable path field, up/use/back actions, one level of child
       *  directories, and the optional "new folder" row. Returned as an ARRAY
       *  for the same reason `panelBody` is. */
      function browseBody(store, t) {
        var level = store.browse;
        var busy = !!store.busy || !!store.browseBusy;
        var entries = level && Array.isArray(level.entries) ? level.entries : null;
        var inputStyle = {
          flex: 1,
          minWidth: 0,
          padding: '4px 8px',
          borderRadius: 6,
          border: '1px solid ' + TOKEN.border,
          background: 'transparent',
          color: TOKEN.ink,
          fontSize: 12,
          fontFamily: 'inherit',
        };
        var smallButton = function (extra) {
          return Object.assign({
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid ' + TOKEN.border,
            background: 'transparent',
            color: TOKEN.ink,
            fontSize: 12,
            fontFamily: 'inherit',
          }, extra || {});
        };
        var rows = entries === null ? null : entries.map(function (entry, index) {
          return React.createElement(
            'button',
            {
              key: index,
              type: 'button',
              title: t('browse.enter'),
              disabled: busy,
              onClick: function () { browseTo(entry.path); },
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '5px 8px',
                marginBottom: 4,
                borderRadius: 6,
                border: '1px solid transparent',
                background: TOKEN.subtle,
                color: entry.hidden ? TOKEN.inkMuted : TOKEN.ink,
                cursor: busy ? 'default' : 'pointer',
                fontFamily: 'inherit',
                fontSize: 12,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                opacity: busy ? 0.6 : 1,
              },
            },
            '📁 ' + entry.name,
          );
        });
        var sectionHeading = function (title, hint) {
          return React.createElement(
            'div',
            { style: { margin: '4px 0 8px' } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 12, color: TOKEN.ink } }, title),
            React.createElement('div', { style: { marginTop: 2, fontSize: 11, lineHeight: 1.5, color: TOKEN.inkMuted } }, hint),
          );
        };
        return [
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 14, color: TOKEN.ink } }, t('browse.title')),
            React.createElement(
              'button',
              {
                type: 'button',
                title: t('title.close'),
                onClick: function () { closePanel(); },
                style: { padding: '2px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', color: TOKEN.inkMuted, cursor: 'pointer' },
              },
              '✕',
            ),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 6, marginBottom: 6 } },
            React.createElement('input', {
              type: 'text',
              value: store.browseDraft,
              placeholder: t('browse.pathLabel'),
              spellCheck: false,
              onChange: function (event) { patch({ browseDraft: event.target.value }); },
              onKeyDown: function (event) { if (event.key === 'Enter') browseTo(store.browseDraft); },
              style: inputStyle,
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: function () { browseTo(store.browseDraft); },
                style: smallButton({ background: TOKEN.fill, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }),
              },
              t('browse.go'),
            ),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 6, marginBottom: 8 } },
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy || !level || !level.parent,
                onClick: function () { if (level && level.parent) browseTo(level.parent); },
                style: smallButton({ cursor: busy || !level || !level.parent ? 'default' : 'pointer', opacity: busy || !level || !level.parent ? 0.5 : 1 }),
              },
              t('browse.up'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy || !level,
                onClick: function () { if (level) commitBrowsePath(level.path); },
                style: smallButton({ flex: 1, border: '1px solid ' + TOKEN.accent, background: TOKEN.fill, cursor: busy || !level ? 'default' : 'pointer', opacity: busy || !level ? 0.6 : 1 }),
              },
              t('browse.use'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () { closeBrowser(); },
                style: smallButton({ border: '1px solid transparent', color: TOKEN.inkMuted, cursor: 'pointer' }),
              },
              t('browse.back'),
            ),
          ),
          store.browseError
            ? React.createElement('div', { style: { marginBottom: 8, color: TOKEN.danger, whiteSpace: 'pre-wrap', fontSize: 12 } }, String(store.browseError))
            : null,
          store.notice
            ? React.createElement('div', { style: { marginBottom: 8, color: TOKEN.inkMuted, whiteSpace: 'pre-wrap', fontSize: 11 } }, String(store.notice))
            : null,
          React.createElement(
            'div',
            { style: { maxHeight: 200, overflowY: 'auto', marginBottom: 6 } },
            rows === null
              ? (store.browseError
                  ? null
                  : React.createElement('div', { style: { color: TOKEN.inkMuted, fontSize: 12 } }, t('browse.loading')))
              : (rows.length > 0
                  ? rows
                  : React.createElement('div', { style: { color: TOKEN.inkMuted, fontSize: 12 } }, t('browse.empty'))),
          ),
          level && level.truncated
            ? React.createElement(
                'div',
                { style: { marginBottom: 6, color: TOKEN.inkMuted, fontSize: 11 } },
                t('browse.truncated', { count: entries ? entries.length : 0 }),
              )
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 6, marginBottom: 8 } },
            React.createElement('input', {
              type: 'text',
              value: store.newDirName,
              placeholder: t('browse.newDirPlaceholder'),
              spellCheck: false,
              onChange: function (event) { patch({ newDirName: event.target.value }); },
              onKeyDown: function (event) { if (event.key === 'Enter') createBrowseDir(); },
              style: inputStyle,
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy || String(store.newDirName || '').trim() === '',
                onClick: function () { createBrowseDir(); },
                style: smallButton({ background: TOKEN.fill, cursor: busy ? 'default' : 'pointer', opacity: busy || String(store.newDirName || '').trim() === '' ? 0.5 : 1 }),
              },
              t('browse.newDirCreate'),
            ),
          ),
          React.createElement(
            'div',
            { style: { fontSize: 11, lineHeight: 1.5, color: TOKEN.inkMuted } },
            t('browse.hint'),
          ),
        ];
      }

      // Panel body ---------------------------------------------------------
      /** The panel's children, shared verbatim by the overlay panel and the
       *  chip popover. Returned as an ARRAY so each wrapper can spread it as
       *  its own direct children (one DOM shape, two placements). */
      function panelBody(store, t, options) {
        var viewMode = !!(options && options.view);
        var sessionMode = store.mode === 'session';
        var usable = sessionMode || !!store.workspace;
        if (store.browseOpen) return browseBody(store, t);
        var mode = store.sessionMode || 'inherit';
        var busy = !!store.busy || !!store.pickBusy;
        var keyOf = function (path) { return workspacePathKey(String(path)); };
        var excluded = {};
        (store.excludeDirs || []).forEach(function (dir) { excluded[keyOf(dir)] = true; });
        var baseDirs = store.baseDirs || [];
        var sessionDirs = store.sessionDirs || [];
        var effective = store.dirs || [];
        var sectionHeading = function (title, hint) {
          return React.createElement(
            'div',
            { style: { margin: '6px 0 8px' } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 12, color: TOKEN.ink } }, title),
            hint ? React.createElement('div', { style: { marginTop: 2, fontSize: 11, lineHeight: 1.5, color: TOKEN.inkMuted } }, hint) : null,
          );
        };
        var smallButton = function (label, title, color, onClick, disabled) {
          return React.createElement(
            'button',
            {
              type: 'button',
              title: title,
              disabled: !!disabled,
              onClick: function (event) {
                if (event && event.stopPropagation) event.stopPropagation();
                if (!disabled) onClick();
              },
              style: {
                padding: '2px 8px',
                borderRadius: 6,
                border: '1px solid transparent',
                background: 'transparent',
                color: color || TOKEN.inkMuted,
                fontSize: 11,
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.5 : 1,
              },
            },
            label,
          );
        };
        var dirRow = function (dir, key, actions, options) {
          var muted = !!(options && options.muted);
          return React.createElement(
            'div',
            {
              key: key,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                borderRadius: 6,
                background: TOKEN.subtle,
                marginBottom: 6,
                opacity: muted ? 0.65 : 1,
              },
            },
            React.createElement(
              'div',
              {
                title: dir,
                style: {
                  flex: 1,
                  fontSize: 12,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textDecoration: muted ? 'line-through' : 'none',
                },
              },
              dir,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                title: t('panel.reveal'),
                disabled: !usable,
                onClick: function () {
                  patch({ error: null });
                  remoteCall('multiFolder/reveal', { path: dir }).catch(function (e) {
                    patch({ error: String(e && e.message ? e.message : e) });
                  });
                },
                style: { padding: '2px 6px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', color: TOKEN.inkMuted, cursor: 'pointer' },
              },
              '📂',
            ),
            actions,
          );
        };
        var sessionCommand = function (action, path) {
          var quoted = path === undefined ? '' : ' "' + String(path).replace(/"/g, '\\"') + '"';
          return mutate(store.sessionId, '/multi-folder session ' + action + quoted);
        };
        var workspaceRows = (sessionMode ? baseDirs : effective).map(function (dir, index) {
          if (!sessionMode) {
            return dirRow(dir, 'base-' + index, smallButton(t('panel.remove'), t('title.remove'), TOKEN.danger, function () {
              if (store.workspace) mutateWorkspace(store.workspace, 'multiFolder/remove', { path: dir });
            }, busy), {});
          }
          var isExcluded = excluded[keyOf(dir)] === true;
          var action = null;
          if (mode === 'inherit' || mode === 'extend') {
            action = isExcluded
              ? smallButton(t('session.include'), t('session.include'), TOKEN.accent, function () { sessionCommand('include', dir); }, busy)
              : smallButton(t('session.exclude'), t('session.exclude'), TOKEN.danger, function () { sessionCommand('exclude', dir); }, busy);
          } else {
            action = smallButton(t('session.excluded'), t('session.mode.replaceHint'), TOKEN.inkFaint, function () {}, true);
          }
          return dirRow(dir, 'base-' + index, action, { muted: isExcluded || mode === 'replace' });
        });
        var additions = (mode === 'extend' || mode === 'replace') ? sessionDirs.map(function (dir, index) {
          return dirRow(dir, 'session-' + index, smallButton(t('panel.remove'), t('title.remove'), TOKEN.danger, function () {
            sessionCommand('remove', dir);
          }, busy), {});
        }) : [];
        var modeButton = function (value) {
          var label = t('session.mode.' + value);
          var active = mode === value;
          return React.createElement(
            'button',
            {
              key: value,
              type: 'button',
              disabled: busy,
              title: t('session.mode.' + value + 'Hint'),
              onClick: function () { mutate(store.sessionId, '/multi-folder session ' + value); },
              style: {
                flex: 1,
                padding: '5px 6px',
                borderRadius: 7,
                border: '1px solid ' + (active ? TOKEN.accent : TOKEN.border),
                background: active ? TOKEN.hover : 'transparent',
                color: active ? TOKEN.ink : TOKEN.inkSoft,
                fontSize: 11,
                cursor: busy ? 'default' : 'pointer',
              },
            },
            label,
          );
        };
        var emptySession = mode === 'replace'
          ? t('session.replaceEmpty')
          : t('session.empty');
        return [
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 14, color: TOKEN.ink } }, sessionMode ? (viewMode ? t('view.sessionSection') : t('session.title')) : t('panel.title')),
            viewMode
              ? null
              : React.createElement(
                  'button',
                  {
                    type: 'button',
                    title: t('title.close'),
                    onClick: function () { closePanel(); },
                    style: { padding: '2px 8px', borderRadius: 6, border: '1px solid transparent', background: 'transparent', color: TOKEN.inkMuted, cursor: 'pointer' },
                  },
                  '✕',
                ),
          ),
          store.workspace
            ? React.createElement(
                'div',
                { style: { marginBottom: 8, color: TOKEN.inkMuted, fontSize: 12, wordBreak: 'break-all' } },
                t('panel.project', { path: store.workspace }),
              )
            : (!sessionMode
                ? React.createElement(
                    'div',
                    { style: { marginBottom: 8, color: TOKEN.inkMuted } },
                    t('panel.noWorkspaceHint'),
                  )
                : null),
          store.notice
            ? React.createElement(
                'div',
                { style: { marginBottom: 8 } },
                React.createElement('div', { style: { color: TOKEN.inkSoft, fontSize: 12, lineHeight: 1.5 } }, String(store.notice)),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    title: t('workspace.setup.skip'),
                    onClick: function () { closePanel(); },
                    style: { marginTop: 4, padding: 0, border: '1px solid transparent', background: 'transparent', color: TOKEN.inkMuted, fontSize: 11, cursor: 'pointer' },
                  },
                  t('workspace.setup.skip'),
                ),
              )
            : null,
          sessionMode
            ? React.createElement(
                'div',
                { style: { display: 'flex', gap: 6, margin: '4px 0 6px' } },
                modeButton('inherit'),
                modeButton('extend'),
                modeButton('replace'),
              )
            : null,
          sessionMode
            ? React.createElement(
                'div',
                { style: { marginBottom: 10, fontSize: 11, lineHeight: 1.5, color: TOKEN.inkMuted } },
                t('session.mode.' + mode + 'Hint'),
              )
            : null,
          viewMode && sessionMode ? sectionHeading(t('view.workspaceSection'), t('view.workspaceHint')) : null,
          sessionMode ? sectionHeading(t('session.workspaceDirs'), mode === 'replace' ? t('session.mode.replaceHint') : null) : null,
          usable
            ? (workspaceRows.length > 0 ? workspaceRows : React.createElement('div', { style: { marginBottom: 8, color: TOKEN.inkMuted } }, mode === 'inherit' ? t('session.inheritCount', { count: 0 }) : t('session.empty')))
            : React.createElement('div', { style: { marginBottom: 8, color: TOKEN.inkMuted } }, t('panel.pickWorkspaceHint')),
          sessionMode && (mode === 'extend' || mode === 'replace')
            ? sectionHeading(mode === 'replace' ? t('session.replaceDirs') : t('session.sessionDirs'), null)
            : null,
          sessionMode && (mode === 'extend' || mode === 'replace')
            ? (additions.length > 0 ? additions : React.createElement('div', { style: { marginBottom: 8, color: TOKEN.inkMuted } }, emptySession))
            : null,
          sessionMode ? sectionHeading(t('session.effective'), null) : null,
          sessionMode
            ? (effective.length > 0
                ? React.createElement('div', { style: { marginBottom: 8, fontSize: 11, lineHeight: 1.6, color: TOKEN.inkSoft, wordBreak: 'break-all' } }, effective.join(' · '))
                : React.createElement('div', { style: { marginBottom: 8, fontSize: 11, color: TOKEN.inkMuted } }, emptySession))
            : null,
          store.error
            ? React.createElement('div', { style: { marginBottom: 8, color: TOKEN.danger, whiteSpace: 'pre-wrap' } }, String(store.error))
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 4 } },
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy || !usable,
                onClick: function () { addDirectory(); },
                style: {
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid ' + TOKEN.border,
                  background: TOKEN.fill,
                  color: TOKEN.ink,
                  cursor: busy || !usable ? 'default' : 'pointer',
                  opacity: busy || !usable ? 0.6 : 1,
                },
              },
              store.busy ? t('panel.adding') : (store.pickBusy ? t('panel.addBusy') : (sessionMode ? t('session.add') : t('panel.add'))),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy || !usable,
                onClick: function () {
                  if (sessionMode) refresh(store.sessionId);
                  else if (store.workspace) refreshWorkspace(store.workspace);
                },
                style: {
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: '1px solid ' + TOKEN.border,
                  background: 'transparent',
                  color: TOKEN.ink,
                  cursor: busy || !usable ? 'default' : 'pointer',
                  opacity: busy || !usable ? 0.6 : 1,
                },
              },
              t('panel.refresh'),
            ),
          ),
          sessionMode && mode !== 'inherit'
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: function () { mutate(store.sessionId, '/multi-folder session inherit'); },
                  style: { marginBottom: 6, padding: 0, border: '1px solid transparent', background: 'transparent', color: TOKEN.inkMuted, fontSize: 11, textAlign: 'left', cursor: busy ? 'default' : 'pointer' },
                },
                t('session.reset'),
              )
            : null,
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy || !usable,
              onClick: function () { openOwnedBrowser(); },
              style: {
                marginBottom: 6,
                padding: 0,
                border: '1px solid transparent',
                background: 'transparent',
                color: TOKEN.inkMuted,
                fontSize: 11,
                textAlign: 'left',
                cursor: busy || !usable ? 'default' : 'pointer',
                opacity: busy || !usable ? 0.5 : 1,
              },
            },
            t('panel.addBrowse'),
          ),
          React.createElement(
            'div',
            { style: { marginTop: 10, fontSize: 11, lineHeight: 1.5, color: TOKEN.inkMuted } },
            t('panel.footnote'),
          ),
        ];
      }

      /** Spread `children` as the direct children of one element (keeps the
       *  panel's DOM shape identical across both placements). */
      function element(type, props, children) {
        return React.createElement.apply(null, [type, props].concat(children));
      }

      // Overlay panel ------------------------------------------------------
      function Panel(props) {
        var store = useStore();
        var t = props.t;
        if (!store.open || !store.mode) return null;
        // An inline chip owns its own popover; the overlay stands down.
        if (store.anchor !== 'overlay') return null;
        return element(
          'div',
          {
            style: {
              position: 'fixed',
              top: 64,
              right: 20,
              width: 380,
              maxWidth: 'calc(100vw - 40px)',
              zIndex: 400,
              background: TOKEN.surface,
              color: TOKEN.ink,
              border: '1px solid ' + TOKEN.border,
              borderRadius: 12,
              boxShadow: TOKEN.shadow,
              padding: 14,
              fontSize: 13,
            },
          },
          panelBody(store, t),
        );
      }

      // Conversation view --------------------------------------------------
      /** The full-page management surface: one tab holding the workspace base
       *  and the current session's overlay controls. */
      function MultiFolderView(props) {
        var store = useStore();
        var t = props.t;
        var sessionId = props.sessionId;
        React.useEffect(function () {
          if (sessionId && getSnapshot().sessionId !== sessionId) focusSession(sessionId);
        }, [sessionId]);
        if (!sessionId) return null;
        return element(
          'div',
          {
            style: {
              height: '100%',
              overflow: 'auto',
              padding: '18px 22px',
              fontSize: 13,
              color: TOKEN.ink,
            },
          },
          panelBody(store, t, { view: true }),
        );
      }

      // Anchored popover ---------------------------------------------------
      /** The same panel body as a popover anchored to a chip. `direction`
       *  'up' opens above the chip (the dock row sits above the composer
       *  card), 'down' opens below it (the hero chip row). */
      function AnchoredPanel(props) {
        var store = useStore();
        var t = props.t;
        var up = props.direction !== 'down';
        var placement = up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' };
        return element(
          'div',
          {
            style: Object.assign(
              {
                position: 'absolute',
                left: 0,
                zIndex: 40,
                width: 380,
                maxWidth: 'calc(100vw - 40px)',
                // The composer stack lives in a scroll container with
                // `overflow: hidden auto`; capping the height keeps a tall
                // list inside the viewport instead of clipping it.
                maxHeight: 'min(60vh, 420px)',
                overflowY: 'auto',
                background: TOKEN.surface,
                color: TOKEN.ink,
                border: '1px solid ' + TOKEN.border,
                borderRadius: 12,
                boxShadow: TOKEN.shadow,
                padding: 14,
                fontSize: 13,
                textAlign: 'left',
              },
              placement,
            ),
          },
          panelBody(store, t),
        );
      }

      /** Click-outside catcher for an open popover. */
      function Backdrop() {
        return React.createElement('div', {
          onClick: function () { closePanel(); },
          style: { position: 'fixed', inset: 0, zIndex: 30 },
        });
      }

      /** One chip + its popover, wrapped in the positioning context the
       *  popover anchors to. Shared by the dock row and the hero chip. */
      function chipWithPopover(seat, direction, t, button) {
        var store = getSnapshot();
        var open = store.open && store.anchor === seat;
        return React.createElement(
          'div',
          { style: { position: 'relative', display: 'inline-flex', minWidth: 0 } },
          button,
          open ? React.createElement(Backdrop, { key: 'backdrop' }) : null,
          open ? React.createElement(AnchoredPanel, { key: 'panel', t: t, direction: direction }) : null,
        );
      }

      /** The chip pill, styled from the official chip recipe. */
      function chipButton(options) {
        return React.createElement(
          'button',
          {
            type: 'button',
            title: options.title,
            onClick: options.onClick,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 10px',
              borderRadius: 999,
              border: '1px solid ' + (options.open ? TOKEN.accent : TOKEN.border),
              background: options.open ? TOKEN.hover : TOKEN.fill,
              color: options.open ? TOKEN.ink : TOKEN.inkSoft,
              fontSize: 12,
              lineHeight: 1,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              maxWidth: 260,
              overflow: 'hidden',
              opacity: options.dimmed ? 0.7 : 1,
            },
          },
          React.createElement(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
            options.label,
          ),
          React.createElement('span', { style: { color: TOKEN.inkFaint, fontSize: 10 } }, '▾'),
        );
      }

      // Hero (session-creation page) support --------------------------------
      /** The shell's own hero predicate, read from the dock's owner share: a
       *  blank conversation with an open session. A still-loading blank
       *  session already lists as blank, so it may enter the hero phase
       *  before the composer snapshot settles to `open`.
       *
       *  DSH 0.1.2 exposes no `composerPhase` on SessionSnapshot; the hero
       *  phase there is a settled blank session (mirroring ConversationRoot's
       *  `hero = sessionId === undefined || (shellPhase === 'blank' && ...)`),
       *  so the blank/lifecycle fields are used as the fallback. Newer DSH
       *  shells that do carry `composerPhase` keep their original check. */
      function isHeroPhase(session, blank) {
        if (!session) return false;
        if (session.composerPhase !== undefined) {
          return session.composerPhase === 'blank' && (session.openState === 'open' || blank === true);
        }
        return session.blank === true
          && !session.running
          && !session.promptAttempted
          && (blank === true || session.openState === 'open');
      }

      /** The workspace path a session belongs to, from the workspaces list. */
      function workspacePathIn(snapshot, sessionId) {
        var items = snapshot && snapshot.items ? snapshot.items : [];
        for (var i = 0; i < items.length; i++) {
          var workspace = items[i];
          if (workspace && workspace.path && Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(sessionId) >= 0) {
            return workspace.path;
          }
        }
        return null;
      }

      /** The durable WorkspaceId a session belongs to, from the workspaces list. */
      function workspaceIdIn(snapshot, sessionId) {
        var items = snapshot && snapshot.items ? snapshot.items : [];
        for (var i = 0; i < items.length; i++) {
          var workspace = items[i];
          if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(sessionId) >= 0) {
            return workspace.workspaceId ? String(workspace.workspaceId) : null;
          }
        }
        return null;
      }

      /** The durable WorkspaceId for a canonical workspace path, or null. */
      function workspaceIdForPath(path) {
        if (!path) return null;
        var snapshot = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
        var items = snapshot && snapshot.items ? snapshot.items : [];
        var key = workspacePathKey(path);
        for (var i = 0; i < items.length; i++) {
          var workspace = items[i];
          if (workspace && workspace.path && workspacePathKey(workspace.path) === key) {
            return workspace.workspaceId ? String(workspace.workspaceId) : null;
          }
        }
        return null;
      }

      /** Workspace path of the current session (blank-session hero), or null
       *  while no session/workspace is selected at all. Store-read twin of
       *  `workspacePathIn` for the fallback launcher, which has no props. */
      function heroWorkspacePath() {
        var sessionList = sessions && sessions.list ? sessions.list.getSnapshot() : null;
        var id = sessionList && sessionList.current;
        if (!id) return null;
        var workspaceList = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
        var fromWorkspaces = workspacePathIn(workspaceList, id);
        if (fromWorkspaces !== null) return fromWorkspaces;
        var row = sessionList && sessionList.byId ? sessionList.byId[id] : undefined;
        return row && row.cwd ? row.cwd : null;
      }

      /**
       * Dock chip (session-creation page, preferred shipped seat): one in-flow
       * row in `conversation.input.dock`, directly above the composer card and
       * left-aligned with the official hero chip row. The row stays IN FLOW —
       * the framework arranges co-registered dock entries as sibling rows, so
       * absolute positioning here would silently overlap a neighbour's chip.
       *
       * Renders only on the session-creation page: an active session manages the
       * list in its Conversation View tab, so the two never appear at once.
       */
      function DockChip(props) {
        var store = useStore();
        var t = props.t;
        var sessionId = props.sessionId;
        // The standard kit always supplies these selector hooks; the absent
        // form keeps the hook call unconditional (stable hook order) for
        // hosts and tests that render the entry without the kit.
        var useSessions = typeof props.useSessions === 'function' ? props.useSessions : selectNothing;
        var useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : selectNothing;
        var blank = useSessions(function (s) {
          return !!(s && s.byId && sessionId !== undefined && s.byId[sessionId] && s.byId[sessionId].blank === true);
        });
        var cwd = useSessions(function (s) {
          var row = s && s.byId && sessionId !== undefined ? s.byId[sessionId] : undefined;
          return row && row.cwd ? row.cwd : null;
        });
        var fromWorkspaces = useWorkspaces(function (s) { return workspacePathIn(s, sessionId); });
        var workspacePath = fromWorkspaces || cwd;
        var hero = isHeroPhase(props.session, blank);
        var mine = bestHeroSeat(store.heroClaims) === 'dock';
        // Fill the count cache once per workspace. Workspace mode rides the
        // sessionless RPC, so this read produces no conversation row.
        React.useEffect(
          function () {
            if (!hero || !mine || !workspacePath) return undefined;
            if (workspaceCache[workspacePathKey(workspacePath)] === undefined) refreshWorkspace(workspacePath);
            return undefined;
          },
          [hero, mine, workspacePath],
        );
        if (!hero || !mine) return null;
        var open = store.open && store.anchor === 'dock';
        var count = dirCountOf(workspacePath);
        return React.createElement(
          'div',
          {
            style: {
              // The dock outlet is display:contents, so this row is a direct
              // child of the composer stack — the same 20px indent as the
              // official hero chip row above it.
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              paddingLeft: 20,
            },
          },
          chipWithPopover(
            'dock',
            'up',
            t,
            chipButton({
              open: open,
              dimmed: !workspacePath,
              title: workspacePath ? t('title.heroChip') : t('title.heroLauncher.noWorkspace'),
              label: count !== null && count > 0 ? t('label.withCount', { count: count }) : t('label'),
              onClick: function () {
                if (open) {
                  closePanel();
                } else {
                  openForWorkspace(workspacePath, 'dock');
                }
              },
            }),
          ),
        );
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

      /** Fixed-position hero launcher: the last-resort fallback, mounted only
       *  while NO declared slot seat is available. Its DOM/store probing (and
       *  the MutationObserver behind it) stays unwired whenever a real seat
       *  holds the page. */
      function HeroLauncher(props) {
        var store = useStore();
        var t = props.t;
        var seat = bestHeroSeat(store.heroClaims);
        React.useEffect(
          function () {
            if (bestHeroSeat(getSnapshot().heroClaims) !== null) return undefined;
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
          [seat],
        );
        if (seat !== null) return null;
        if (!store.hero) return null;
        return React.createElement(
          'button',
          {
            type: 'button',
            title: store.heroWorkspace ? t('title.heroLauncher.hasWorkspace') : t('title.heroLauncher.noWorkspace'),
            onClick: function () { openForWorkspace(store.heroWorkspace, 'overlay'); },
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
              border: '1px solid ' + TOKEN.border,
              background: TOKEN.surface,
              color: TOKEN.ink,
              fontSize: 13,
              cursor: 'pointer',
              boxShadow: TOKEN.shadow,
              opacity: store.heroWorkspace ? 1 : 0.7,
            },
          },
          t('label'),
        );
      }

      /** Inline chip for the upstream `conversation.hero.workspaceExtras`
       *  slot: rendered beside the workspace picker once the DSH core declares
       *  the slot; a no-op registration until then. Its popover opens
       *  DOWNWARD, matching the official workspace picker on the same row. */
      function HeroChip(props) {
        var store = useStore();
        var t = props.t;
        var workspacePath = props && props.workspacePath ? props.workspacePath : store.heroWorkspace;
        if (bestHeroSeat(store.heroClaims) !== 'extras') return null;
        var open = store.open && store.anchor === 'extras';
        var count = dirCountOf(workspacePath);
        return chipWithPopover(
          'extras',
          'down',
          t,
          chipButton({
            open: open,
            dimmed: !workspacePath,
            title: workspacePath ? t('title.heroChip') : t('title.heroLauncher.noWorkspace'),
            label: count !== null && count > 0 ? t('label.withCount', { count: count }) : t('label'),
            onClick: function () {
              if (open) {
                closePanel();
              } else {
                openForWorkspace(workspacePath, 'extras');
              }
            },
          }),
        );
      }

      // ------------------------------------- workspace-browser integration
      /** Workspace rows as the Workspace Controller sees them. */
      function workspaceItems() {
        if (!workspaces || !workspaces.list) return [];
        var snapshot = workspaces.list.getSnapshot();
        return snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
      }

      /** Resolve the Workspace one browser row belongs to, using the stable
       *  anchors both shipped browsers expose: the official tree row key and
       *  the homepage list's `data-ws`. */
      function workspaceOfRow(row) {
        if (!row || typeof row.getAttribute !== 'function') return null;
        var id = row.getAttribute('data-ws');
        if (!id) {
          var key = row.getAttribute('data-row-key') || '';
          if (key.indexOf('workspace:') === 0) id = key.slice('workspace:'.length);
        }
        if (!id || id === 'ungrouped') return null;
        var items = workspaceItems();
        for (var i = 0; i < items.length; i += 1) {
          if (String(items[i].workspaceId) === String(id)) return items[i];
        }
        return null;
      }

      /** The action strip a row already owns. Official rows use a CSS-module
       *  class containing `rowActions`; the homepage list marks its strip with
       *  `ph-sb-actions`. */
      function workspaceActionHost(row) {
        if (!row || typeof row.querySelector !== 'function') return null;
        if (row.getAttribute('data-sb') === 'project') return row.querySelector('.ph-sb-actions');
        var host = row.querySelector('[class*="rowActions"]');
        if (host === null) {
          var last = row.querySelector('span:last-child');
          host = last && last.querySelector('button') ? last : null;
        }
        if (host === null || host.querySelector('button') === null) return null;
        return host;
      }

      /** A folder glyph reads as directory settings; a plus was too close to
       *  the separate "new session" affordance. */
      function folderIcon() {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '14');
        svg.setAttribute('height', '14');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', FOLDER_PATH);
        svg.appendChild(path);
        return svg;
      }
      function workspaceActionButton(workspace) {
        var button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-mf-workspace-action', '');
        button.setAttribute('aria-label', t('workspace.row.action'));
        button.title = t('workspace.row.action');
        button.appendChild(folderIcon());
        button.style.cssText = [
          'display:inline-flex',
          'align-items:center',
          'justify-content:center',
          'width:18px',
          'height:18px',
          'padding:0',
          'border:0',
          'border-radius:4px',
          'background:transparent',
          'color:' + TOKEN.inkMuted,
          'font:14px/1 inherit',
          'cursor:pointer',
        ].join(';');
        button.addEventListener('mouseenter', function () { button.style.background = TOKEN.hover; });
        button.addEventListener('mouseleave', function () { button.style.background = 'transparent'; });
        button.addEventListener('click', function (event) {
          if (event && event.preventDefault) event.preventDefault();
          if (event && event.stopPropagation) event.stopPropagation();
          openForWorkspace(workspace.path, 'overlay', workspace.workspaceId);
        });
        return button;
      }

      /** Add the workspace-level entry to every rendered workspace row. This is
       *  an additive DOM integration, not a takeover: the official list and the
       *  homepage grouped list keep rendering and owning their rows. */
      function decorateWorkspaceRows() {
        if (typeof document === 'undefined' || !document.body) return;
        var rows = document.querySelectorAll('[data-row-key^="workspace:"], [data-sb="project"][data-ws]');
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i];
          var workspace = workspaceOfRow(row);
          if (workspace === null) continue;
          var host = workspaceActionHost(row);
          if (host === null || host.querySelector('[data-mf-workspace-action]') !== null) continue;
          host.appendChild(workspaceActionButton(workspace));
        }
      }

      /** Add the session-level entry to homepage grouped Session rows. The
       *  official browser renders the same action through
       *  `sidebar.workspaces.session.row.action`. */
      function decorateHomepageSessionRows() {
        if (typeof document === 'undefined' || !document.body) return;
        var rows = document.querySelectorAll('[data-sb="session"][data-id]');
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i];
          var host = row.querySelector('.ph-sb-actions');
          if (host === null || host.querySelector('[data-mf-session-action]') !== null) continue;
          var menu = host.querySelector('[data-sb="sessionMenu"]');
          var button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('data-mf-session-action', '');
          button.setAttribute('aria-label', t('session.row.action'));
          button.title = t('session.row.action');
          button.textContent = '⚙';
          button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:' + TOKEN.inkMuted + ';font:13px/1 inherit;cursor:pointer;';
          button.addEventListener('click', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();
            var id = row.getAttribute('data-id');
            if (id) openFor(id);
          });
          if (menu !== null && menu.parentElement === host) host.insertBefore(button, menu);
          else host.appendChild(button);
        }
      }

      /** Arm the first-run prompt only after the user starts an official
       *  Workspace-creation flow. Automatic default-Workspace initialization
       *  must not interrupt the shell. */
      var workspaceCreateArmedAt = 0;
      function armWorkspaceCreateFlow(event) {
        var node = event && event.target;
        while (node && node.nodeType === 1) {
          var label = String(node.getAttribute && (node.getAttribute('aria-label') || node.getAttribute('title')) || (node.textContent || '').trim());
          if (label === wt('workspace.add') || label === wt('menu.addWorkspace')
            || label === ht('sidebar.list.newProject') || label === ht('sidebar.list.addProject')) {
            workspaceCreateArmedAt = Date.now();
            return;
          }
          node = node.parentElement;
        }
      }
      function installWorkspaceCreateArm() {
        if (typeof document === 'undefined' || !document.body || typeof document.body.addEventListener !== 'function') {
          return function () {};
        }
        document.body.addEventListener('click', armWorkspaceCreateFlow, true);
        return function () {
          document.body.removeEventListener('click', armWorkspaceCreateFlow, true);
        };
      }

      /** Return one pending create signal; cancellations expire after five minutes. */
      function consumeWorkspaceCreateSignal() {
        if (workspaceCreateArmedAt === 0 || Date.now() - workspaceCreateArmedAt > 300000) return false;
        workspaceCreateArmedAt = 0;
        return true;
      }

      function installWorkspaceRowActions() {
        if (typeof document === 'undefined' || !document.body || typeof MutationObserver === 'undefined') {
          return function () {};
        }
        var timer = null;
        function schedule() {
          if (timer !== null) return;
          timer = setTimeout(function () {
            timer = null;
            decorateWorkspaceRows();
            decorateHomepageSessionRows();
          }, 50);
        }
        var observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        schedule();
        return function () {
          observer.disconnect();
          if (timer !== null) clearTimeout(timer);
        };
      }

      /** Prompt once for a freshly created Workspace: the official create flow
       *  has no extension form, so the plugin offers the secondary-directory
       *  step immediately after the new identity appears. */
      function installNewWorkspacePrompt() {
        if (!workspaces || !workspaces.list || typeof workspaces.list.subscribe !== 'function') {
          return function () {};
        }
        var known = null;
        var prompted = Object.create(null);
        function storageGet(id) {
          try { return window.localStorage.getItem('dsh-multi-folder.setup.' + id) === '1'; } catch (_) { return false; }
        }
        function storageSet(id) {
          try { window.localStorage.setItem('dsh-multi-folder.setup.' + id, '1'); } catch (_) { /* private mode */ }
        }
        function check() {
          var snapshot = workspaces.list.getSnapshot();
          if (!snapshot || snapshot.phase !== 'ready') return;
          var items = Array.isArray(snapshot.items) ? snapshot.items : [];
          var next = Object.create(null);
          items.forEach(function (item) { next[String(item.workspaceId)] = true; });
          if (known === null) { known = next; return; }
          var fresh = items.filter(function (item) { return known[String(item.workspaceId)] !== true; });
          known = next;
          fresh.forEach(function (item) {
            var id = String(item.workspaceId);
            if (prompted[id] || storageGet(id) || !consumeWorkspaceCreateSignal()) return;
            prompted[id] = true;
            storageSet(id);
            openForWorkspace(item.path, 'overlay', id, { firstRun: true });
          });
        }
        var dispose = workspaces.list.subscribe(check);
        check();
        return dispose;
      }

      // Registrations ------------------------------------------------------
      // Transitional header shortcut (see HeaderButton): kept until the view
      // is verified in a shipped shell.
      var disposeHeader = slots.inject('conversation.session.header.actions', function () {
        return slots.register(
          { name: 'conversation.session.header.actions', id: 'multi-folder', order: 30, label: function () { return t('label'); }, locale: NS },
          function (props) { return React.createElement(HeaderButton, props); },
        );
      });
      // The session management surface is a Conversation View tab: one page
      // holds the workspace base and the session overlay controls.
      // Order 15 sits after Chat (0) and Trajectory (10).
      slots.inject('conversation.view', function () {
        // The view is the primary surface; the header button is a fallback for
        // a shell that does not declare `conversation.view` at all.
        if (typeof disposeHeader === 'function') disposeHeader();
        return slots.register(
          { name: 'conversation.view', id: 'multi-folder', order: 15, label: function () { return t('label'); }, locale: NS },
          function (props) { return React.createElement(MultiFolderView, props); },
        );
      });
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'multi-folder', order: 100, label: function () { return t('label'); }, locale: NS },
          function (props) { return React.createElement(Panel, props); },
        );
      });
      // Official Session rows expose a hover action and a "..." menu row. The
      // action is the compact entry; the menu row keeps the same setting
      // reachable on hoverless devices.
      slots.inject('sidebar.workspaces.session.row.action', function () {
        return slots.register(
          { name: 'sidebar.workspaces.session.row.action', id: 'multi-folder', order: 300, label: function () { return t('session.row.action'); }, locale: NS },
          function (props) { return React.createElement(SessionRowButton, props); },
        );
      });
      slots.inject('sidebar.workspaces.session.menu.item', function () {
        return slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'multi-folder', order: 500, label: function () { return t('session.row.action'); }, locale: NS },
          function (props) { return React.createElement(SessionMenuRow, props); },
        );
      });
      // Session-creation page, shipped seat: the official input dock band (a
      // session-scoped `list` slot rendered directly above the composer
      // card). One unique id, one explicit order, one in-flow row — the
      // framework arranges this row against every other plugin's dock entry.
      slots.inject('conversation.input.dock', function () {
        var release = claimHeroSeat('dock');
        var dispose = slots.register(
          { name: 'conversation.input.dock', id: 'multi-folder', order: DOCK_ORDER, label: function () { return t('label.heroDock'); }, locale: NS },
          function (props) { return React.createElement(DockChip, props); },
        );
        return function () {
          dispose();
          release();
        };
      });
      slots.inject('shell.overlay', function () {
        return slots.register(
          { name: 'shell.overlay', id: 'multi-folder-hero', order: 200, label: function () { return t('label.heroLauncher'); }, locale: NS },
          function (props) { return React.createElement(HeroLauncher, props); },
        );
      });
      // Upstream slot: the callback fires only once a DSH build declares
      // `conversation.hero.workspaceExtras`; until then this contributes
      // nothing and the dock row above holds the page.
      slots.inject('conversation.hero.workspaceExtras', function () {
        var release = claimHeroSeat('extras');
        var dispose = slots.register(
          { name: 'conversation.hero.workspaceExtras', id: 'multi-folder', order: 30, label: function () { return t('label'); }, locale: NS },
          function (props) { return React.createElement(HeroChip, props); },
        );
        return function () {
          dispose();
          release();
        };
      });

      // Sidebar integration: additive row entry plus the first-run prompt.
      ctx.effect(installWorkspaceRowActions, 'dsh-multi-folder: workspace row entries');
      ctx.effect(installWorkspaceCreateArm, 'dsh-multi-folder: workspace create arm');
      ctx.effect(installNewWorkspacePrompt, 'dsh-multi-folder: new workspace prompt');

      // ------------------------------------- @ discovery for secondaries
      // The shipped `@` menu is SINGLE-ROOT: `ui-reference` feeds it from
      // `remote.fileReferences.list`, whose provider walks the addressed
      // session's cwd and refuses any candidate outside that root. A configured
      // secondary directory is by definition outside it, so this plugin
      // registers a COMPANION source on the same trigger and answers it from
      // `multiFolder/listFiles`.
      //
      // The trigger registry keys sources by `(trigger, name)` and renders one
      // group per source, so the shipped files/sessions group is untouched and
      // this group appears beside it (order 10 = below the shipped group, which
      // defaults to 0). `showGroupTitle: false` is deliberate: the menu derives
      // a group's title by looking its SOURCE NAME up in its own dictionary, so
      // a visible title would read "multi-folder", and a group whose query found
      // nothing would otherwise render that heading over an empty list. Every
      // row instead carries a `section`, which heads the rows by directory.
      //
      // `ctx.inject` rather than a hard `inject` entry: a shell that composes
      // no input-trigger service must keep its panel, and on such a shell this
      // contribution simply never activates.

      /** Last path segment, tolerant of either separator. */
      function lastSegment(path) {
        var parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/);
        return parts.length === 0 ? '' : parts[parts.length - 1];
      }

      /** Drop the host home prefix from a heading when the path sits under it. */
      function abbreviate(path) {
        var home = remote && remote.$host ? remote.$host.home : undefined;
        if (!home) return path;
        var flat = String(path).replace(/\\/g, '/');
        var prefix = String(home).replace(/\\/g, '/');
        if (flat.toLowerCase().indexOf(prefix.toLowerCase()) !== 0) return path;
        return '~' + flat.slice(prefix.length);
      }

      /** Mention text for one discovered path. Mirrors the shipped
       *  `formatFileMention` grammar — whitespace quotes the path, a quoted
       *  directory keeps its quote open so completion can descend, and a path
       *  with control characters or an embedded quote is unrepresentable.
       *  Reimplemented here because this bundle is standalone (no build step)
       *  and cannot import that package's module. */
      function formatMention(path, kind, preserveQuote) {
        var text = kind === 'directory' ? path + '/' : path;
        if (/[\u0000-\u001f\u007f-\u009f"]/.test(text)) return undefined;
        if (!preserveQuote && !/\s/.test(text)) return '@' + text;
        return kind === 'directory' ? '@"' + text : '@"' + text + '"';
      }

      /** The source-owned payload one menu row carries. */
      function rowValue(value) {
        if (typeof value !== 'string') return undefined;
        try {
          var parsed = JSON.parse(value);
          return parsed && typeof parsed.mention === 'string' ? parsed : undefined;
        } catch (e) {
          return undefined;
        }
      }

      /** Project one host candidate onto a menu row (or nothing when the path
       *  cannot be written back as mention text). */
      function fileRow(candidate, preserveQuote, heading) {
        var path = String(candidate.path || '').replace(/\\/g, '/');
        var kind = candidate.kind === 'directory' ? 'directory' : 'file';
        var mention = formatMention(path, kind, preserveQuote);
        if (mention === undefined) return [];
        var rel = String(candidate.rel || '');
        var name = rel === '' ? lastSegment(path) : lastSegment(rel);
        var slash = rel.lastIndexOf('/');
        var parent = slash < 0 ? '' : rel.slice(0, slash);
        return [{
          name: kind === 'directory' ? name + '/' : name,
          // The in-directory location only: the heading above the row already
          // names the directory, so repeating it there says nothing.
          ...(parent === '' ? {} : { description: parent }),
          icon: kind === 'directory' ? 'folder' : 'file',
          section: heading,
          value: JSON.stringify({ kind: kind, path: path, mention: mention }),
          ...(kind === 'directory' ? { drill: true } : {}),
        }];
      }

      ctx.inject(['inputTriggers'], function (scope) {
        var registry = scope.inputTriggers;
        if (!registry || typeof registry.registerSource !== 'function') return;
        scope.effect(function () {
          return registry.registerSource({
            trigger: '@',
            name: NS,
            order: 10,
            // The menu titles a group from its source name via its OWN
            // dictionary (an unknown key renders verbatim), so the title row is
            // switched off: rows are headed by their directory section instead,
            // and an empty result renders nothing at all.
            showGroupTitle: false,
            candidates: function (session, request) {
              var summary = sessions.list.getSnapshot().byId[session.sessionId];
              var workspace = summary && summary.cwd;
              if (!workspace) return Promise.resolve([]);
              var preserveQuote = request.quoted === true;
              var payload = { workspace: workspace, query: request.query, sessionId: session.sessionId };
              var workspaceId = workspaceIdForPath(workspace);
              if (workspaceId) payload.workspaceId = workspaceId;
              return remoteCall('multiFolder/listFiles', payload).then(
                function (value) {
                  var items = value && Array.isArray(value.candidates) ? value.candidates : [];
                  var rows = [];
                  for (var i = 0; i < items.length; i += 1) {
                    var item = items[i];
                    rows = rows.concat(fileRow(item, preserveQuote, abbreviate(String(item.dir || ''))));
                  }
                  return rows;
                },
                // Autocomplete is advisory: a discovery failure is an empty
                // group, never a broken composer and never a failed send.
                function () { return []; },
              );
            },
            onPick: function (pick) {
              var chosen = rowValue(pick.candidate.value);
              if (chosen === undefined) return undefined;
              var name = lastSegment(chosen.path);
              // Tab / the row chevron refines the query in place instead of
              // settling the pick, so a directory descends one level: the
              // mention text becomes the live query, and the host resolves the
              // absolute spelling it just produced.
              if (chosen.kind === 'directory' && pick.action === 'drill') {
                return { text: chosen.mention, continue: true };
              }
              return {
                insert: {
                  source: NS,
                  ref: chosen.mention,
                  label: chosen.kind === 'directory' ? name + '/' : name,
                  appearance: chosen.kind === 'directory' ? 'folder' : 'file',
                  clipboardText: chosen.mention,
                },
              };
            },
            // The mention IS the model form (an `@path` token the prompt
            // grammar already defines), so serialization is the identity.
            codec: {
              clipboardText: function (ref) { return ref; },
              serialize: function (ref) { return Promise.resolve(ref); },
            },
          });
        }, 'dsh-multi-folder: @ discovery source');
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
