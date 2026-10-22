/**
 * Smoke tests for opencode-usage-dsh.
 *
 *   node test/smoke.mjs
 *
 * The host test talks to the real OpenCode usage endpoint when an
 * OPENCODE_GO_API_KEY / OPENCODE_API_KEY credential is available (from the
 * environment or from $DSH_HOME/.credentials.yaml), and falls back to a stubbed
 * response otherwise, so the suite passes offline too.
 */
import { mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SANDBOX = join(HERE, '.sandbox')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// host half
// ---------------------------------------------------------------------------

/** Read a credential reference out of the shared DSH credentials document. */
function credentialFromHome(ref) {
  const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const match = new RegExp(`${ref}:\\s*(\\S+)`).exec(text)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function scaffold() {
  const pkg = join(SANDBOX, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', version: '0.0.0-stub', type: 'module', main: 'index.js' }))
  writeFileSync(
    join(pkg, 'index.js'),
    [
      'export class TypertRemoteService {',
      '  constructor(ctx, namespace) { this.ctx = ctx; this.namespace = namespace }',
      '}',
      'export function Remote(name) {',
      '  return (fn) => { fn.__remoteName = name }',
      '}',
      '',
    ].join('\n'),
  )
  copyFileSync(join(ROOT, 'lib', 'index.js'), join(SANDBOX, 'host.mjs'))
}

function mockContext(keyRef, key, options = {}) {
  const withProviders = options.withProviders !== false
  const credentialsAfterMs = options.credentialsAfterMs || 0
  const startedAt = Date.now()
  return {
    logger: { warn() {}, info() {} },
    on() {},
    effect(fn) {
      return fn()
    },
    interval() {
      return () => {}
    },
    timeout() {
      return () => {}
    },
    get(name) {
      // A credential store that has not finished mounting yet: the very first
      // poll sees no service at all.
      if (name === 'credentials' && Date.now() - startedAt < credentialsAfterMs) return undefined
      if (name === 'credentials') {
        return { resolve: async (ref) => (ref === keyRef ? { value: key } : undefined) }
      }
      if (name === 'settings' && withProviders) {
        return {
          get: (namespace) =>
            namespace === 'llm-pi-ai'
              ? { providers: { 'opencode-go': { apiKeyEnv: keyRef, models: [] } } }
              : undefined,
        }
      }
      return undefined
    },
  }
}

async function testHost() {
  console.log('host half')
  scaffold()
  const { default: OpencodeUsageService, SERVICE, PLUGIN_ID } = await import(pathToFileURL(join(SANDBOX, 'host.mjs')).href)

  check('namespace is advertised', SERVICE === 'opencodeUsage' && PLUGIN_ID === 'opencode-usage-dsh')

  const keyRef = 'OPENCODE_GO_API_KEY'
  const key = process.env[keyRef] || credentialFromHome(keyRef) || credentialFromHome('OPENCODE_API_KEY')
  const live = Boolean(key)
  const now = Date.now()

  const originalFetch = globalThis.fetch
  if (!live) {
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('/usage')
          ? JSON.stringify({
              usage: {
                rolling: { status: 'ok', percent: 3, resetsAt: new Date(now + 4 * 3600_000 + 19 * 60_000).toISOString() },
                weekly: { status: 'ok', percent: 1, resetsAt: new Date(now + 2 * 86400_000).toISOString() },
                monthly: { status: 'ok', percent: 0, resetsAt: new Date(now + 30 * 86400_000).toISOString() },
              },
            })
          : JSON.stringify({ data: [{ id: 'deepseek-v4-flash-vision-exp' }, { id: 'glm-5.3' }] }),
    })
  }

  try {
    const service = new OpencodeUsageService(mockContext(keyRef, key || 'stub-key'))
    const state = await service.snapshot()
    check('snapshot is JSON-safe', !JSON.stringify(state).includes('undefined'))
    check('one account discovered', state.accounts.length === 1, JSON.stringify(state.accounts.map((a) => a.id)))
    const account = state.accounts[0] || {}
    check('key resolves through credentials', account.keyConfigured === true)
    check('usage windows present', Boolean(account.usage && account.usage.rolling && account.usage.weekly && account.usage.monthly))
    const rolling = account.usage && account.usage.rolling
    check(
      `rolling percent is a number (${rolling && rolling.percent})`,
      Boolean(rolling) && typeof rolling.percent === 'number' && rolling.percent >= 0 && rolling.percent <= 100,
    )
    check(
      `rolling reset time parses (${rolling && rolling.resetsAt})`,
      Boolean(rolling) && !Number.isNaN(Date.parse(rolling.resetsAt || '')),
    )
    check(`plan models listed (${account.modelCount})`, account.modelCount > 0, account.modelsError || '')
    check('no usage error', !account.usageError, account.usageError || '')
    console.log(`       source: ${live ? 'live API' : 'stubbed response'}`)

    // Discovery fallback: no provider is configured, so only the refs that
    // actually resolve should produce a card.
    const fallbackService = new OpencodeUsageService(mockContext(keyRef, key || 'stub-key', { withProviders: false }))
    const fallbackState = await fallbackService.snapshot()
    check('fallback drops unconfigured refs', fallbackState.accounts.length === 1, JSON.stringify(fallbackState.accounts.map((a) => a.id)))
    check(
      'fallback keeps the configured ref',
      fallbackState.accounts[0] && fallbackState.accounts[0].apiKeyEnv === keyRef,
      JSON.stringify(fallbackState.accounts.map((a) => a.apiKeyEnv)),
    )

    // A credential store that is slower than the first poll must not decide the
    // first paint: the startup retries have to resolve the key on their own.
    const slowService = new OpencodeUsageService(mockContext(keyRef, key || 'stub-key', { credentialsAfterMs: 600 }))
    await slowService.ready
    check('first poll may race the credential store', slowService.needsCredentialRetry() === true)
    const healed = await slowService.bootstrapRetries().then(() => slowService.state)
    check('startup retries resolve the key', healed.accounts.every((a) => a.keyConfigured === true), JSON.stringify(healed.accounts.map((a) => a.keyConfigured)))

    // Nothing resolves at all: the retry loop must still run (an empty account
    // list is a reason to retry, not a reason to stop).
    const emptyService = new OpencodeUsageService(mockContext(keyRef, undefined, { withProviders: false }))
    await emptyService.ready
    check('empty snapshot keeps retrying', emptyService.needsCredentialRetry() === true)
    check('empty snapshot exposes no account card', emptyService.state.accounts.length === 0)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---------------------------------------------------------------------------
// browser half
// ---------------------------------------------------------------------------

/** Just enough React for a server-side smoke render. */
function reactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect(effect) {
      effect()
    },
  }
}

/** Collect every string rendered into an element tree. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (node.children) for (const child of node.children) textOf(child, out)
  return out
}

async function testClient() {
  console.log('browser half')
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  let definition = null
  const fakeWindow = { __ModuleLoader__: { load: (value) => { definition = value } } }
  const requireStub = (name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected require("${name}")`)
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(fakeWindow, requireStub)

  check('module loader definition captured', Boolean(definition) && definition.id === 'opencode-usage-dsh')
  const plugin = definition.factory(requireStub)
  check('apply/inject exported', typeof plugin.apply === 'function' && Array.isArray(plugin.inject))
  check('timer is injected for polling', plugin.inject.includes('timer'))

  let registeredOptions = null
  let RegisteredComponent = null
  const remoteCalls = []
  const namespace = {
    async snapshot() {
      remoteCalls.push('snapshot')
      return {
        ok: true,
        value: {
          fetchedAt: Date.now(),
          error: null,
          accounts: [
            {
              id: 'opencode-go',
              displayName: 'OpenCode Zen Go',
              apiKeyEnv: 'OPENCODE_GO_API_KEY',
              keyConfigured: true,
              modelCount: 12,
              usageError: null,
              usage: {
                rolling: { status: 'ok', percent: 3, resetsAt: new Date(Date.now() + 4 * 3600_000 + 19 * 60_000).toISOString() },
                weekly: { status: 'ok', percent: 1, resetsAt: new Date(Date.now() + 2 * 86400_000 + 10 * 3600_000).toISOString() },
                monthly: { status: 'ok', percent: 0, resetsAt: new Date(Date.now() + 30 * 86400_000 + 23 * 3600_000).toISOString() },
              },
            },
          ],
        },
      }
    },
    async refresh() {
      remoteCalls.push('refresh')
      return { ok: true, value: null }
    },
  }

  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    timeout() {
      return () => {}
    },
    interval() {
      return () => {}
    },
    locale: { bind: () => (key) => key, register() {} },
    slots: {
      inject(name, callback) {
        if (name !== 'settings.section') return
        callback()
      },
      register(options, component) {
        registeredOptions = options
        RegisteredComponent = component
        return () => {}
      },
    },
    remote: { $mount: async () => {} },
    inject(services, callback) {
      if (services[0] === 'remote.opencodeUsage') {
        callback({ remote: { opencodeUsage: namespace } })
      }
    },
  }

  await plugin.apply(ctx)
  await new Promise((done) => setTimeout(done, 60))

  check('settings.section registered', Boolean(registeredOptions) && registeredOptions.name === 'settings.section')
  check('section id is opencode-usage', registeredOptions && registeredOptions.id === 'opencode-usage')
  check('section carries a nav label', registeredOptions && typeof registeredOptions.label === 'function')
  check('remote snapshot was read', remoteCalls.includes('snapshot'))

  const face = registeredOptions.inject()
  const hooks = face.hooks
  check('store hooks exposed', Boolean(hooks && hooks.opencodeUsage && typeof hooks.opencodeUsage.getSnapshot === 'function'))

  const state = hooks.opencodeUsage.getSnapshot()
  check('store reached the ready phase', state.phase === 'ready', state.phase)
  check('one account rendered', state.accounts.length === 1)

  const props = {
    ...face,
    t: (key) => key,
    useOpencodeUsage: (selector) => selector(hooks.opencodeUsage.getSnapshot()),
    useOpencodeUsageBusy: (selector) => selector(hooks.opencodeUsageBusy.getSnapshot()),
  }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = () => 0
  let text
  try {
    const tree = RegisteredComponent(props)
    text = textOf(tree).join(' | ')
  } finally {
    globalThis.setInterval = originalSetInterval
  }
  check('renders the rolling window', text.includes('rolling') && text.includes('3usedSuffix'), text)
  check('renders the weekly window', text.includes('weekly') && text.includes('1usedSuffix'), text)
  check('renders the monthly window', text.includes('monthly') && text.includes('0usedSuffix'), text)
  check('renders a reset countdown', /\d+[dh] \d+[hm]/.test(text), text)
  check('renders the plan model count', text.includes('12'))

  await new Promise((done) => {
    const originalSetInterval = globalThis.setInterval
    globalThis.setInterval = () => 0
    try {
      props.reload()
      setTimeout(() => {
        globalThis.setInterval = originalSetInterval
        done()
      }, 40)
    } catch (error) {
      globalThis.setInterval = originalSetInterval
      done()
    }
  })
  check('reload forces a host refresh', remoteCalls.includes('refresh'))
}

// ---------------------------------------------------------------------------

try {
  await testHost()
  await testClient()
} finally {
  await new Promise((done) => setTimeout(done, 20))
}

rmSync(SANDBOX, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
