import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, TurnStepInput, TurnStepResult, TurnUsage } from 'claude-code'

const MINUTE = 60_000
const MODEL = 'claude-opus-5-5'

const warm = (read: number): ModelForkResult => ({
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: read, cache_creation_input_tokens: 0 },
})

const cold: ModelForkResult = {
  isAnswered: true,
  text: 'ok',
  usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 },
}

const stepUsage: TurnUsage = {
  model: MODEL,
  input_tokens: 40,
  output_tokens: 300,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 500,
}

type Step = { responseMs?: number; usage?: TurnUsage | null }

// The engine beneath the plugin: a mocked clock, a counted fork, model
// requests that take `responseMs` to stream, and the bottom of every event
// the plugin passes on.
function world(on: On, reply: () => ModelForkResult = () => warm(90_000)) {
  const clock = mock.clock(on)
  const forks: string[] = []
  const statuses: (string | undefined)[] = []
  const steps = new Map<string, Step>()
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: reply() }
  })
  on('turn.step', async function* (_$, e) {
    const { responseMs = 0, usage = stepUsage } = steps.get(e.turnId) ?? {}
    if (responseMs > 0) {
      await clock.sleep(responseMs)
    }
    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: usage === null ? null : 'end_turn',
      usage,
    }
    return result
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return { clock, forks, statuses, steps }
}

async function drain($: Engine, input: TurnStepInput) {
  const stream = $.turn.step(input)
  for await (const _chunk of stream) {
    // chunks are the engine's; only the result matters here
  }
  return stream.result
}

async function startSession($: Engine) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

// One main-thread turn of one model request, answered at once.
async function turn($: Engine, turnId: string) {
  await $.turn.start({ text: 'hi', turnId })
  await drain($, { turnId, index: 0, model: MODEL, messageCount: 2 })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

async function startAndAnswer($: Engine, turnId = 't1') {
  await startSession($)
  await turn($, turnId)
}

const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'cache-keepalive',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

test('pings once at the 55th idle minute and re-arms', async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  await clock.advance(54 * MINUTE)
  expect(forks.length).toBe(0)

  await clock.advance(1 * MINUTE)
  expect(forks.length).toBe(1)

  await clock.advance(54 * MINUTE)
  expect(forks.length).toBe(1)
  await clock.advance(1 * MINUTE)
  expect(forks.length).toBe(2)
})

test('the countdown runs from when the request was sent, not when the turn ended', async ($, on) => {
  const { clock, forks, steps } = world(on)
  await startSession($)
  steps.set('t1', { responseMs: 20 * MINUTE })

  await $.turn.start({ text: 'long one', turnId: 't1' })
  const step = drain($, { turnId: 't1', index: 0, model: MODEL, messageCount: 2 })
  await clock.advance(20 * MINUTE)
  await step
  await $.turn.complete({ answer: 'done', durationMs: 20 * MINUTE, isAborted: false, turnId: 't1', reason: 'answer' })

  // 55 minutes after the request went out, 35 after the turn ended.
  await clock.advance(34 * MINUTE)
  expect(forks.length).toBe(0)
  await clock.advance(1 * MINUTE)
  expect(forks.length).toBe(1)
})

test('a turn whose last request is past the deadline does not ping a cold cache', async ($, on) => {
  const { clock, forks, statuses, steps } = world(on)
  await startSession($)
  steps.set('t1', { responseMs: 59 * MINUTE })

  await $.turn.start({ text: 'very long one', turnId: 't1' })
  const step = drain($, { turnId: 't1', index: 0, model: MODEL, messageCount: 2 })
  await clock.advance(59 * MINUTE)
  await step
  await $.turn.complete({ answer: 'done', durationMs: 59 * MINUTE, isAborted: false, turnId: 't1', reason: 'answer' })

  await clock.advance(120 * MINUTE)
  expect(forks.length).toBe(0)
  expect(statuses.at(-1)).toBe('cache keep-alive: cache likely cold')
})

test('a request with no response does not count as warming the cache', async ($, on) => {
  const { clock, forks, steps } = world(on)
  await startAndAnswer($)

  await clock.advance(30 * MINUTE)
  steps.set('t2', { usage: null })
  await turn($, 't2')

  // Still timed from t1's request at minute 0, not t2's at minute 30.
  await clock.advance(25 * MINUTE)
  expect(forks.length).toBe(1)
})

test('a new turn before minute 55 resets the countdown', async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  await clock.advance(50 * MINUTE)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.advance(10 * MINUTE)
  expect(forks.length).toBe(0)
  await drain($, { turnId: 't2', index: 0, model: MODEL, messageCount: 4 })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })

  await clock.advance(54 * MINUTE)
  expect(forks.length).toBe(0)
  await clock.advance(1 * MINUTE)
  expect(forks.length).toBe(1)
})

test('subagent requests and turns do not count as activity', async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  await clock.advance(30 * MINUTE)
  await drain($, { turnId: 's', index: 0, model: MODEL, messageCount: 2, agentId: 'a1' })
  await $.turn.complete({ answer: 'sub', durationMs: 1, isAborted: false, turnId: 's', agentId: 'a1', reason: 'answer' })
  await clock.advance(25 * MINUTE)
  expect(forks.length).toBe(1)
})

test('stops after maxPings in a row', { options: { maxPings: 2 } }, async ($, on) => {
  const { clock, forks, statuses } = world(on)
  await startAndAnswer($)

  await clock.advance(5 * 55 * MINUTE)
  expect(forks.length).toBe(2)
  expect(statuses.at(-1)).toBe('cache keep-alive: stopped after 2 pings')
})

test('idleMinutes is capped below the deadline so the ping still goes out', { options: { idleMinutes: 59 } }, async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  await clock.advance(58 * MINUTE)
  expect(forks.length).toBe(1)
})

test('stands down when the ping finds the cache cold', async ($, on) => {
  const { clock, forks, statuses } = world(on, () => cold)
  await startAndAnswer($)

  await clock.advance(3 * 55 * MINUTE)
  expect(forks.length).toBe(1)
  expect(statuses.at(-1)).toBe('cache keep-alive: no cache hit, paused until next turn')
})

test('/cache-keepalive off stops pings, on resumes them', async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  const off = await run($, 'off')
  expect(off.text).toContain('off')
  await clock.advance(55 * MINUTE)
  expect(forks.length).toBe(0)

  await turn($, 't3')
  await run($, 'on')
  await clock.advance(55 * MINUTE)
  expect(forks.length).toBe(1)
})
