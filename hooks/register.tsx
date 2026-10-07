import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheTtl, Line, Tone } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * MINUTE, '1h': HOUR }
const KEEP_ALIVE_MS: Record<string, number> = { off: 0, '1h': HOUR, '2h': 2 * HOUR, '4h': 4 * HOUR, '8h': 8 * HOUR }
const PING_PROMPT = 'Keep-alive ping for the prompt cache. Reply with the single word: ok'

// API price ratios against one uncached input token; savings are counted in these units.
const WRITE_WEIGHT: Record<CacheTtl, number> = { '5m': 1.25, '1h': 2 }
const OUTPUT_WEIGHT = 5
const readWeight = (model: string): number =>
  /fable-5-1|mythos-5-1/.test(model) ? 0.025 : /opus-5-5/.test(model) ? 0.05 : 0.1

const lastHitAt = atom({ plugin: 'cache-timer', key: 'lastHitAt' } as const, null)
const lastModel = atom({ plugin: 'cache-timer', key: 'lastModel' } as const, null)
const learnedTtl = atom({ plugin: 'cache-timer', key: 'learnedTtl' } as const, null)
const warnedFor = atom({ plugin: 'cache-timer', key: 'warnedFor' } as const, null)
const lastActivityAt = atom({ plugin: 'cache-timer', key: 'lastActivityAt' } as const, null)
const lastRealHitAt = atom({ plugin: 'cache-timer', key: 'lastRealHitAt' } as const, null)
const pingsSinceReal = atom({ plugin: 'cache-timer', key: 'pingsSinceReal' } as const, 0)
const savedSession = atom({ plugin: 'cache-timer', key: 'savedSession' } as const, 0)
const line = atom({ plugin: 'cache-timer', key: 'line' } as const, null)

const COLORS: Record<Tone, string> = { ok: 'subtle', warn: 'warning', cold: 'inactive' }

type Config = { assumedTtl: CacheTtl; keepAliveMs: number }

const formatLeft = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const formatSpan = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / MINUTE))

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

const formatTokens = (n: number): string => {
  const abs = Math.abs(n)
  const text =
    abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(1)}M` : abs >= 1000 ? `${(abs / 1000).toFixed(abs < 10_000 ? 1 : 0)}k` : `${Math.round(abs)}`

  return n < 0 ? `-${text}` : text
}

const isTtl = (value: unknown): value is CacheTtl => value === '5m' || value === '1h'

let shown: string | undefined
let timer: { cancel: () => void } | undefined
let isWorking = false
let isPinging = false
let pingedFor: number | undefined
let savedTotal = 0

const show = async ($: EngineInterface, text: string, tone: Tone) => {
  if (text !== shown) {
    shown = text
    const next: Line = { text, tone }
    await update($, line, () => next)
  }
}

const credit = async ($: EngineInterface, delta: number) => {
  await update($, savedSession, n => n + delta)
  savedTotal += delta
  await $.store.set('savedTotal', savedTotal)
}

// What a request cost, in uncached-input-token units.
const costOf = (model: string, ttl: CacheTtl, usage: ModelUsage): number =>
  usage.input_tokens +
  usage.cache_read_input_tokens * readWeight(model) +
  usage.cache_creation_input_tokens * WRITE_WEIGHT[ttl] +
  usage.output_tokens * OUTPUT_WEIGHT

// Re-sends the main thread's last request (nothing joins the transcript): a cache read
// refreshes the entry's timer for a fraction of what re-writing it costs.
const ping = async ($: EngineInterface, ttl: CacheTtl): Promise<string> => {
  const at = await read($, lastHitAt)
  isPinging = true
  pingedFor = at ?? undefined

  try {
    const sentAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: PING_PROMPT })

    if (!reply.isAnswered) {
      return `Keep-alive failed: ${reply.reason}`
    }

    const cached = reply.usage.cache_read_input_tokens
    await credit($, -costOf((await read($, lastModel)) ?? '', ttl, reply.usage))

    if (cached === 0) {
      return 'Keep-alive found the cache already gone; not refreshing further'
    }

    await update($, lastHitAt, () => sentAt)
    await update($, pingsSinceReal, n => n + 1)

    return `⟳ Cache refreshed (${Math.round(cached / 1000)}k tokens read from cache)`
  } finally {
    isPinging = false
  }
}

const savedSuffix = async ($: EngineInterface): Promise<string> => {
  const session = await read($, savedSession)

  if (session === 0 && savedTotal === 0) {
    return ''
  }

  const total = savedTotal !== session ? ` (Σ ${formatTokens(savedTotal)})` : ''

  return ` · saved ~${formatTokens(session)} tok${total}`
}

const tick = async ($: EngineInterface, config: Config) => {
  const at = await read($, lastHitAt)
  const saved = await savedSuffix($)

  if (at === null) {
    await show($, `❄ cache cold${saved}`, 'cold')

    return
  }

  const ttl = (await read($, learnedTtl)) ?? config.assumedTtl
  const now = await $.clock.now()
  const left = at + TTL_MS[ttl] - now

  if (left <= 0) {
    await show($, `❄ cache expired ${Math.floor(-left / MINUTE)} min ago (TTL ${ttl})${saved}`, 'cold')

    return
  }

  const activeUntil = ((await read($, lastActivityAt)) ?? now) + config.keepAliveMs
  const isKeptAlive = config.keepAliveMs > 0 && now < activeUntil
  const lead = Math.min(2 * MINUTE, TTL_MS[ttl] / 5)

  if (isKeptAlive && left <= lead && !isWorking && !isPinging && pingedFor !== at) {
    void ping($, ttl).then(async text => {
      $.ui.toast(text, { timeoutMs: 6000 })
      await tick($, config)
    })
  }

  const warnAt = Math.min(5 * MINUTE, TTL_MS[ttl] / 5)
  const isWarning = left <= warnAt && !isKeptAlive

  if (isWarning && (await read($, warnedFor)) !== at) {
    await update($, warnedFor, () => at)
    $.ui.toast(`Session cache expires in ${formatLeft(left)}`, { timeoutMs: 8000 })
  }

  const suffix = isKeptAlive ? ` · ⟳ keep-alive ${formatSpan(activeUntil - now)}` : ''
  await show($, `⏳ cache ${formatLeft(left)} (TTL ${ttl})${suffix}${saved}`, isWarning ? 'warn' : 'ok')
}

// The first real request after the cache would have lapsed without keep-alive pings: what it
// read from the cache would otherwise have been written again.
const creditRescue = async ($: EngineInterface, config: Config, sentAt: number, model: string, usage: ModelUsage) => {
  const realAt = await read($, lastRealHitAt)
  const ttl = (await read($, learnedTtl)) ?? config.assumedTtl
  const isRescue = realAt !== null && (await read($, pingsSinceReal)) > 0 && sentAt > realAt + TTL_MS[ttl]

  if (isRescue && usage.cache_read_input_tokens > 0) {
    await credit($, usage.cache_read_input_tokens * (WRITE_WEIGHT[ttl] - readWeight(model)))
  }

  await update($, lastRealHitAt, () => sentAt)
  await update($, pingsSinceReal, () => 0)
}

// A request after a gap between 5m and 1h tells which TTL the cache really has.
const learn = async ($: EngineInterface, sentAt: number, model: string, usage: ModelUsage) => {
  const prev = await read($, lastHitAt)

  if (prev === null || (await read($, lastModel)) !== model) {
    return
  }

  const gap = sentAt - prev
  const isTelling = gap > TTL_MS['5m'] + 30_000 && gap < TTL_MS['1h'] - MINUTE

  if (isTelling && usage.cache_read_input_tokens > 0) {
    await update($, learnedTtl, () => '1h' as const)
  } else if (isTelling && usage.cache_creation_input_tokens > 0) {
    await update($, learnedTtl, () => '5m' as const)
  }
}

export const register: Register = (on, options) => {
  const config: Config = {
    assumedTtl: isTtl(options.ttl) ? options.ttl : '1h',
    keepAliveMs: KEEP_ALIVE_MS[String(options.keepAlive)] ?? 0,
  }

  on('session.start', async ($, e, next) => {
    const fromEnv = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
    config.assumedTtl = isTtl(fromEnv) ? fromEnv : config.assumedTtl
    shown = undefined
    savedTotal = Number((await $.store.get('savedTotal')) ?? 0) || 0
    $.ui.status(undefined)

    if ((await read($, lastActivityAt)) === null) {
      const now = await $.clock.now()
      await update($, lastActivityAt, () => now)
    }

    await $.command.register({ name: 'cache-ping', description: 'Refresh the session prompt cache now (keep-alive)' })
    timer?.cancel()
    timer = $.clock.every(1000, () => void tick($, config))
    await tick($, config)

    return next(e)
  })

  on('command.run', { command: 'cache-ping' }, async $ => {
    const at = await read($, lastHitAt)
    const ttl = (await read($, learnedTtl)) ?? config.assumedTtl

    if (at === null || at + TTL_MS[ttl] <= (await $.clock.now())) {
      return { text: 'No warm cache to refresh.' }
    }

    const text = await ping($, ttl)
    await tick($, config)

    return { text }
  })

  // What the person does counts as activity; the keep-alive window runs from it.
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, lastActivityAt, () => now)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    isWorking = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isWorking = false

    return next(e)
  })

  // Only the main thread's requests: subagents cache their own prefixes.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    const sentAt = await $.clock.now()
    const response = yield* next(e)

    if (response.usage !== null) {
      await creditRescue($, config, sentAt, e.model, response.usage)
      await learn($, sentAt, e.model, response.usage)
      await update($, lastHitAt, () => sentAt)
      await update($, lastModel, () => e.model)
      await tick($, config)
    }

    return response
  })

  // The engine knows the TTL here; the new model's cache starts cold.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, learnedTtl, () => e.cache_ttl)
    await update($, lastHitAt, () => null)
    await update($, lastModel, () => e.to_model)
    await tick($, config)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.seconds_since_last_response !== undefined) {
      const at = (await $.clock.now()) - e.seconds_since_last_response * 1000
      await update($, lastHitAt, () => at)
      await update($, lastModel, () => e.model ?? null)
      await tick($, config)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Our own band above the prompt: the status line would prefix it with a warning icon.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, line)

    if (e.props.hasSurvey || current === null) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)

    return <Text color={COLORS[current.tone]}>{current.text}</Text>
  })
}
