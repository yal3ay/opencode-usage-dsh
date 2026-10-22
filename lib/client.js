/**
 * OpenCode usage for DeepSeek Harness — browser half.
 *
 * Registers a "OpenCode 用量" page into the Settings dialog through the official
 * `settings.section` slot, and reads the three quota windows (5h rolling /
 * weekly / monthly) from the host half over the Typert Remote namespace
 * `opencodeUsage`.
 *
 * Written against the plain `window.__ModuleLoader__` contract, so no build
 * step and no JSX toolchain are required: React comes from the module loader.
 */
window.__ModuleLoader__.load({
  id: 'opencode-usage-dsh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // ---------------------------------------------------------------- wire ---

    const PLUGIN_ID = 'opencode-usage-dsh'
    const SERVICE = 'opencodeUsage'

    /** Strict JSON codec for the hand-written request payload. */
    const codec = () => ({
      mode: 'strict',
      typeSymbol: `${PLUGIN_ID}#json`,
      create: () => ({ parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }),
    })

    /** One direct-invocation descriptor, hand-written in place of codegen. */
    function descriptor(method, withRequest) {
      return {
        id: `${PLUGIN_ID}#${SERVICE}/${method}`,
        service: SERVICE,
        namespace: SERVICE,
        method,
        invocation: { kind: 'direct' },
        ...(withRequest
          ? { parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec() }] }
          : { parameters: [] }),
        result: { mode: 'src-json' },
        cancellation: { parameter: 'signal' },
      }
    }

    const TYPERT_REMOTE = {
      package: PLUGIN_ID,
      descriptors: [descriptor('snapshot', true), descriptor('refresh', false)],
    }

    // -------------------------------------------------------------- locale ---

    const NS = 'settings.opencodeUsage'

    const en = {
      nav: 'OpenCode usage',
      title: 'OpenCode usage',
      intro: 'Quota windows of the configured opencode.ai Zen / Go plan: 5-hour rolling, weekly and monthly.',
      rolling: '5-hour rolling',
      weekly: 'Weekly',
      monthly: 'Monthly',
      usedSuffix: '% used',
      resetPrefix: 'Resets in ',
      resetPending: 'resetting now',
      models: 'plan models',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Reading usage…',
      unavailable: 'The opencode-usage-dsh host half is not running in this profile.',
      noKey: 'No OpenCode API key is configured (OPENCODE_GO_API_KEY / OPENCODE_API_KEY).',
      failed: 'Could not read usage',
      retry: 'Try again',
      updated: 'Updated ',
      unavailableWindow: 'not reported',
    }

    const zh = {
      nav: 'OpenCode 用量',
      title: 'OpenCode 用量',
      intro: '当前 opencode.ai Zen / Go 套餐的三档额度：5 小时滚动、每周、每月。',
      rolling: '5 小时滚动',
      weekly: '每周',
      monthly: '每月',
      usedSuffix: '% 已用',
      resetPrefix: '重置于 ',
      resetPending: '即将重置',
      models: '个套餐模型',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取用量…',
      unavailable: '当前 profile 没有加载 opencode-usage-dsh 的宿主半。',
      noKey: '没有配置 OpenCode 的 API key（OPENCODE_GO_API_KEY / OPENCODE_API_KEY）。',
      failed: '读取用量失败',
      retry: '重试',
      updated: '更新于 ',
      unavailableWindow: '未返回',
    }

    // ------------------------------------------------------------- helpers ---

    /**
     * Used percentage, rounded and clamped, exactly as opencode.ai reports it.
     * The API's `percent` is the consumed share, and opencode's own UI shows that
     * number ("13% used"), so mirror it instead of inverting to the remainder.
     */
    function percentUsed(window) {
      if (!window || typeof window.percent !== 'number' || !Number.isFinite(window.percent)) return null
      return Math.max(0, Math.min(100, Math.round(window.percent)))
    }

    /** Compact countdown, e.g. `4h 19m`, `2d 10h`, `30d 23h`. */
    function countdown(resetsAt, now) {
      if (typeof resetsAt !== 'string') return null
      const target = Date.parse(resetsAt)
      if (Number.isNaN(target)) return null
      const diff = target - now
      if (diff <= 0) return ''
      const minutes = Math.floor(diff / 60_000)
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const mins = minutes % 60
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${mins}m`
      return `${mins}m`
    }

    /** Green → amber → red as the consumed share grows. */
    function barColor(used) {
      if (used === null) return 'rgba(128,128,128,.5)'
      if (used > 85) return '#d05a4e'
      if (used > 60) return '#d99a2b'
      return '#2f9e60'
    }

    function message(error) {
      if (!error) return ''
      if (typeof error === 'string') return error
      return error.message || String(error)
    }

    /** Unwrap the Remote call's discriminated result. */
    function unwrap(result) {
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok) return result.value
        const failure = result.error
        throw new Error(message(failure))
      }
      return result
    }

    // --------------------------------------------------------------- store ---

    /** Minimal observable the slot engine can turn into a `useX` hook. */
    function createStore() {
      let current = { phase: 'loading', accounts: [], fetchedAt: null, error: null }
      const listeners = new Set()
      return {
        getSnapshot: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set: (next) => {
          current = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    // ------------------------------------------------------------------ ui ---

    const styles = {
      head: { margin: '0 0 6px', fontSize: 18, fontWeight: 600 },
      intro: { margin: '0 0 18px', fontSize: 13, lineHeight: 1.55, opacity: 0.72 },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: 12, padding: '16px 18px', marginBottom: 14 },
      cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
      cardTitle: { fontSize: 14, fontWeight: 600 },
      cardSub: { marginTop: 3, fontSize: 12, opacity: 0.66 },
      button: {
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 12,
        cursor: 'pointer',
      },
      row: { marginTop: 12 },
      rowHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 },
      windowLabel: { fontSize: 14, fontWeight: 600, minWidth: 92 },
      badge: {
        fontSize: 12,
        background: 'rgba(128,128,128,.10)',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 6,
        padding: '1px 7px',
      },
      reset: { marginLeft: 'auto', fontSize: 13, opacity: 0.7 },
      track: { height: 8, borderRadius: 999, background: 'rgba(128,128,128,.22)', overflow: 'hidden' },
      hint: { fontSize: 13, lineHeight: 1.6, opacity: 0.8 },
      error: { fontSize: 13, lineHeight: 1.6, color: '#d05a4e' },
    }

    /** One labelled window with its bar. */
    function renderWindow(t, key, label, window, now) {
      const used = percentUsed(window)
      const remaining = countdown(window && window.resetsAt, now)
      const resetText =
        window && window.resetsAt
          ? remaining === ''
            ? t('resetPending')
            : `${t('resetPrefix')}${remaining}`
          : ''
      return React.createElement(
        'div',
        { key, style: styles.row },
        React.createElement(
          'div',
          { style: styles.rowHead },
          React.createElement('span', { style: styles.windowLabel }, label),
          React.createElement(
            'span',
            {
              style: used === null ? styles.badge : { ...styles.badge, color: barColor(used), borderColor: barColor(used) },
            },
            used === null ? t('unavailableWindow') : `${used}${t('usedSuffix')}`,
          ),
          resetText ? React.createElement('span', { style: styles.reset }, resetText) : null,
        ),
        React.createElement(
          'div',
          { style: styles.track },
          React.createElement('div', {
            style: {
              height: '100%',
              width: `${used === null ? 0 : used}%`,
              background: barColor(used),
              transition: 'width .3s ease',
            },
          }),
        ),
      )
    }

    /** One provider's usage card. */
    function renderAccount(t, account, index, now, reload, busy) {
      const usage = account.usage
      const rows = []
      if (usage) {
        rows.push(renderWindow(t, 'rolling', t('rolling'), usage.rolling, now))
        rows.push(renderWindow(t, 'weekly', t('weekly'), usage.weekly, now))
        rows.push(renderWindow(t, 'monthly', t('monthly'), usage.monthly, now))
      }
      const subtitle = [
        account.apiKeyEnv,
        account.modelCount ? `${account.modelCount} ${t('models')}` : null,
        account.keyConfigured === false ? t('noKey') : null,
      ]
        .filter(Boolean)
        .join(' · ')

      return React.createElement(
        'div',
        { key: account.id || String(index), style: styles.card },
        React.createElement(
          'div',
          { style: styles.cardHead },
          React.createElement(
            'div',
            null,
            React.createElement('div', { style: styles.cardTitle }, account.displayName || account.id),
            subtitle ? React.createElement('div', { style: styles.cardSub }, subtitle) : null,
          ),
          React.createElement(
            'button',
            { type: 'button', style: styles.button, onClick: reload, disabled: busy },
            busy ? t('refreshing') : t('refresh'),
          ),
        ),
        account.usageError
          ? React.createElement('div', { style: styles.error }, `${t('failed')}：${account.usageError}`)
          : null,
        ...rows,
      )
    }

    /** The Settings section itself. */
    function UsageSection(props) {
      const t = props.t
      const state = props.useOpencodeUsage((value) => value)
      const reload = props.reload
      const busy = props.useOpencodeUsageBusy ? props.useOpencodeUsageBusy((value) => value) : false
      const [, tick] = React.useState(0)

      // The countdowns are wall-clock facts: re-render them on their own cadence
      // instead of waiting for the next poll.
      React.useEffect(() => {
        const id = setInterval(() => tick((value) => value + 1), 30_000)
        return () => clearInterval(id)
      }, [])

      const now = Date.now()
      const body = []
      if (state.phase === 'loading') {
        body.push(React.createElement('p', { key: 'loading', style: styles.hint }, t('loading')))
      } else if (state.phase === 'unavailable') {
        body.push(React.createElement('p', { key: 'unavailable', style: styles.hint }, t('unavailable')))
      } else {
        if (state.error) {
          body.push(React.createElement('p', { key: 'error', style: styles.error }, `${t('failed')}：${state.error}`))
        }
        if (state.accounts.length === 0) {
          body.push(React.createElement('p', { key: 'empty', style: styles.hint }, t('noKey')))
        }
        for (const [index, account] of state.accounts.entries()) {
          body.push(renderAccount(t, account, index, now, reload, busy))
        }
        if (state.fetchedAt) {
          const at = new Date(state.fetchedAt)
          body.push(
            React.createElement(
              'p',
              { key: 'stamp', style: { ...styles.hint, fontSize: 12, opacity: 0.55 } },
              `${t('updated')}${at.toLocaleTimeString()}`,
            ),
          )
        }
      }

      return React.createElement(
        'div',
        null,
        React.createElement('h2', { style: styles.head }, t('title')),
        React.createElement('p', { style: styles.intro }, t('intro')),
        ...body,
      )
    }

    // ---------------------------------------------------------------- plugin ---

    const inject = ['slots', 'locale', 'remote', 'timer']

    async function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode-usage: dictionaries')

      const store = createStore()
      const busyStore = createStore()
      let namespace = null
      let disposed = false

      const setBusy = (busy) => busyStore.set(busy)

      const load = async (force) => {
        if (disposed) return
        if (!namespace) return
        setBusy(true)
        try {
          if (force) {
            try {
              unwrap(await namespace.refresh())
            } catch {
              /* the snapshot call below reports the same failure */
            }
          }
          // Always send the declared `request` parameter explicitly: the wire
          // descriptor expects one, and an absent JSON payload is not the same
          // as `{}`.
          const state = unwrap(await namespace.snapshot({ refresh: false }))
          if (disposed) return
          store.set({
            phase: 'ready',
            accounts: Array.isArray(state && state.accounts) ? state.accounts : [],
            fetchedAt: (state && state.fetchedAt) || null,
            error: (state && state.error) || null,
          })
        } catch (error) {
          if (disposed) return
          store.set({ phase: 'error', accounts: [], fetchedAt: null, error: message(error) })
        } finally {
          setBusy(false)
        }
      }

      ctx.slots.inject(
        'settings.section',
        () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'opencode-usage',
              order: 40,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({
                hooks: { opencodeUsage: store, opencodeUsageBusy: busyStore },
                reload: () => {
                  void load(true)
                },
              }),
            },
            UsageSection,
          ),
      )

      let mountError = null
      try {
        await ctx.remote.$mount(TYPERT_REMOTE)
      } catch (error) {
        mountError = message(error)
        ctx.logger?.warn?.('opencode-usage: failed to mount the %s Remote namespace: %o', SERVICE, error)
      }

      ctx.inject([`remote.${SERVICE}`], (child) => {
        namespace = child.remote[SERVICE]
        void load(false)
      })

      ctx.effect(() => ctx.interval(() => void load(false), 30_000), 'opencode-usage: poll')

      ctx.effect(
        () =>
          ctx.timeout(() => {
            if (disposed || namespace) return
            store.set({
              phase: 'unavailable',
              accounts: [],
              fetchedAt: null,
              error: mountError,
            })
          }, 5000),
        'opencode-usage: host-half grace period',
      )

      ctx.effect(
        () => () => {
          disposed = true
        },
        'opencode-usage: disposal',
      )
    }

    exports.NS = NS
    exports.SERVICE = SERVICE
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
