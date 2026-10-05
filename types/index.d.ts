export type WarmedAt = number | null

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': {
      /** Epoch ms of the last main-thread response or keep-alive; null before the first. */
      lastWarmAt: WarmedAt
      /** Keep-alives sent since the person last ran a turn. */
      pings: number
      /** Turned off with /cache-keepalive off. */
      isPaused: boolean
    }
  }
}
