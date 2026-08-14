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
const savedConfigs = [];
const writes = [];
const edits = [];
const shellRuns = [];
let commandDef = null;
const sections = [];

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
    throw new Error('no such file');
  },
  async writeText(target, content, expected, signal, policy) {
    writes.push({ path: String(target.processPath ?? target.displayPath), content, policy });
    return { operation: 'create', version: 'v1', before: null, after: content };
  },
  async editText(target, edit, expected, signal, policy) {
    edits.push({ path: String(target.processPath ?? target.displayPath), edit, policy });
    return { before: edit.oldString, after: edit.newString };
  },
};

const ctx = {
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
  get(name) {
    if (name === 'shell') {
      return {
        resolve(request) {
          return { request };
        },
        async run(spec) {
          shellRuns.push(spec.request);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            timeoutMs: 1000,
            stdout: { text: 'ok\r\n', truncated: false },
            stderr: { text: '', truncated: false },
            sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
          };
        },
      };
    }
    if (name === 'shellEnv') {
      return { collect() { return { DSH_TEST: '1' }; } };
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
    const list = listeners.get(event) ?? [];
    list.push(fn);
    listeners.set(event, list);
    return () => {};
  },
};

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

// 4. Pre-step channel: notice prepended at the next step boundary.
const preStep = listeners.get('agent/pre-step')[0];
const preStepOut = await preStep(
  { agent, messages: [], turn: 1, step: 1, signal: undefined },
  enterWith([{ id: 'm1', role: 'user' }]),
);
assert(preStepOut.kind === 'enter', 'pre-step enter');
assert(preStepOut.messages.length === 2, 'notice prepended');
assert(preStepOut.messages[0].source.kind === 'plugin' && preStepOut.messages[0].source.form === 'notice', 'notice source shape');
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

// 5b. Unchanged add arms nothing: next post-execute carries no additional context.
await commandHandler({ commandId: 'c3', agent, rawInput: 'add "' + SEC2 + '"', signal: undefined });
const postNoChange = await postExec(
  { name: 'read', arguments: {}, agent, signal: undefined },
  { isError: false },
  async () => ({ kind: 'accept', content: [{ type: 'text', text: 'y' }] }),
);
assert(!postNoChange.additionalContexts || postNoChange.additionalContexts.length === 0, 'no notice without change');

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

console.log('intercept: all assertions passed');
