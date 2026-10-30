import { describe, expect, mock, test } from 'claude-code/testing'

import type { Job } from '../types'
import { backgroundIdOf, clockOf, keyOf, progressOf, taskEndOf } from './register'

const BAND = {
  plugin: 'live-progress',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

describe('keyOf', () => {
  const bash = (command: string) => keyOf('Bash', { command })

  test('a script is learned under its file name and its flags', () => {
    expect(bash('cd /repo && ./scripts/build.ps1 -Target web')).toBe('Bash:build.ps1 -Target web')
    expect(bash('$o = & "C:\\repo\\build.ps1" -Quick')).toBe('Bash:build.ps1 -Quick')
    expect(bash('python tools/gen.py --out=dist')).toBe('Bash:gen.py --out dist')
  })

  test('a program is learned under up to two subcommands', () => {
    expect(bash('npm run build')).toBe('Bash:npm run build')
    expect(bash('npm run test')).toBe('Bash:npm run test')
    expect(bash('FOO=1 cargo build --release | tee log')).toBe('Bash:cargo build --release')
    expect(bash('uv run --project app pytest tests/')).toBe('Bash:pytest')
  })

  test('free text and flag order do not split a key', () => {
    expect(bash('git commit -m "fix: a -b thing"')).toBe(bash('git commit -m "other words"'))
    expect(bash('make all -j 8 -k')).toBe(bash('make all -k -j 8'))
  })

  test('a call without a command falls back to its description', () => {
    expect(keyOf('Agent', { description: 'Explore the repo' })).toBe('Agent:Explore the repo')
  })
})

test('clockOf says seconds, minutes and hours', () => {
  expect(clockOf(45_000)).toBe('45s')
  expect(clockOf(61_000)).toBe('1m')
  expect(clockOf(61_000, true)).toBe('2m')
  expect(clockOf(80 * 60_000)).toBe('1h20m')
})

test('progressOf moves from run to near to over', () => {
  const job: Job = { id: 'j', kind: 'tool', label: 'x', key: 'k', startedAt: 0, expectedMs: 100_000 }
  expect(progressOf(job, 50_000)).toMatchObject({ mood: 'run', share: 0.5 })
  expect(progressOf(job, 90_000).mood).toBe('near')
  expect(progressOf(job, 120_000)).toMatchObject({ mood: 'over', words: '2m - 20s over the usual 1m' })
  expect(progressOf({ ...job, expectedMs: null }, 3_000).mood).toBe('sleep')
  expect(progressOf({ ...job, doneAt: 7_000 }, 9_000)).toMatchObject({ mood: 'done', words: 'done in 7s' })
})

test('a background call and its notification are read with any id', () => {
  expect(backgroundIdOf({ result: {}, text: 'Command running in background with ID: bg-1a_2' })).toBe('bg-1a_2')
  expect(backgroundIdOf({ result: {}, text: 'ok' })).toBeNull()
  const row = (status: string) => ({ content: `<task-notification><task-id>bg-1</task-id><status>${status}</status></task-notification>` })
  expect(taskEndOf(row('completed'))).toEqual({ id: 'bg-1', succeeded: true })
  expect(taskEndOf(row('killed'))).toEqual({ id: 'bg-1', succeeded: false })
  expect(taskEndOf({ content: 'hello' })).toBeNull()
})

for (const [name, answer, taught] of [
  ['a run that succeeded teaches its duration', { result: {}, text: 'ok' }, true],
  ['a run that failed teaches nothing', { result: {}, text: 'boom', isError: true }, false],
] as const) {
  test(name, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    on('tool.call', async () => {
      await clock.sleep(5_000)
      return answer
    })

    const first = $.tool.call({ tool: 'Bash', command: './build.sh' })
    await clock.advance(5_000)
    await first
    await clock.advance(4_000)  // past the "done" moment

    const second = $.tool.call({ tool: 'Bash', command: './build.sh' })
    await clock.settle()
    const ui = await $.ui.mount(BAND)
    const words = await ui.find({ type: 'Text', text: taught ? /ETA 5s/ : /no ETA yet/ })
    expect(words).toBeDefined()
    await ui.unmount()
    await clock.advance(5_000)
    await second
  })
}

test('a client attaching again gets its pictures made anew', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd4:Bash:build.sh': 600_000 })
  on('tool.call', async () => {
    await clock.sleep(60_000)
    return { result: {}, text: 'ok' }
  })
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  // the words the picture starts with: where the job stood when the picture was made
  const startsAt = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const said = /\d+% - \d+s/.exec(JSON.stringify(await ui.drawn()))?.[0]
    await ui.unmount()
    return said
  }

  const run = $.tool.call({ tool: 'Bash', command: './build.sh' })
  await clock.settle()
  expect(await startsAt()).toBe('0% - 0s')
  await clock.advance(30_000)
  expect(await startsAt()).toBe('0% - 0s')  // kept: a new source would reload the frame
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(await startsAt()).toBe('5% - 30s')
  await clock.advance(30_000)
  await run
})
