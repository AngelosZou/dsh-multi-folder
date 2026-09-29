/**
 * Host-half smoke test: import the real plugin module, apply it against a mock
 * ctx, and assert the apply body registers its contributions without throwing.
 * Also exercises the sessionless `multiFolder/*` remote service (list / add /
 * set / remove) end to end through the provided plain-object service.
 * Does not require the DSH runtime. Run: node test/smoke-host.mjs
 */
import { name, inject, apply } from '../lib/index.js';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const listeners = new Map(); // eventName -> [fn]
const sections = [];
const commandsRegistered = [];
const typertContributions = [];
const provided = new Map(); // serviceName -> value
const fileStore = new Map(); // absolute path -> text
const configDir = join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'storages', 'multi-folder');
// The one level the mocked fs seam can list for the browser endpoints. Names
// are chosen to prove the sort, the hidden flag and the file filter.
const BROWSE_ROOT = 'D:\\Projects\\node\\DSH-multi-folder';
const SEAM_ENTRIES = [
  { name: 'zeta', type: 'directory', target: { fakePath: BROWSE_ROOT + '\\zeta' } },
  { name: 'readme.md', type: 'file', target: { fakePath: BROWSE_ROOT + '\\readme.md' } },
  { name: '.hidden', type: 'directory', target: { fakePath: BROWSE_ROOT + '\\.hidden' } },
  { name: 'alpha', type: 'directory', target: { fakePath: BROWSE_ROOT + '\\alpha' } },
];

const fsMock = {
  async resolve(path) {
    return { fakePath: String(path) };
  },
  processPath(target) {
    return String(target && target.fakePath !== undefined ? target.fakePath : target);
  },
  async listDir(target) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    if (key === BROWSE_ROOT) return SEAM_ENTRIES;
    if (key === os.homedir()) return [];
    throw new Error('ENOENT: ' + key);
  },
  async readText(target) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    if (fileStore.has(key)) return fileStore.get(key);
    throw new Error('no such file');
  },
  async writeText(target, content, expected, signal, policy) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    fileStore.set(key, String(content));
    return { operation: 'create', before: null, after: String(content), policy };
  },
};

const mockCtx = {
  fs: fsMock,
  sandboxPolicy: {
    resolve() { return { mode: 'workspace-write', workspaceRoot: 'D:\\Projects\\node\\DSH-multi-folder' }; },
  },
  systemPrompt: {
    section(section) { sections.push(section); return () => {}; },
  },
  get(name) { return undefined; }, // shell / shellEnv all absent
  provide(name, value) {
    provided.set(name, value);
    return () => {};
  },
  inject(names, callback) {
    if (names.includes('typert')) {
      return callback({
        typert: {
          register(contribution) {
            typertContributions.push(contribution);
            return () => {};
          },
        },
      });
    }
    return () => {}; // commands never appears
  },
  on(event, fn) {
    const list = listeners.get(event) ?? [];
    list.push(fn);
    listeners.set(event, list);
    return () => {};
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

// ------------------------------------------------------------ remote API
assert(typertContributions.length === 1, 'typert contribution registered');
const contribution = typertContributions[0];
assert(contribution.package === 'dsh-multi-folder' && contribution.face === 'host', 'contribution identity');
assert(Array.isArray(contribution.invocations) && contribution.invocations.length === 6, 'six remote endpoints');
const methods = contribution.invocations.map((d) => d.method).sort().join(',');
assert(methods === 'add,browse,list,makeDir,remove,set', 'endpoint method roster');
for (const descriptor of contribution.invocations) {
  assert(descriptor.namespace === 'multiFolder' && descriptor.service === 'multiFolder', 'namespace/service: ' + descriptor.method);
  assert(descriptor.invocation && descriptor.invocation.kind === 'direct', 'direct invocation: ' + descriptor.method);
  assert(descriptor.result && descriptor.result.mode === 'src-json', 'src-json result: ' + descriptor.method);
  for (const parameter of descriptor.parameters) {
    assert(parameter.source === 'json' && parameter.codec.mode === 'src-json', 'src-json parameter: ' + descriptor.method + '/' + parameter.name);
  }
}
const listParams = contribution.invocations.find((d) => d.method === 'list').parameters.map((p) => p.wire);
assert(listParams.join(',') === 'workspace', 'list wire shape');
const setParams = contribution.invocations.find((d) => d.method === 'set').parameters.map((p) => p.wire);
assert(setParams.join(',') === 'workspace,dirs', 'set wire shape');
const browseParams = contribution.invocations.find((d) => d.method === 'browse').parameters.map((p) => p.wire);
assert(browseParams.join(',') === 'path', 'browse wire shape');
const makeDirParams = contribution.invocations.find((d) => d.method === 'makeDir').parameters.map((p) => p.wire);
assert(makeDirParams.join(',') === 'parent,name', 'makeDir wire shape');

const api = provided.get('multiFolder');
assert(api !== undefined, 'multiFolder service provided');
assert(api.typertRemote && api.typertRemote.service === api, 'typertRemote binding points at the service');
assert(api.typertRemote.serviceKey === 'multiFolder' && api.typertRemote.namespace === 'multiFolder', 'typertRemote binding fields');

// Remote flows: list (empty) -> add -> idempotent add -> set -> remove.
const SEC = 'C:\\workspaces\\secondary';
const SEC2 = 'C:\\workspaces\\secondary-2';

const initial = await api.list(ws);
assert(Array.isArray(initial.dirs) && initial.dirs.length === 0, 'remote list starts empty');

const added = await api.add(ws, SEC);
assert(added.changed === true && added.dirs.length === 1 && added.dirs[0] === SEC, 'remote add applies');
const addedAgain = await api.add(ws, SEC);
assert(addedAgain.changed === false && addedAgain.dirs.length === 1, 'remote add is idempotent');

// The remote write must land in the host-owned store through the guarded policy.
const configFile = join(configDir, String(ws).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json');
assert(fileStore.has(configFile), 'config persisted through the shared core');

// Cross-channel coherence: the prompt section reads the same cache the remote wrote.
const sectionText = sections[0].text({ agent: { session: { header: { cwd: ws } } } });
assert(sectionText.includes(SEC), 'prompt section sees remote-configured dirs');

const setOut = await api.set(ws, [SEC2, SEC2, ws]); // dedupe + primary-workspace exclusion
assert(setOut.changed === true && setOut.dirs.length === 1 && setOut.dirs[0] === SEC2, 'remote set sanitizes');

const removed = await api.remove(ws, SEC2);
assert(removed.changed === true && removed.dirs.length === 0, 'remote remove clears');
const afterRemove = sections[0].text({ agent: { session: { header: { cwd: ws } } } });
assert(afterRemove === '', 'prompt section empty again after removal');

// Error surface: business failures reject with a prefixed message.
await api.add(ws, 'relative\\path').then(
  () => { throw new Error('FAIL: remote add should reject relative paths'); },
  (e) => { assert(String(e.message).startsWith('multi-folder: add requires an absolute path'), 'remote error prefix'); },
);
await api.list(undefined).then(
  () => { throw new Error('FAIL: remote list should require a workspace'); },
  (e) => { assert(String(e.message).includes('workspace is required'), 'remote workspace requirement'); },
);

// ------------------------------------------------- owned directory browser
// `browse`/`makeDir` serve the plugin's own picker (client item 8). They must
// run on the fs seam alone — no dependency on the composed directory picker —
// and must never touch the configuration store.
const storeBeforeBrowse = fileStore.size;

const level = await api.browse(ws);
assert(level.path === ws, 'browse echoes the canonical level path');
assert(level.parent === 'D:\\Projects\\node', 'browse reports the parent level');
assert(level.home === os.homedir(), 'browse reports the host home directory');
assert(Array.isArray(level.entries) && level.entries.length === 3, 'browse returns directories only');
assert(
  level.entries.map((e) => e.name).join(',') === '.hidden,alpha,zeta',
  'browse sorts names and keeps hidden entries flagged: ' + JSON.stringify(level.entries.map((e) => e.name)),
);
assert(level.entries[0].hidden === true && level.entries[1].hidden === false, 'browse flags hidden entries');
assert(level.entries[1].path === BROWSE_ROOT + '\\alpha', 'browse joins child paths onto the level');
assert(level.truncated === false, 'browse reports no truncation below the cap');

const home = await api.browse('');
assert(home.path === os.homedir(), 'a blank path lists the host home directory');

await api.browse('relative\\path').then(
  () => { throw new Error('FAIL: browse should reject a non-qualified path'); },
  (e) => {
    assert(
      String(e.message).startsWith('multi-folder: browse requires a fully qualified path'),
      'browse path fence: ' + String(e.message),
    );
  },
);
await api.browse('Z:\\definitely\\missing').then(
  () => { throw new Error('FAIL: an unlistable level should reject'); },
  (e) => { assert(String(e.message).includes('cannot list'), 'browse surfaces a listing failure: ' + String(e.message)); },
);

// Creation is a real directory creation (the fs seam has no primitive, so the
// host uses Node's mkdir exactly like the shipped browse backend does).
const tmpRoot = await mkdtemp(join(os.tmpdir(), 'mf-browse-'));
try {
  const created = await api.makeDir(tmpRoot, 'child');
  assert(created.path === join(tmpRoot, 'child'), 'makeDir returns the created path');
  assert(existsSync(created.path), 'makeDir created the directory');
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}
await api.makeDir(BROWSE_ROOT, 'a/b').then(
  () => { throw new Error('FAIL: makeDir should reject a multi-segment name'); },
  (e) => { assert(String(e.message).includes('single path segment'), 'makeDir segment fence: ' + String(e.message)); },
);
await api.makeDir('relative', 'child').then(
  () => { throw new Error('FAIL: makeDir should reject a non-qualified parent'); },
  (e) => { assert(String(e.message).includes('fully qualified parent'), 'makeDir parent fence: ' + String(e.message)); },
);
assert(fileStore.size === storeBeforeBrowse, 'browse/makeDir leave the configuration store untouched');

console.log('smoke-host: all assertions passed');
