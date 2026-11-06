/**
 * T3 — session directory overlay.
 *
 * Verifies the persistent overlay contract (`inherit | extend | replace`),
 * session-level exclusions, the effective-list merge used by the system prompt
 * and tool interception, and the session-scoped command channel.
 *   node test/session-overlay.mjs
 */
import { apply } from '../lib/index.js';
import { join } from 'node:path';

const DSH_HOME = '/tmp/mf-t3-home';
process.env.DSH_HOME = DSH_HOME;
const configRoot = join(DSH_HOME, 'storages', 'multi-folder');
const workspaceFile = (id) => join(configRoot, 'workspaces', id + '.json');
const sessionFile = (id) => join(configRoot, 'sessions', id + '.json');

const files = new Map();
const writes = [];
const fsMock = {
  async resolve(path) { return { fakePath: String(path) }; },
  processPath(target) { return String(target && target.fakePath !== undefined ? target.fakePath : target); },
  async readText(target) {
    const key = this.processPath(target);
    if (!files.has(key)) throw new Error('ENOENT: ' + key);
    return files.get(key);
  },
  async writeText(target, content, _options, _signal, policy) {
    const key = this.processPath(target);
    const before = files.has(key) ? files.get(key) : null;
    files.set(key, String(content));
    writes.push({ key, policy });
    return { operation: before === null ? 'create' : 'update', before, after: String(content), version: 1 };
  },
  async stat() { return { type: 'directory' }; },
  async listDir() { return []; },
};

const makeCtx = (registry) => {
  const sections = [];
  const listeners = new Map();
  const provided = new Map();
  const commands = [];
  const ctx = {
    fs: fsMock,
    sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: '/proj/a' }; } },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    get(name) { return name === 'workspaceRegistry' ? registry : undefined; },
    provide(name, value) { provided.set(name, value); return () => {}; },
    inject(names, callback) {
      if (Array.isArray(names) && names.includes('commands')) {
        callback({ commands: { register(description) { commands.push(description); return () => {}; } }, effect(fn) { return fn(); } });
      }
      return () => {};
    },
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
  };
  apply(ctx);
  return { ctx, sections, listeners, provided, commands };
};

const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };
const agentOf = (id, cwd) => ({ session: { id, header: { cwd }, append() {} } });
const parseJson = (text) => {
  const marker = '[MF:JSON] ';
  const at = String(text).lastIndexOf(marker);
  return at < 0 ? null : JSON.parse(String(text).slice(at + marker.length));
};

const workspaces = [
  { id: 'w1', path: '/proj/a', title: 'Project A', sessionIds: ['s1', 's2', 's3', 's4'] },
];
const registry = { list: () => workspaces, get: (id) => workspaces.find((w) => w.id === id) };
const { sections, listeners, provided, commands } = makeCtx(registry);
const api = provided.get('multiFolder');
assert(api, 'multiFolder service provided');
assert(commands.length === 1 && typeof commands[0].handler === 'function', 'command registered');

await api.set('/proj/a', ['/repos/base1', '/repos/base2'], 'w1');
const run = async (agent, rawInput) => {
  const result = await commands[0].handler({ agent, rawInput });
  assert(result.kind === 'success', 'command succeeds: ' + rawInput + ' -> ' + result.text);
  return { result, json: parseJson(result.text) };
};

const s1 = agentOf('s1', '/proj/a');
const s2 = agentOf('s2', '/proj/a');
const s3 = agentOf('s3', '/proj/a');
const s4 = agentOf('s4', '/proj/a');
assert(sections[0].text({ agent: s1 }).includes('/repos/base1'), 'inherited base is in the prompt');
assert(sections[0].text({ agent: s2 }).includes('/repos/base2'), 'another session inherits the base');

let out = await run(s1, 'session add "/repos/extra"');
assert(out.json.mode === 'extend', 'adding to an inherited session switches to extend');
assert(out.json.sessionDirs.includes('/repos/extra'), 'session addition stored');
assert(out.json.effectiveDirs.includes('/repos/base1') && out.json.effectiveDirs.includes('/repos/extra'), 'extend keeps the base and adds the session dir');
assert(sections[0].text({ agent: s1 }).includes('/repos/extra'), 'session addition reaches the prompt');
assert(!sections[0].text({ agent: s2 }).includes('/repos/extra'), 'session addition does not leak to a sibling');
const persisted = JSON.parse(files.get(sessionFile('s1')));
assert(persisted.version === 1 && persisted.sessionId === 's1' && persisted.mode === 'extend', 'session file shape');
assert(persisted.dirs.includes('/repos/extra'), 'session file stores additions');

out = await run(s1, 'session exclude "/repos/base1"');
assert(out.json.excludedDirs.includes('/repos/base1'), 'base directory excluded');
assert(!out.json.effectiveDirs.includes('/repos/base1'), 'excluded base is not effective');
assert(out.json.effectiveDirs.includes('/repos/base2') && out.json.effectiveDirs.includes('/repos/extra'), 'other base and addition remain');

// A fresh process must load the persisted exclusion against the workspace
// base, not silently discard it while normalizing the overlay.
const reloaded = makeCtx(registry);
const reloadedList = await reloaded.commands[0].handler({ agent: s1, rawInput: 'session list' });
const reloadedJson = parseJson(reloadedList.text);
assert(reloadedJson.excludedDirs.includes('/repos/base1'), 'persisted exclusion survives a reload');
assert(!reloadedJson.effectiveDirs.includes('/repos/base1'), 'reloaded exclusion stays effective');

out = await run(s1, 'session include "/repos/base1"');
assert(!out.json.excludedDirs.includes('/repos/base1'), 'exclusion restored');
assert(out.json.effectiveDirs.includes('/repos/base1'), 'restored base is effective');

out = await run(s1, 'session replace');
assert(out.json.mode === 'replace', 'mode switch to replace');
assert(out.json.effectiveDirs.length === 1 && out.json.effectiveDirs[0] === '/repos/extra', 'replace uses only session directories');

out = await run(s1, 'session set "/repos/x" "/repos/y"');
assert(out.json.mode === 'replace' && out.json.effectiveDirs.length === 2, 'session set replaces the session list');
assert(out.json.effectiveDirs.includes('/repos/x') && out.json.effectiveDirs.includes('/repos/y'), 'set paths effective');

out = await run(s1, 'session inherit');
assert(out.json.mode === 'inherit', 'reset to inherit');
assert(out.json.effectiveDirs.includes('/repos/base1') && out.json.effectiveDirs.includes('/repos/base2'), 'inherit restores the workspace base');

// Removing an inherited base directory is an exclusion, not a workspace edit.
out = await run(s3, 'session remove "/repos/base2"');
assert(out.json.mode === 'extend' && out.json.excludedDirs.includes('/repos/base2'), 'remove from inherit records an exclusion');
assert(out.json.effectiveDirs.includes('/repos/base1') && !out.json.effectiveDirs.includes('/repos/base2'), 'excluded base removed from effective list');
out = await run(s3, 'session include "/repos/base2"');
assert(out.json.mode === 'inherit', 'last exclusion returns to inherit');

// A replace-mode session sees only its own directories through @ discovery.
out = await run(s4, 'session set "/repos/only"');
const listed = await api.listFiles('/proj/a', '', 'w1', 's4');
assert(listed.dirs.length === 1 && listed.dirs[0] === '/repos/only', '@ discovery reads the session-effective list');
assert(listed.candidates.some((candidate) => candidate.path === '/repos/only'), '@ discovery offers the replacement directory');

// Tool interception re-roots a write into a session-only directory.
const execute = listeners.get('tools/execute')[0];
const writeResult = await execute(
  { name: 'write', arguments: { file_path: '/repos/only/new.txt', content: 'x' }, agent: s4, signal: undefined },
  async () => ({ isError: false, content: [] }),
);
assert(writeResult.isError === false, 'session-only write is accepted');
const write = writes.find((entry) => entry.key === '/repos/only/new.txt');
assert(write && write.policy && write.policy.workspaceRoot === '/repos/only', 'write is re-rooted at the session directory');

// An empty replace overlay is intentional: it must not fall back to the
// workspace base list.
out = await run(s4, 'session set');
assert(out.json.mode === 'replace' && out.json.effectiveDirs.length === 0, 'empty replace stays empty');
let fellThrough = false;
const noRoot = await execute(
  { name: 'write', arguments: { file_path: '/repos/only/new.txt', content: 'y' }, agent: s4, signal: undefined },
  async () => { fellThrough = true; return { isError: false, content: [] } },
);
assert(fellThrough && noRoot.isError === false, 'empty replace leaves the call to the default pipeline');
assert(writes.filter((entry) => entry.key === '/repos/only/new.txt').length === 1, 'empty replace performs no re-rooted write');

// The config store remains off-limits to writes.
const denied = await execute(
  { name: 'write', arguments: { file_path: sessionFile('s1'), content: '{}' }, agent: s1, signal: undefined },
  async () => ({ isError: false, content: [] }),
);
assert(denied.isError === true, 'session config write rejected');

console.log('session-overlay: all assertions passed');
