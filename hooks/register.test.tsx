import { describe, expect, mock, test } from 'claude-code/testing'

import type { Job } from '../types'
import { backgroundIdOf, clockOf, isShown, keyOf, progressOf, taskEndsOf } from './register'

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

const notification = (...ends: Array<[id: string, status: string]>) => ({
  message: {
    type: 'user' as const,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: ends.map(([id, status]) => `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>`).join('\n') }],
  },
  door: 'queue' as const,
  origin: { kind: 'task-notification' as const },
  uuid: `n-${ends.map(([id]) => id).join('-')}`,
})

describe('keyOf', () => {
  const bash = (command: string) => keyOf('Bash', { command })

  test('a script is learned under its file name and its flags', () => {
    expect(bash('cd /repo && ./scripts/build.ps1 -Target web')).toBe('Bash:build.ps1 -Target web')
    expect(bash('$o = & "C:\\My Scripts\\build.ps1" -Quick')).toBe('Bash:build.ps1 -Quick')
    expect(bash('python -u tools/gen.py --out=dist')).toBe('Bash:gen.py --out dist')
    expect(bash('Set-Location D:\\repo; ./build.ps1')).toBe('Bash:build.ps1')
  })

  test('a file a command only names is not a script run', () => {
    expect(bash('git add build.sh')).toBe('Bash:git add')
    expect(bash('git commit -m "fix build.ps1"')).toBe('Bash:git commit -m')
    expect(bash('cat deploy.py')).toBe('Bash:cat')
  })

  test('a program is learned under up to two subcommands', () => {
    expect(bash('npm run build')).toBe('Bash:npm run build')
    expect(bash('npm run test')).toBe('Bash:npm run test')
    expect(bash('FOO=1 cargo build --release | tee log')).toBe('Bash:cargo build --release')
    expect(bash('uv run --project app pytest tests/')).toBe('Bash:pytest')
  })

  test('a chain is learned whole', () => {
    expect(bash('npm ci && npm run build')).toBe('Bash:npm ci && npm run build')
    expect(bash('npm ci')).toBe('Bash:npm ci')
  })

  test('free text, per-run values and flag order do not split a key', () => {
    expect(bash('git commit -m "fix: a -b thing"')).toBe(bash('git commit -m "other words"'))
    expect(bash('make all -j 8 -k')).toBe(bash('make all -k -j 16'))
    expect(bash('./validate.ps1 -OutName run7')).toBe(bash('./validate.ps1 -OutName run8'))
  })

  test('a subagent is learned under its type', () => {
    expect(keyOf('Agent', { description: 'Explore the repo', subagent_type: 'Explore' })).toBe('Agent:Explore')
    expect(keyOf('Agent', { description: 'Something else' })).toBe('Agent:general-purpose')
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

test('a quick job shows only once it has run a while, a known long one at once', () => {
  const job: Job = { id: 'j', kind: 'tool', label: 'x', key: 'k', startedAt: 0, expectedMs: null }
  expect(isShown(job, 500)).toBe(false)
  expect(isShown(job, 2_500)).toBe(true)
  expect(isShown({ ...job, doneAt: 300 }, 2_500)).toBe(false)
  expect(isShown({ ...job, expectedMs: 60_000 }, 0)).toBe(true)
})

test('background ids and notifications are read, several to a row', () => {
  expect(backgroundIdOf({ result: {}, text: 'Command running in background with ID: bg-1a_2' })).toBe('bg-1a_2')
  expect(backgroundIdOf({ result: {}, text: 'Async agent launched. agentId: a7f-3' })).toBe('a7f-3')
  expect(backgroundIdOf({ result: {}, text: 'ok' })).toBeNull()
  const said = notification(['bg-1', 'completed'], ['bg-2', 'killed']).message.content[0].text
  expect(taskEndsOf(said)).toEqual([{ id: 'bg-1', callId: undefined, succeeded: true }, { id: 'bg-2', callId: undefined, succeeded: false }])
  expect(taskEndsOf('<task-notification><task-id>x</task-id><tool-use-id>toolu_1</tool-use-id><status>failed</status></task-notification>'))
    .toEqual([{ id: 'x', callId: 'toolu_1', succeeded: false }])
  expect(taskEndsOf('hello')).toEqual([])
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
    await clock.advance(2_500)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: taught ? /ETA 3s/ : /no ETA yet/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(5_000)
    await second
  })
}

test('a quick command never opens the band', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /git status/ })).toBeUndefined()
  await ui.unmount()
})

// (the kit's clock settles one run's end before the next, so this shows the averaging, not the race learn's queue guards against)
test('two overlapping runs both teach', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('tool.call', async (_, e) => {
    await clock.sleep(Number((e as { timeout?: number }).timeout))
    return { result: {}, text: 'ok' }
  })

  const a = $.tool.call({ tool: 'Bash', command: './build.sh', timeout: 10_000 })
  await clock.advance(4_000)
  const b = $.tool.call({ tool: 'Bash', command: './build.sh', timeout: 6_000 })
  await clock.advance(6_000)
  await Promise.all([a, b])
  await clock.advance(4_000)

  // 10 s and 6 s folded one after the other: 8.4 s or 7.6 s, never 10 s or 6 s alone
  const c = $.tool.call({ tool: 'Bash', command: './build.sh', timeout: 10_000 })
  await clock.settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /ETA [89]s/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(10_000)
  await c
})

describe('background tasks', () => {
  type Body = Parameters<typeof test>[1]
  const setUp = (on: Parameters<Body>[1]) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    on('tool.call', async (_, e) => {
      const call = e as { command?: string; run_in_background?: boolean }
      if (call.run_in_background === true) return { result: {}, text: `Command running in background with ID: ${call.command === './a.sh' ? 'bg-1' : 'bg-2'}` }
      await clock.sleep(10_000)
      return { result: {}, text: 'ok' }
    })
    // the engine's own: a band with nothing of the mod's, and a turn's end
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('classic.Stop', () => ({}))
    return clock
  }
  const labelShown = async ($: Parameters<Body>[0], label: RegExp) => {
    const ui = await $.ui.mount(BAND)
    const found = await ui.find({ type: 'Text', text: label })
    await ui.unmount()
    return found !== undefined
  }

  test('a notification ends the task and teaches its duration', async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await clock.advance(4_000)
    expect(await labelShown($, /a\.sh/)).toBe(true)
    await $.session.append(notification(['bg-1', 'completed']))
    await clock.advance(4_000)
    expect(await labelShown($, /a\.sh/)).toBe(false)

    const again = $.tool.call({ tool: 'Bash', command: './a.sh' })
    await clock.settle()
    expect(await labelShown($, /ETA 4s/)).toBe(true)
    await clock.advance(10_000)
    await again
  })

  test('one row ending two tasks ends both', async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await $.tool.call({ tool: 'Bash', command: './b.sh', run_in_background: true })
    await clock.advance(3_000)
    await $.session.append(notification(['bg-1', 'completed'], ['bg-2', 'killed']))
    await clock.advance(4_000)
    expect(await labelShown($, /\.sh/)).toBe(false)
  })

  test('a turn ending with the task no longer in flight drops it', async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await clock.advance(6_000)

    // a list naming its tasks some other way leaves the job alone
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'other', type: 'shell', status: 'running', description: '' }] })
    expect(await labelShown($, /a\.sh/)).toBe(true)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg-1', type: 'shell', status: 'running', description: '' }] })
    expect(await labelShown($, /a\.sh/)).toBe(true)

    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    expect(await labelShown($, /a\.sh/)).toBe(false)
  })
})

test('the terminal keeps Clawd inside the bar past the usual time', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd5:Bash:build.sh': 3_000 })
  on('tool.call', async () => {
    await clock.sleep(10_000)
    return { result: {}, text: 'ok' }
  })

  const run = $.tool.call({ tool: 'Bash', command: './build.sh' })
  await clock.advance(5_000)
  const ui = await $.ui.mount(BAND)
  type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const rowsOf = (n: unknown): Node[] => {
    if (typeof n !== 'object' || n === null) return []
    const node = n as Node
    return [...(node.type === 'Box' && node.props?.width === 32 ? [node] : []), ...(node.children ?? []).flatMap(rowsOf)]
  }
  const [row] = rowsOf(await ui.drawn())
  const cells = (row.children as Node[]).reduce((sum, child) =>
    sum + (child.type === 'Box' ? Number(child.props?.width) : (child.children as string[]).join('').length), 0)
  expect(cells).toBeLessThanOrEqual(32)
  await ui.unmount()
  await clock.advance(5_000)
  await run
})

test('a client attaching or leaving gets its pictures made anew', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd5:Bash:build.sh': 600_000 })
  on('tool.call', async () => {
    await clock.sleep(60_000)
    return { result: {}, text: 'ok' }
  })
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.detach', (_, e) => ({ clientId: e.clientId }))
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
  await clock.advance(10_000)
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
  expect(await startsAt()).toBe('6% - 40s')
  await clock.advance(20_000)
  await run
})
