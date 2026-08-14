/**
 * Client-half smoke test: load the hand-written factory bundle under a fake
 * `window.__ModuleLoader__`, materialize the factory with a React shim, apply
 * against a mock ctx, and drive the header button -> panel -> command flow.
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
assert(typeof moduleExport.apply === 'function', 'client apply exported');

// Mock ctx ---------------------------------------------------------------
const calls = [];
const registrations = new Map(); // slotName -> { options, component }

const ctx = {
  slots: {
    inject(slotName, callback) {
      return callback();
    },
    register(options, component) {
      registrations.set(options.name, { options, component });
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
  workspaces: {
    async pickDirectory() {
      return 'C:\\workspaces\\secondary';
    },
  },
};

moduleExport.apply(ctx);

assert(registrations.has('conversation.session.header.actions'), 'header action registered');
assert(registrations.has('shell.overlay'), 'overlay registered');
assert(registrations.get('shell.overlay').options.id === 'multi-folder', 'overlay registration id');

// Drive the header button -------------------------------------------------
const renderDeep = (el) => {
  while (el !== null && typeof el.type === 'function') el = el.type(el.props);
  return el;
};
const header = registrations.get('conversation.session.header.actions');
const element = renderDeep(header.component({ sessionId: 'session-x' }));
assert(element.type === 'button', 'header renders a button');
assert(calls.length === 0, 'no command before click');

const tick = () => new Promise((r) => setTimeout(r, 0));

element.props.onClick(); // open + refresh
await tick();
assert(calls.length === 1, 'refresh command fired on open');
assert(calls[0].sessionId === 'session-x', 'session id passed to remote');
assert(calls[0].line === '/multi-folder list', 'list line');

// Panel render after refresh ----------------------------------------------
const panel = registrations.get('shell.overlay');
const panelElement = renderDeep(panel.component({}));
assert(panelElement !== null, 'panel open after click');
const panelText = JSON.stringify(panelElement);
assert(panelText.includes('secondary'), 'panel lists the secondary dir');

// Close + reopen -----------------------------------------------------------
const closeButton = panelElement.children[0].children[1];
closeButton.props.onClick();
assert(renderDeep(panel.component({})) === null, 'panel closed');

element.props.onClick();
element.props.onClick(); // toggles closed again
assert(renderDeep(panel.component({})) === null, 'panel toggled closed');
assert(calls.length === 1, 'reopen from cache issues no list command');

// Add-directory flow (pickDirectory -> add command) --------------------------
element.props.onClick();
await tick();
let panelAfter = renderDeep(panel.component({}));
const buttons = [];
const walk = (node) => {
  if (node === null || node === undefined) return;
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

// Session switch: re-rendering the header for a different session (same
// component instance, new props) must switch the open panel's content to
// that session and refresh from the Host. (Panel is still open here.)
renderDeep(header.component({ sessionId: 'session-y' })); // effect fires on sessionId change
await tick();
assert(calls.length > before && calls[calls.length - 1].sessionId === 'session-y', 'refresh fired for the new session');
const switchedPanel = renderDeep(panel.component({}));
assert(switchedPanel !== null, 'panel stays open across the switch');
assert(JSON.stringify(switchedPanel).includes('secondary'), 'panel content switched to the new session');

// Error path: remote failure surfaces as error state ------------------------
ctx.remote.commands.execute = async () => {
  return { ok: true, value: { commandId: 'c3', result: { kind: 'error', text: 'boom' } } };
};
element.props.onClick(); // opens session-x panel from cache (no fetch, no error yet)
await tick();
let errPanelEl = renderDeep(panel.component({}));
buttons.length = 0;
walk(errPanelEl);
const refreshBtn = buttons.find((b) => JSON.stringify(b.children || []).includes('刷新'));
assert(refreshBtn, 'refresh button present');
refreshBtn.props.onClick(); // forced refresh now fails
await tick();
const errPanel = renderDeep(panel.component({}));
assert(JSON.stringify(errPanel).includes('boom'), 'error surfaced in panel');

console.log('smoke-client: all assertions passed');
