/**
 * Client-half smoke test: load the hand-written factory bundle under a fake
 * `window.__ModuleLoader__`, materialize the factory with a React shim, apply
 * against a mock ctx, and drive the header button -> panel -> command flow,
 * plus the session-creation page flows (hero launcher + workspace-mode panel
 * over the sessionless `multiFolder/*` RPC channel).
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
  list.push({ options, component });
  registrations.set(options.name, list);
};
const entryBy = (slotName, id) =>
  (registrations.get(slotName) ?? []).find((entry) => entry.options.id === id);

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
      return callback();
    },
    register(options, component) {
      registerEntry(options, component);
      return () => {};
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
        return { current: 'session-blank', byId: { 'session-blank': { cwd: 'C:\\workspaces\\primary' } } };
      },
    },
  },
};

moduleExport.apply(ctx);

assert(entryBy('conversation.session.header.actions', 'multi-folder'), 'header action registered');
assert(entryBy('shell.overlay', 'multi-folder'), 'overlay panel registered');
assert(entryBy('shell.overlay', 'multi-folder-hero'), 'hero launcher registered');
assert(entryBy('conversation.hero.workspaceExtras', 'multi-folder'), 'upstream hero slot registration present');

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
  ['conversation.hero.workspaceExtras', 'multi-folder'],
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

// ---- Session-creation page flows (hero) ----------------------------------
// Close the session panel, then mount the hero launcher: the fake document
// reports data-phase="hero" and the mock session list points at the blank
// session of C:\workspaces\primary.
closeButton.props.onClick();

const heroEntry = entryBy('shell.overlay', 'multi-folder-hero');
renderDeep(heroEntry.component(withT({}))); // mounts the effect: syncHero runs
const heroButton = renderDeep(heroEntry.component(withT({})));
assert(heroButton !== null && heroButton.type === 'button', 'hero launcher visible in hero phase');

const rpcBefore = rpcCalls.length;
heroButton.props.onClick();
await tick();
assert(rpcCalls.length === rpcBefore + 1, 'workspace-mode open lists through the shared RPC channel');
assert(rpcCalls[rpcCalls.length - 1].channel === '/api', 'RPC channel is /api');
assert(rpcCalls[rpcCalls.length - 1].endpoint === 'multiFolder/list', 'list endpoint');
assert(rpcCalls[rpcCalls.length - 1].args.workspace === 'C:\\workspaces\\primary', 'list keyed by workspace path');

const workspacePanel = renderDeep(panel.component(withT({})));
assert(workspacePanel !== null, 'panel opens in workspace mode');
assert(JSON.stringify(workspacePanel).includes('C:\\\\workspaces\\\\primary'), 'workspace shown in panel');
assert(JSON.stringify(workspacePanel).includes('secondary'), 'dirs listed from the remote value');

// Workspace-mode mutations: add via pickDirectory -> multiFolder/add.
buttons.length = 0;
walk(workspacePanel);
const wsAddButton = buttons.find((b) => JSON.stringify(b.children || []).includes('添加目录'));
assert(wsAddButton, 'workspace-mode add button present');
const rpcBeforeAdd = rpcCalls.length;
wsAddButton.props.onClick();
await new Promise((r) => setTimeout(r, 20));
assert(rpcCalls.length > rpcBeforeAdd, 'workspace-mode add fired through the RPC channel');
assert(rpcCalls[rpcCalls.length - 1].endpoint === 'multiFolder/add', 'add endpoint');
assert(rpcCalls[rpcCalls.length - 1].args.workspace === 'C:\\workspaces\\primary', 'add keyed by workspace path');
assert(rpcCalls[rpcCalls.length - 1].args.path === 'C:\\workspaces\\secondary', 'add path argument');

// Workspace-mode remove.
const afterAddPanel = renderDeep(panel.component(withT({})));
buttons.length = 0;
walk(afterAddPanel);
const wsRemoveButton = buttons.find((b) => JSON.stringify(b.children || []).includes('移除'));
assert(wsRemoveButton, 'workspace-mode remove button present');
const rpcBeforeRemove = rpcCalls.length;
wsRemoveButton.props.onClick();
await tick();
assert(rpcCalls.length === rpcBeforeRemove + 1 && rpcCalls[rpcCalls.length - 1].endpoint === 'multiFolder/remove', 'remove endpoint');

// Upstream hero chip (B1): opens the same workspace-mode panel.
const heroChipEntry = entryBy('conversation.hero.workspaceExtras', 'multi-folder');
const chip = renderDeep(heroChipEntry.component(withT({ workspacePath: 'C:\\workspaces\\primary' })));
assert(chip !== null && chip.type === 'button', 'hero chip renders');
const rpcBeforeChip = rpcCalls.length;
chip.props.onClick();
await tick();
assert(rpcCalls.length === rpcBeforeChip || rpcCalls[rpcCalls.length - 1].endpoint === 'multiFolder/list', 'hero chip reuses cached workspace list (or refreshes)');
assert(renderDeep(panel.component(withT({}))) !== null, 'hero chip opens the workspace panel');

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
