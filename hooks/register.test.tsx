import { describe, expect, mock, test } from 'claude-code/testing'

import type { Job } from '../types'
import { backgroundIdOf, clawdRows, clawdSvg, clockOf, isShown, keyOf, progressOf, taskEndsOf } from './register'
import type { Cell } from './register'

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

  test('a wrapper counts by what it runs, a script by its subcommands', () => {
    expect(bash('timeout 600 pytest')).toBe('Bash:pytest')
    expect(bash('timeout -k 5 60 ./quick.sh')).toBe('Bash:quick.sh')
    expect(bash('time npm run build')).toBe('Bash:npm run build')
    expect(bash('env FOO=1 make all')).toBe('Bash:make all')
    expect(bash('npx tsx a.ts')).not.toBe(bash('npx tsx b.ts'))
    expect(bash('python manage.py migrate')).toBe('Bash:manage.py migrate')
    expect(bash('python manage.py migrate')).not.toBe(bash('python manage.py runserver'))
  })

  test('quoted free text never counts, a quoted script path does', () => {
    expect(bash('git commit -m "fix scripts/build.sh"')).toBe('Bash:git commit -m')
    expect(bash('pwsh -NoProfile -Command "& ./build.ps1"')).toBe('Bash:build.ps1')
    expect(keyOf('Bash', { command: 'cd foo', description: 'Go to foo' })).toBe('Bash:')
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

describe('the terminal Clawd', () => {
  const job = (more: Partial<Job> = {}): Job => ({ id: 'j', kind: 'tool', label: 'x', key: 'k', startedAt: 0, expectedMs: 20_000, ...more })
  const EYE = '#1f1e1d'
  // where his eyes are: the cells with the eye colour, above or below
  const eyesOf = (rows: Cell[][]) => rows.flatMap(r => r.flatMap((c, x) => (c.fg === EYE || c.bg === EYE ? [x] : [])))
  const colours = (rows: Cell[][]) => new Set(rows.flat().flatMap(c => [c.fg, c.bg]).filter(Boolean))
  const top = (rows: Cell[][]) => rows[0].map(c => c.ch).join('')

  test('he is four rows over the whole bar, with two eyes', () => {
    const rows = clawdRows(job(), 4_000)
    expect(rows.length).toBe(4)
    for (const r of rows) expect(r.length).toBe(32)
    expect(eyesOf(rows).length).toBe(2)
  })

  test('he stands over the end of the filled part', () => {
    expect(eyesOf(clawdRows(job(), 0))).toEqual([3, 7])
    expect(eyesOf(clawdRows(job(), 8_000))).toEqual([3 + 8, 7 + 8])  // 0.4 of the 21 cells he walks
  })

  test('his legs step four times a second', () => {
    const feet = (t: number) => clawdRows(job({ expectedMs: 600_000 }), t)[3].map(c => c.ch).join('')  // long: he stays on his cell
    expect(feet(4_000)).not.toBe(feet(4_500))
    expect(feet(4_000)).toBe(feet(5_000))
  })

  test('he hops half way', () => {
    for (const t of [9_000, 9_250, 9_500, 9_750]) expect(top(clawdRows(job(), t))).not.toMatch(/[▀█]/)
    expect(top(clawdRows(job(), 10_100))).toMatch(/[▀█]/)
  })

  test('past the usual time he is red and sweats at the end of the bar', () => {
    const rows = clawdRows(job(), 25_000)
    expect(eyesOf(rows)).toEqual([24, 28])
    expect(colours(rows)).toContain('#d9534f')
    expect(colours(rows)).toContain('#8fd0ff')
    expect(colours(rows)).not.toContain('#D97757')
  })

  test('on a first run he dozes at the start with a blinking z', () => {
    const asleep = (t: number) => clawdRows(job({ expectedMs: null }), t)
    expect(eyesOf(asleep(3_000))).toEqual([3, 7])
    expect(asleep(4_000).flat().some(c => c.ch === 'z')).toBe(true)
    expect(asleep(5_000).flat().some(c => c.ch === 'z')).toBe(false)
  })

  test('done, he jumps at the end of the bar under confetti', () => {
    const done = (t: number) => clawdRows(job({ doneAt: 20_000 }), t)
    expect(new Set([0, 250, 500, 750].map(dt => eyesOf(done(20_000 + dt))[0]))).toEqual(new Set([24]))
    expect(new Set([0, 250, 500, 750].map(dt => top(done(20_000 + dt))))).not.toEqual(new Set([top(done(20_000))]))
    expect([...colours(done(20_500))].filter(c => !['#D97757', EYE].includes(c as string)).length).toBeGreaterThanOrEqual(3)
  })

  test('dust kicks up behind him as he walks', () => {
    expect([0, 250, 500, 750].some(dt => clawdRows(job(), 4_000 + dt).flat().some(c => c.ch === '░'))).toBe(true)
    expect(clawdRows(job({ expectedMs: null }), 4_000).flat().some(c => c.ch === '░')).toBe(false)
  })
})

test('the terminal band is drawn four times a second', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd6:Bash:build.sh': { ms: 60_000, at: 0 } })
  on('tool.call', async () => {
    await clock.sleep(10_000)
    return { result: {}, text: 'ok' }
  })

  const run = $.tool.call({ tool: 'Bash', command: './build.sh' })
  await clock.advance(3_000)
  const ui = await $.ui.mount(BAND)
  const before = JSON.stringify(await ui.drawn())
  await clock.advance(250)
  expect(JSON.stringify(await ui.drawn())).not.toBe(before)
  await ui.unmount()
  await clock.advance(7_000)
  await run
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
  expect(backgroundIdOf({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-9' }, text: 'moved' })).toBe('bg-9')
  expect(taskEndsOf('<task-id>a</task-id><status>completed</status>')).toEqual([])  // nothing outside a notification
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
  mock.store(on, { 'd6:Bash:build.sh': { ms: 3_000, at: 0 } })
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
  // Clawd's rows (the bar's own box, filled by a percent, is not one)
  const rows = rowsOf(await ui.drawn()).filter(r => !(r.children as Node[]).some(c => typeof c.props?.width === 'string'))
  expect(rows.length).toBeGreaterThanOrEqual(4)  // (a blank row is a box of its own as wide)
  for (const row of rows) {
    const cells = (row.children as Node[]).reduce((sum, child) =>
      sum + (child.type === 'Box' ? Number(child.props?.width) : (child.children as string[]).join('').length), 0)
    expect(cells).toBeLessThanOrEqual(32)
  }
  await ui.unmount()
  await clock.advance(5_000)
  await run
})

test('a client attaching or leaving gets its pictures made anew', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd6:Bash:build.sh': { ms: 600_000, at: 0 } })
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

describe('what a run teaches and when a job goes', () => {
  type Body = Parameters<typeof test>[1]
  type Engine = Parameters<Body>[0]
  const engineBand = (on: Parameters<Body>[1]) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('classic.Stop', () => ({}))
    on('classic.PermissionRequest', () => ({}))
  }
  const shows = async ($: Engine, text: RegExp, band: typeof BAND = BAND) => {
    const ui = await $.ui.mount(band)
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found !== undefined
  }
  const said = (block: string) => ({
    message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'text' as const, text: block }] },
    door: 'queue' as const,
    origin: { kind: 'task-notification' as const },
    uuid: `n-${block.length}`,
  })

  test('a command moved to the background (Ctrl+B) goes on as a task, not done', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engineBand(on)
    on('tool.call', async () => {
      await clock.sleep(3_000)
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-9', backgroundedByUser: true }, text: 'moved to the background' }
    })
    const run = $.tool.call({ tool: 'Bash', command: './long.sh' })
    await clock.advance(3_000)
    await run
    await clock.advance(4_000)
    expect(await shows($, /long\.sh/)).toBe(true)
    expect(await shows($, /done in/)).toBe(false)
    await $.session.append(notification(['bg-9', 'completed']))
    await clock.advance(4_000)
    expect(await shows($, /long\.sh/)).toBe(false)
  })

  test('a tool that waits on the person is not shown', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engineBand(on)
    on('tool.call', async () => {
      await clock.sleep(10_000)
      return { result: {}, text: 'answered' }
    })
    const run = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await clock.advance(5_000)
    expect(await shows($, /AskUserQuestion/)).toBe(false)
    await clock.advance(5_000)
    await run
  })

  test('a run that waited on a permission dialog teaches nothing', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engineBand(on)
    on('tool.call', async () => {
      await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: './build.sh' } })
      await clock.sleep(5_000)
      return { result: {}, text: 'ok' }
    })
    const first = $.tool.call({ tool: 'Bash', command: './build.sh' })
    await clock.advance(5_000)
    await first
    await clock.advance(4_000)
    const second = $.tool.call({ tool: 'Bash', command: './build.sh' })
    await clock.advance(2_500)
    expect(await shows($, /no ETA yet/)).toBe(true)
    await clock.advance(5_000)
    await second
  })

  test("a turn's end drops a main-loop call that lost its end, not a subagent's", async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engineBand(on)
    on('tool.call', async () => {
      await clock.sleep(60_000)
      return { result: {}, text: 'ok' }
    })
    const main = $.tool.call({ tool: 'Bash', command: './main.sh' })
    const sub = $.tool.call({ tool: 'Bash', command: './sub.sh', agentId: 'a1' })
    await clock.advance(6_000)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    expect(await shows($, /main\.sh/)).toBe(false)
    expect(await shows($, /sub\.sh/)).toBe(true)
    await clock.advance(60_000)
    await Promise.all([main, sub])
  })

  test("a task the turn's end dropped teaches nothing when its notification comes late", async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engineBand(on)
    on('tool.call', async (_, e) => {
      if ((e as { run_in_background?: boolean }).run_in_background === true) return { result: {}, text: 'Command running in background with ID: bg-1' }
      await clock.sleep(10_000)
      return { result: {}, text: 'ok' }
    })
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await clock.advance(6_000)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    await $.session.append(notification(['bg-1', 'completed']))
    const again = $.tool.call({ tool: 'Bash', command: './a.sh' })
    await clock.advance(2_500)
    expect(await shows($, /no ETA yet/)).toBe(true)
    await clock.advance(10_000)
    await again
  })

  test('a notification is its own row or a queued command, by task or by call; nothing else ends a task', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    engineBand(on)
    const calls: string[] = []
    on('tool.call', async (_, e) => {
      calls.push(e.tool_use_id)
      return e.tool === 'Agent' ? { result: {}, text: 'Async agent launched. agentId: a7f-3' } : { result: {}, text: 'started' }
    })
    await $.tool.call({ tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true })
    await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
    await clock.advance(3_000)
    expect(await shows($, /Look round/)).toBe(true)
    expect(await shows($, /quiet\.sh/)).toBe(true)

    // quoted in a tool's result or a file's attachment: not a notification
    const quote = '<task-notification><task-id>a7f-3</task-id><status>completed</status></task-notification>'
    await $.session.append({ ...said(quote), door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: 'q1' })
    await $.session.append({ message: { type: 'attachment', name: 'nested_memory', content: [{ type: 'text', text: quote }] }, door: 'attachment', origin: { kind: 'engine' }, uuid: 'q2' })
    await clock.advance(4_000)
    expect(await shows($, /Look round/)).toBe(true)

    // delivered into a running turn, as a queued command's attachment
    await $.session.append({ message: { type: 'attachment', name: 'queued_command', content: [{ type: 'text', text: quote }] }, door: 'attachment', origin: { kind: 'engine' }, uuid: 'q3' })
    // a shell task whose id the call's words did not give: named by the call
    await $.session.append(said(`<task-notification><task-id>zz</task-id><tool-use-id>${calls[1]}</tool-use-id><status>completed</status></task-notification>`))
    await clock.advance(4_000)
    expect(await shows($, /Look round/)).toBe(false)
    expect(await shows($, /quiet\.sh/)).toBe(false)
  })

  test('the terminal band shows as many jobs as fit its rows, the latest', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on, { 'd6:Bash:one.sh': { ms: 600_000, at: 0 }, 'd6:Bash:two.sh': { ms: 600_000, at: 0 }, 'd6:Bash:three.sh': { ms: 600_000, at: 0 } })
    on('tool.call', async () => {
      await clock.sleep(60_000)
      return { result: {}, text: 'ok' }
    })
    const runs = []
    for (const name of ['one', 'two', 'three']) {
      runs.push($.tool.call({ tool: 'Bash', command: `./${name}.sh` }))
      await clock.advance(1_000)
    }
    const band = (maxRows: number) => ({ ...BAND, props: { ...BAND.props, maxRows } })
    expect(await shows($, /\+2 more/, band(12))).toBe(true)  // one with Clawd
    expect(await shows($, /three\.sh/, band(12))).toBe(true)
    expect(await shows($, /one\.sh/, band(12))).toBe(false)
    expect(await shows($, /\+1 more/, band(16))).toBe(true)  // two
    const lean = await $.ui.mount(band(8))  // not even one with Clawd: two without him
    expect(await lean.find({ type: 'Text', text: /\+1 more/ })).toBeDefined()
    expect(JSON.stringify(await lean.drawn())).not.toMatch(/[▀▄█]/)
    await lean.unmount()
    await clock.advance(60_000)
    await Promise.all(runs)
  })
})

test('the desktop picture stays under the Svg source limit', () => {
  for (const minutes of [0.05, 1, 3, 10, 60, 299, 300, 301, 1200, 6000]) {
    const e = minutes * 60_000
    for (const share of [0, 0.5, 0.86, 1, 1.5, 3]) {
      const job: Job = { id: 'j', kind: 'tool', label: 'x', key: 'k', startedAt: 1_700_000_000_000, expectedMs: e }
      expect(clawdSvg(job, job.startedAt + share * e).length).toBeLessThanOrEqual(131_072)
    }
  }
})

test('a typed prompt shows the hidden band again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd6:Bash:build.sh': { ms: 60_000, at: 0 } })
  on('tool.call', async () => {
    await clock.sleep(10_000)
    return { result: {}, text: 'ok' }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const run = $.tool.call({ tool: 'Bash', command: './build.sh' })
  await clock.settle()
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /build\.sh/ })).toBeUndefined()
  await $.prompt.submit({ text: 'go on', asUser: true })
  expect(await ui.find({ type: 'Text', text: /build\.sh/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(10_000)
  await run
})
