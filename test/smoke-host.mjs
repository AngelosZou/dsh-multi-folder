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

// Fake secondary-directory tree behind the same fs seam. `node_modules` and
// `.hidden` prove the exclusion and hidden-entry rules; `deep/` proves the
// bounded recursion.
const SEC = 'C:\\workspaces\\secondary';
const SEC2 = 'C:\\workspaces\\secondary-2';
const SEC_TREE = {
  [SEC]: [
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file' },
    { name: 'node_modules', type: 'directory' },
    { name: '.hidden', type: 'directory' },
  ],
  [SEC + '\\src']: [
    { name: 'deep', type: 'directory' },
    { name: 'main.ts', type: 'file' },
  ],
  [SEC + '\\src\\deep']: [
    { name: 'util.ts', type: 'file' },
  ],
  [SEC + '\\node_modules']: [{ name: 'pkg', type: 'directory' }],
  [SEC + '\\node_modules\\pkg']: [{ name: 'index.js', type: 'file' }],
  [SEC + '\\.hidden']: [{ name: 'secret.txt', type: 'file' }],
  [SEC2]: [{ name: 'probe.txt', type: 'file' }],
};
let listDirCalls = 0;

const fsMock = {
  async resolve(path) {
    return { fakePath: String(path) };
  },
  processPath(target) {
    return String(target && target.fakePath !== undefined ? target.fakePath : target);
  },
  async listDir(target) {
    const key = String(target && target.fakePath !== undefined ? target.fakePath : target);
    listDirCalls += 1;
    if (key === BROWSE_ROOT) return SEAM_ENTRIES;
    if (key === os.homedir()) return [];
    if (SEC_TREE[key] !== undefined) return SEC_TREE[key];
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
assert(Array.isArray(contribution.invocations) && contribution.invocations.length === 9, 'nine remote endpoints');
const methods = contribution.invocations.map((d) => d.method).sort().join(',');
assert(methods === 'add,browse,list,listFiles,makeDir,pick,remove,reveal,set', 'endpoint method roster');
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
const listFilesParams = contribution.invocations.find((d) => d.method === 'listFiles').parameters.map((p) => p.wire);
assert(listFilesParams.join(',') === 'workspace,query', 'listFiles wire shape');
const pickParams = contribution.invocations.find((d) => d.method === 'pick').parameters.map((p) => p.wire);
assert(pickParams.join(',') === 'cwd', 'pick wire shape');
const revealParams = contribution.invocations.find((d) => d.method === 'reveal').parameters.map((p) => p.wire);
assert(revealParams.join(',') === 'path', 'reveal wire shape');

const api = provided.get('multiFolder');
assert(api !== undefined, 'multiFolder service provided');
assert(api.typertRemote && api.typertRemote.service === api, 'typertRemote binding points at the service');
assert(api.typertRemote.serviceKey === 'multiFolder' && api.typertRemote.namespace === 'multiFolder', 'typertRemote binding fields');

// Remote flows: list (empty) -> add -> idempotent add -> set -> remove.
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

// ------------------------------------------------- @ discovery for secondaries
// The shipped `@` file-reference menu is single-root (session cwd only), so
// secondary directories need this plugin's own discovery endpoint. It rides
// the fs seam, never touches the configuration store, and mirrors the shipped
// provider's rules: generated/vendor basenames excluded, hidden entries
// reachable only when asked for explicitly, candidates bounded.
const storeBeforeFiles = fileStore.size;
const configured = await api.set(ws, [SEC, SEC2]);
assert(configured.dirs.length === 2, 'two secondary directories configured');

// An empty query offers the directories themselves — the menu's entry points.
const entryPoints = await api.listFiles(ws, '');
assert(entryPoints.workspace === ws && entryPoints.dirs.length === 2, 'listFiles echoes workspace + dirs');
assert(entryPoints.candidates.length === 2, 'empty query yields the configured directories');
assert(entryPoints.candidates.every((c) => c.kind === 'directory' && c.rel === ''), 'entry points are the directories themselves');
assert(entryPoints.candidates[0].dir === SEC && entryPoints.candidates[1].dir === SEC2, 'entry points keep configuration order');
assert(entryPoints.candidates[0].path === 'C:/workspaces/secondary', 'mention path is forward-slashed: ' + entryPoints.candidates[0].path);

// A bare fragment fuzzy-ranks across every configured directory; the first such
// query builds the index, and the next one inside the TTL reuses it.
listDirCalls = 0;
const probe = await api.listFiles(ws, 'probe');
assert(listDirCalls > 0, 'the first bare query traverses the configured directories');
assert(probe.candidates.length === 1 && probe.candidates[0].rel === 'probe.txt' && probe.candidates[0].dir === SEC2, 'bare fragment matches by file name');
assert(probe.candidates[0].path === 'C:/workspaces/secondary-2/probe.txt', 'candidate path joins dir + rel');
listDirCalls = 0;
await api.listFiles(ws, 'probe');
assert(listDirCalls === 0, 'a later query inside the TTL reuses the cached index');
assert(probe.truncated === false, 'listFiles reports its truncation state');

// The configured directory's own basename is searchable at the lowest rank.
const narrowed = await api.listFiles(ws, 'secondary-2');
assert(narrowed.candidates.length === 1 && narrowed.candidates[0].dir === SEC2, 'directory basename narrows the search');

// Generated/vendor basenames are never indexed; hidden entries are not offered
// for a global query (both mirror the shipped provider).
const vendored = await api.listFiles(ws, 'index');
assert(vendored.candidates.length === 0, 'node_modules is excluded from the index');
const hiddenQuery = await api.listFiles(ws, 'secret');
assert(hiddenQuery.candidates.length === 0, 'hidden entries are invisible to a global query');

// A query carrying a separator lists that level instead of ranking it.
const byBasename = await api.listFiles(ws, 'secondary/src/');
assert(byBasename.candidates.length === 2, 'a basename-spelled level lists its children');
assert(byBasename.candidates.map((c) => c.rel).join(',') === 'src/deep,src/main.ts', 'directories rank first, then names: ' + JSON.stringify(byBasename.candidates));
assert(byBasename.candidates[0].kind === 'directory' && byBasename.candidates[1].kind === 'file', 'level listing keeps file kinds');

// A drill inserts an absolute mention, so the absolute spelling must resolve to
// exactly the same level.
const byAbsolute = await api.listFiles(ws, 'C:/workspaces/secondary/src/');
assert(
  JSON.stringify(byAbsolute.candidates) === JSON.stringify(byBasename.candidates),
  'absolute and basename spellings list the same level',
);
const deepLevel = await api.listFiles(ws, 'secondary/src/deep/');
assert(deepLevel.candidates.length === 1 && deepLevel.candidates[0].rel === 'src/deep/util.ts', 'recursion reaches nested levels');
const fragment = await api.listFiles(ws, 'secondary/src/ma');
assert(fragment.candidates.length === 1 && fragment.candidates[0].rel === 'src/main.ts', 'a fragment filters the listed level');

// Hidden levels stay reachable when they are asked for by name.
const hiddenLevel = await api.listFiles(ws, 'C:/workspaces/secondary/.hidden/');
assert(hiddenLevel.candidates.length === 1 && hiddenLevel.candidates[0].rel === '.hidden/secret.txt', 'an explicitly named hidden level lists');

// A path outside every configured directory resolves to nothing at all.
const outside = await api.listFiles(ws, 'C:/elsewhere/');
assert(outside.candidates.length === 0, 'a level outside every configured directory yields nothing');

// A level query may not climb out of the configured set, in either spelling:
// the owner field would otherwise lie about where the candidates came from.
for (const escape of ['secondary/../../elsewhere/', 'C:/workspaces/secondary/../secondary-2/', 'C:/workspaces/secondary/src/../../']) {
  const climbed = await api.listFiles(ws, escape);
  assert(climbed.candidates.length === 0, 'a climbing level query is refused: ' + escape);
}
// Normalizing (not rejecting) is what handles a doubled separator.
const doubled = await api.listFiles(ws, 'secondary//src/');
assert(doubled.candidates.length === 2 && doubled.candidates[1].rel === 'src/main.ts', 'redundant separators normalize');

await api.listFiles(undefined).then(
  () => { throw new Error('FAIL: listFiles should require a workspace'); },
  (e) => { assert(String(e.message).startsWith('multi-folder: workspace is required'), 'listFiles workspace fence: ' + String(e.message)); },
);

// --------------------------------------------------- system folder picker
// `pick` asks the host's OWN native picker first, and only reaches for an OS
// dialog when that cannot answer. The fallback path is exercised with the
// platform reported as one the helper does not support, so that a test run can
// never open a real window on a developer's machine; if a future Node makes
// `process.platform` read-only, this fails loudly instead of doing so.
const realGet = mockCtx.get;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
if (platformDescriptor === undefined || platformDescriptor.configurable === false) {
  throw new Error('FAIL: process.platform is not configurable, so the OS-dialog fallback cannot be exercised safely');
}
const asUnsupportedPlatform = (body) => {
  Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
  return Promise.resolve().then(body).finally(() => {
    Object.defineProperty(process, 'platform', { value: platformDescriptor.value, configurable: true });
  });
};

// A native composition answers, and is the ONLY thing asked.
mockCtx.get = (n) => (n === 'directoryPicker'
  ? { capability: () => ({ kind: 'native', pick: async () => 'D:\\picked\\by\\host' }) }
  : undefined);
const pickedNative = await api.pick(ws);
assert(pickedNative.via === 'host-native' && pickedNative.path === 'D:\\picked\\by\\host', 'a native composition answers the pick');

// The shipped Windows chooser worker has been observed to exit mid-call: that
// failure must be swallowed and the next attempt made, never propagated.
mockCtx.get = (n) => (n === 'directoryPicker'
  ? { capability: () => ({ kind: 'native', pick: async () => { throw new Error('directory picker failed: worker exited'); } }) }
  : undefined);
const afterCrash = await asUnsupportedPlatform(() => api.pick(ws));
assert(afterCrash.via === 'unavailable' && afterCrash.path === null, 'a crashing native picker degrades instead of throwing');

// A browse-only composition is NOT asked at all: it would answer
// `directory-picker/unavailable`, and asking costs a round trip.
let browseAsked = 0;
mockCtx.get = (n) => (n === 'directoryPicker'
  ? { capability: () => ({ kind: 'browse', list: async () => { browseAsked += 1; return {}; } }) }
  : undefined);
const noPicker = await asUnsupportedPlatform(() => api.pick());
assert(browseAsked === 0 && noPicker.via === 'unavailable', 'a browse-only composition is never asked');

// An absent service is not an error either, and the start directory is optional.
mockCtx.get = realGet;
const absent = await asUnsupportedPlatform(() => api.pick());
assert(absent.via === 'unavailable' && absent.path === null, 'an absent picker service degrades quietly');

// `reveal` validates its argument before spawning anything, so a bad call can
// never open a file manager.
await api.reveal('relative\\path').then(
  () => { throw new Error('FAIL: reveal should refuse a relative path'); },
  (e) => { assert(/reveal requires a fully qualified path/.test(String(e.message)), 'reveal fence: ' + String(e.message)); },
);

// Clearing the configuration withdraws the whole discovery surface.
await api.set(ws, []);
const noneLeft = await api.listFiles(ws, 'probe');
assert(noneLeft.dirs.length === 0 && noneLeft.candidates.length === 0, 'no configured directories means no candidates');
assert(fileStore.size === storeBeforeFiles, 'listFiles never writes the configuration store');

console.log('smoke-host: all assertions passed');
