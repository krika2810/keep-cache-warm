import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

const MINUTE = 60_000

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

// The engine beneath the plugin: a mocked clock, a counted fork, and the
// bottom of every event the plugin passes on.
function world(on: On, reply: () => ModelForkResult = () => warm(90_000)) {
  const clock = mock.clock(on)
  const forks: string[] = []
  const statuses: (string | undefined)[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: reply() }
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
  return { clock, forks, statuses }
}

async function startAndAnswer($: Engine, turnId = 't1') {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' })
}

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

test('a new turn before minute 55 resets the countdown', async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  await clock.advance(50 * MINUTE)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await clock.advance(10 * MINUTE)
  expect(forks.length).toBe(0)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })

  await clock.advance(54 * MINUTE)
  expect(forks.length).toBe(0)
  await clock.advance(1 * MINUTE)
  expect(forks.length).toBe(1)
})

test('subagent turns do not count as activity', async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  await clock.advance(30 * MINUTE)
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

test('stands down when the ping finds the cache cold', async ($, on) => {
  const { clock, forks } = world(on, () => cold)
  await startAndAnswer($)

  await clock.advance(3 * 55 * MINUTE)
  expect(forks.length).toBe(1)
})

test('/cache-keepalive off stops pings, on resumes them', async ($, on) => {
  const { clock, forks } = world(on)
  await startAndAnswer($)

  const off = await $.command.run({ command: 'cache-keepalive', args: 'off', origin: 'user', presentation: 'text' } as never)
  expect(off.text).toContain('off')
  await clock.advance(55 * MINUTE)
  expect(forks.length).toBe(0)

  await $.turn.start({ text: 'x', turnId: 't3' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
  await $.command.run({ command: 'cache-keepalive', args: 'on', origin: 'user', presentation: 'text' } as never)
  await clock.advance(55 * MINUTE)
  expect(forks.length).toBe(1)
})
