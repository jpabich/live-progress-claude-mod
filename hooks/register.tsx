import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Job } from '../types'

// A band above the prompt: what runs now, each with a bar that fills by its learned typical duration (ETA). Everything is drawn
// here from the engine's events and a one-second local clock: no model call, so no tokens.

const jobs = atom({ plugin: 'live-progress', key: 'jobs' } as const, [] as Job[])
const now = atom({ plugin: 'live-progress', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'live-progress', key: 'isHidden' } as const, false)
const urgency = atom({ plugin: 'live-progress', key: 'urgency' } as const, '#5aa55a')  // the frame's colour
const redraw = atom({ plugin: 'live-progress', key: 'redraw' } as const, 0)  // bumped to draw the band again with fresh pictures

const QUICK = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite', 'ToolSearch'])  // too short to show
const SHOWN = 4
const BAR_CELLS = 32  // the terminal bar's length, in cells

const SCRIPT = /[\w./\\:-]+\.(?:ps1|psm1|py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|gd|bat|cmd)\b/i
const SUBCOMMAND = /^[a-z][\w:.-]*$/i  // `build`, `run`, `test:unit`
const FLAG_VALUE = /^[\w./\\:-]{1,32}$/  // a flag's value kept in the key: a word or a short path, never free text

// What a run is learned under: the tool, then the script it runs (its file name) or the program and up to two subcommands, then
// the flags it is given, with their values when short, sorted. So `./build.ps1 -Target web` and `./build.ps1 -Quick` learn apart,
// and `npm run build` apart from `npm run test`. Only the first command of a chain counts, once `cd … &&`, `FOO=1 `, a PowerShell
// `$x = ` or `& ` and `uv run [--project …]` are taken off. Without a command: the tool's description or skill.
export const keyOf = (tool: string, e: Record<string, unknown>): string => {
  let what = ''
  if (typeof e.command === 'string') {
    const c = e.command
      .replace(/"([^"]*)"|'([^']*)'/g, (_, d?: string, s?: string) => (SCRIPT.test(d ?? s ?? '') ? (d ?? s ?? '') : '""'))
      .trim()
      .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '')
      .split(/\s*(?:&&|\|\||[|;\n])\s*/)[0]
      .replace(/^\$\w+\s*=\s*/, '').replace(/^&\s*/, '')
      .replace(/^(?:\w+=\S*\s+)+/, '')
      .replace(/^uv run(?:\s+--project\s+\S+)?\s+/, '')
    const words = c.split(/\s+/).filter(w => w !== '')
    const at = words.findIndex(w => SCRIPT.test(w))
    let head: string[]
    let rest: string[]
    if (at >= 0) {
      head = [words[at].replace(/^.*[\\/]/, '')]
      rest = words.slice(at + 1)
    } else {
      let n = 1
      while (n < 3 && n < words.length && SUBCOMMAND.test(words[n])) n++
      head = words.length > 0 ? [words[0].replace(/^.*[\\/]/, ''), ...words.slice(1, n)] : []
      rest = words.slice(n)
    }
    const flags = new Set<string>()
    rest.forEach((w, i) => {
      if (!/^--?[a-z]/i.test(w)) return
      const eq = w.indexOf('=')
      const name = eq < 0 ? w : w.slice(0, eq)
      const after = rest[i + 1]
      const value = eq >= 0 ? w.slice(eq + 1) : after !== undefined && !after.startsWith('-') ? after : undefined
      flags.add(value !== undefined && FLAG_VALUE.test(value) ? `${name} ${value}` : name)
    })
    what = [...head, ...[...flags].sort()].join(' ')
  }
  what = what || (typeof e.description === 'string' ? e.description : '') || (typeof e.skill === 'string' ? e.skill : '')
  return `${tool}:${what}`.slice(0, 80)
}

const labelOf = (tool: string, e: Record<string, unknown>): string => {
  const d = typeof e.description === 'string' ? e.description : typeof e.command === 'string' ? e.command : ''
  return (d ? `${tool}: ${d}` : tool).slice(0, 70)
}

const DONE_SHOW_MS = 3000

export type Look = { words: string; mood: 'run' | 'near' | 'over' | 'sleep' | 'done'; share: number }

// One way of saying a length of time everywhere, the same on the desktop and in a terminal: "45s", "11m", "1h20m"; `up` rounds up
// to the unit shown (an ETA), else down.
export const clockOf = (ms: number, up = false): string => {
  const s = up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000)
  if (s < 60) return `${Math.max(0, s)}s`
  const m = up ? Math.ceil(s / 60) : Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const BAR_STEPS = 20  // the sweep's positions while there is no estimate

// How far a job at `t` ms is, its mood and its words.
export const progressOf = (job: Job, t: number): Look => {
  const elapsed = Math.max(0, (job.doneAt ?? t) - job.startedAt)
  if (job.doneAt !== undefined) return { words: `done in ${clockOf(elapsed)}`, mood: 'done', share: 1 }
  if (job.expectedMs === null || job.expectedMs <= 0) {
    // no estimate yet: the bar sweeps
    const at = Math.floor(elapsed / 1000) % BAR_STEPS
    return { words: `${clockOf(elapsed)} - first run of its kind: no ETA yet`, mood: 'sleep', share: at / BAR_STEPS }
  }
  const share = elapsed / job.expectedMs
  const left = job.expectedMs - elapsed
  if (left <= 0) return { words: `${clockOf(elapsed)} - ${clockOf(-left)} over the usual ${clockOf(job.expectedMs)}`, mood: 'over', share: 1 }
  return { words: `${Math.floor(share * 100)}% - ${clockOf(elapsed)} - ETA ${clockOf(left, true)}`, mood: share > 0.85 ? 'near' : 'run', share }
}

const MOOD_COLOUR: Record<Look['mood'], string> = { run: 'green', near: 'yellow', over: 'red', sleep: 'cyan', done: 'green' }

// Clawd, animated, the band's full width. On the desktop one SVG a job: SMIL moves Clawd and the bar from where the job is at the
// drawing to the end of its usual time, switches the words, turns him red past the usual time, and walks his legs in a four-step
// cycle. In a terminal, which draws no SVG, a one-row Clawd of blocks.
const CLAWD_H = 70  // the picture's height, CSS pixels; it is as wide as the band (the bar and Clawd's way in percents)
const PX = 4  // a sprite pixel
const SPRITE_W = 11 * PX
const SPRITE_Y = 8
const BAR_Y = 32
const BAR_H = 12
const FILL_HEX: Record<Look['mood'], string> = { run: '#5aa55a', near: '#d4b13a', over: '#d9534f', sleep: '#4fb6c9', done: '#5aa55a' }
const ORANGE = '#D97757'
const RED = '#d9534f'
const STEP_S = 0.6  // one walk cycle
const MAX_WORDS = 500  // texts of the words at most

// The sprite, 11 x 4 pixels over the legs: B body, E eye (closed for a blink by squashing it).
const CLAWD_BODY = ['..BBBBBBB..', '..BEBBBEB..', 'BBBBBBBBBBB', '..BBBBBBB..']
// The walk: four frames of the four legs (row 4; a lifted leg is shorter and a little forward), the body up on the passes.
const LEG_X = [2, 4, 6, 8]
const STEPS: Array<{ lifted: number[]; up: boolean }> = [
  { lifted: [1, 3], up: false }, { lifted: [], up: true }, { lifted: [0, 2], up: false }, { lifted: [], up: true },
]

const rect = (x: number | string, y: number, w: number | string, h: number, fill: string, extra = '', inner = ''): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}>${inner}</rect>`

// Each row is one rect a run of pixels, a little taller than the row so the rows overlap (pixel by pixel, the edges of the rects showed
// as thin seams wherever Clawd stood between whole pixels), the eyes drawn over the body.
const body = (colour: string): string =>
  CLAWD_BODY.flatMap((r, y) => [...r.matchAll(/[BE]+/g)].map(m => rect(m.index! * PX, y * PX, m[0].length * PX, PX + 0.6, colour))).join('') +
  CLAWD_BODY.flatMap((r, y) => [...r].map((c, x) => c !== 'E' ? ''
    : rect(x * PX, y * PX, PX, PX, '#1f1e1d', '',
      `<animate attributeName="height" values="${PX};${PX};1;${PX}" keyTimes="0;0.94;0.97;1" dur="4s" repeatCount="indefinite"/>` +
      // every 20 s he looks round: the eyes back, then ahead, then home
      `<animate attributeName="x" values="${x * PX};${x * PX};${x * PX - 1.5};${x * PX - 1.5};${x * PX + 1.5};${x * PX + 1.5};${x * PX}" keyTimes="0;0.88;0.9;0.93;0.95;0.98;1" dur="20s" repeatCount="indefinite" calcMode="discrete"/>`))).join('')

// Dust puffs behind his feet as he walks (to the right: the puffs drift left and up and fade).
const dust = (): string => [0, 1, 2].map(i =>
  `<circle cx="0" cy="${5 * PX}" r="1.6" fill="#b8ad9e" opacity="0">` +
  `<animate attributeName="cx" values="${2 * PX};${2 * PX - 9}" dur="0.9s" begin="${i * 0.3}s" repeatCount="indefinite"/>` +
  `<animate attributeName="cy" values="${5 * PX};${5 * PX - 5}" dur="0.9s" begin="${i * 0.3}s" repeatCount="indefinite"/>` +
  `<animate attributeName="opacity" values="0.8;0" dur="0.9s" begin="${i * 0.3}s" repeatCount="indefinite"/></circle>`).join('')

// Sweat past the usual time: two drops by his head, falling and fading, again and again.
const sweat = (): string => [[-3, 0], [SPRITE_W + 1, 0.45]].map(([x, d]) =>
  `<ellipse cx="${x}" cy="0" rx="1.4" ry="2.2" fill="#7fc4ff" opacity="0">` +
  `<animate attributeName="cy" values="0;9" dur="0.9s" begin="${d}s" repeatCount="indefinite"/>` +
  `<animate attributeName="opacity" values="1;0" dur="0.9s" begin="${d}s" repeatCount="indefinite"/></ellipse>`).join('')

// Confetti over him at the finish: little squares of colour falling and turning.
const CONFETTI = ['#ffd23f', '#5aa55a', '#7fc4ff', '#ff8cc6', '#D97757', '#b48cff', '#ffd23f', '#5aa55a']
const confetti = (): string => CONFETTI.map((c, i) => {
  const x = -26 + i * 9
  const d = (i * 0.17) % 1.2
  return `<rect x="${x}" y="-10" width="3" height="3" fill="${c}">` +
    `<animate attributeName="y" values="-12;24" dur="1.3s" begin="${d}s" repeatCount="indefinite"/>` +
    `<animateTransform attributeName="transform" type="rotate" values="0 ${x + 1.5} 6;360 ${x + 1.5} 6" dur="1.3s" begin="${d}s" repeatCount="indefinite"/></rect>`
}).join('')
const legs = (colour: string, lifted: number[]): string =>
  LEG_X.map((x, i) => lifted.includes(i) ? rect(x * PX + 1.5, 4 * PX - 0.6, PX, PX - 1.4, colour) : rect(x * PX, 4 * PX - 0.6, PX, PX + 1.6, colour)).join('')

// One frame in four, shown for its quarter of the cycle.
const frame = (k: number, inner: string): string => {
  const values = [0, 1, 2, 3].map(i => (i === k ? 1 : 0)).join(';')
  return `<g opacity="${k === 0 ? 1 : 0}">${inner}<animate attributeName="opacity" values="${values}" keyTimes="0;0.25;0.5;0.75" dur="${STEP_S}s" repeatCount="indefinite" calcMode="discrete"/></g>`
}

const walker = (colour: string): string =>
  STEPS.map((s, k) => frame(k, `<g transform="translate(0 ${s.up ? -1.5 : 0})">${body(colour)}</g>${legs(colour, s.lifted)}`)).join('')

const text = (words: string, colour: string): string =>
  `<text x="0" y="${CLAWD_H - 6}" font-size="14" font-weight="600" font-family="system-ui, sans-serif" fill="${colour}">${words}</text>`

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const pct = (share: number): string => `${Math.floor(Math.min(share, 9.99) * 100)}%`

// Clawd at `share` of the way: a nested svg at that percent of the width, the sprite pulled back by that share of its own width, so he
// stands at the left edge at 0 and against the right one at 1. With `to` and `dur` he walks on to there in that many seconds.
const placed = (share: number, inner: string, to?: number, dur?: number): string => {
  const go = to !== undefined && dur !== undefined && dur > 0
  return `<svg x="${share * 100}%" y="${SPRITE_Y}" overflow="visible" shape-rendering="crispEdges">` +
    (go ? `<animate attributeName="x" from="${share * 100}%" to="${to * 100}%" dur="${dur}s" fill="freeze"/>` : '') +
    `<g transform="translate(${-share * SPRITE_W} 0)">` +
    (go ? `<animateTransform attributeName="transform" type="translate" from="${-share * SPRITE_W} 0" to="${-to * SPRITE_W} 0" dur="${dur}s" fill="freeze"/>` : '') +
    `${inner}</g></svg>`
}

// The picture for `job` as it stands at `t0` (ms), animated from there on by itself.
export const clawdSvg = (job: Job, t0: number): string => {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${CLAWD_H}">`
  const track = rect(0, BAR_Y, '100%', BAR_H, '#3a3a38', ' rx="4"')
  const elapsed = Math.max(0, (job.doneAt ?? t0) - job.startedAt)
  if (job.doneAt !== undefined) {
    const jump = `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${SPRITE_Y};0 0" dur="0.6s" repeatCount="indefinite"/>`
    return open + placed(1, `<g>${jump}${body(ORANGE)}${legs(ORANGE, [])}</g>${confetti()}`) + track +
      rect(0, BAR_Y, '100%', BAR_H, FILL_HEX.done, ' rx="4"') + text(`done in ${clockOf(elapsed)}`, FILL_HEX.done) + '</svg>'
  }
  const e = job.expectedMs
  if (e === null || e <= 0) {
    const z = `<text x="${SPRITE_W + 4}" y="2" font-size="13" font-family="monospace" fill="${FILL_HEX.sleep}">z<animate attributeName="opacity" values="1;0.2;1" dur="2s" repeatCount="indefinite"/></text>`
    const sweep = rect(0, BAR_Y, '8%', BAR_H, FILL_HEX.sleep, ' rx="4"', '<animate attributeName="x" values="0%;92%;0%" dur="4s" repeatCount="indefinite"/>')
    return open + placed(0, `${body(ORANGE)}${legs(ORANGE, [])}${z}`) + track + sweep +
      text('first run of its kind: no ETA yet', FILL_HEX.sleep) + '</svg>'
  }
  const left = Math.max(0, (e - elapsed) / 1000)  // seconds to the usual end, from the drawing
  const s0 = Math.min(1, elapsed / e)
  const near = Math.max(0, (0.85 * e - elapsed) / 1000)
  // Clawd walks from s0 to the end over `left` seconds, then stays there, red, walking on the spot
  const red = `<g opacity="${left > 0 ? 0 : 1}">${walker(RED)}${sweat()}${left > 0 ? `<set attributeName="opacity" to="1" begin="${left}s"/>` : ''}</g>`
  const orange = left > 0 ? `<g>${walker(ORANGE)}<set attributeName="opacity" to="0" begin="${left}s"/></g>` : ''
  // a hop half way
  const hopAt = (0.5 * e - elapsed) / 1000
  const hop = hopAt > 0 ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${SPRITE_Y};0 0" dur="0.5s" begin="${hopAt}s"/>` : ''
  const w0 = `${Math.max(1, s0 * 100)}%`
  const fill = rect(0, BAR_Y, left > 0 ? w0 : '100%', BAR_H, left <= 0 ? FILL_HEX.over : elapsed >= 0.85 * e ? FILL_HEX.near : FILL_HEX.run, ' rx="4"',
    (left > 0 ? `<animate attributeName="width" from="${w0}" to="100%" dur="${left}s" fill="freeze"/>` : '') +
    (near > 0 ? `<set attributeName="fill" to="${FILL_HEX.near}" begin="${near}s"/>` : '') +
    (left > 0 ? `<set attributeName="fill" to="${FILL_HEX.over}" begin="${left}s"/>` : ''))
  // the words, one text a step (a second while the times are in seconds, then a minute; the first until the next whole step of the
  // job), each shown from its start to the next one's
  const steps: Array<{ at: number; said: string; colour: string }> = []
  let at = 0  // seconds from the drawing
  for (let i = 0; i < MAX_WORDS; i++) {
    const ms = elapsed + at * 1000
    const over = ms - e
    steps.push({
      at,
      colour: over >= 0 ? FILL_HEX.over : ms >= 0.85 * e ? FILL_HEX.near : FILL_HEX.run,
      said: over >= 0 ? `${clockOf(ms)} - ${clockOf(over)} over the usual ${clockOf(e)}`
        : `${pct(ms / e)} - ${clockOf(ms)} - ETA ${clockOf(e - ms, true)} - ends ${hhmm(job.startedAt + e)}`,
    })
    // (seconds only in a job's first minute and in short jobs: a second a text all through a long one would outgrow the picture)
    const step = ms < 60e3 || e < 180e3 ? 1 : 60
    const next = at + step - (ms / 1000) % step
    const end = (e - elapsed) / 1000  // the usual end gets a text of its own: "over" starts there, not at the next step
    at = at < end && next > end ? end : next
    // an hour past the usual end, or two minutes past it in seconds: the last words stay (the picture's source is held to 128 KB)
    if (over > 3600e3 || (step === 1 && over > 120e3)) break
  }
  // the texts share their font in one group, each one only its words, colour and times (a few hundred of them)
  const r = (v: number) => Math.round(v * 100) / 100
  const words = steps.map((st, i) => {
    const show = i === 0 ? '' : `<set attributeName="visibility" to="visible" begin="${r(st.at)}s"/>`
    const hide = i < steps.length - 1 ? `<set attributeName="visibility" to="hidden" begin="${r(steps[i + 1].at)}s"/>` : ''
    return `<text x="0" y="${CLAWD_H - 6}" fill="${st.colour}"${i === 0 ? '' : ' visibility="hidden"'}>${st.said}${show}${hide}</text>`
  })
  return open + placed(s0, `<g>${hop}${dust()}${orange}${red}</g>`, 1, left) + track + fill +
    `<g font-size="14" font-weight="600" font-family="system-ui, sans-serif">${words.join('')}</g></svg>`
}

// A picture animates from the moment its frame loads, as from the time it was made: a frame loaded again later (the desktop showing
// the session again after another one) would start over from that old time, the bar back near where it was then. So a picture is
// made anew once a client attaches or leaves, and once it is REFRESH_MS old; otherwise it is kept while its estimate and its end
// stay the same, whenever the band is drawn again (a typed prompt, another job), since each new source reloads the frame, a blink.
const REFRESH_MS = 60e3
const pictures = new Map<string, { sig: string; at: number; svg: string }>()
export const pictureOf = (job: Job, t: number): string => {
  const sig = `${job.expectedMs}|${job.doneAt}`
  const kept = pictures.get(job.id)
  if (kept !== undefined && kept.sig === sig && t - kept.at < REFRESH_MS) return kept.svg
  const svg = clawdSvg(job, t)
  pictures.set(job.id, { sig, at: t, svg })
  if (pictures.size > 50) pictures.delete(pictures.keys().next().value as string)
  return svg
}

// The terminal's Clawd: one row of blocks, his legs swapping each second.
const CLAWD_TEXT = ['▐▛█▜▌', '▝▜█▛▘']

// The functions `$` is handed to are top-level declarations (the engine follows `$` only into those).
let tick: { cancel: () => void } | null = null
let serial = 0  // ids for tool calls that came without one
const rechecked = new Set<string>()  // module state: empty again after each reload

// Learned durations live under STORE, keyed by keyOf; a change to what keyOf makes of a command takes a new prefix.
const STORE = 'd4:'

async function expected($: EngineInterface, key: string): Promise<number | null> {
  const v = await $.store.get(`${STORE}${key}`)
  return typeof v === 'number' ? v : null
}

async function learn($: EngineInterface, key: string, ms: number): Promise<void> {
  const old = await expected($, key)
  await $.store.set(`${STORE}${key}`, old === null ? ms : Math.round(0.6 * old + 0.4 * ms))  // the typical duration, recent runs weighed more
}

// The frame's colour: red once a job is past its usual time, yellow once one is near it, cyan while none has an estimate, else green.
const urgencyOf = (list: Job[], t: number): string => {
  const moods = list.map(j => progressOf(j, t).mood)
  return moods.includes('over') ? FILL_HEX.over : moods.includes('near') ? FILL_HEX.near
    : moods.length > 0 && moods.every(m => m === 'sleep') ? FILL_HEX.sleep : FILL_HEX.run
}

async function onTick($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  await update($, now, () => t)
  const stale = (j: Job) => j.doneAt !== undefined && t - j.doneAt >= DONE_SHOW_MS
  if ((await read($, jobs)).some(stale)) await update($, jobs, all => all.filter(j => !stale(j)))  // (a write each second redrew the band each second)
  // a job's estimate is looked up again on the first tick after a (re)load, and while it has none: another run may have taught it
  for (const j of await read($, jobs)) {
    if (j.expectedMs === null || !rechecked.has(j.id)) {
      rechecked.add(j.id)
      const e = await expected($, j.key)
      if (e !== j.expectedMs) await update($, jobs, all => all.map(x => (x.id === j.id ? { ...x, expectedMs: e } : x)))
    }
  }
  const list = await read($, jobs)
  const colour = urgencyOf(list, t)
  if (colour !== (await read($, urgency))) await update($, urgency, () => colour)
  if (list.length === 0 && tick !== null) {
    tick.cancel()
    tick = null
  }
}

// The one-second clock; a reload drops the old module's timer, so `session.start` (run again by a reload) calls this too.
function ensureTick($: EngineInterface): void {
  if (tick === null) tick = $.clock.every(1000, () => onTick($))
}

async function start($: EngineInterface, job: Job): Promise<void> {
  await update($, jobs, list => [...list.filter(j => j.id !== job.id), job])
  await update($, now, () => job.startedAt)
  ensureTick($)
}

// A job's end: one that succeeded shows "done" a moment and teaches its duration; one that failed, was refused or stopped just goes,
// so a crash after five seconds does not teach a two-hour build that it takes five seconds.
async function finish($: EngineInterface, id: string, succeeded: boolean): Promise<void> {
  const job = (await read($, jobs)).find(j => j.id === id)
  if (job === undefined) return
  if (!succeeded) {
    await update($, jobs, list => list.filter(j => j.id !== id))
    return
  }
  const t = await $.clock.now()
  await update($, jobs, list => list.map(j => (j.id === id ? { ...j, doneAt: t } : j)))
  await learn($, job.key, t - job.startedAt)
}

// What a background call answers with: `… running in background with ID: <id>`.
export const backgroundIdOf = (ran: ToolCallResult): string | null => {
  const said = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '')
  return /background with ID: ([\w-]+)/.exec(said)?.[1] ?? null
}

// A background task's end, as its notification row says it: its id and how it ended.
export const taskEndOf = (message: unknown): { id: string; succeeded: boolean } | null => {
  const ended = /<task-id>([\w-]+)<\/task-id>[\s\S]*?<status>(completed|failed|killed|stopped)<\/status>/.exec(JSON.stringify(message))
  return ended === null ? null : { id: ended[1], succeeded: ended[2] === 'completed' }
}

// A client came or went: the desktop loads the band's frames again when it shows the session again, so the pictures are made anew.
async function freshPictures($: EngineInterface): Promise<void> {
  pictures.clear()
  await update($, redraw, n => n + 1)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if ((await read($, jobs)).length > 0) ensureTick($)  // jobs begun before a reload go on ticking
    await update($, redraw, n => n + 1)  // the band drawn again by the new code
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await freshPictures($)
    return r
  })

  on('session.detach', async ($, e, next) => {
    const r = await next(e)
    if (e.reason !== 'end') await freshPictures($)
    return r
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (QUICK.has(tool) || tool.startsWith('mcp__')) return next(e)
    const args = e as unknown as Record<string, unknown>
    const startedAt = await $.clock.now()
    const id = e.tool_use_id ?? `${tool}-${startedAt}-${++serial}`
    const key = keyOf(tool, args)
    const label = labelOf(tool, args)
    const job = (jobId: string, kind: Job['kind']): Promise<Job> =>
      expected($, key).then(expectedMs => ({ id: jobId, kind, label, key, startedAt, expectedMs }))
    await start($, await job(id, tool === 'Agent' ? 'agent' : 'tool'))
    try {
      const ran = await next(e)
      const failed = ran.deny !== undefined || ran.isError === true
      if (args.run_in_background === true && !failed) {
        // the call returned at once: the work goes on as a background task until its notification
        await update($, jobs, list => list.filter(j => j.id !== id))
        const bg = backgroundIdOf(ran)
        if (bg !== null) await start($, await job(bg, 'background'))
      } else {
        await finish($, id, !failed)
      }
      return ran
    } catch (err) {
      await finish($, id, false)
      throw err
    }
  })

  on('session.append', async ($, e, next) => {
    const ended = taskEndOf(e.message)
    if (ended !== null) await finish($, ended.id, ended.succeeded)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, jobs)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) return next(e)
    await read($, redraw)
    const { Box, Button, Text, Svg } = $.ui.resolve(e) as any
    // the picture on the desktop; the terminal's table has no Svg, but what resolve hands back there is not undefined either
    const isPicture = e.surface !== 'terminal' && Svg !== undefined
    // the terminal redraws each second by `now`; the desktop's picture animates itself, so it reads the clock without subscribing
    const t = isPicture ? await $.clock.now() : await read($, now)
    const shown = [...list].sort((a, b) => a.startedAt - b.startedAt).slice(-SHOWN)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={await read($, urgency)} paddingX={1}>
        {shown.map(job => {
          const p = progressOf(job, t)
          if (isPicture) {
            return (
              <Box key={job.id} flexDirection="column">
                <Svg source={pictureOf(job, t)} alt="Clawd walking along the job's progress bar" height={CLAWD_H} isInteractive />
                <Text dimColor>{job.label}</Text>
              </Box>
            )
          }
          const clawd = p.mood === 'done' || p.mood === 'sleep' ? CLAWD_TEXT[0] : CLAWD_TEXT[Math.floor(t / 1000) % 2]
          return (
            <Box key={job.id} flexDirection="column">
              {/* the bar is laid out in cells, not drawn in characters: a constant length whatever the font, and Clawd stands
                  exactly over the end of the filled part */}
              <Box width={BAR_CELLS}>
                <Box width={`${Math.round(Math.min(p.share, 0.94) * 100)}%`}><Text> </Text></Box>
                <Text bold color={p.mood === 'over' ? RED : ORANGE}>{clawd}{p.mood === 'sleep' ? ' z' : ''}</Text>
              </Box>
              <Box>
                <Box width={BAR_CELLS} backgroundColor="#3a3a38">
                  {p.mood === 'sleep'
                    ? <Box width={BAR_CELLS}>
                        <Box width={`${Math.round(p.share * 100)}%`}><Text> </Text></Box>
                        <Box width={2} backgroundColor={MOOD_COLOUR.sleep}><Text> </Text></Box>
                      </Box>
                    : <Box width={`${Math.max(1, Math.round(p.share * 100))}%`} backgroundColor={MOOD_COLOUR[p.mood]}><Text> </Text></Box>}
                </Box>
                <Text> </Text>
                <Text bold color={MOOD_COLOUR[p.mood]}>{p.words}{p.mood === 'run' || p.mood === 'near' ? ` - ends ${hhmm(job.startedAt + (job.expectedMs as number))}` : ''}</Text>
              </Box>
              <Text dimColor>{job.label}</Text>
            </Box>
          )
        })}
        <Box justifyContent="space-between">
          <Text dimColor>{list.length > SHOWN ? `+${list.length - SHOWN} more` : ' '}</Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, isHidden, () => false)  // a new prompt shows the band again
    return next(e)
  })
}
