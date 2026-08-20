/**
 * Client-half smoke test: load the hand-written factory bundle under a fake
 * `window.__ModuleLoader__`, materialize the factory with a React shim, apply
 * against a mock ctx, and drive the header button -> panel -> command flow,
 * plus the session-creation page flows (the input-dock chip, the upstream hero
 * chip, and the fixed fallback launcher) over the sessionless `multiFolder/*`
 * RPC channel.
 *
 * The `slots.inject` mock is DECLARATION-AWARE like the real service: a wait
 * fires only while its slot is declared, and collapsing a declaration disposes
 * the registration. That is what makes the hero-seat election testable — the
 * page must never show two Multi-folder entries.
 * Run: node test/smoke-client.mjs
 */
import { readFileSync } from 'node:fs';

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(record) {
      captured = record;
    },
  },
};
// Fake DOM: the conversation root reports the hero phase via data-phase.
globalThis.document = {
  body: {},
  querySelector(selector) {
    if (selector === '[data-phase]') {
      return { getAttribute: (name) => (name === 'data-phase' ? 'hero' : null) };
    }
    return null;
  },
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
(0, eval)(source);

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
};
assert(captured && captured.id === 'dsh-multi-folder', 'bundle registered under its id');

const reactShim = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot();
  },
  useEffect(fn) {
    fn(); // run immediately; deps ignored (test drives re-renders manually)
    return undefined;
  },
};

const moduleExport = captured.factory((spec) => {
  if (spec === 'react') return reactShim;
  throw new Error('unexpected require: ' + spec);
});

assert(moduleExport.name === 'dsh-multi-folder', 'client plugin name');
assert(Array.isArray(moduleExport.inject) && moduleExport.inject.includes('slots'), 'client inject list');
assert(moduleExport.inject.includes('connection') && moduleExport.inject.includes('sessions'), 'client injects connection + sessions');
assert(moduleExport.inject.includes('locale'), 'client injects the locale service');
assert(typeof moduleExport.apply === 'function', 'client apply exported');

// Mock ctx ---------------------------------------------------------------
const calls = []; // remote.commands.execute calls
const rpcCalls = []; // connection.rpc.call calls
const registrations = new Map(); // slotName -> [{ options, component }]

const registerEntry = (options, component) => {
  const list = registrations.get(options.name) ?? [];
  const entry = { options, component };
  list.push(entry);
  registrations.set(options.name, list);
  return () => {
    const current = registrations.get(options.name) ?? [];
    const at = current.indexOf(entry);
    if (at >= 0) current.splice(at, 1);
  };
};
const entryBy = (slotName, id) =>
  (registrations.get(slotName) ?? []).find((entry) => entry.options.id === id);

// Declaration-aware slot mock: `inject` waits fire only for declared slots and
// re-fire when a declaration arrives later (the real service reconciles on the
// declaration epoch). `shell.overlay` and the session header are always
// declared by the shell; the conversation seats are declared by the test.
const declared = new Set(['conversation.session.header.actions', 'shell.overlay']);
const waits = new Map(); // slotName -> [{ callback, dispose }]

const declareSlot = (slotName) => {
  if (declared.has(slotName)) return;
  declared.add(slotName);
  for (const wait of waits.get(slotName) ?? []) {
    if (wait.dispose === undefined) wait.dispose = wait.callback();
  }
};
const collapseSlot = (slotName) => {
  if (!declared.has(slotName)) return;
  declared.delete(slotName);
  for (const wait of waits.get(slotName) ?? []) {
    if (typeof wait.dispose === 'function') wait.dispose();
    wait.dispose = undefined;
  }
};

// Locale service mock (mirrors @deepseek-ai/dsh-client-locale's surface the
// bundle uses: register(ns, dicts) + bind(ns) -> t(key, params)). The real
// service enforces bilingual balance and resolves the active locale.
const localeDicts = new Map();
let activeLocale = 'zh';
const locale = {
  register(ns, dicts) {
    localeDicts.set(ns, dicts);
    return () => localeDicts.delete(ns);
  },
  bind(ns) {
    return (key, params) => {
      const dicts = localeDicts.get(ns) ?? {};
      const dict = dicts[activeLocale] ?? dicts.zh ?? {};
      let text = dict[key] !== undefined ? dict[key] : key;
      if (params) text = text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
      return text;
    };
  },
  setLocale(id) {
    activeLocale = id;
  },
};
/** The framework renderer hands entries declared with `locale:` a `t` seat;
 *  the test simulates that by passing it in props. */
const t = locale.bind('multi-folder');
const withT = (props) => Object.assign({}, props ?? {}, { t });

const ctx = {
  effect(fn) {
    const disposer = fn();
    return () => { if (typeof disposer === 'function') disposer(); };
  },
  locale,
  slots: {
    inject(slotName, callback) {
      const wait = { callback, dispose: undefined };
      const list = waits.get(slotName) ?? [];
      list.push(wait);
      waits.set(slotName, list);
      if (declared.has(slotName)) wait.dispose = callback();
      return () => {
        if (typeof wait.dispose === 'function') wait.dispose();
        wait.dispose = undefined;
      };
    },
    register(options, component) {
      if (!declared.has(options.name)) {
        throw new Error('register() on an undeclared slot: ' + options.name);
      }
      return registerEntry(options, component);
    },
  },
  remote: {
    commands: {
      async execute(sessionId, line) {
        calls.push({ sessionId, line });
        if (line.includes('list')) {
          return {
            ok: true,
            value: {
              commandId: 'c1',
              result: {
                kind: 'success',
                text: 'Secondary working directories:\n- C:\\workspaces\\secondary\n[MF:JSON] {"workspace":"C:\\\\workspaces\\\\primary","dirs":["C:\\\\workspaces\\\\secondary"],"changed":false}',
              },
            },
          };
        }
        return {
          ok: true,
          value: {
            commandId: 'c2',
            result: { kind: 'success', text: 'ok\n[MF:JSON] {"workspace":"W","dirs":["C:\\\\workspaces\\\\secondary"],"changed":true}' },
          },
        };
      },
    },
  },
  connection: {
    rpc: {
      async call(channel, endpoint, payload) {
        rpcCalls.push({ channel, endpoint, args: payload.args });
        if (endpoint === 'multiFolder/list') {
          return { ok: true, value: { workspace: 'C:\\workspaces\\primary', dirs: ['C:\\workspaces\\secondary'] } };
        }
        if (endpoint === 'multiFolder/add' || endpoint === 'multiFolder/remove' || endpoint === 'multiFolder/set') {
          return { ok: true, value: { workspace: 'C:\\workspaces\\primary', dirs: ['C:\\workspaces\\secondary'], changed: true } };
        }
        return { ok: false, error: { message: 'unknown endpoint ' + endpoint } };
      },
    },
  },
  workspaces: {
    async pickDirectory() {
      return 'C:\\workspaces\\secondary';
    },
    list: {
      subscribe() { return () => {}; },
      getSnapshot() {
        return {
          items: [
            { workspaceId: 'w1', path: 'C:\\workspaces\\primary', sessionIds: ['session-blank'] },
          ],
        };
      },
    },
  },
  sessions: {
    list: {
      subscribe() { return () => {}; },
      getSnapshot() {
        return {
          current: 'session-blank',
          byId: {
            'session-blank': { cwd: 'C:\\workspaces\\primary', blank: true },
            'session-x': { cwd: 'C:\\workspaces\\primary' },
          },
        };
      },
    },
  },
};

// Standard-kit shares the shell hands a `conversation.input.dock` entry: the
// session id, the dock owner share (`{ session, input }`), and the root
// selector hooks. Mirrors the rc.6 ConversationRoot render.
const sessionsSnapshot = ctx.sessions.list.getSnapshot();
const workspacesSnapshot = ctx.workspaces.list.getSnapshot();
const dockProps = (over) =>
  withT(Object.assign(
    {
      sessionId: 'session-blank',
      session: { composerPhase: 'blank', openState: 'open' },
      input: {},
      useSessions: (selector) => selector(sessionsSnapshot),
      useWorkspaces: (selector) => selector(workspacesSnapshot),
    },
    over ?? {},
  ));

// The shipped rc.6 shell declares the input dock but not the hero-extras hole.
declareSlot('conversation.input.dock');

moduleExport.apply(ctx);

assert(entryBy('conversation.session.header.actions', 'multi-folder'), 'header action registered');
assert(entryBy('shell.overlay', 'multi-folder'), 'overlay panel registered');
assert(entryBy('shell.overlay', 'multi-folder-hero'), 'hero launcher registered');
assert(entryBy('conversation.input.dock', 'multi-folder'), 'input-dock chip registered');
assert(
  entryBy('conversation.hero.workspaceExtras', 'multi-folder') === undefined,
  'undeclared upstream hero slot stays unoccupied',
);

// Dock entry shape: the list-slot contract the framework arranges by. A unique
// id and an explicit order are what let other plugins share this band.
const dockEntry = entryBy('conversation.input.dock', 'multi-folder');
assert(dockEntry.options.id === 'multi-folder', 'dock entry carries a unique list id');
assert(typeof dockEntry.options.order === 'number', 'dock entry declares an explicit order');
assert(dockEntry.options.order > 100, 'dock order sits after the shipped dock neighbours');

// Locale: the bundle registered a bilingual `multi-folder` namespace, and
// every list-entry label is a thunk resolving through the active locale.
const dicts = localeDicts.get('multi-folder');
assert(dicts && dicts.zh && dicts.en, 'bilingual dictionaries registered');
assert(
  Object.keys(dicts.zh).sort().join('\n') === Object.keys(dicts.en).sort().join('\n'),
  'zh/en key sets match (bilingual balance)',
);
for (const [slotName, id] of [
  ['conversation.session.header.actions', 'multi-folder'],
  ['shell.overlay', 'multi-folder'],
  ['shell.overlay', 'multi-folder-hero'],
  ['conversation.input.dock', 'multi-folder'],
]) {
  assert(typeof entryBy(slotName, id).options.label === 'function', `label is a thunk (${slotName})`);
  assert(entryBy(slotName, id).options.locale === 'multi-folder', `registration declares locale (${slotName})`);
}

// Drive the header button -------------------------------------------------
const renderDeep = (el) => {
  while (el !== null && el !== undefined && typeof el.type === 'function') el = el.type(el.props);
  return el;
};
const header = entryBy('conversation.session.header.actions', 'multi-folder');
const element = renderDeep(header.component(withT({ sessionId: 'session-x' })));
assert(element.type === 'button', 'header renders a button');
assert(calls.length === 0, 'no command before click');

const tick = () => new Promise((r) => setTimeout(r, 0));

element.props.onClick(); // open + refresh
await tick();
assert(calls.length === 1, 'refresh command fired on open');
assert(calls[0].sessionId === 'session-x', 'session id passed to remote');
assert(calls[0].line === '/multi-folder list', 'list line');

// Panel render after refresh ----------------------------------------------
const panel = entryBy('shell.overlay', 'multi-folder');
const panelElement = renderDeep(panel.component(withT({})));
assert(panelElement !== null, 'panel open after click');
const panelText = JSON.stringify(panelElement);
assert(panelText.includes('secondary'), 'panel lists the secondary dir');

// Close + reopen -----------------------------------------------------------
const closeButton = panelElement.children[0].children[1];
closeButton.props.onClick();
assert(renderDeep(panel.component(withT({}))) === null, 'panel closed');

element.props.onClick();
element.props.onClick(); // toggles closed again
assert(renderDeep(panel.component(withT({}))) === null, 'panel toggled closed');
assert(calls.length === 1, 'reopen from cache issues no list command');

// Add-directory flow (pickDirectory -> add command) --------------------------
element.props.onClick();
await tick();
let panelAfter = renderDeep(panel.component(withT({})));
const buttons = [];
const walk = (node) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (node.type === 'button') buttons.push(node);
  if (Array.isArray(node.children)) node.children.forEach(walk);
  if (node.props && node.props.children !== undefined) {
    (Array.isArray(node.props.children) ? node.props.children : [node.props.children]).forEach(walk);
  }
};
walk(panelAfter);
const addButton = buttons.find((b) => JSON.stringify(b.children || []).includes('添加目录'));
assert(addButton, 'add button present');
const before = calls.length;
addButton.props.onClick(); // async — need a tick
await new Promise((r) => setTimeout(r, 20));
assert(calls.length > before, 'add command fired after pickDirectory');
assert(calls[calls.length - 1].line.includes('add'), 'add line shape');

// ---- Locale support: copy and labels follow the active locale ------------
locale.setLocale('en');
const headerEntry = entryBy('conversation.session.header.actions', 'multi-folder');
assert(headerEntry.options.label() === 'Multi-folder', 'slot label thunk resolves English');
const enHeader = renderDeep(header.component(withT({ sessionId: 'session-x' })));
assert(JSON.stringify(enHeader).includes('Multi-folder ▾'), 'header button copy in English');
const enPanel = renderDeep(panel.component(withT({})));
const enText = JSON.stringify(enPanel);
assert(enText.includes('Add directory') && enText.includes('Remove') && enText.includes('Refresh'), 'panel actions in English');
assert(enText.includes('Workspace:'), 'panel workspace line in English');
assert(enText.includes('command-execution rights'), 'panel footnote in English');
locale.setLocale('zh');
assert(headerEntry.options.label() === '多工作目录', 'slot label thunk resolves Chinese again');

// Session switch: re-rendering the header for a different session (same
// component instance, new props) must switch the open panel's content to
// that session and refresh from the Host. (Panel is still open here.)
renderDeep(header.component(withT({ sessionId: 'session-y' }))); // effect fires on sessionId change
await tick();
assert(calls.length > before && calls[calls.length - 1].sessionId === 'session-y', 'refresh fired for the new session');
const switchedPanel = renderDeep(panel.component(withT({})));
assert(switchedPanel !== null, 'panel stays open across the switch');
assert(JSON.stringify(switchedPanel).includes('secondary'), 'panel content switched to the new session');

// Error path: remote failure surfaces as error state ------------------------
ctx.remote.commands.execute = async () => {
  return { ok: true, value: { commandId: 'c3', result: { kind: 'error', text: 'boom' } } };
};
element.props.onClick(); // opens session-x panel from cache (no fetch, no error yet)
await tick();
let errPanelEl = renderDeep(panel.component(withT({})));
buttons.length = 0;
walk(errPanelEl);
const refreshBtn = buttons.find((b) => JSON.stringify(b.children || []).includes('刷新'));
assert(refreshBtn, 'refresh button present');
refreshBtn.props.onClick(); // forced refresh now fails
await tick();
const errPanel = renderDeep(panel.component(withT({})));
assert(JSON.stringify(errPanel).includes('boom'), 'error surfaced in panel');

// ---- Session-creation page: the input-dock chip (shipped seat) ------------
// Deep helpers: the anchored popover is a nested function component, so the
// shallow `walk` above cannot reach it.
const deepRender = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(deepRender);
  if (typeof node.type === 'function') return deepRender(node.type(node.props));
  return {
    type: node.type,
    props: node.props,
    children: Array.isArray(node.children) ? node.children.map(deepRender) : node.children,
  };
};
const textOf = (node) => JSON.stringify(deepRender(node));
const collectButtons = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collectButtons(child, out));
    return out;
  }
  if (typeof node.type === 'function') return collectButtons(node.type(node.props), out);
  if (node.type === 'button') out.push(node);
  if (Array.isArray(node.children)) node.children.forEach((child) => collectButtons(child, out));
  if (node.props && node.props.children !== undefined) {
    (Array.isArray(node.props.children) ? node.props.children : [node.props.children]).forEach((child) => collectButtons(child, out));
  }
  return out;
};

// Close the session panel first; the fake document reports data-phase="hero"
// and the mock session list points at the blank session of C:\workspaces\primary.
closeButton.props.onClick();

const dock = entryBy('conversation.input.dock', 'multi-folder');
const heroEntry = entryBy('shell.overlay', 'multi-folder-hero');

// While a declared slot seat holds the page, the fixed bottom-right launcher
// stands down — one hero entry, never two.
assert(renderDeep(heroEntry.component(withT({}))) === null, 'fixed launcher stands down while a slot seat is mounted');

// An active (non-blank) session keeps its entry in the session header, so the
// dock row renders nothing there.
assert(
  renderDeep(dock.component(dockProps({
    sessionId: 'session-x',
    session: { composerPhase: 'ready', openState: 'open' },
  }))) === null,
  'dock chip hides outside the session-creation page',
);

// Session-creation page: the chip row renders and warms its count through the
// sessionless channel (workspace mode produces no conversation row).
const rpcBeforeDock = rpcCalls.length;
let dockRow = renderDeep(dock.component(dockProps()));
await tick();
assert(dockRow !== null && dockRow.type === 'div', 'dock chip renders a row in the hero phase');
assert(dockRow.props.style.paddingLeft === 20, 'dock row is indented onto the official hero chip row');
assert(dockRow.props.style.position === undefined, 'dock row stays in flow (no absolute positioning)');
assert(rpcCalls.length > rpcBeforeDock, 'dock chip warms the workspace list over the RPC channel');
assert(rpcCalls[rpcCalls.length - 1].channel === '/api', 'RPC channel is /api');
assert(rpcCalls[rpcCalls.length - 1].endpoint === 'multiFolder/list', 'warm read uses the list endpoint');
assert(rpcCalls[rpcCalls.length - 1].args.workspace === 'C:\\workspaces\\primary', 'warm read keyed by workspace path');

// Warm cache: the chip label carries the configured count.
dockRow = renderDeep(dock.component(dockProps()));
assert(textOf(dockRow).includes('多工作目录 · 1'), 'chip shows the configured directory count');

// Clicking it opens the panel as the chip's OWN popover, and the overlay panel
// stands down so the panel never renders twice.
const dockChipButton = collectButtons(dockRow)[0];
assert(dockChipButton, 'dock chip renders a button');
dockChipButton.props.onClick();
await tick();
assert(renderDeep(panel.component(withT({}))) === null, 'overlay panel stands down for an anchored chip');
dockRow = renderDeep(dock.component(dockProps()));
const dockText = textOf(dockRow);
assert(dockText.includes('C:\\\\workspaces\\\\primary'), 'anchored popover shows the workspace');
assert(dockText.includes('secondary'), 'anchored popover lists the configured dirs');

// Workspace-mode mutations from the anchored popover.
const dockPanelButtons = collectButtons(dockRow);
const dockAdd = dockPanelButtons.find((b) => textOf(b.children || []).includes('添加目录'));
assert(dockAdd, 'anchored popover carries the add button');
const rpcBeforeDockAdd = rpcCalls.length;
dockAdd.props.onClick();
await new Promise((r) => setTimeout(r, 20));
assert(rpcCalls.length > rpcBeforeDockAdd, 'anchored add fired through the RPC channel');
assert(rpcCalls[rpcCalls.length - 1].endpoint === 'multiFolder/add', 'add endpoint');
assert(rpcCalls[rpcCalls.length - 1].args.workspace === 'C:\\workspaces\\primary', 'add keyed by workspace path');
assert(rpcCalls[rpcCalls.length - 1].args.path === 'C:\\workspaces\\secondary', 'add path argument');

// ---- Hero seat election: a better seat takes over, still one entry --------
declareSlot('conversation.hero.workspaceExtras');
const heroChipEntry = entryBy('conversation.hero.workspaceExtras', 'multi-folder');
assert(heroChipEntry, 'upstream hero chip registers the moment the slot is declared');
assert(renderDeep(dock.component(dockProps())) === null, 'dock chip stands down for the upstream hero seat');
assert(renderDeep(heroEntry.component(withT({}))) === null, 'fixed launcher stands down for the upstream hero seat');

const extrasProps = withT({ workspacePath: 'C:\\workspaces\\primary' });
let extrasRow = renderDeep(heroChipEntry.component(extrasProps));
assert(extrasRow !== null && extrasRow.type === 'div', 'hero chip renders');
const extrasButton = collectButtons(extrasRow)[0];
extrasButton.props.onClick();
await tick();
assert(renderDeep(panel.component(withT({}))) === null, 'hero chip owns its popover too');
extrasRow = renderDeep(heroChipEntry.component(extrasProps));
assert(textOf(extrasRow).includes('secondary'), 'hero chip popover lists the configured dirs');

// ---- Fallback: no declared seat at all -> the fixed launcher returns ------
collapseSlot('conversation.hero.workspaceExtras');
collapseSlot('conversation.input.dock');
assert(entryBy('conversation.input.dock', 'multi-folder') === undefined, 'collapsing a declaration withdraws the dock entry');
assert(entryBy('conversation.hero.workspaceExtras', 'multi-folder') === undefined, 'collapsing the upstream declaration withdraws the chip');

renderDeep(heroEntry.component(withT({}))); // mounts the effect: syncHero runs
const fallback = renderDeep(heroEntry.component(withT({})));
assert(fallback !== null && fallback.type === 'button', 'fixed launcher returns when no slot seat is available');

fallback.props.onClick();
await tick();
const workspacePanel = renderDeep(panel.component(withT({})));
assert(workspacePanel !== null, 'fallback launcher opens the overlay panel in workspace mode');
assert(textOf(workspacePanel).includes('C:\\\\workspaces\\\\primary'), 'workspace shown in panel');
assert(textOf(workspacePanel).includes('secondary'), 'dirs listed from the cached remote value');

// Workspace-mode remove through the overlay panel.
buttons.length = 0;
walk(workspacePanel);
const wsRemoveButton = buttons.find((b) => JSON.stringify(b.children || []).includes('移除'));
assert(wsRemoveButton, 'workspace-mode remove button present');
const rpcBeforeRemove = rpcCalls.length;
wsRemoveButton.props.onClick();
await tick();
assert(rpcCalls.length === rpcBeforeRemove + 1 && rpcCalls[rpcCalls.length - 1].endpoint === 'multiFolder/remove', 'remove endpoint');

// RPC failure surfaces in workspace mode.
ctx.connection.rpc.call = async () => ({ ok: false, error: { message: 'rpc-boom' } });
const wsErrEl = renderDeep(panel.component(withT({})));
buttons.length = 0;
walk(wsErrEl);
const wsRefreshBtn = buttons.find((b) => JSON.stringify(b.children || []).includes('刷新'));
assert(wsRefreshBtn, 'workspace-mode refresh button present');
wsRefreshBtn.props.onClick();
await tick();
const wsErrPanel = renderDeep(panel.component(withT({})));
assert(JSON.stringify(wsErrPanel).includes('rpc-boom'), 'workspace-mode RPC failure surfaced');

console.log('smoke-client: all assertions passed');
