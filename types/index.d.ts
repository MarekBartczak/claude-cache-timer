export type CacheTtl = '5m' | '1h'
export type Tone = 'ok' | 'warn' | 'cold'
export type Line = { text: string; tone: Tone }

declare module 'claude-code' {
  interface PluginState {
    'cache-timer': {
      lastHitAt: number | null
      lastModel: string | null
      learnedTtl: CacheTtl | null
      warnedFor: number | null
      lastActivityAt: number | null
      lastRealHitAt: number | null
      pingsSinceReal: number
      savedSession: number
      line: Line | null
    }
  }
}
