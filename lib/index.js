/**
 * OpenCode usage for DeepSeek Harness — Host half.
 *
 * Reads the official OpenCode Zen / Go quota endpoint
 *   GET <base>/v1/usage   →  { usage: { rolling, weekly, monthly: { status, percent, resetsAt } } }
 * for every opencode-family provider configured in `llm-pi-ai` (or, when none is
 * configured, for the standard `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`
 * credential refs), and serves a JSON-safe snapshot to the browser half over
 * the process-private Typert Remote namespace `opencodeUsage`.
 *
 * The API key is resolved from DSH credentials on every refresh and never
 * leaves this process: only percentages, reset times and model ids cross the
 * Remote boundary.
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Typert wire namespace owned by this plugin. */
const SERVICE = 'opencodeUsage'

/** Host half of the plugin identity, matched by the browser half's descriptors. */
const PLUGIN_ID = 'opencode-usage-dsh'

const DEFAULT_BASE = 'https://opencode.ai/zen/go'
const STANDARD_REFS = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']
const POLL_MS = 30_000
const STARTUP_RETRY_DELAYS = [1200, 4000]
const REQUEST_TIMEOUT_MS = 15_000
const MAX_BODY_CHARS = 400

/** Strip trailing slashes and a trailing `/v1`, so `/v1/usage` can be appended. */
function normalizeBase(value) {
  if (typeof value !== 'string' || value === '') return DEFAULT_BASE
  let base = value.trim().replace(/\/+$/, '')
  if (base === '') return DEFAULT_BASE
  if (!/^https?:\/\//i.test(base)) return DEFAULT_BASE
  base = base.replace(/\/v1$/i, '')
  return base
}

/** Is this `llm-pi-ai` provider an OpenCode one? */
function isOpencodeProvider(id, entry) {
  if (id === 'opencode' || id === 'opencode-go') return true
  const env = entry && entry.apiKeyEnv
  if (typeof env === 'string' && /^OPENCODE/i.test(env)) return true
  const url = entry && entry.baseURL
  return typeof url === 'string' && url.indexOf('opencode.ai') !== -1
}

/** Every field that crosses the Remote boundary must survive JSON. */
function sanitize(value) {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(sanitize)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = sanitize(value[key])
    return out
  }
  return value
}

/** Short, log-safe summary of a failed HTTP body. */
function bodyExcerpt(text) {
  const trimmed = String(text || '').trim().replace(/\s+/g, ' ')
  return trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}…` : trimmed
}

/**
 * One authenticated JSON GET. Uses the host process's own `fetch`, so an
 * `Authorization` header is allowed (the `ctx.web` seam deliberately is not).
 */
async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${text ? ` — ${bodyExcerpt(text)}` : ''}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('响应不是合法 JSON')
  }
}

/** The three windows the UI renders, in display order. */
function readUsage(payload) {
  const usage = payload && payload.usage
  if (!usage || typeof usage !== 'object') return null
  const window = (value) => {
    if (!value || typeof value !== 'object') return null
    const percent = typeof value.percent === 'number' ? value.percent : null
    return {
      status: typeof value.status === 'string' ? value.status : null,
      percent,
      resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null,
    }
  }
  return {
    rolling: window(usage.rolling),
    weekly: window(usage.weekly),
    monthly: window(usage.monthly),
  }
}

/** Read the configured `llm-pi-ai` providers without requiring the service. */
function readProviders(ctx) {
  try {
    const settings = ctx.get('settings')
    const pi = settings && typeof settings.get === 'function' ? settings.get('llm-pi-ai') : null
    const providers = pi && pi.providers
    if (providers && typeof providers === 'object') return providers
  } catch {
    /* settings not composed, or the namespace is not served: fall back to refs */
  }
  return null
}

/**
 * Host-side owner of the polled snapshot. One instance per host process; the
 * browser half only ever reads it.
 */
export class OpencodeUsageService extends TypertRemoteService {
  static inject = ['timer']

  constructor(ctx, config = {}) {
    super(ctx, SERVICE)
    this.ctx = ctx
    this.config = config && typeof config === 'object' ? config : {}
    this.inflight = null
    this.state = sanitize({
      fetchedAt: null,
      platform: typeof process !== 'undefined' ? process.platform : null,
      accounts: [],
      error: null,
    })

    const kick = () => {
      void this.refresh()
    }

    ctx.on('credentials/reference-updated', kick)
    ctx.on('settings/updated', (namespace) => {
      if (namespace === undefined || namespace === 'llm-pi-ai') kick()
    })
    ctx.effect(() => ctx.interval(kick, POLL_MS), 'opencode-usage: poll')
    // The first poll is awaited by `snapshot()`, so a client that asks before the
    // network answers receives real data instead of the empty placeholder.
    this.ready = this.refresh()
    // The credential store reads its file asynchronously, so the very first poll
    // can beat it. Retry briefly instead of leaving the page keyless until the
    // next 30s tick.
    void this.bootstrapRetries()
    ctx.logger?.info?.('opencode-usage: service started; polling opencode.ai every 30s')
  }

  /** Current snapshot; pass `refresh: true` to re-read before answering. */
  async snapshot(request) {
    if (request && request.refresh === true) {
      await this.refresh()
    } else {
      await this.ready
    }
    return this.state
  }

  /**
   * Does the snapshot still look like a credential store that is not ready yet?
   * Either nothing resolved at all, or a configured provider is still missing
   * its key.
   */
  needsCredentialRetry() {
    const accounts = this.state.accounts
    return accounts.length === 0 || accounts.some((account) => account.keyConfigured !== true)
  }

  /**
   * Re-poll a couple of times right after startup, so a credential store that is
   * still loading does not make the first paint look unconfigured.
   */
  async bootstrapRetries() {
    for (const delay of STARTUP_RETRY_DELAYS) {
      if (!this.needsCredentialRetry()) return
      await new Promise((done) => setTimeout(done, delay))
      await this.refresh()
    }
  }

  /** Force one poll now. Concurrent callers share the in-flight poll. */
  async refresh() {
    if (this.inflight) return this.inflight
    this.inflight = this.runPoll()
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  /** One poll, with the failure folded into the state. */
  async runPoll() {
    try {
      this.state = sanitize(await this.poll())
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      this.ctx.logger?.warn?.('opencode-usage: refresh failed: %s', message)
      this.state = sanitize({
        fetchedAt: Date.now(),
        platform: typeof process !== 'undefined' ? process.platform : null,
        accounts: this.state.accounts,
        error: message,
      })
    }
    return this.state
  }

  /** Resolve which provider + credential pairs to poll. */
  async resolveTargets() {
    const targets = []
    const seen = new Set()
    const push = (id, entry, apiKeyEnv, fallback) => {
      const base = normalizeBase(entry && entry.baseURL)
      const dedupe = `${apiKeyEnv}|${base}`
      if (seen.has(dedupe)) return
      seen.add(dedupe)
      targets.push({
        id: id || apiKeyEnv.toLowerCase().replace(/_/g, '-'),
        displayName: (entry && entry.displayName) || id || apiKeyEnv,
        apiKeyEnv,
        base,
        fallback: fallback === true,
      })
    }

    const providers = readProviders(this.ctx)
    if (providers) {
      for (const id of Object.keys(providers)) {
        const entry = providers[id]
        if (!isOpencodeProvider(id, entry)) continue
        const env = entry && entry.apiKeyEnv
        if (typeof env !== 'string' || env === '') continue
        push(id, entry, env, false)
      }
    }
    if (targets.length === 0) {
      for (const env of STANDARD_REFS) {
        const id = env.toLowerCase().replace(/_/g, '-').replace(/-api-key$/, '')
        push(id, null, env, true)
      }
    }

    const credentials = this.ctx.get('credentials')
    for (const target of targets) {
      let key = null
      if (credentials && typeof credentials.resolve === 'function') {
        try {
          const hit = await credentials.resolve(target.apiKeyEnv)
          if (hit && typeof hit.value === 'string' && hit.value !== '') key = hit.value
        } catch {
          /* unconfigured → null */
        }
      }
      target.key = key
    }
    // A discovery fallback exists to find *some* usable key; an unset ref is
    // noise, not a configuration mistake the page should report.
    return targets.filter((target) => target.key !== null || !target.fallback)
  }

  /** Poll usage + plan models for every distinct credential. */
  async poll() {
    const targets = await this.resolveTargets()

    // One credential may back several providers; fetch it once.
    const byKey = new Map()
    for (const target of targets) {
      if (!target.key) continue
      let bucket = byKey.get(target.key)
      if (!bucket) {
        bucket = { base: target.base, usage: null, usageError: null, models: null, modelsError: null }
        byKey.set(target.key, bucket)
      }
      target.bucket = bucket
    }

    await Promise.all(
      [...byKey.entries()].map(async ([key, bucket]) => {
        const base = bucket.base || DEFAULT_BASE
        const [usage, models] = await Promise.allSettled([
          getJson(`${base}/v1/usage`, key),
          getJson(`${base}/v1/models`, key),
        ])
        if (usage.status === 'fulfilled') {
          bucket.usage = readUsage(usage.value)
          bucket.usageError = bucket.usage ? null : '响应中没有 usage 字段'
        } else {
          bucket.usageError = usage.reason?.message ?? String(usage.reason)
        }
        if (models.status === 'fulfilled') {
          const list = Array.isArray(models.value?.data) ? models.value.data : []
          bucket.models = list
            .map((model) => (model && model.id ? String(model.id) : ''))
            .filter(Boolean)
            .sort()
          bucket.modelsError = null
        } else {
          bucket.modelsError = models.reason?.message ?? String(models.reason)
        }
      }),
    )

    const accounts = targets.map((target) => {
      const bucket = target.bucket
      return {
        id: target.id,
        displayName: target.displayName,
        apiKeyEnv: target.apiKeyEnv,
        baseUrl: target.base,
        keyConfigured: target.key !== null,
        usage: bucket ? bucket.usage : null,
        usageError: bucket ? bucket.usageError : target.key === null ? '未配置 API key' : null,
        modelCount: bucket && bucket.models ? bucket.models.length : 0,
        models: bucket && bucket.models ? bucket.models : [],
        modelsError: bucket ? bucket.modelsError : null,
      }
    })

    return {
      fetchedAt: Date.now(),
      platform: typeof process !== 'undefined' ? process.platform : null,
      accounts,
      error: null,
    }
  }
}

// The Typert pipeline normally generates these decorators; a hand-written
// bundle applies them directly, exactly as the shipped third-party bundles do.
for (const name of ['snapshot', 'refresh']) {
  const prototype = OpencodeUsageService.prototype
  Remote(name)(prototype[name], {
    name,
    private: false,
    static: false,
    addInitializer(fn) {
      fn.call(Object.create(prototype))
    },
  })
}

export { PLUGIN_ID, SERVICE }
export default OpencodeUsageService
