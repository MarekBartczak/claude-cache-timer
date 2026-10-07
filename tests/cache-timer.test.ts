import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MODEL = 'claude-opus-5-5'
const MINUTE = 60_000

type Usage = { cache_read_input_tokens: number; cache_creation_input_tokens: number }

const WARM: Usage = { cache_read_input_tokens: 50_000, cache_creation_input_tokens: 500 }
const COLD: Usage = { cache_read_input_tokens: 0, cache_creation_input_tokens: 50_000 }

// The engine beneath the plugin: a clock, the env, status/toast sinks and a model that answers.
const PING: Usage = { cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0 }

const world = (on: On, env: Record<string, string> = {}, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, env)
  mock.store(on, stored)
  const toasts: string[] = []
  let usage: Usage = WARM
  let forkUsage: Usage = PING
  let forks = 0

  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('model.fork', () => {
    forks += 1

    return { value: { isAnswered: true as const, text: 'ok', usage: { input_tokens: 20, output_tokens: 2, ...forkUsage } } }
  })
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 10, output_tokens: 5, ...usage, model: MODEL },
    }
  })

  return {
    clock,
    toasts,
    forks: () => forks,
    answerWith: (next: Usage) => {
      usage = next
    },
    forkWith: (next: Usage) => {
      forkUsage = next
    },
  }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }

const band = async ($: Engine) => {
  const drawn = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const text = await drawn.find({ type: 'Text' })

  return text === undefined ? undefined : { text: text.text, color: text.props.color }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

const step = async ($: Engine, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model: MODEL, messageCount: 1, ...(agentId ? { agentId } : {}) })
  let read = await stream.next()

  while (!read.done) {
    read = await stream.next()
  }

  return read.value
}

const OFF = { options: { keepAlive: 'off' } }

describe('cache-timer', () => {
  test('shows a cold cache before the first request', OFF, async ($, on) => {
    const w = world(on)
    await start($)

    expect((await band($))?.text).toBe('❄ cache cold')
  })

  test('counts the TTL down from the last main-thread request', OFF, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)

    expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h)')

    await w.clock.advance(10 * MINUTE)
    expect((await band($))?.text).toBe('⏳ cache 50:00 (TTL 1h)')
  })

  test('warns once in the last 5 minutes, then shows it expired', OFF, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)

    await w.clock.advance(55 * MINUTE)
    expect(await band($)).toEqual({ text: '⏳ cache 5:00 (TTL 1h)', color: 'warning' })
    expect(w.toasts).toEqual(['Session cache expires in 5:00'])

    await w.clock.advance(4 * MINUTE)
    expect(w.toasts.length).toBe(1)

    await w.clock.advance(3 * MINUTE)
    expect((await band($))?.text).toBe('❄ cache expired 2 min ago (TTL 1h)')
  })

  test('a new request resets the countdown', OFF, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(20 * MINUTE)
    await step($)

    expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h)')
  })

  test("a subagent's request leaves the main countdown alone", OFF, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(20 * MINUTE)
    await step($, 'agent-1')

    expect((await band($))?.text).toBe('⏳ cache 40:00 (TTL 1h)')
  })

  test('learns a 5m TTL from a miss after a 10 minute gap', OFF, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await w.clock.advance(10 * MINUTE)
    w.answerWith(COLD)
    await step($)

    expect((await band($))?.text).toBe('⏳ cache 5:00 (TTL 5m)')
  })

  test('takes the TTL from CLAUDE_CODE_PROMPT_CACHE_TTL', OFF, async ($, on) => {
    const w = world(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
    await start($)
    await step($)

    expect((await band($))?.text).toBe('⏳ cache 5:00 (TTL 5m)')
  })

  test('a model switch starts the cache cold with the TTL the engine reports', OFF, async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    await $.classic.PostModelSwitch({
      from_model: MODEL,
      to_model: 'claude-sonnet-5-5',
      requested_model: 'sonnet',
      source: 'command',
      context_tokens: 0,
      prompt_cache_warm: true,
      cache_ttl: '5m',
      estimated_cache_write_usd: 0,
      pricing: 'catalog',
    })

    expect((await band($))?.text).toBe('❄ cache cold')

    await step($)
    expect((await band($))?.text).toBe('⏳ cache 5:00 (TTL 5m)')
  })

  test('a resumed session counts from its last response', OFF, async ($, on) => {
    const w = world(on)
    await start($)
    await $.classic.SessionStart({ source: 'resume', model: MODEL, seconds_since_last_response: 600 })

    expect((await band($))?.text).toBe('⏳ cache 50:00 (TTL 1h)')
  })

  describe('keep-alive', () => {
    test('refreshes the cache shortly before it expires while idle', async ($, on) => {
      const w = world(on)
      await start($)
      await step($)
      expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h) · ⟳ keep-alive 4h 0m')

      await w.clock.advance(58 * MINUTE)
      expect(w.forks()).toBe(1)
      expect(w.toasts).toContain('⟳ Cache refreshed (50k tokens read from cache)')
      // ping cost: 20 input + 50k read × 0.05 + 2 output × 5 = 2530
      expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h) · ⟳ keep-alive 3h 2m · saved ~-2.5k tok')
    })

    test('stops once the window after the last activity is over', { options: { keepAlive: '1h' } }, async ($, on) => {
      const w = world(on)
      await start($)
      await step($)
      await w.clock.advance(61 * MINUTE)
      await w.clock.advance(61 * MINUTE)

      expect(w.forks()).toBe(1)
      expect((await band($))?.text).toBe('❄ cache expired 4 min ago (TTL 1h) · saved ~-2.5k tok')
    })

    test('a prompt restarts the window', async ($, on) => {
      const w = world(on)
      on('prompt.submit', (_$, e) => ({ text: e.text }))
      await start($)
      for (const _hour of [1, 2, 3]) {
        await w.clock.advance(60 * MINUTE)
      }

      await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
      await step($)

      expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h) · ⟳ keep-alive 4h 0m')
    })

    test('a ping that finds the cache gone does not retry', async ($, on) => {
      const w = world(on)
      w.forkWith(COLD)
      await start($)
      await step($)
      await w.clock.advance(59 * MINUTE)

      expect(w.forks()).toBe(1)
      expect(w.toasts).toContain('Keep-alive found the cache already gone; not refreshing further')
    })

    test('does not ping while a turn is running', async ($, on) => {
      const w = world(on)
      await start($)
      await step($)
      await $.turn.start({ text: 'long task', turnId: 't' })
      await w.clock.advance(59 * MINUTE)

      expect(w.forks()).toBe(0)
    })
  })

  describe('saved tokens', () => {
    test('credits the rewrite a keep-alive spared when you come back', async ($, on) => {
      const w = world(on)
      await start($)
      await step($)
      await w.clock.advance(58 * MINUTE)
      await w.clock.advance(12 * MINUTE)
      await step($)

      // 50k read instead of re-written at 1h: 50k × (2 − 0.05) = 97500, minus the 2530 ping
      expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h) · ⟳ keep-alive 2h 50m · saved ~95k tok')
    })

    test('credits nothing when you come back before the cache would have lapsed', async ($, on) => {
      const w = world(on)
      await start($)
      await step($)
      await w.clock.advance(58 * MINUTE)
      await w.clock.advance(1 * MINUTE)
      await step($)

      expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h) · ⟳ keep-alive 3h 1m · saved ~-2.5k tok')
    })

    test('keeps a running total across sessions', async ($, on) => {
      const w = world(on, {}, { savedTotal: 1_000_000 })
      await start($)
      await step($)
      await w.clock.advance(58 * MINUTE)
      await w.clock.advance(12 * MINUTE)
      await step($)

      expect((await band($))?.text).toBe('⏳ cache 60:00 (TTL 1h) · ⟳ keep-alive 2h 50m · saved ~95k tok (Σ 1.1M)')
    })
  })
})
