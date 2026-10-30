import type { AgentStatus } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Job } from '../types'
import { backgroundIdOf, clawdRows, clawdSvg, clockOf, isListedAs, isShown, isStuck, keyOf, progressOf, stoppedIdOf, taskEndsOf } from './register'
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

type Engine = Parameters<Parameters<typeof test>[1]>[0]

// background tasks' notifications, as one prompt carries them, and their delivery: a prompt the engine stamps as a notification
const noticeOf = (...ends: Array<[id: string, status: string]>) =>
  ends.map(([id, status]) => `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>`).join('\n')
const deliver = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'task-notification' } })
const notify = ($: Engine, ...ends: Array<[id: string, status: string]>) => deliver($, noticeOf(...ends))
// the same as the session stores it (the `taskHooks` option reads it): a row of its own, or delivered into a running turn
const row = (...ends: Array<[id: string, status: string]>) => ({
  message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'text' as const, text: noticeOf(...ends) }] },
  door: 'queue' as const,
  origin: { kind: 'task-notification' as const },
  uuid: `n-${ends.map(([id]) => id).join('-')}`,
})
const queued = (...ends: Array<[id: string, status: string]>) => ({
  message: { type: 'attachment' as const, name: 'queued_command', content: [{ type: 'text' as const, text: noticeOf(...ends) }] },
  door: 'attachment' as const,
  origin: { kind: 'engine' as const },
  uuid: `q-${ends.map(([id]) => id).join('-')}`,
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

  test('a heredoc is one command: the text it feeds never counts', () => {
    expect(bash("cat > \"$SP/a.py\" <<'EOF'\nimport sys\nfrom PIL import Image\nEOF")).toBe('Bash:cat')
    expect(bash("cat > a.py <<'EOF'\nimport sys\nEOF\npython -I a.py")).toBe(bash("cat > b.py <<'EOF'\nprint(1)\nEOF\npython -I a.py"))
    expect(bash('cat <<EOF | python3\nprint("a; b && c")\nEOF\nnpm ci')).toBe('Bash:cat && npm ci')
    expect(bash('cat <<-END\n\tls\n\tEND\nnpm ci')).toBe('Bash:cat && npm ci')
    expect(bash('git commit -m "$(cat <<\'EOF\'\nFix it\n\nCo-Authored-By: x\nEOF\n)"')).toBe('Bash:git commit -m')
    expect(bash("python - <<'EOF'\nimport os\n")).toBe('Bash:python')
    expect(bash('cat<<EOF\nls\nEOF')).toBe('Bash:cat')
  })

  test('a here-string and a shift are no heredoc', () => {
    expect(bash('cat <<< "x"\nnpm ci')).toBe('Bash:cat && npm ci')
    expect(bash('echo $((1<<3))\nnpm ci')).toBe('Bash:echo && npm ci')
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
  expect(progressOf(job, 120_000)).toMatchObject({ mood: 'over', words: '2m · 20s over the usual 1m' })
  expect(progressOf({ ...job, expectedMs: null }, 3_000)).toMatchObject({ mood: 'sleep', words: '3s · first run of its kind · no ETA yet' })
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
  mock.store(on, { 'd7:Bash:build.sh': { ms: 60_000, at: 0 } })
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

test('with the clawd option off, the terminal draws bars and labels alone, and more jobs fit', { options: { clawd: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd7:Bash:one.sh': { ms: 600_000, at: 0 }, 'd7:Bash:two.sh': { ms: 600_000, at: 0 }, 'd7:Bash:three.sh': { ms: 600_000, at: 0 } })
  on('tool.call', async () => {
    await clock.sleep(60_000)
    return { result: {}, text: 'ok' }
  })
  const runs = []
  for (const name of ['one', 'two', 'three']) {
    runs.push($.tool.call({ tool: 'Bash', command: `./${name}.sh` }))
    await clock.advance(1_000)
  }
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 12 } })  // one job with Clawd would fit here
  expect(JSON.stringify(await ui.drawn())).not.toMatch(/[▀▄█]/)
  for (const name of ['one', 'two', 'three']) expect(await ui.find({ type: 'Text', text: new RegExp(`${name}\\.sh`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\d+% · \d+s · ETA/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /more/ })).toBeUndefined()
  await ui.unmount()
  await clock.advance(60_000)
  await Promise.all(runs)
})

test('with the clawd option off, the desktop still draws Clawd', { options: { clawd: false } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd7:Bash:build.sh': { ms: 600_000, at: 0 } })
  on('tool.call', async () => {
    await clock.sleep(60_000)
    return { result: {}, text: 'ok' }
  })
  const run = $.tool.call({ tool: 'Bash', command: './build.sh' })
  await clock.settle()
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()
  await clock.advance(60_000)
  await run
})

test('a background job is past its time far past its usual time, 4 h on a first run', () => {
  const at = 1_000_000
  const job = (o: Partial<Job>): Job => ({ id: 'bg-1', callId: 'toolu_1', kind: 'background', label: 'x', key: 'Bash:a.sh', startedAt: at, expectedMs: null, ...o })
  const hours = (h: number) => at + h * 3_600_000
  expect(isStuck(job({}), hours(3.9))).toBe(false)
  expect(isStuck(job({}), hours(4.1))).toBe(true)
  expect(isStuck(job({ expectedMs: 10_000 }), at + 9 * 60_000)).toBe(false)  // 3 × 10 s, at least 10 min
  expect(isStuck(job({ expectedMs: 10_000 }), at + 11 * 60_000)).toBe(true)
  expect(isStuck(job({ expectedMs: 3_600_000 }), hours(2.9))).toBe(false)  // 3 × 1 h
  expect(isStuck(job({ kind: 'tool' }), hours(10))).toBe(false)
})

test("a turn-end list's command names a job's as it is, wrapped, or cut", () => {
  expect(isListedAs('./a.sh -x', './a.sh -x')).toBe(true)
  expect(isListedAs('./a.sh -x', './a.sh')).toBe(false)
  expect(isListedAs('timeout 600 ./a.sh', './a.sh')).toBe(false)  // not wrapped unless asked
  expect(isListedAs('timeout 600 ./a.sh', './a.sh', true)).toBe(true)
  expect(isListedAs('timeout 600 ./a.sh -x', './a.sh', true)).toBe(false)
  const long = `./a.sh ${'x'.repeat(1200)}`
  const cut = (s: string) => `${s.slice(0, 1000)}... [+${s.length - 1000} chars]`
  expect(isListedAs(cut(long), long)).toBe(true)
  expect(isListedAs(cut(`timeout 600 ${long}`), long, true)).toBe(true)
  expect(isListedAs(cut(`./b.sh ${'y'.repeat(1200)} short`), 'short', true)).toBe(false)  // a stray word names nothing
})

test('TaskStop names the task stopped by its result, else by the call', () => {
  expect(stoppedIdOf({ task_id: 'researcher' }, { result: { message: 'stopped', task_id: 'a7f-3', task_type: 'local_agent' }, text: 'stopped' })).toBe('a7f-3')
  expect(stoppedIdOf({ task_id: 'bg-1' }, { result: {}, text: 'stopped' })).toBe('bg-1')
  expect(stoppedIdOf({ shell_id: 'bg-2' }, { result: {}, text: 'stopped' })).toBe('bg-2')
  expect(stoppedIdOf({}, { result: {}, text: 'stopped' })).toBeUndefined()
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
  // an agent's launch, as Claude Code words it now: its words name "the agentId below" before the id
  const launched = 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, ' +
    'including the agentId below, into a user-facing reply.)\nagentId: ace9556ac2d44509a'
  expect(backgroundIdOf({ result: {}, text: launched })).toBe('ace9556ac2d44509a')
  expect(backgroundIdOf({ result: { status: 'async_launched', agentId: 'ace9556ac2d44509a', description: 'Say hi', prompt: 'hi' }, text: launched }))
    .toBe('ace9556ac2d44509a')
  expect(backgroundIdOf({ result: { status: 'async_launched', agentId: 'a1' } })).toBe('a1')  // the record alone, no words
  expect(backgroundIdOf({ result: { agentId: 'a2' } })).toBe('a2')  // words-less, read from the record as JSON
  expect(taskEndsOf('<task-id>a</task-id><status>completed</status>')).toEqual([])  // nothing outside a notification
  expect(taskEndsOf(noticeOf(['bg-1', 'completed'], ['bg-2', 'killed']))).toEqual([{ id: 'bg-1', callId: undefined, succeeded: true }, { id: 'bg-2', callId: undefined, succeeded: false }])
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
      const call = e as { command?: string; run_in_background?: boolean; task_id?: string }
      if (e.tool === 'TaskStop') return { result: { message: 'stopped', task_id: call.task_id, task_type: 'local_bash' }, text: 'stopped' }
      if (call.run_in_background === true) return { result: {}, text: `Command running in background with ID: ${call.command === './a.sh' ? 'bg-1' : 'bg-2'}` }
      await clock.sleep(10_000)
      return { result: {}, text: 'ok' }
    })
    // the engine's own: a band with nothing of the mod's, a prompt's delivery, and a turn's end
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))
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
    await notify($, ['bg-1', 'completed'])
    await clock.advance(4_000)
    expect(await labelShown($, /a\.sh/)).toBe(false)

    const again = $.tool.call({ tool: 'Bash', command: './a.sh' })
    await clock.settle()
    expect(await labelShown($, /ETA 4s/)).toBe(true)
    await clock.advance(10_000)
    await again
  })

  test('one prompt ending two tasks ends both', async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await $.tool.call({ tool: 'Bash', command: './b.sh', run_in_background: true })
    await clock.advance(3_000)
    await notify($, ['bg-1', 'completed'], ['bg-2', 'killed'])
    await clock.advance(4_000)
    expect(await labelShown($, /\.sh/)).toBe(false)
  })

  test('a task Claude stops goes at once and teaches nothing, its late notification too', async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await clock.advance(6_000)
    expect(await labelShown($, /a\.sh/)).toBe(true)
    await $.tool.call({ tool: 'TaskStop', task_id: 'bg-1' })
    expect(await labelShown($, /a\.sh/)).toBe(false)
    expect(await labelShown($, /TaskStop/)).toBe(false)
    await notify($, ['bg-1', 'completed'])

    const again = $.tool.call({ tool: 'Bash', command: './a.sh' })
    await clock.advance(2_500)
    expect(await labelShown($, /no ETA yet/)).toBe(true)
    await clock.advance(10_000)
    await again
  })

  test('a notification row, or one delivered into a running turn, ends its task', async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await $.tool.call({ tool: 'Bash', command: './b.sh', run_in_background: true })
    await clock.advance(3_000)
    await $.session.append(row(['bg-1', 'completed']))
    await clock.advance(4_000)
    expect(await labelShown($, /a\.sh/)).toBe(false)
    expect(await labelShown($, /b\.sh/)).toBe(true)
    await $.session.append(queued(['bg-2', 'completed']))
    await clock.advance(4_000)
    expect(await labelShown($, /b\.sh/)).toBe(false)
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
    expect(await labelShown($, /a\.sh/)).toBe(true)  // its notification may come as the turn ends
    await clock.advance(11_000)
    expect(await labelShown($, /a\.sh/)).toBe(false)

    const again = $.tool.call({ tool: 'Bash', command: './a.sh' })
    await clock.advance(2_500)
    expect(await labelShown($, /no ETA yet/)).toBe(true)  // taught nothing
    await clock.advance(10_000)
    await again
  })

  test("a task its turn's end no longer lists still teaches when its notification comes as the turn ends", async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await clock.advance(6_000)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    await clock.advance(1_000)
    await notify($, ['bg-1', 'completed'])
    await clock.advance(4_000)
    expect(await labelShown($, /a\.sh/)).toBe(false)

    const again = $.tool.call({ tool: 'Bash', command: './a.sh' })
    await clock.settle()
    expect(await labelShown($, /ETA 7s/)).toBe(true)
    await clock.advance(10_000)
    await again
  })

  test('with the taskHooks option off, rows and turn-end lists end nothing', { options: { taskHooks: false } }, async ($, on) => {
    const clock = setUp(on)
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await clock.advance(6_000)
    await $.session.append(row(['bg-1', 'completed']))
    await $.session.append(queued(['bg-1', 'completed']))
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    await clock.advance(11_000)
    expect(await labelShown($, /a\.sh/)).toBe(true)
    await notify($, ['bg-1', 'completed'])
    await clock.advance(4_000)
    expect(await labelShown($, /a\.sh/)).toBe(false)
  })
})

test('the terminal keeps Clawd inside the bar past the usual time', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd7:Bash:build.sh': { ms: 3_000, at: 0 } })
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
  mock.store(on, { 'd7:Bash:build.sh': { ms: 600_000, at: 0 } })
  on('tool.call', async () => {
    await clock.sleep(60_000)
    return { result: {}, text: 'ok' }
  })
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.detach', (_, e) => ({ clientId: e.clientId }))
  // the words the picture starts with: where the job stood when the picture was made
  const startsAt = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const said = /\d+% · \d+s/.exec(JSON.stringify(await ui.drawn()))?.[0]
    await ui.unmount()
    return said
  }

  const run = $.tool.call({ tool: 'Bash', command: './build.sh' })
  await clock.settle()
  expect(await startsAt()).toBe('0% · 0s')
  await clock.advance(30_000)
  expect(await startsAt()).toBe('0% · 0s')  // kept: a new source would reload the frame
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(await startsAt()).toBe('5% · 30s')
  await clock.advance(10_000)
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:default', reason: 'detach' })
  expect(await startsAt()).toBe('6% · 40s')
  await clock.advance(20_000)
  await run
})

describe('what a run teaches and when a job goes', () => {
  type Body = Parameters<typeof test>[1]
  // the engine's own: a band with nothing of the mod's, a prompt's delivery, a turn's end, a permission dialog
  const engineBand = (on: Parameters<Body>[1]) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('turn.complete', (_, e) => ({ text: e.answer }))
    on('classic.PermissionRequest', () => ({}))
  }
  const shows = async ($: Engine, text: RegExp, band: typeof BAND = BAND) => {
    const ui = await $.ui.mount(band)
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found !== undefined
  }
  const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }

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
    await notify($, ['bg-9', 'completed'])
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
    await $.turn.complete(turnEnd)
    expect(await shows($, /main\.sh/)).toBe(false)
    expect(await shows($, /sub\.sh/)).toBe(true)
    await clock.advance(60_000)
    await Promise.all([main, sub])
  })

  test('a task dropped far past its usual time teaches nothing when its notification comes late', { options: { taskHooks: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on, { 'd7:Bash:a.sh': { ms: 10_000, at: 0 } })
    engineBand(on)
    on('tool.call', async (_, e) => {
      if ((e as { run_in_background?: boolean }).run_in_background === true) return { result: {}, text: 'Command running in background with ID: bg-1' }
      await clock.sleep(10_000)
      return { result: {}, text: 'ok' }
    })
    await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
    await clock.advance(11 * 60_000)  // past the bound: 3 × 10 s, at least 10 min
    expect(await shows($, /a\.sh/)).toBe(false)
    await notify($, ['bg-1', 'completed'])
    const again = $.tool.call({ tool: 'Bash', command: './a.sh' })
    await clock.settle()
    expect(await shows($, /ETA 10s/)).toBe(true)  // as it was
    await clock.advance(10_000)
    await again
  })

  test('only a prompt stamped as a notification ends a task, by task or by call', async ($, on) => {
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

    // typed, or a plugin's prompt quoting one: not a notification
    const quote = noticeOf(['a7f-3', 'completed'])
    await $.prompt.submit({ text: quote, asUser: true })
    await $.prompt.submit({ text: quote })
    await clock.advance(4_000)
    expect(await shows($, /Look round/)).toBe(true)

    await deliver($, quote)
    // a shell task whose id the call's words did not give: named by the call
    await deliver($, `<task-notification><task-id>zz</task-id><tool-use-id>${calls[1]}</tool-use-id><status>completed</status></task-notification>`)
    await clock.advance(4_000)
    expect(await shows($, /Look round/)).toBe(false)
    expect(await shows($, /quiet\.sh/)).toBe(false)
  })

  // with the taskHooks option off, or where a managed plugin takes session.append and classic.Stop past the mod, ends come from
  // prompts and turns
  describe('notifications as prompts, subagents by their turn ends', () => {
    const launch = (on: Parameters<Body>[1], learned: Record<string, { ms: number; at: number }> = {}) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      mock.store(on, learned)
      engineBand(on)
      const agent = { id: 'a7f-3', description: 'Look round', type: 'Explore', status: 'running' as AgentStatus }
      on('agent.list', () => ({ value: [agent] }))
      on('tool.call', async (_, e) => {
        if (e.tool === 'Agent') return { result: {}, text: 'Async agent launched. agentId: a7f-3' }
        if ((e as { run_in_background?: boolean }).run_in_background === true) return { result: {}, text: 'Command running in background with ID: bg-1' }
        await clock.sleep(60_000)
        return { result: {}, text: 'ok' }
      })
      return { clock, agent }
    }
    // as a session delivers one (its summary and output file included)
    const ends = [
      '<task-notification>',
      '<task-id>bg-1</task-id>',
      '<tool-use-id>toolu_018SZj3N7yD6o5qNrXVFd98w</tool-use-id>',
      '<output-file>C:\\tasks\\bg-1.output</output-file>',
      '<status>completed</status>',
      '<summary>Background command "quiet" completed (exit code 0)</summary>',
      '</task-notification>',
    ].join('\n')
    // what a kind of job was taught, as the next run of it shows: the time left at its start
    const nextRunShows = async ($: Engine, clock: ReturnType<typeof launch>['clock'], call: Parameters<Engine['tool']['call']>[0], label: RegExp) => {
      const run = $.tool.call(call)
      await clock.settle()
      const found = await shows($, label)
      await clock.advance(60_000)
      await run
      return found
    }

    test('a notification delivered as a prompt ends the task; a typed one quoting it does not', async ($, on) => {
      const { clock } = launch(on)
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(3_000)
      await $.prompt.submit({ text: ends, asUser: true })
      expect(await shows($, /quiet\.sh/)).toBe(true)
      await $.prompt.submit({ text: ends, origin: { kind: 'task-notification' } })
      await clock.advance(4_000)
      expect(await shows($, /quiet\.sh/)).toBe(false)
    })

    test('an end told by two events at once teaches once', async ($, on) => {
      const { clock } = launch(on, { 'd7:Bash:quiet.sh': { ms: 60_000, at: 0 } })
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(4_000)
      await Promise.all([deliver($, ends), notify($, ['bg-1', 'completed'])])
      await clock.advance(4_000)
      expect(await nextRunShows($, clock, { tool: 'Bash', command: './quiet.sh' }, /ETA 38s/)).toBe(true)  // 0.6 × 60s + 0.4 × 4s, once
    })

    test("a background subagent's turn end ends its job and teaches, unless it waits on work of its own", async ($, on) => {
      const { clock, agent } = launch(on)
      await $.tool.call({ tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true })
      const lost = $.tool.call({ tool: 'Bash', command: './sub.sh', agentId: 'a7f-3' })
      await clock.advance(6_000)
      agent.status = 'waiting'
      await $.turn.complete({ ...turnEnd, agentId: 'a7f-3' })
      expect(await shows($, /Look round/)).toBe(true)
      expect(await shows($, /sub\.sh/)).toBe(false)  // its own call that lost its end goes all the same
      await clock.advance(4_000)
      agent.status = 'completed'
      await $.turn.complete({ ...turnEnd, agentId: 'a7f-3' })
      await clock.advance(4_000)
      expect(await shows($, /Look round/)).toBe(false)
      await clock.advance(60_000)
      await lost
      const again = { tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true } as const
      expect(await nextRunShows($, clock, again, /ETA 10s/)).toBe(true)
    })

    test("an interrupted subagent's turn end ends its job and teaches nothing", async ($, on) => {
      const { clock } = launch(on)
      await $.tool.call({ tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true })
      await clock.advance(6_000)
      await $.turn.complete({ ...turnEnd, agentId: 'a7f-3', isAborted: true, reason: 'aborted' })
      expect(await shows($, /Look round/)).toBe(false)
      await clock.advance(4_000)
      await $.tool.call({ tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true })
      await clock.advance(2_500)  // a kind not yet known shows once it has run a while
      expect(await shows($, /no ETA yet/)).toBe(true)
    })

    test("a subagent's job goes by the id its spawn gave, though the call's words name none", async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      mock.store(on)
      engineBand(on)
      on('agent.list', () => ({ value: [] }))
      on('agent.spawn', () => ({ model: 'haiku', agentId: 'real-1' }))
      on('tool.call', async (_, e) => {
        const spawn = { tool_use_id: e.tool_use_id, prompt: 'look', description: 'Look round', subagentType: 'Explore', background: true, fork: false }
        await $.agent.spawn(spawn as never)
        return { result: {}, text: 'Async agent launched.' }
      })
      await $.tool.call({ tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true })
      await clock.advance(3_000)
      expect(await shows($, /Look round/)).toBe(true)
      await $.turn.complete({ ...turnEnd, agentId: 'real-1' })
      await clock.advance(4_000)
      expect(await shows($, /Look round/)).toBe(false)
    })

    test('with the taskHooks option off, a background job goes only far past its usual time, whatever the turns', { options: { taskHooks: false } }, async ($, on) => {
      const { clock } = launch(on, { 'd7:Bash:quiet.sh': { ms: 10_000, at: 0 } })
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(9 * 60_000)
      expect(await shows($, /quiet\.sh/)).toBe(true)  // the bound is 10 min, at least
      await clock.advance(2 * 60_000)
      expect(await shows($, /quiet\.sh/)).toBe(false)
    })

    // with the option on, two main-loop turns end each time: answered with no Stop (a managed plugin took it), answered with Stop,
    // interrupted (which raises no Stop)
    const cases = [
      { name: 'goes where no turn end lists the work in flight', reason: 'answer', isStopHeard: false, stays: false },
      { name: 'stays where a turn end lists it in flight', reason: 'answer', isStopHeard: true, stays: true },
      { name: 'stays after turns that were interrupted, not answered', reason: 'aborted', isStopHeard: false, stays: true },
    ] as const
    for (const { name, reason, isStopHeard, stays } of cases) {
      test(`a background job far past its usual time ${name}`, async ($, on) => {
        const { clock } = launch(on, { 'd7:Bash:quiet.sh': { ms: 10_000, at: 0 } })
        on('classic.Stop', () => ({}))
        await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
        for (let turn = 0; turn < 2; turn++) {
          await $.turn.complete({ ...turnEnd, reason, isAborted: reason === 'aborted' })
          if (isStopHeard) await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg-1', type: 'shell', status: 'running', description: '' }] })
        }
        await clock.advance(9 * 60_000)
        expect(await shows($, /quiet\.sh/)).toBe(true)  // the bound is 10 min, at least
        await clock.advance(2 * 60_000)
        expect(await shows($, /quiet\.sh/)).toBe(stays)
      })
    }

    test("a job its turn's end does not name goes by time, though the list names another", async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      mock.store(on, { 'd7:Bash:quiet.sh': { ms: 10_000, at: 0 }, 'd7:Bash:named.sh': { ms: 10_000, at: 0 } })
      engineBand(on)
      on('classic.Stop', () => ({}))
      on('tool.call', async (_, e) => (e as { command?: string }).command === './named.sh'
        ? { result: {}, text: 'Command running in background with ID: bg-1' }
        : { result: {}, text: 'started' })
      await $.tool.call({ tool: 'Bash', command: './named.sh', run_in_background: true })
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })  // its id unread: the call's
      await clock.advance(6_000)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg-1', type: 'shell', status: 'running', description: '' }] })
      await clock.advance(9 * 60_000)
      expect(await shows($, /quiet\.sh/)).toBe(true)  // the bound is 10 min, at least
      await clock.advance(2 * 60_000)
      expect(await shows($, /quiet\.sh/)).toBe(false)
      expect(await shows($, /named\.sh/)).toBe(true)  // listed in flight: it runs
    })

    test("a background subagent its turn's end does not list stays while the engine lists it live", async ($, on) => {
      const { clock, agent } = launch(on)
      on('classic.Stop', () => ({}))
      await $.tool.call({ tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true })
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(6_000)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg-1', type: 'shell', status: 'running', description: '' }] })
      await clock.advance(11_000)
      expect(await shows($, /Look round/)).toBe(true)
      agent.status = 'completed'
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bg-1', type: 'shell', status: 'running', description: '' }] })
      await clock.advance(11_000)
      expect(await shows($, /Look round/)).toBe(false)
    })

    test('a subagent far past its usual time stays while the engine lists it live (a remote one has no turn end)', { options: { taskHooks: false } }, async ($, on) => {
      const { clock, agent } = launch(on, { 'd7:Agent:Explore': { ms: 10_000, at: 0 } })
      await $.tool.call({ tool: 'Agent', description: 'Look round', prompt: 'look', subagent_type: 'Explore', run_in_background: true })
      await clock.advance(11 * 60_000)
      expect(await shows($, /Look round/)).toBe(true)
      agent.status = 'completed'  // its end unseen: no turn end came
      await clock.advance(2_000)
      expect(await shows($, /Look round/)).toBe(false)
    })
  })

  describe('turn-end lists, the session end, the × and the status command', () => {
    const shellTask = (id: string, command: string) => ({ id, type: 'shell', status: 'running', description: '', command })
    // background commands whose words give no id: the call's id stands in for the task's
    const quietLaunch = (on: Parameters<Body>[1], learned: Record<string, { ms: number; at: number }> = {}, said = 'started') => {
      const clock = mock.clock(on, { now: 1_000_000 })
      mock.store(on, learned)
      engineBand(on)
      on('classic.Stop', () => ({}))
      on('classic.SubagentStop', () => ({}))
      on('agent.list', () => ({ value: [] }))
      const calls: string[] = []
      on('tool.call', async (_, e) => {
        calls.push(e.tool_use_id)
        if ((e as { run_in_background?: boolean }).run_in_background === true) return { result: {}, text: said }
        await clock.sleep(60_000)
        return { result: {}, text: 'ok' }
      })
      return { clock, calls }
    }

    test("a subagent's turn-end list drops a job it no longer lists", async ($, on) => {
      const { clock } = quietLaunch(on, {}, 'Command running in background with ID: bg-1')
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(6_000)
      await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_transcript_path: '', agent_type: 'Explore', background_tasks: [] })
      await clock.advance(11_000)
      expect(await shows($, /quiet\.sh/)).toBe(false)
    })

    test('a job whose id went unread takes its task id by its command line, and ends by its notification', async ($, on) => {
      const { clock } = quietLaunch(on)
      await $.tool.call({ tool: 'Bash', command: './quiet.sh --long', run_in_background: true })
      await clock.advance(6_000)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [shellTask('bg-7', './quiet.sh --long')] })
      await notify($, ['bg-7', 'completed'])
      await clock.advance(4_000)
      expect(await shows($, /quiet\.sh/)).toBe(false)
      const again = $.tool.call({ tool: 'Bash', command: './quiet.sh --long' })
      await clock.settle()
      expect(await shows($, /ETA 6s/)).toBe(true)  // taught
      await clock.advance(60_000)
      await again
    })

    test('a command the list cut is matched by the part it kept; two jobs of one command are told apart by neither', async ($, on) => {
      const { clock } = quietLaunch(on)
      const long = `./quiet.sh ${'x'.repeat(1200)}`
      await $.tool.call({ tool: 'Bash', command: long, run_in_background: true })
      await $.tool.call({ tool: 'Bash', command: './twin.sh', run_in_background: true })
      await $.tool.call({ tool: 'Bash', command: './twin.sh', run_in_background: true })
      await clock.advance(6_000)
      const cut = `${long.slice(0, 1000)}... [+${long.length - 1000} chars]`
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [shellTask('bg-7', cut), shellTask('bg-8', './twin.sh'), shellTask('bg-9', './twin.sh')] })
      await notify($, ['bg-7', 'completed'], ['bg-8', 'completed'])
      await clock.advance(4_000)
      expect(await shows($, /quiet\.sh/)).toBe(false)
      expect(await shows($, /twin\.sh/)).toBe(true)  // neither twin took bg-8
    })

    test('the session ending drops its jobs and shows the band again', async ($, on) => {
      const { clock } = quietLaunch(on)
      on('session.end', (_, e) => ({ sessionId: e.sessionId }))
      const run = $.tool.call({ tool: 'Bash', command: './build.sh' })
      await clock.advance(3_000)
      const ui = await $.ui.mount(BAND)
      await ui.press({ key: 'hide' })
      await ui.unmount()
      await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
      const next = $.tool.call({ tool: 'Bash', command: './next.sh' })
      await clock.advance(3_000)
      expect(await shows($, /build\.sh/)).toBe(false)
      expect(await shows($, /next\.sh/)).toBe(true)  // not hidden
      await clock.advance(60_000)
      await Promise.all([run, next])
    })

    test("the × drops a job at once, teaching nothing, on the terminal and the desktop", async ($, on) => {
      const { clock, calls } = quietLaunch(on)
      const first = $.tool.call({ tool: 'Bash', command: './build.sh' })
      const second = $.tool.call({ tool: 'Bash', command: './other.sh' })
      await clock.advance(3_000)
      for (const [surface, i, label] of [['terminal', 0, /build\.sh/], ['desktop', 1, /other\.sh/]] as const) {
        const ui = await $.ui.mount({ ...BAND, surface })
        await ui.press({ key: `drop:${calls[i]}` })
        expect(await ui.find({ type: 'Text', text: label })).toBeUndefined()
        await ui.unmount()
      }
      await clock.advance(60_000)
      await Promise.all([first, second])
      const again = $.tool.call({ tool: 'Bash', command: './build.sh' })
      await clock.advance(2_500)
      expect(await shows($, /no ETA yet/)).toBe(true)
      await clock.advance(60_000)
      await again
    })

    test('a job whose own command a task names as it is takes it, before a job a wrapped listing would name', async ($, on) => {
      const { clock } = quietLaunch(on)
      await $.tool.call({ tool: 'Bash', command: './b.sh && ./a.sh', run_in_background: true })
      await $.tool.call({ tool: 'Bash', command: './a.sh', run_in_background: true })
      await clock.advance(6_000)
      // a plugin beneath ran the second wrapped
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [shellTask('bg-1', './b.sh && ./a.sh'), shellTask('bg-2', 'timeout 600 ./a.sh')] })
      await notify($, ['bg-1', 'completed'])
      await clock.advance(4_000)
      expect(await shows($, /b\.sh/)).toBe(false)
      expect(await shows($, /Bash: \.\/a\.sh/)).toBe(true)
      await notify($, ['bg-2', 'completed'])
      await clock.advance(4_000)
      expect(await shows($, /a\.sh/)).toBe(false)
    })

    test('a job the × took stays gone when its call moves to the background', async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      mock.store(on)
      engineBand(on)
      const calls: string[] = []
      on('tool.call', async (_, e) => {
        calls.push(e.tool_use_id)
        await clock.sleep(10_000)
        return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-9', backgroundedByUser: true }, text: 'moved to the background' }
      })
      const run = $.tool.call({ tool: 'Bash', command: './long.sh' })
      await clock.advance(3_000)
      const ui = await $.ui.mount(BAND)
      await ui.press({ key: `drop:${calls[0]}` })
      await ui.unmount()
      await clock.advance(10_000)
      await run
      await clock.advance(1_000)
      expect(await shows($, /long\.sh/)).toBe(false)
    })

    test('with the taskHooks option off, a subagent turn-end list ends nothing', { options: { taskHooks: false } }, async ($, on) => {
      const { clock } = quietLaunch(on, {}, 'Command running in background with ID: bg-1')
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(6_000)
      await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'a1', agent_transcript_path: '', agent_type: 'Explore', background_tasks: [] })
      await clock.advance(11_000)
      expect(await shows($, /quiet\.sh/)).toBe(true)
    })

    test('the status command says why a job past its time stays, and the commands an unread id is matched by', async ($, on) => {
      const { clock } = quietLaunch(on, { 'd7:Bash:quiet.sh': { ms: 10_000, at: 0 } }, 'Command running in background with ID: bg-1')
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(6_000)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [shellTask('bg-1', './quiet.sh')] })
      await clock.advance(11 * 60_000)
      const { text } = await $.command.run({ command: 'live-progress-status' })
      expect(text).toMatch(/past the time bound, kept: the last turn-end list names it/)
      expect(text).toContain('shell bg-1: running, command "./quiet.sh"')
    })

    test('the status command tells the jobs, their ids and the last turn-end list', async ($, on) => {
      const { clock, calls } = quietLaunch(on, { 'd7:Bash:quiet.sh': { ms: 10_000, at: 0 } })
      await $.tool.call({ tool: 'Bash', command: './quiet.sh', run_in_background: true })
      await clock.advance(6_000)
      await $.classic.Stop({ stop_hook_active: false, background_tasks: [shellTask('other', './else.sh')] })
      const { text } = await $.command.run({ command: 'live-progress-status' })
      expect(text).toMatch(/taskHooks on, band shown/)
      expect(text).toContain(`background ${calls[0]}: Bash: ./quiet.sh`)
      expect(text).toMatch(/usually 10s, running, id unread, command "\.\/quiet\.sh"/)
      expect(text).toMatch(/Turn-end list \(0s ago\):\n {2}shell other: running, command "\.\/else\.sh"/)
    })
  })

  test('the terminal band shows as many jobs as fit its rows, the latest', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on, { 'd7:Bash:one.sh': { ms: 600_000, at: 0 }, 'd7:Bash:two.sh': { ms: 600_000, at: 0 }, 'd7:Bash:three.sh': { ms: 600_000, at: 0 } })
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
  const first: Job = { id: 'j', kind: 'tool', label: 'x', key: 'k', startedAt: 1_700_000_000_000, expectedMs: null }
  for (const minutes of [0, 0.5, 1, 60, 239, 240, 300]) {
    expect(clawdSvg(first, first.startedAt + minutes * 60_000).length).toBeLessThanOrEqual(131_072)
  }
})

test('the desktop bar grows by CSS from where the job is, over a SMIL width for a view without CSS widths', () => {
  const job: Job = { id: 'j', kind: 'tool', label: 'x', key: 'k', startedAt: 1_700_000_000_000, expectedMs: 100_000 }
  const svg = clawdSvg(job, job.startedAt + 20_000)
  expect(svg).toContain('@keyframes grow{from{width:20%}to{width:100%}}')
  expect(svg).toContain('width="20%" height="12" fill="#5aa55a" rx="4" style="animation:grow 80s linear forwards">' +
    '<animate attributeName="width" from="20%" to="100%" dur="80s" fill="freeze"/>')
  // past the usual end nothing grows: the bar is full and red
  const over = clawdSvg(job, job.startedAt + 120_000)
  expect(over).not.toContain('@keyframes')
  expect(over).not.toContain('attributeName="width"')
  expect(over).toContain('width="100%" height="12" fill="#d9534f" rx="4">')
})

test('the desktop picture counts a first run up', () => {
  const job: Job = { id: 'j', kind: 'tool', label: 'x', key: 'k', startedAt: 1_700_000_000_000, expectedMs: null }
  const said = (svg: string) => [...svg.matchAll(/>([^<>]*first run of its kind · no ETA yet)</g)].map(m => m[1])
  const early = said(clawdSvg(job, job.startedAt + 58_500))
  expect(early.slice(0, 4)).toEqual(['58s · first run of its kind · no ETA yet', '59s · first run of its kind · no ETA yet',
    '1m · first run of its kind · no ETA yet', '2m · first run of its kind · no ETA yet'])
  // past the 4 h a first run may be dropped by, a subagent still running stays: the count goes on
  expect(early.at(-1)).toBe('8h18m · first run of its kind · no ETA yet')
  const late = said(clawdSvg(job, job.startedAt + 300 * 60_000))
  expect([late[0], late[1]]).toEqual(['5h00m · first run of its kind · no ETA yet', '5h01m · first run of its kind · no ETA yet'])
  // each second once, from a drawing between whole seconds
  expect(said(clawdSvg(job, job.startedAt + 1_234)).slice(0, 4).map(s => s.split(' ')[0])).toEqual(['1s', '2s', '3s', '4s'])
})

test('a typed prompt shows the hidden band again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd7:Bash:build.sh': { ms: 60_000, at: 0 } })
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

test("Hide holds on the desktop too, through a notification's turn, until the person's next prompt", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'd7:Bash:build.sh': { ms: 60_000, at: 0 } })
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
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /build\.sh/ })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: /build\.sh/ })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('engine')  // the engine's own band in its place
  await deliver($, noticeOf(['bg-1', 'completed']))
  expect(await ui.find({ type: 'Text', text: /build\.sh/ })).toBeUndefined()
  await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', name: 'other' } })
  expect(await ui.find({ type: 'Text', text: /build\.sh/ })).toBeUndefined()
  await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' } })
  expect(await ui.find({ type: 'Text', text: /build\.sh/ })).toBeDefined()
  await ui.unmount()
  await clock.advance(10_000)
  await run
})
