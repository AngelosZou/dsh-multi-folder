/**
 * Host-half smoke test: import the real plugin module, apply it against a mock
 * ctx, and assert the apply body registers its contributions without throwing.
 * Does not require the DSH runtime. Run: node test/smoke-host.mjs
 */
import { name, inject, apply } from '../lib/index.js';

const listeners = new Map(); // eventName -> [fn]
const sections = [];
const commandsRegistered = [];
let disposed = false;

const mockCtx = {
  fs: {
    async resolve() { throw new Error('mock: no fs.resolve'); },
  },
  sandboxPolicy: {
    resolve() { return { mode: 'workspace-write', workspaceRoot: 'D:\\Projects\\node\\DSH-multi-folder' }; },
  },
  systemPrompt: {
    section(section) { sections.push(section); return () => {}; },
  },
  get(name) { return undefined; }, // shell / shellEnv all absent
  inject(names, callback) { return () => {}; }, // commands never appears
  on(event, fn) {
    const list = listeners.get(event) ?? [];
    list.push(fn);
    listeners.set(event, list);
    return () => { disposed = true; };
  },
};

apply(mockCtx);

const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };

assert(name === 'dsh-multi-folder', 'plugin name');
assert(Array.isArray(inject) && inject.includes('fs') && inject.includes('sandboxPolicy') && inject.includes('systemPrompt'), 'inject list');
assert(sections.length === 1, 'prompt section registered');
assert(sections[0].name === 'multi-folder:secondary-dirs', 'section name');
assert(typeof sections[0].text === 'function', 'section text provider');
assert(sections[0].text({}) === '', 'section provider: empty without agent context');
const ws = 'D:\\Projects\\node\\DSH-multi-folder';
assert(sections[0].text({ agent: { session: { header: { cwd: ws } } } }) === '', 'section provider: empty without configured dirs');
assert(listeners.has('agent/pre-step'), 'pre-step listener');
assert(listeners.has('tools/post-execute'), 'post-execute listener');
assert(listeners.has('tools/execute'), 'tools/execute listener');
assert(listeners.has('agent/created'), 'agent/created listener');
assert(commandsRegistered.length === 0, 'no commands registered without commands service');

// tools/execute pass-through: absent shell and no dirs -> next() result passes through
const nextResult = { isError: false, value: { ok: 1 }, content: [{ type: 'text', text: 'pass' }] };
const executeListener = listeners.get('tools/execute')[0];
await executeListener(
  { name: 'write', arguments: { file_path: 'x.txt', content: 'x' }, agent: null, signal: undefined },
  async () => nextResult,
).then((r) => {
  assert(r === nextResult, 'tools/execute falls back to next() for unknown workspaces');
});

console.log('smoke-host: all assertions passed');
