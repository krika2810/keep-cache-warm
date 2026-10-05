export type WarmedAt = number | null

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': {
      /** Epoch ms when the last main-thread request or keep-alive that read or wrote the cache was sent; null before the first. */
      lastWarmAt: WarmedAt
      /** Keep-alives sent since the person last ran a turn. */
      pings: number
      /** Turned off with /cache-keepalive off. */
      isPaused: boolean
    }
  }
}
