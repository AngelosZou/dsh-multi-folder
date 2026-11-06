/**
 * T2 workspace-browser integration smoke test:
 * - workspace rows receive a compact Multi-folder entry;
 * - the official Workspace row anchor and the homepage grouped-list anchor both work;
 * - a newly ready Workspace opens the small workspace panel once.
 */
import { readFileSync } from 'node:fs'

let captured = null
const storage = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load(record) {
      captured = record
    },
  },
  localStorage: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null },
    setItem(key, value) { storage.set(key, String(value)) },
  },
}

class FakeNode {
  constructor(tag) {
    this.tag = tag
    this.attrs = {}
    this.children = []
    this.listeners = {}
    this.style = {}
    this.textContent = ''
  }

  setAttribute(key, value) { this.attrs[key] = String(value) }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null }
  appendChild(child) { this.children.push(child); return child }
  addEventListener(name, handler) { this.listeners[name] = handler }
  click(event = {}) {
    if (typeof this.listeners.click === 'function') {
      this.listeners.click({ preventDefault() {}, stopPropagation() {}, ...event })
    }
  }

  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child
      if (typeof child.find === 'function') {
        const match = child.find(predicate)
        if (match) return match
      }
    }
    return null
  }

  querySelector(selector) {
    if (selector.includes('data-mf-workspace-action')) {
      return this.find(child => child.getAttribute && child.getAttribute('data-mf-workspace-action') !== null)
    }
    if (selector.includes('rowActions') || selector === '.ph-sb-actions' || selector === 'span:last-child') {
      if (this.tag === 'span' && (String(this.attrs.class || '').includes('rowActions') || String(this.attrs.class || '').includes('ph-sb-actions'))) return this
      return this.find(child => child.tag === 'span')
    }
    if (selector === 'button') return this.find(child => child.tag === 'button')
    return null
  }
}

const listSourceListeners = new Set()
const listSnapshot = {
  phase: 'ready',
  items: [
    { workspaceId: 'w1', path: '/workspace/one', title: 'One' },
  ],
}
const listSource = {
  getSnapshot: () => listSnapshot,
  subscribe(listener) {
    listSourceListeners.add(listener)
    return () => listSourceListeners.delete(listener)
  },
}

const listCalls = []
const localeDicts = new Map()
localeDicts.set('workspace', {
  zh: { 'workspace.add': '添加工作区', 'menu.addWorkspace': '添加工作区…' },
  en: { 'workspace.add': 'Add workspace', 'menu.addWorkspace': 'Add workspace…' },
})
const locale = {
  register(ns, dicts) {
    localeDicts.set(ns, dicts)
    return () => localeDicts.delete(ns)
  },
  bind(ns) {
    return (key, params = {}) => {
      const entry = localeDicts.get(ns)
      const text = entry ? (entry.zh[key] ?? entry.en[key] ?? key) : key
      return String(text).replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? '' : String(params[name])))
    }
  },
}

function makeRow(attrs, actionClass) {
  const row = new FakeNode('div')
  Object.entries(attrs).forEach(([key, value]) => row.setAttribute(key, value))
  const actions = new FakeNode('span')
  actions.setAttribute('class', actionClass)
  actions.appendChild(new FakeNode('button'))
  row.children.push(actions)
  return row
}

const officialRow = makeRow({ 'data-row-key': 'workspace:w1' }, 'rowActions_x')
const homepageRow = makeRow({ 'data-sb': 'project', 'data-ws': 'w1' }, 'ph-sb-actions')
const rows = [officialRow, homepageRow]

const document = {
  body: new FakeNode('body'),
  querySelector() { return null },
  querySelectorAll(selector) {
    return selector.includes('workspace:') || selector.includes('data-ws') ? rows : []
  },
  createElement(tag) { return new FakeNode(tag) },
}
globalThis.document = document

class MutationObserver {
  constructor(callback) { this.callback = callback }
  observe() {}
  disconnect() {}
  takeRecords() { return [] }
}
globalThis.MutationObserver = MutationObserver

const reactShim = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  useEffect() {},
}
;(0, eval)(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
const module = captured.factory((spec) => {
  if (spec === 'react') return reactShim
  throw new Error('unexpected require: ' + spec)
})

const ctx = {
  effect(fn) { fn(); return () => {} },
  inject() { return () => {} },
  get() { return undefined },
  locale,
  slots: {
    inject() { return () => {} },
    register() { return () => {} },
  },
  remote: {
    $host: { home: '/home' },
    commands: { execute: async () => ({ ok: false, error: { message: 'unused' } }) },
  },
  connection: {
    rpc: {
      async call(_channel, endpoint, payload) {
        if (endpoint === 'multiFolder/list') {
          listCalls.push(payload.args)
          return {
            ok: true,
            value: {
              workspace: payload.args.workspace,
              workspaceId: payload.args.workspaceId || null,
              dirs: [],
              changed: false,
            },
          }
        }
        return { ok: false, error: { message: 'unexpected endpoint ' + endpoint } }
      },
    },
  },
  sessions: { list: listSource },
  workspaces: { list: listSource },
}

const assert = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message)
    process.exit(1)
  }
}

module.apply(ctx)

// The official Add Workspace control arms the first-run flow; a workspace
// becoming ready without that user intent (automatic default initialization)
// must never interrupt the shell.
const armClick = document.body.listeners.click
assert(typeof armClick === 'function', 'the add-workspace click sentinel is installed')
armClick({ target: {
  nodeType: 1,
  getAttribute(name) { return name === 'aria-label' ? '添加工作区' : null },
  textContent: '添加工作区',
  parentElement: null,
} })

// A new Workspace becoming ready is the official flow's creation signal.
listSnapshot.items = [...listSnapshot.items, { workspaceId: 'w2', path: '/workspace/two', title: 'Two' }]
listSourceListeners.forEach(listener => listener())
assert(listCalls.some(args => args.workspace === '/workspace/two' && args.workspaceId === 'w2'),
  'the first-run panel opens for a newly created workspace')
assert(storage.get('dsh-multi-folder.setup.w2') === '1', 'the first-run prompt is recorded once')

await new Promise(resolve => setTimeout(resolve, 80))

const officialAction = officialRow.children[0].children.at(-1)
const homepageAction = homepageRow.children[0].children.at(-1)
assert(officialAction && officialAction.getAttribute('data-mf-workspace-action') === '',
  'official workspace row receives a directory-settings button')
assert(homepageAction && homepageAction.getAttribute('data-mf-workspace-action') === '',
  'homepage grouped workspace row receives the same entry')
assert(officialAction.getAttribute('aria-label') === '工作区目录设置（多工作目录）',
  'the row entry carries an accessible localized label')

const before = listCalls.length
officialAction.click()
assert(listCalls.length > before, 'the workspace row entry opens the workspace panel')
assert(listCalls.at(-1).workspace === '/workspace/one' && listCalls.at(-1).workspaceId === 'w1',
  'the row entry addresses the workspace by path and durable id')

console.log('workspace-browser: all assertions passed')
