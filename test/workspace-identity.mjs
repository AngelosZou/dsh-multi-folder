/**
 * T1 — workspace identity store.
 *
 * Verifies that a project's secondary directories are keyed by the durable
 * WorkspaceId (stable across a title rename and across path spellings), that
 * the legacy path-keyed file is still read and migrated, and that sessions in
 * one workspace share one list. Runs without the DSH runtime:
 *   node test/workspace-identity.mjs
 */
import { apply } from '../lib/index.js';
import { join } from 'node:path';

const DSH_HOME = '/tmp/mf-t1-home';
process.env.DSH_HOME = DSH_HOME;
const configRoot = join(DSH_HOME, 'storages', 'multi-folder');
const workspaceFile = (id) => join(configRoot, 'workspaces', id + '.json');
const legacyFile = (path) => join(configRoot, String(path).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json');

const files = new Map();
const fsMock = {
  async resolve(path) { return { fakePath: String(path) }; },
  processPath(target) { return String(target && target.fakePath !== undefined ? target.fakePath : target); },
  async readText(target) {
    const key = this.processPath(target);
    if (!files.has(key)) throw new Error('ENOENT: ' + key);
    return files.get(key);
  },
  async writeText(target, content) {
    const key = this.processPath(target);
    const before = files.has(key) ? files.get(key) : null;
    files.set(key, String(content));
    return { operation: before === null ? 'create' : 'update', before, after: String(content), version: 1 };
  },
  async stat() { return { type: 'directory' }; },
  async listDir() { return []; },
};

const makeCtx = (workspaceRegistry) => {
  const sections = [];
  const listeners = new Map();
  const provided = new Map();
  const ctx = {
    fs: fsMock,
    sandboxPolicy: { resolve() { return { mode: 'workspace-write', workspaceRoot: '/proj/a' }; } },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    get(name) { return name === 'workspaceRegistry' ? workspaceRegistry : undefined; },
    provide(name, value) { provided.set(name, value); return () => {}; },
    inject() { return () => {}; },
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
  };
  apply(ctx);
  return { ctx, sections, listeners, provided };
};

const assert = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); };
const agentOf = (id, cwd) => ({ session: { id, header: { cwd }, append() {} } });

// ---------------------------------------------------------------- registry
let workspaces = [
  { id: 'w1', path: '/proj/a', title: 'Project A', sessionIds: ['s1', 's2'] },
  { id: 'w2', path: '/proj/b', title: 'Project B', sessionIds: ['s3'] },
];
const registry = { list: () => workspaces };
const { sections, listeners, provided } = makeCtx(registry);
const api = provided.get('multiFolder');
assert(api !== undefined, 'multiFolder service provided');

// One workspace, one identity-keyed file: both sessions share it.
const first = await api.add('/proj/a', '/repos/one', 'w1');
assert(first.changed === true && first.workspaceId === 'w1', 'add returns the workspace identity');
assert(files.has(workspaceFile('w1')), 'identity-keyed file written');
const stored = JSON.parse(files.get(workspaceFile('w1')));
assert(stored.version === 1 && stored.workspaceId === 'w1' && stored.path === '/proj/a', 'identity file shape');
assert(stored.dirs.length === 1 && stored.dirs[0] === '/repos/one', 'identity file dirs');

const a = sections[0].text({ agent: agentOf('s1', '/proj/a') });
const b = sections[0].text({ agent: agentOf('s2', '/proj/a') });
assert(a.includes('/repos/one') && b.includes('/repos/one'), 'two sessions of one workspace share the list');

// The same path WITHOUT the identity is a different (legacy) scope: T1 does not
// silently assume every path call is a workspace call.
const legacyView = await api.list('/proj/a');
assert(legacyView.workspaceId === null && legacyView.dirs.length === 0, 'path-only scope stays legacy');
assert(!files.has(legacyFile('/proj/a')), 'reading the legacy scope does not write a file');

// Router rename (title) leaves the identity and the list untouched.
workspaces = workspaces.map((w) => (w.id === 'w1' ? { ...w, title: 'Renamed Project' } : w));
const afterRename = sections[0].text({ agent: agentOf('s1', '/proj/a') });
assert(afterRename.includes('/repos/one'), 'title rename keeps the configuration');
const listed = await api.list('/proj/a', 'w1');
assert(listed.dirs[0] === '/repos/one', 'list through the identity still sees the dir');

// Legacy migration: an old path-keyed file is copied into the identity store.
files.set(legacyFile('/proj/b'), JSON.stringify(['/repos/two'], null, 2) + '\n');
const migrated = await api.list('/proj/b', 'w2');
assert(migrated.dirs.length === 1 && migrated.dirs[0] === '/repos/two', 'legacy list migrated');
assert(files.has(workspaceFile('w2')), 'migration wrote the identity file');
assert(files.has(legacyFile('/proj/b')), 'migration keeps the legacy file');
const migratedStored = JSON.parse(files.get(workspaceFile('w2')));
assert(migratedStored.workspaceId === 'w2' && migratedStored.path === '/proj/b', 'migration metadata');

// No registry (headless / unregistered session): the path scope still works.
const headless = makeCtx(undefined);
const headlessApi = headless.provided.get('multiFolder');
const pathOnly = await headlessApi.add('/proj/c', '/repos/three');
assert(pathOnly.workspaceId === null, 'headless add has no workspace identity');
assert(files.has(legacyFile('/proj/c')), 'headless writes the legacy path-keyed file');
const headlessText = headless.sections[0].text({ agent: agentOf('s9', '/proj/c') });
assert(headlessText.includes('/repos/three'), 'headless prompt reads the legacy file');

// Security boundary: the whole config store is write-forbidden to tools.
const execute = listeners.get('tools/execute')[0];
assert(typeof execute === 'function', 'tools/execute listener registered');
const denied = await execute(
  { name: 'write', arguments: { file_path: workspaceFile('w1'), content: '{}' }, agent: agentOf('s1', '/proj/a'), signal: undefined },
  async () => ({ isError: false, content: [] }),
);
assert(denied.isError === true, 'writing the identity file is rejected');
assert(String(denied.content?.[0]?.text ?? '').includes('managed by the dsh-multi-folder plugin'), 'guard message');

// The directory set never accepts the plugin's own store.
const selfGrant = await api.add('/proj/a', configRoot, 'w1');
assert(selfGrant.dirs.length === 1, 'config store cannot be added as a secondary directory');

console.log('workspace-identity: all assertions passed');
