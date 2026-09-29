/**
 * Host-half behavior test: exercise the REAL plugin module's interception,
 * command handling, prompt section, and both notice channels against mock
 * services. Run: node test/intercept.mjs
 */
import { apply } from '../lib/index.js';
import { join } from 'node:path';
import os from 'node:os';

const WS = 'C:\\workspaces\\primary';
const SEC = 'C:\\workspaces\\secondary';
const SEC2 = 'C:\\workspaces\\secondary-2';
const CFG_DIR = join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'storages', 'multi-folder');
const CFG_NAME = WS.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json';
const CFG_PATH = join(CFG_DIR, CFG_NAME);

const listeners = new Map();
const sections = [];
const emitted = [];
const savedConfigs = [];
const writes = [];
const edits = [];
const shellRuns = [];
const shellStarts = [];
/** Specs handed to the post-0.1.7 `execute()` seam (foreground AND background). */
const shellExecutes = [];
const jobStarts = [];
let startedHooks = null;
let jobsAvailable = true;
let fakeProc = null;
let commandDef = null;

const session = { id: 's1', header: { cwd: WS } };
const agent = { session };

const normalize = (p) => {
  const parts = String(p).replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(part);
    }
  }
  const joined = out.join('/');
  if (/^[A-Za-z]:/.test(joined)) return joined.replace(/\//g, '\\');
  return joined.replace(/^\/+/, '');
};

const configStore = new Map();
const configKey = (target) => String(target.processPath ?? target.displayPath).replace(/\\/g, '/').toLowerCase();

// Injected mutation failures for the ownership tests (section 17): a thrown
// value here stands in for any real provider refusal — a missing `old_string`,
// a locked target, a stale version, a genuine sandbox denial.
let editFailure = null;
let writeFailure = null;

// Launch-preparation controls for the background tests (section 10b): the real
// `shell.start` is async and rejects when preparation is cancelled or fails.
let startGate = null;
let startFailure = null;

const fsMock = {
  async resolve(path, opts) {
    const key = normalize(path);
    const isRel = !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/');
    const full = opts && opts.cwd && isRel ? normalize(opts.cwd + '/' + path) : key;
    return { displayPath: path, targetKey: full, processPath: full };
  },
  processPath(target) {
    return target.processPath;
  },
  async readText(target) {
    const key = configKey(target);
    const entry = configStore.get(key);
    if (entry !== undefined) return JSON.stringify(entry);
    throw new Error('no such file');
  },
  async writeText(target, content, expected, signal, policy) {
    writes.push({ path: String(target.processPath ?? target.displayPath), content, policy });
    if (writeFailure !== null) throw writeFailure;
    if (String(target.processPath ?? target.displayPath).replace(/\\/g, '/').includes('storages/multi-folder/')) {
      configStore.set(configKey(target), JSON.parse(content));
    }
    return { operation: 'create', version: 'v1', before: null, after: content };
  },
  async editText(target, edit, expected, signal, policy) {
    edits.push({ path: String(target.processPath ?? target.displayPath), edit, policy });
    if (editFailure !== null) throw editFailure;
    return { before: edit.oldString, after: edit.newString };
  },
};

const makeCtx = (listenersMap, overrides = {}, shellApi = 'legacy') => ({
  fs: fsMock,
  sandboxPolicy: {
    resolve(request) {
      const sid = request && request.session ? String(request.session.id) : undefined;
      return { mode: 'workspace-write', workspaceRoot: WS, ...(sid ? { sessionId: sid } : {}) };
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section);
      return () => {};
    },
  },
  emit(event, ...args) {
    emitted.push({ event, args });
  },
  get(name) {
    if (name === 'shell') {
      const resolve = (request) => ({ request });
      /** The canonical foreground projection both seams answer with. */
      const foregroundResult = () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1000,
        stdout: { text: 'ok\r\n', truncated: false },
        stderr: { text: '', truncated: false },
        sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
      });
      // The REAL contract (DSH >= 0.1.6-alpha.1) is async: the launch resolves
      // the process handle only after launch preparation (Windows ACL grants
      // included) and rejects when preparation is cancelled or fails. A
      // synchronous mock here is exactly what let the regression through —
      // `proc.done` off the returned promise threw
      // `Cannot read properties of undefined (reading 'then')`, so NO
      // background run inside a secondary directory could start at all.
      const launch = async () => {
        if (startGate !== null) await startGate;
        if (startFailure !== null) throw startFailure;
        return fakeProc;
      };
      /** The retired 0.1.6 launch entry point (records the legacy seam's use). */
      const start = (spec) => {
        shellStarts.push(spec);
        return launch();
      };
      const run = async (spec) => {
        shellRuns.push(spec.request);
        return foregroundResult();
      };
      const legacy = { resolve, run, start };
      if (shellApi === 'legacy') return legacy;
      // DSH >= 0.1.7-alpha.1: `run` and `start` are GONE; one `execute()`
      // returns a `ShellExecution` — the process handle plus the foreground
      // projection `result()`. The background arm is recognised by
      // `onExpiry: 'none'`, the only thing that tells the executor to arm no
      // deadline; a mock that still carried `run` would silently route the
      // whole call down the legacy branch instead.
      const execute = async (spec) => {
        shellExecutes.push(spec);
        if (spec.request.onExpiry === 'none') return launch();
        return { result: async () => foregroundResult() };
      };
      // `both` stands in for a hypothetical release that keeps the retired
      // methods alongside `execute()`: the probe must prefer the modern seam.
      return shellApi === 'both' ? { resolve, run, start, execute } : { resolve, execute };
    }
    if (name === 'shellEnv') {
      return { collect() { return { DSH_TEST: '1' }; } };
    }
    if (name === 'jobs') {
      if (!jobsAvailable) return undefined;
      return {
        start(spec) {
          jobStarts.push(spec);
          startedHooks = spec.run();
          return spec.kind + '-' + jobStarts.length;
        },
      };
    }
    return undefined;
  },
  provide(name, value) {
    // The sessionless `multiFolder` service; exercised by smoke-host.mjs.
    return () => {};
  },
  inject(names, callback) {
    if (names.includes('commands')) {
      return callback({
        commands: {
          register(def) {
            commandDef = def;
            return () => {};
          },
        },
      });
    }
    if (names.includes('typert')) {
      return callback({
        typert: {
          register() {
            return () => {};
          },
        },
      });
    }
    return () => {};
  },
  on(event, fn) {
    const list = listenersMap.get(event) ?? [];
    list.push(fn);
    listenersMap.set(event, list);
    return () => {};
  },
  ...overrides,
});

const ctx = makeCtx(listeners);

apply(ctx);

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
};
const nextPassthrough = async () => 'PASSTHROUGH';
const enterWith = (messages) => async () => ({ kind: 'enter', messages });

// 1. Prompt section: empty before config, populated after.
assert(sections.length === 1, 'section registered');
const sectionText = sections[0].text;
assert(sectionText({}) === '', 'empty without agent context');
assert(sectionText({ agent }) === '', 'empty without configured dirs');

// 2. Command: set config + arm notice.
const commandHandler = commandDef && commandDef.handler;
assert(commandHandler, 'command registered');
const setResult = await commandHandler({
  commandId: 'c1',
  agent,
  rawInput: 'set "' + SEC + '"',
  signal: undefined,
});
assert(setResult.kind === 'success', 'set succeeds: ' + JSON.stringify(setResult));
assert(setResult.text.includes(SEC), 'set result lists dir');
assert(setResult.text.includes('[MF:JSON]'), 'set result carries JSON line');
assert(writes.length === 1, 'config saved once');
assert(writes[0].path.replace(/\\/g, '/').endsWith(CFG_NAME.replace(/\\/g, '/')), 'config path host-owned');
assert(writes[0].path.includes(CFG_NAME), 'config file named by workspace key');
assert(writes[0].policy.mode === 'workspace-write' && writes[0].policy.workspaceRoot.replace(/\\/g, '/').endsWith('storages/multi-folder'), 'config policy rooted at config dir');

// 3. Prompt section now renders the dir.
const text = sectionText({ agent });
assert(text.includes(SEC), 'section lists secondary dir');
assert(text.includes('only ONE root'), 'section warns about the single writable root');
assert(text.includes('git -C'), 'section warns against git -C from the primary workspace');
assert(text.includes('MUST set `workdir`'), 'section requires workdir for file-creating commands');
// The two reported workarounds: a RELATIVE workdir resolves against the primary
// workspace (never a secondary dir), and changing the process directory inside
// the command does not widen the writable root.
assert(text.includes('ABSOLUTE path'), 'section requires an absolute workdir');
assert(text.includes('relative `workdir` is resolved against the PRIMARY workspace'), 'section explains relative-workdir resolution');
assert(text.includes('does NOT widen the writable root'), 'section explains in-command cd cannot widen the root');
assert(text.includes('error 5'), 'section names the Windows denial symptom');

// 4. Pre-step channel: notice prepended at the next step boundary.
const preStep = listeners.get('agent/pre-step')[0];
const preStepOut = await preStep(
  { agent, messages: [], turn: 1, step: 1, signal: undefined },
  enterWith([{ id: 'm1', role: 'user' }]),
);
assert(preStepOut.kind === 'enter', 'pre-step enter');
assert(preStepOut.messages.length === 2, 'notice prepended');
// Session format v4 admits only PRODUCER-OWNED source kinds: the retired
// catch-all `{ kind: 'plugin', plugin }` wrapper makes the durable log's
// encoder throw `format v4 message requires a producer-owned source kind`,
// which fails the run when the notice is appended. A plugin's canonical
// spelling is the namespaced kind the v3→v4 migration itself produces.
assert(
  preStepOut.messages[0].source.kind === 'plugin:dsh-multi-folder'
    && preStepOut.messages[0].source.form === 'notice',
  'notice source shape: ' + JSON.stringify(preStepOut.messages[0].source),
);
assert(preStepOut.messages[0].source.kind !== 'plugin', 'notice refuses the retired plugin wrapper');
assert(
  !Object.prototype.hasOwnProperty.call(preStepOut.messages[0].source, 'plugin'),
  'notice carries no legacy plugin field',
);
assert(
  typeof preStepOut.messages[0].source.summary === 'string' && preStepOut.messages[0].source.summary.length > 0,
  'notice declares the one-line summary its form requires',
);
assert(preStepOut.messages[1].id === 'm1', 'original message preserved');

// 5. Post-execute channel: additionalContexts attached at a tool-call boundary
//    — and ONLY when the directory set actually changed.
await commandHandler({ commandId: 'c2', agent, rawInput: 'add "' + SEC2 + '"', signal: undefined });
const postExec = listeners.get('tools/post-execute')[0];
const postOut = await postExec(
  { name: 'read', arguments: {}, agent, signal: undefined },
  { isError: false },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'x' }] }),
);
assert(postOut.kind === 'accept', 'post-execute accept');
assert(Array.isArray(postOut.additionalContexts) && postOut.additionalContexts.length === 1, 'notice attached as additionalContexts');
assert(
  postOut.additionalContexts[0].source.kind === 'plugin:dsh-multi-folder'
    && postOut.additionalContexts[0].source.form === 'notice',
  'additionalContexts notice carries the producer-owned source kind',
);

// 5b. Unchanged add arms nothing: next post-execute carries no additional context.
await commandHandler({ commandId: 'c3', agent, rawInput: 'add "' + SEC2 + '"', signal: undefined });
const postNoChange = await postExec(
  { name: 'read', arguments: {}, agent, signal: undefined },
  { isError: false },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'y' }] }),
);
assert(!postNoChange.additionalContexts || postNoChange.additionalContexts.length === 0, 'no notice without change');

// 5c. Failure diagnosis: an OS-level permission denial on a command that
//     references a secondary dir while confined to the primary workspace gets
//     a workdir-fix hint attached (the reported git case: `git -C <secondary>
//     commit` -> index.lock Permission denied).
const denFail = await postExec(
  { name: 'pwsh', arguments: { command: 'git -C "' + SEC + '" commit -m x', workdir: WS }, agent, signal: undefined },
  {
    isError: false,
    value: { kind: 'foreground', exitCode: 128, stdout: { text: '' }, stderr: { text: "fatal: Unable to create '" + SEC + "\\.git\\index.lock': Permission denied" } },
    content: [{ type: 'text', text: "fatal: Unable to create '" + SEC + "\\.git\\index.lock': Permission denied\n[exit code: 128]" }],
  },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'x' }] }),
);
assert(Array.isArray(denFail.additionalContexts) && denFail.additionalContexts.length === 1, 'denial hint attached');
assert(denFail.additionalContexts[0].content[0].text.includes('workdir'), 'hint names the workdir fix');
assert(denFail.additionalContexts[0].content[0].text.includes(SEC), 'hint names the referenced directory');

// 5d. No hint on success, and none without a secondary-dir reference.
const noDenial = await postExec(
  { name: 'pwsh', arguments: { command: 'git -C "' + SEC + '" status', workdir: WS }, agent, signal: undefined },
  { isError: false, value: { exitCode: 0, stdout: { text: 'clean' }, stderr: { text: '' } }, content: [{ type: 'text', text: 'clean' }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'x' }] }),
);
assert(!noDenial.additionalContexts || noDenial.additionalContexts.length === 0, 'no hint on success');

const noRef = await postExec(
  { name: 'pwsh', arguments: { command: 'git commit -m x', workdir: WS }, agent, signal: undefined },
  { isError: false, value: { exitCode: 128, stdout: { text: '' }, stderr: { text: 'fatal: Permission denied' } }, content: [{ type: 'text', text: 'fatal: Permission denied' }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'x' }] }),
);
assert(!noRef.additionalContexts || noRef.additionalContexts.length === 0, 'no hint without secondary reference');

// 5e. Re-rooted runs (workdir inside a secondary dir) that deny a write
//     OUTSIDE that directory get the symmetric hint.
const revDenial = await postExec(
  { name: 'pwsh', arguments: { command: 'Set-Content "' + WS + '\\a.txt" x', workdir: SEC }, agent, signal: undefined },
  { isError: false, value: { exitCode: 1, stdout: { text: '' }, stderr: { text: "Access to the path '" + WS + "\\a.txt' is denied." } }, content: [{ type: 'text', text: "Access to the path '" + WS + "\\a.txt' is denied." }] },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'x' }] }),
);
assert(Array.isArray(revDenial.additionalContexts) && revDenial.additionalContexts.length === 1, 're-rooted denial hint attached');
assert(revDenial.additionalContexts[0].content[0].text.includes('OUTSIDE'), 're-rooted hint explains the outside-root denial');

// 6. write interception: short-circuit with the re-rooted policy.
const execWrite = listeners.get('tools/execute')[0];
const writeOut = await execWrite(
  {
    name: 'write',
    arguments: { file_path: SEC + '\\a.txt', content: 'hi' },
    agent,
    signal: undefined,
  },
  nextPassthrough,
);
assert(writeOut !== 'PASSTHROUGH', 'write intercepted');
assert(writeOut.isError === false, 'write success');
assert(writeOut.value.operation === 'create', 'write value shape');
assert(writeOut.content[0].text.includes('Created file'), 'write content envelope');
assert(writes[2].policy.workspaceRoot === SEC, 'write policy re-rooted to secondary');
assert(writes[2].policy.mode === 'workspace-write', 'write policy keeps session mode');

// 7. write outside secondary -> passthrough.
const outside = await execWrite(
  { name: 'write', arguments: { file_path: 'C:\\Windows\\Temp\\x.txt', content: 'x' }, agent, signal: undefined },
  nextPassthrough,
);
assert(outside === 'PASSTHROUGH', 'outside path passes through');

// 7b. relative `..` path canonicalizes into the secondary dir -> intercepted.
const dotdot = await execWrite(
  { name: 'write', arguments: { file_path: '..\\secondary\\b.txt', content: 'y' }, agent, signal: undefined },
  nextPassthrough,
);
assert(dotdot !== 'PASSTHROUGH' && dotdot.isError === false, 'dot-dot path intercepted');
assert(writes[3].policy.workspaceRoot === SEC, 'dot-dot write policy re-rooted to secondary');

// 8. edit interception.
const editOut = await execWrite(
  {
    name: 'edit',
    arguments: { file_path: SEC + '\\a.txt', old_string: 'hi', new_string: 'bye' },
    agent,
    signal: undefined,
  },
  nextPassthrough,
);
assert(editOut !== 'PASSTHROUGH' && editOut.isError === false, 'edit intercepted');
assert(edits.length === 1 && edits[0].policy.workspaceRoot === SEC, 'edit policy re-rooted');
assert(editOut.content[0].text.includes('updated successfully'), 'edit content');

// 9. pwsh interception with workdir inside the secondary dir.
const pwshOut = await execWrite(
  {
    name: 'pwsh',
    arguments: { command: 'echo x', workdir: SEC, timeoutMs: 5000 },
    agent,
    signal: undefined,
  },
  nextPassthrough,
);
assert(pwshOut !== 'PASSTHROUGH' && pwshOut.isError === false, 'pwsh intercepted');
assert(shellRuns.length === 1, 'shell ran once');
assert(shellRuns[0].sandboxPolicy.workspaceRoot === SEC, 'shell policy re-rooted');
assert(shellRuns[0].workdir === SEC, 'shell workdir');
assert(shellRuns[0].dshEnv && shellRuns[0].dshEnv.DSH_TEST === '1', 'dshEnv collected');
assert(pwshOut.value.kind === 'foreground' && pwshOut.value.exitCode === 0, 'pwsh value shape');
assert(pwshOut.content[0].text.includes('ok'), 'pwsh content stdout');

// 10. pwsh with primary workdir -> passthrough.
const pwshPrimary = await execWrite(
  { name: 'pwsh', arguments: { command: 'echo x', workdir: WS }, agent, signal: undefined },
  nextPassthrough,
);
assert(pwshPrimary === 'PASSTHROUGH', 'primary workdir passes through');

// 10a. background pwsh with workdir inside the secondary dir -> intercepted,
//      registered with the jobs runtime under the SAME re-rooted policy.
fakeProc = {
  status: 'completed',
  exitCode: 0,
  signal: null,
  done: Promise.resolve(),
  sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
  readOutput() { return { delta: 'bg ok\r\n', lossy: false }; },
  kill() { return true; },
};
const bgPwsh = await execWrite(
  { name: 'pwsh', arguments: { command: 'echo bg', workdir: SEC, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(bgPwsh !== 'PASSTHROUGH' && bgPwsh.isError === false, 'background pwsh intercepted');
assert(shellRuns.length === 1, 'background does not use shell.run');
assert(shellStarts.length === 1 && shellStarts[0].request.sandboxPolicy.workspaceRoot === SEC, 'background policy re-rooted');
assert(shellStarts[0].request.workdir === SEC, 'background workdir canonical');
assert(shellStarts[0].request.dshEnv && shellStarts[0].request.dshEnv.DSH_TEST === '1', 'background dshEnv collected');
assert(jobStarts.length === 1 && jobStarts[0].kind === 'pwsh' && jobStarts[0].label === 'echo bg', 'job identity');
assert(jobStarts[0].owner === agent, 'job owner is the calling agent');
assert(bgPwsh.value.kind === 'background' && bgPwsh.value.jobId === 'pwsh-1', 'background value shape');
assert(bgPwsh.content[0].text === 'started background job pwsh-1', 'background content text');

// hooks: terminal outcome + clean streamed read.
assert(startedHooks && typeof startedHooks.cancel === 'function' && typeof startedHooks.readOutput === 'function', 'job hooks shape');
const bgOutcome = await startedHooks.done;
assert(bgOutcome.status === 'completed' && bgOutcome.detail === 'exit code: 0', 'job outcome completed');
assert(startedHooks.readOutput() === 'bg ok\r\n', 'clean read passes through');

// sandbox-denial markers surface on streamed reads.
fakeProc = {
  ...fakeProc,
  sandbox: { mode: 'workspace-write', denied: true, enforcement: 'partial' },
  readOutput() { return { delta: 'x\r\n', lossy: false }; },
};
const bgDenied = await execWrite(
  { name: 'pwsh', arguments: { command: 'echo d', workdir: SEC, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(bgDenied !== 'PASSTHROUGH' && bgDenied.value.jobId === 'pwsh-2', 'denied background still intercepted');
assert(startedHooks.readOutput() === 'x\r\n[sandbox: file access denied under workspace-write mode]', 'denial marker on read');

// lossy reads carry the spill notice; killed processes settle as killed.
fakeProc = {
  ...fakeProc,
  sandbox: undefined,
  readOutput() { return { delta: 'y', lossy: true, stdoutSpillPath: 'C:\\spill\\out.txt' }; },
};
await execWrite(
  { name: 'pwsh', arguments: { command: 'echo l', workdir: SEC, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(startedHooks.readOutput() === 'y\n[some output was dropped from memory; full output: C:\\spill\\out.txt]', 'lossy read notice');
fakeProc = {
  ...fakeProc,
  status: 'killed',
  exitCode: null,
  signal: 'SIGTERM',
  done: Promise.resolve(),
  sandbox: undefined,
  readOutput() { return { delta: '', lossy: false }; },
};
await execWrite(
  { name: 'pwsh', arguments: { command: 'echo k', workdir: SEC, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
const killedOutcome = await startedHooks.done;
assert(killedOutcome.status === 'killed' && killedOutcome.detail === 'signal: SIGTERM', 'killed outcome carries signal');

// relative background workdir canonicalizes before matching (bash path too).
fakeProc = { ...fakeProc, status: 'completed', exitCode: 0, signal: null, done: Promise.resolve() };
const bgRel = await execWrite(
  { name: 'bash', arguments: { command: 'echo rel', workdir: '..\\secondary', run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(bgRel !== 'PASSTHROUGH' && bgRel.value.jobId === 'bash-5', 'relative background workdir intercepted');
assert(shellStarts[shellStarts.length - 1].request.workdir === SEC, 'relative background workdir canonicalized');

// background with primary workdir -> passthrough.
const bgPrimary = await execWrite(
  { name: 'pwsh', arguments: { command: 'echo x', workdir: WS, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(bgPrimary === 'PASSTHROUGH', 'background primary workdir passes through');

// background without the jobs service -> passthrough (default pipeline owns it).
jobsAvailable = false;
const bgNoJobs = await execWrite(
  { name: 'pwsh', arguments: { command: 'echo x', workdir: SEC, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(bgNoJobs === 'PASSTHROUGH', 'background without jobs service passes through');
jobsAvailable = true;

// 10b. Background LAUNCH is asynchronous and cancellable at preparation time.
//      The regression this guards: `shell.start` became async in DSH
//      0.1.6-alpha.1 (it resolves the handle only after launch preparation,
//      Windows ACL grants included), so reading `proc.done` off the un-awaited
//      promise threw `Cannot read properties of undefined (reading 'then')` and
//      every background run in a secondary directory failed before starting.
//      A launch that never publishes a handle must also be cancellable, and a
//      message read before publication must be empty rather than a throw.
let releaseStart = null;
startGate = new Promise((resolve) => { releaseStart = resolve; });
fakeProc = {
  status: 'running',
  exitCode: 0,
  signal: null,
  done: Promise.resolve(),
  sandbox: undefined,
  readOutput() { return { delta: 'late\r\n', lossy: false }; },
  kill() { this.status = 'killed'; this.signal = 'SIGTERM'; return true; },
};
const bgPending = await execWrite(
  { name: 'pwsh', arguments: { command: 'echo slow', workdir: SEC, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(bgPending !== 'PASSTHROUGH' && bgPending.isError === false, 'unpublished launch stays intercepted');
const pendingSpec = shellStarts[shellStarts.length - 1];
assert(pendingSpec.request.signal !== undefined && pendingSpec.request.signal !== null, 'job-owned signal reaches shell.start');
assert(pendingSpec.request.signal.aborted === false, 'preparation signal live before cancel');
assert(startedHooks.readOutput() === '', 'no output before the handle is published');
startedHooks.cancel('stop');
assert(pendingSpec.request.signal.aborted === true, 'cancel aborts in-flight preparation');
releaseStart();
startGate = null;
const pendingOutcome = await startedHooks.done;
assert(pendingOutcome.status === 'killed', 'cancel during preparation settles the job as killed: ' + JSON.stringify(pendingOutcome));
assert(pendingOutcome.detail === 'signal: SIGTERM', 'killed outcome carries the process signal');

// A rejected preparation (runner failed, ACL grant refused, launch abort) must
// settle the job as `failed` with the real cause — never leave it running.
startFailure = new Error('the sandbox runner failed to apply the write grant');
const bgFailed = await execWrite(
  { name: 'pwsh', arguments: { command: 'echo f', workdir: SEC, run_in_background: true }, agent, signal: undefined },
  nextPassthrough,
);
assert(bgFailed !== 'PASSTHROUGH' && bgFailed.isError === false, 'failed launch still intercepted');
const failedOutcome = await startedHooks.done;
assert(failedOutcome.status === 'failed', 'preparation failure settles the job as failed: ' + JSON.stringify(failedOutcome));
assert(failedOutcome.detail === 'the sandbox runner failed to apply the write grant', 'failure detail carries the real cause');
startFailure = null;
fakeProc = {
  status: 'completed',
  exitCode: 0,
  signal: null,
  done: Promise.resolve(),
  sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
  readOutput() { return { delta: '', lossy: false }; },
  kill() { return true; },
};

// 11. Escalation args -> passthrough (default pipeline owns escalation).
const escalated = await execWrite(
  {
    name: 'write',
    arguments: { file_path: SEC + '\\a.txt', content: 'x', sandbox_permissions: 'danger-full-access', justification: 't' },
    agent,
    signal: undefined,
  },
  nextPassthrough,
);
assert(escalated === 'PASSTHROUGH', 'escalation passes through');

// 12. list command + remove.
const listResult = await commandHandler({ commandId: 'c3', agent, rawInput: 'list', signal: undefined });
assert(listResult.kind === 'success' && listResult.text.includes(SEC), 'list works');
const removeResult = await commandHandler({ commandId: 'c4', agent, rawInput: 'remove "' + SEC + '"', signal: undefined });
assert(removeResult.kind === 'success', 'remove works');
const afterRemove = sectionText({ agent });
assert(!afterRemove.split('\n').some((l) => l === '- ' + SEC), 'section drops removed dir');
assert(afterRemove.split('\n').some((l) => l === '- ' + SEC2), 'section keeps remaining dir');

// 13. Security boundary: direct write/edit against the config location is rejected.
const guardNew = await execWrite(
  {
    name: 'write',
    arguments: { file_path: CFG_PATH, content: 'x' },
    agent,
    signal: undefined,
  },
  nextPassthrough,
);
assert(guardNew !== 'PASSTHROUGH' && guardNew.isError === true, 'host-owned config write rejected');
assert(guardNew.content[0].text.includes('managed by the dsh-multi-folder plugin'), 'guard message text');

const guardEdit = await execWrite(
  {
    name: 'edit',
    arguments: { file_path: CFG_PATH, old_string: 'a', new_string: 'b' },
    agent,
    signal: undefined,
  },
  nextPassthrough,
);
assert(guardEdit !== 'PASSTHROUGH' && guardEdit.isError === true, 'host-owned config edit rejected');

// 14. Cold-cache regression: with a FRESH context (no prior command, no cached
//     config), the FIRST edit -- or write -- that lands in a secondary
//     directory is still intercepted and re-rooted. The interception awaits
//     hydration; a fire-and-forget read would make this first call see an
//     empty cache, fall through to the default pipeline, and be fenced
//     against the PRIMARY workspace root -- surfacing as the spurious
//     `[sandbox: file access denied under workspace-write mode]` this test
//     guards against.
const listenersC = new Map();
const ctxC = makeCtx(listenersC);
apply(ctxC);
const execCold = listenersC.get('tools/execute')[0];
// By this point the shared config for WS holds only SEC2 (SEC was removed by
// the command tests above); a fresh context must hydrate it and intercept the
// very first secondary-dir mutation.
const coldEdit = await execCold(
  { name: 'edit', arguments: { file_path: SEC2 + '\\cold.txt', old_string: 'x', new_string: 'y' }, agent, signal: undefined },
  nextPassthrough,
);
assert(coldEdit !== 'PASSTHROUGH' && coldEdit.isError === false, 'cold-first edit intercepted');
assert(edits[edits.length - 1].policy.workspaceRoot === SEC2, 'cold-first edit policy re-rooted to secondary');
const coldWrite = await execCold(
  { name: 'write', arguments: { file_path: SEC2 + '\\cold-w.txt', content: 'c' }, agent, signal: undefined },
  nextPassthrough,
);
assert(coldWrite !== 'PASSTHROUGH' && coldWrite.isError === false, 'cold-first write intercepted');
assert(writes[writes.length - 1].policy.workspaceRoot === SEC2, 'cold-first write policy re-rooted to secondary');

// 15. Key-desync regression: the session header cwd may be an as-spelled
//     variant (e.g. `C:\ws\primary`) while the resolved policy workspaceRoot
//     is its canonical spelling (`C:\real\primary` -- how a symlinked or
//     junctioned workspace appears to sandbox-policy). Hydration is keyed by
//     the header spelling; the interception must consult BOTH keys before
//     falling through, or every secondary-dir mutation would be fenced
//     against the canonical primary root and denied.
const WS_B = 'C:\\ws\\primary';
const REAL_B = 'C:\\real\\primary';
const agentB = { session: { id: 'sB', header: { cwd: WS_B } } };
const listenersB = new Map();
const ctxB = makeCtx(listenersB, {
  sandboxPolicy: {
    resolve(request) {
      const sid = request && request.session ? String(request.session.id) : undefined;
      return { mode: 'workspace-write', workspaceRoot: REAL_B, ...(sid ? { sessionId: sid } : {}) };
    },
  },
});
apply(ctxB);
const commandHandlerB = commandDef && commandDef.handler;
assert(commandHandlerB, 'desync command registered');
const setB = await commandHandlerB({ commandId: 'cb1', agent: agentB, rawInput: 'set "' + SEC + '"', signal: undefined });
assert(setB.kind === 'success', 'desync config set succeeds: ' + JSON.stringify(setB));
const execB = listenersB.get('tools/execute')[0];
const editB = await execB(
  { name: 'edit', arguments: { file_path: SEC + '\\d.txt', old_string: 'a', new_string: 'b' }, agent: agentB, signal: undefined },
  nextPassthrough,
);
assert(editB !== 'PASSTHROUGH' && editB.isError === false, 'desync-cwd edit intercepted');
assert(edits[edits.length - 1].policy.workspaceRoot === SEC, 'desync-cwd edit policy re-rooted to secondary');
const writeB = await execB(
  { name: 'write', arguments: { file_path: SEC + '\\d-w.txt', content: 'x' }, agent: agentB, signal: undefined },
  nextPassthrough,
);
assert(writeB !== 'PASSTHROUGH' && writeB.isError === false, 'desync-cwd write intercepted');
assert(writes[writes.length - 1].policy.workspaceRoot === SEC, 'desync-cwd write policy re-rooted to secondary');

// 16. Intercepted mutations emit `fs/observed` (the shipped tools' contract),
//     keeping the fs observation layer coherent after a re-rooted write/edit.
const observed = emitted.filter((e) => e.event === 'fs/observed');
assert(observed.length >= 2, 'fs/observed emitted for intercepted write/edit');
assert(observed.every((e) => e.args[1] && e.args[1].kind === 'present'), 'fs/observed presence observation');

// 17. Ownership rule: once a call's target is resolved inside a configured
//     secondary directory, the interception OWNS it — a mutation failure is
//     reported as that call's real error and is NEVER handed back to the
//     default pipeline. The regression this guards: the default pipeline fences
//     the call against the PRIMARY workspace root, so an ordinary local failure
//     (a missing `old_string`, a locked target) surfaced as the bogus
//     `[sandbox: file access denied under workspace-write mode]` marker plus a
//     full-access escalation hint, which reads as "edit is blocked here".
let nextCalls = 0;
const countingNext = async () => {
  nextCalls += 1;
  return 'PASSTHROUGH';
};

// 17a. A non-sandbox provider failure reports its real cause and code.
editFailure = Object.assign(new Error('cannot edit "' + SEC2 + '\\a.txt": old_string not found'), { code: 'FS_EDIT_NO_MATCH' });
const editFailed = await execWrite(
  { name: 'edit', arguments: { file_path: SEC2 + '\\a.txt', old_string: 'nope', new_string: 'x' }, agent, signal: undefined },
  countingNext,
);
assert(editFailed !== 'PASSTHROUGH' && nextCalls === 0, 'failed secondary edit stays intercepted');
assert(editFailed.isError === true, 'failed secondary edit is an error result');
assert(editFailed.content[0].text === 'Error: cannot edit "' + SEC2 + '\\a.txt": old_string not found', 'real cause surfaced: ' + editFailed.content[0].text);
assert(!editFailed.content[0].text.includes('sandbox:'), 'no spurious sandbox marker on a local failure');
assert(editFailed.error.info && editFailed.error.info.code === 'FS_EDIT_NO_MATCH', 'FS code preserved in the error envelope');
assert(editFailed.error.message === editFailed.content[0].text.slice('Error: '.length), 'error message matches the rendered text');
editFailure = null;

// 17b. Same for `write`.
writeFailure = Object.assign(new Error('cannot write "' + SEC2 + '\\b.txt": the file is locked'), { code: 'FS_IO_ERROR' });
const writeFailed = await execWrite(
  { name: 'write', arguments: { file_path: SEC2 + '\\b.txt', content: 'x' }, agent, signal: undefined },
  countingNext,
);
assert(writeFailed !== 'PASSTHROUGH' && nextCalls === 0, 'failed secondary write stays intercepted');
assert(writeFailed.content[0].text.includes('the file is locked'), 'write real cause surfaced');
assert(writeFailed.error.info && writeFailed.error.info.code === 'FS_IO_ERROR', 'write FS code preserved');
writeFailure = null;

// 17c. A GENUINE sandbox denial keeps the shipped marker + escalation hint.
editFailure = Object.assign(new Error('cannot write "x": file access denied under read-only mode'), { code: 'FS_SANDBOX_DENIED' });
const deniedEdit = await execWrite(
  { name: 'edit', arguments: { file_path: SEC2 + '\\a.txt', old_string: 'a', new_string: 'b' }, agent, signal: undefined },
  countingNext,
);
assert(deniedEdit !== 'PASSTHROUGH' && nextCalls === 0, 'denied secondary edit stays intercepted');
assert(deniedEdit.error.info && deniedEdit.error.info.code === 'FS_SANDBOX_DENIED', 'denial code preserved');
assert(deniedEdit.content[0].text.includes('[sandbox: file access denied under workspace-write mode]'), 'denial marker rendered');
assert(deniedEdit.content[0].text.includes('escalation available'), 'one-shot escalation hint preserved');
editFailure = null;

// 17d. Only a REAL escalation request defers to the default pipeline; a
//      null/empty value is not one and must not re-root the call at the
//      primary workspace.
const nullEscalation = await execWrite(
  {
    name: 'edit',
    arguments: { file_path: SEC2 + '\\a.txt', old_string: 'a', new_string: 'b', sandbox_permissions: null, justification: null },
    agent,
    signal: undefined,
  },
  countingNext,
);
assert(nullEscalation !== 'PASSTHROUGH' && nullEscalation.isError === false, 'null sandbox_permissions still intercepted');

const emptyEscalation = await execWrite(
  {
    name: 'edit',
    arguments: { file_path: SEC2 + '\\a.txt', old_string: 'a', new_string: 'b', sandbox_permissions: '' },
    agent,
    signal: undefined,
  },
  countingNext,
);
assert(emptyEscalation !== 'PASSTHROUGH' && emptyEscalation.isError === false, 'empty sandbox_permissions still intercepted');

const realEscalation = await execWrite(
  {
    name: 'edit',
    arguments: { file_path: SEC2 + '\\a.txt', old_string: 'a', new_string: 'b', sandbox_permissions: 'danger-full-access', justification: 't' },
    agent,
    signal: undefined,
  },
  countingNext,
);
assert(realEscalation === 'PASSTHROUGH' && nextCalls === 1, 'real escalation still passes through');

// 17e. Targets outside every secondary directory keep the default pipeline.
const outsideAgain = await execWrite(
  { name: 'edit', arguments: { file_path: 'C:\\Windows\\Temp\\y.txt', old_string: 'a', new_string: 'b' }, agent, signal: undefined },
  countingNext,
);
assert(outsideAgain === 'PASSTHROUGH' && nextCalls === 2, 'non-secondary edit still passes through');

// 17f. An UNRESOLVABLE absolute path inside a secondary directory is still
//      answered here rather than fenced at the primary root.
const listenersR = new Map();
const ctxR = makeCtx(listenersR, {
  fs: {
    ...fsMock,
    async resolve(path, opts) {
      if (/unresolvable/i.test(String(path))) {
        throw Object.assign(new Error('path contains illegal characters'), { code: 'FS_INVALID_PATH' });
      }
      return fsMock.resolve(path, opts);
    },
  },
});
apply(ctxR);
const execR = listenersR.get('tools/execute')[0];
let nextR = 0;
const unresolvable = await execR(
  {
    name: 'edit',
    arguments: { file_path: SEC2 + '\\unresolvable.txt', old_string: 'a', new_string: 'b' },
    agent,
    signal: undefined,
  },
  async () => {
    nextR += 1;
    return 'PASSTHROUGH';
  },
);
assert(unresolvable !== 'PASSTHROUGH' && nextR === 0, 'unresolvable secondary path stays intercepted');
assert(unresolvable.isError === true, 'unresolvable secondary path is an error result');
assert(unresolvable.content[0].text.includes('illegal characters'), 'resolution failure surfaced');
assert(unresolvable.error.info && unresolvable.error.info.code === 'FS_INVALID_PATH', 'resolution failure code preserved');

// 18. DSH >= 0.1.7-alpha.1 shell seam: `ShellExecutor.run` and
//     `ShellExecutor.start` were DELETED in favour of one `execute(spec)`
//     returning a `ShellExecution` (the process handle plus the foreground
//     projection `result()`), and `JobSpec.owner` changed from the calling
//     `Agent` to its `SessionId` — `jobs-local` resolves that id through
//     `agents.get(id)`. Every release since 0.1.7-alpha.1 (0.1.7-rc.2,
//     0.2.0-rc.1 included) exposes ONLY `execute`, so a composition modelled
//     here is what a current install actually looks like. The two regressions
//     this guards, both reproduced against DSH 0.2.0-rc.1:
//       foreground -> `Error: shell.run is not a function` (the command never ran)
//       background -> `session "[object Object]" has no live agent`
const sessionM = { id: 'sM', header: { cwd: WS } };
const agentM = { id: 'sM', session: sessionM };
const listenersM = new Map();
const ctxM = makeCtx(listenersM, {}, 'modern');
apply(ctxM);
const commandHandlerM = commandDef && commandDef.handler;
assert(commandHandlerM, 'modern composition registers the command');
const setM = await commandHandlerM({ commandId: 'cm1', agent: agentM, rawInput: 'set "' + SEC + '"', signal: undefined });
assert(setM.kind === 'success', 'modern config set succeeds: ' + JSON.stringify(setM));
const execM = listenersM.get('tools/execute')[0];

// 18a. Foreground: one `execute()` whose `result()` is the awaited run result.
shellExecutes.length = 0;
const runsBeforeM = shellRuns.length;
const fgM = await execM(
  { name: 'pwsh', arguments: { command: 'echo x', workdir: SEC, timeoutMs: 5000 }, agent: agentM, signal: undefined },
  nextPassthrough,
);
assert(fgM !== 'PASSTHROUGH' && fgM.isError === false, 'modern foreground intercepted');
assert(shellExecutes.length === 1, 'modern foreground goes through execute()');
assert(shellRuns.length === runsBeforeM, 'modern foreground never touches the retired shell.run');
assert(shellExecutes[0].request.sandboxPolicy.workspaceRoot === SEC, 'modern foreground policy re-rooted to secondary');
assert(shellExecutes[0].request.workdir === SEC, 'modern foreground workdir canonical');
assert(shellExecutes[0].request.onExpiry === undefined, 'a foreground call keeps the executor deadline (no onExpiry override)');
assert(fgM.value.kind === 'foreground' && fgM.value.exitCode === 0, 'modern foreground value shape');
assert(fgM.content[0].text.includes('ok'), 'modern foreground content carries stdout');
assert(fgM.value.sandbox.mode === 'workspace-write' && fgM.value.sandbox.denied === false, 'modern foreground sandbox facts survive');

// 18b. Background: `execute()` under `onExpiry: 'none'` (no deadline), registered
//      with the jobs runtime and owned by the SESSION ID, not the Agent object.
fakeProc = {
  status: 'completed',
  exitCode: 0,
  signal: null,
  done: Promise.resolve(),
  sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
  readOutput() { return { delta: 'bg modern ok\r\n', lossy: false }; },
  kill() { return true; },
};
shellExecutes.length = 0;
const startsBeforeM = shellStarts.length;
const jobsBeforeM = jobStarts.length;
const bgM = await execM(
  { name: 'pwsh', arguments: { command: 'echo bgm', workdir: SEC, run_in_background: true }, agent: agentM, signal: undefined },
  nextPassthrough,
);
assert(bgM !== 'PASSTHROUGH' && bgM.isError === false, 'modern background intercepted');
assert(shellStarts.length === startsBeforeM, 'modern background never touches the retired shell.start');
assert(shellExecutes.length === 1, 'modern background goes through execute()');
assert(
  shellExecutes[0].request.onExpiry === 'none',
  'modern background arms NO deadline — the retired start() ignored timeoutMs, and resolve() defaults onExpiry to "kill"',
);
assert(shellExecutes[0].request.sandboxPolicy.workspaceRoot === SEC, 'modern background policy re-rooted to secondary');
assert(shellExecutes[0].request.workdir === SEC, 'modern background workdir canonical');
assert(shellExecutes[0].request.dshEnv && shellExecutes[0].request.dshEnv.DSH_TEST === '1', 'modern background dshEnv collected');
const jobM = jobStarts[jobsBeforeM];
assert(jobStarts.length === jobsBeforeM + 1 && jobM.kind === 'pwsh' && jobM.label === 'echo bgm', 'modern job identity');
assert(
  jobM.owner === 'sM',
  'modern job owner is the SessionId (an Agent object throws "has no live agent"): ' + JSON.stringify(jobM.owner),
);
assert(bgM.value.kind === 'background' && bgM.value.jobId === 'pwsh-' + jobStarts.length, 'modern background value shape');
assert(bgM.content[0].text === 'started background job ' + bgM.value.jobId, 'modern background content text');
const bgOutcomeM = await startedHooks.done;
assert(bgOutcomeM.status === 'completed' && bgOutcomeM.detail === 'exit code: 0', 'modern job outcome completed');
assert(startedHooks.readOutput() === 'bg modern ok\r\n', 'modern streamed read');

// 18c. The modern launch keeps the async/cancellable preparation semantics:
//      cancelling before the handle is published must settle the job as killed.
let releaseStartM = null;
startGate = new Promise((resolve) => { releaseStartM = resolve; });
fakeProc = {
  status: 'running',
  exitCode: 0,
  signal: null,
  done: Promise.resolve(),
  sandbox: undefined,
  readOutput() { return { delta: 'late\r\n', lossy: false }; },
  kill() { this.status = 'killed'; this.signal = 'SIGTERM'; return true; },
};
const bgPendingM = await execM(
  { name: 'bash', arguments: { command: 'echo slow', workdir: SEC, run_in_background: true }, agent: agentM, signal: undefined },
  nextPassthrough,
);
assert(bgPendingM !== 'PASSTHROUGH' && bgPendingM.isError === false, 'modern unpublished launch stays intercepted');
assert(startedHooks.readOutput() === '', 'modern: no output before the handle is published');
startedHooks.cancel('stop');
assert(shellExecutes[shellExecutes.length - 1].request.signal.aborted === true, 'modern cancel aborts in-flight preparation');
releaseStartM();
startGate = null;
const pendingOutcomeM = await startedHooks.done;
assert(pendingOutcomeM.status === 'killed', 'modern cancel during preparation settles the job as killed: ' + JSON.stringify(pendingOutcomeM));

// 18d. A rejected preparation settles the job as `failed` with the real cause.
startFailure = new Error('the sandbox runner failed to apply the write grant');
const bgFailedM = await execM(
  { name: 'pwsh', arguments: { command: 'echo f', workdir: SEC, run_in_background: true }, agent: agentM, signal: undefined },
  nextPassthrough,
);
assert(bgFailedM !== 'PASSTHROUGH' && bgFailedM.isError === false, 'modern failed launch still intercepted');
const failedOutcomeM = await startedHooks.done;
assert(failedOutcomeM.status === 'failed', 'modern preparation failure settles the job as failed: ' + JSON.stringify(failedOutcomeM));
assert(failedOutcomeM.detail === 'the sandbox runner failed to apply the write grant', 'modern failure detail carries the real cause');
startFailure = null;

// 18e. A release carrying BOTH seams (retired methods kept alongside
//      `execute()`) must still take the modern path — the probe keys on
//      `execute` being present, never on `run` being absent.
const listenersBoth = new Map();
const ctxBoth = makeCtx(listenersBoth, {}, 'both');
apply(ctxBoth);
const commandHandlerBoth = commandDef && commandDef.handler;
await commandHandlerBoth({ commandId: 'cb1', agent: agentM, rawInput: 'set "' + SEC + '"', signal: undefined });
const execBoth = listenersBoth.get('tools/execute')[0];
shellExecutes.length = 0;
const runsBeforeBoth = shellRuns.length;
const fgBoth = await execBoth(
  { name: 'pwsh', arguments: { command: 'echo both', workdir: SEC }, agent: agentM, signal: undefined },
  nextPassthrough,
);
assert(fgBoth !== 'PASSTHROUGH' && fgBoth.isError === false, 'dual-seam foreground intercepted');
assert(shellExecutes.length === 1 && shellRuns.length === runsBeforeBoth, 'dual-seam prefers execute() over the retired run()');

console.log('intercept: all assertions passed');
