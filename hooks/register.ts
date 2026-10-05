import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

const MINUTE = 60_000
// The 1-hour cache entry lapses 60 minutes after the request that last read or
// wrote it, counted from when that request was sent, not from when its
// response or the turn finished.
const TTL_MS = 60 * MINUTE
// Pings due later than this are skipped: the entry is probably gone, and a
// ping would pay a full cache write for nothing. The minute of slack covers
// timer drift and the time the ping request takes to reach the API.
const LATEST_PING_MS = TTL_MS - MINUTE
const PING_PROMPT =
  'Automated prompt-cache keep-alive. Do not use tools. Reply with exactly: ok'

const lastWarmAt = atom({ plugin: 'cache-keepalive', key: 'lastWarmAt' } as const, null)
const pings = atom({ plugin: 'cache-keepalive', key: 'pings' } as const, 0)
const isPaused = atom({ plugin: 'cache-keepalive', key: 'isPaused' } as const, false)

// The module's own variables start over on every load; what must survive a
// reload lives in the atoms above.
let idleMs = 55 * MINUTE
let maxPings = 6
let timer: Timer | undefined
let dueAt: number | undefined
let isTurnRunning = false
let isPinging = false

const formatTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

function disarm() {
  timer?.cancel()
  timer = undefined
  dueAt = undefined
}

// Schedules the next ping for idleMs after the cache was last warmed.
async function arm($: EngineInterface) {
  disarm()
  const warmedAt = await read($, lastWarmAt)
  if (warmedAt === null || isTurnRunning || (await read($, isPaused))) {
    return
  }
  const sent = await read($, pings)
  if (maxPings > 0 && sent >= maxPings) {
    $.ui.status(`cache keep-alive: stopped after ${sent} pings`)
    return
  }
  const now = await $.clock.now()
  if (now - warmedAt >= LATEST_PING_MS) {
    $.ui.status('cache keep-alive: cache likely cold')
    return
  }
  const wait = Math.max(warmedAt + idleMs - now, 0)
  dueAt = now + wait
  timer = $.clock.after(wait, () => {
    ping($).catch(err => $.ui.log(`cache-keepalive: ping threw: ${err}`, { to: 'debug' }))
  })
  $.ui.status(
    maxPings > 0 ? `cache keep-alive: armed (${sent}/${maxPings})` : 'cache keep-alive: armed',
  )
}

async function ping($: EngineInterface) {
  timer = undefined
  dueAt = undefined
  if (isTurnRunning || isPinging || (await read($, isPaused))) {
    return
  }
  const warmedAt = await read($, lastWarmAt)
  const now = await $.clock.now()
  // A late timer (the machine slept) finds the entry already gone: skip
  // rather than pay to rebuild a cache nobody may come back to.
  if (warmedAt === null || now - warmedAt >= LATEST_PING_MS) {
    $.ui.status('cache keep-alive: cache likely cold')
    return
  }

  isPinging = true
  const r = await $.model.fork({ prompt: PING_PROMPT }).finally(() => {
    isPinging = false
  })
  if (isTurnRunning) {
    return
  }

  if (!r.isAnswered && r.reason === 'nothing-to-fork') {
    await update($, lastWarmAt, () => null)
    $.ui.status(undefined)
    return
  }
  if (!r.isAnswered && r.reason !== 'empty-reply') {
    $.ui.log(`cache-keepalive: ping failed (${r.reason})`, { to: 'debug' })
    $.ui.status('cache keep-alive: ping failed')
    return
  }

  const { cache_read_input_tokens: hit, cache_creation_input_tokens: wrote } = r.usage
  if (hit === 0 && wrote > 0) {
    // Nothing was served from cache: the TTL is shorter than assumed (the
    // 5-minute cache) or the model changed. Pinging again would only repeat
    // a full cache write, so stand down until the next turn.
    await update($, lastWarmAt, () => null)
    $.ui.status('cache keep-alive: no cache hit, paused until next turn')
    $.ui.toast('cache-keepalive: ping found the cache cold; is the 1-hour TTL on?')
    return
  }

  // `now` was read before the fork was sent, so the countdown runs from no
  // later than the request that refreshed the entry.
  await update($, lastWarmAt, () => now)
  const sent = await update($, pings, n => n + 1)
  $.ui.log(`cache-keepalive: refreshed ${formatTokens(hit)} cached tokens (ping ${sent})`, {
    to: 'debug',
  })
  await arm($)
}

async function describe($: EngineInterface) {
  if (await read($, isPaused)) {
    return 'Cache keep-alive is off. Run /cache-keepalive on to resume.'
  }
  const sent = await read($, pings)
  const limit = maxPings > 0 ? `/${maxPings}` : ''
  if (dueAt === undefined) {
    return `Cache keep-alive is idle (${sent}${limit} pings sent). It arms after the next response.`
  }
  const minutes = Math.max(Math.round((dueAt - (await $.clock.now())) / MINUTE), 0)
  return `Next keep-alive in ${minutes} min (${sent}${limit} pings sent since your last turn).`
}

export const register: Register = (on, options) => {
  // At most 58, so a ping is always due before LATEST_PING_MS.
  idleMs = Math.min(Math.max(Number(options.idleMinutes ?? 55), 1), 58) * MINUTE
  maxPings = Math.max(Number(options.maxPings ?? 6), 0)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'cache-keepalive',
      description: 'Prompt-cache keep-alive: status | on | off | now',
    })
    // A reload keeps $.state, so pick up where the previous load left off.
    await arm($)
    return result
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    disarm()
    return next(e)
  })

  // Each main-thread request reads or writes the cache when it is sent, so its
  // send time (taken before the response streams) is when the TTL restarts.
  // A long response or a long turn therefore can't push the ping past expiry.
  // Subagent steps send their own prefix and don't warm the main thread's.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    const usage = result.usage
    // No usage means no response arrived, so the entry may not have been
    // touched; keep the older, safer timestamp.
    if (usage !== null && usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0) {
      await update($, lastWarmAt, () => sentAt)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      isTurnRunning = false
      await update($, pings, () => 0)
      await arm($)
    }
    return result
  })

  on('command.run', { command: 'cache-keepalive' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off') {
      await update($, isPaused, () => true)
      disarm()
      $.ui.status(undefined)
      return { text: 'Cache keep-alive is off for this session.' }
    }
    if (arg === 'on') {
      await update($, isPaused, () => false)
      await update($, pings, () => 0)
      await arm($)
      return { text: await describe($) }
    }
    if (arg === 'now') {
      await ping($)
      return { text: `Keep-alive attempted. ${await describe($)}` }
    }
    return { text: await describe($) }
  })
}
