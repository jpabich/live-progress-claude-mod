import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Job } from '../types'

// A band above the prompt: what runs now, each with a bar that fills by its learned typical duration (ETA). Everything is drawn
// here from the engine's events and a local clock: no model call, so no tokens.

const jobs = atom({ plugin: 'live-progress', key: 'jobs' } as const, [] as Job[])
const now = atom({ plugin: 'live-progress', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'live-progress', key: 'isHidden' } as const, false)
const urgency = atom({ plugin: 'live-progress', key: 'urgency' } as const, '#5aa55a')  // the frame's colour
const redraw = atom({ plugin: 'live-progress', key: 'redraw' } as const, 0)  // bumped to draw the band again

const QUICK = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite', 'ToolSearch'])  // too short to show
const ON_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'])  // waiting on the person, not work: no bar, nothing learned
const SHOWN = 4
const BAR_CELLS = 32  // the terminal bar's length, in cells
const SHOW_AFTER_MS = 2000  // a job shows once it has run this long, or at once when its kind usually takes longer
const NEAR = 0.85  // the share of the usual time from which a job is near its end

const SCRIPT = /\.(?:ps1|psm1|py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|gd|bat|cmd)$/i  // a word naming a script
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'bun', 'deno', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'ruby', 'perl', 'php', 'godot', 'cmd'])
const NAVIGATION = new Set(['cd', 'pushd', 'popd', 'set-location', 'push-location', 'pop-location', 'sl'])
const SUBCOMMAND = /^[a-z][\w:-]*$/i  // `build`, `run`, `test:unit`; never a file name
const FLAG_VALUE = /^[a-z][a-z._/\\:-]{0,31}$/i  // a flag's value kept in the key: a mode or a path without digits, never a per-run value
// Programs that run another: the key is the one they run. Their own flags, counts and durations (`timeout -k 5 600`) and an `env`'s
// assignments go with them.
const WRAPPERS = new Set(['time', 'timeout', 'nice', 'nohup', 'sudo', 'env', 'exec', 'command', 'npx', 'bunx', 'pnpx'])
const WRAPPER_ARG = /^(?:-\S*|\d+(?:\.\d+)?[smhd]?|\w+=\S*)$/

// One command of a chain: the script it runs (its file name) when the command is the script or an interpreter running one, else the
// program; then up to two subcommands (`manage.py migrate`, `npm run build`); then its flags, with their values when they name a mode
// or a place, sorted. A pipeline counts by its first program; `cd`, `Set-Location` and the like count for nothing.
const commandKey = (command: string): string => {
  const c = command.split('|')[0].trim()
    .replace(/^\$\w+\s*=\s*/, '').replace(/^&\s*/, '')
    .replace(/^(?:\w+=\S*\s+)+/, '')
    .replace(/^uv run(?:\s+--project\s+\S+)?\s+/, '')
  let words = c.split(/\s+/).filter(w => w !== '')
  while (words.length > 0 && WRAPPERS.has(words[0].replace(/^.*[\\/]/, '').toLowerCase())) {
    let n = 1
    while (n < words.length && WRAPPER_ARG.test(words[n])) n++
    words = words.slice(n)
  }
  if (words.length === 0) return ''
  const program = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  if (NAVIGATION.has(program.toLowerCase())) return ''
  const at = SCRIPT.test(words[0]) ? 0
    : INTERPRETERS.has(program.toLowerCase()) ? words.findIndex((w, i) => i > 0 && SCRIPT.test(w)) : -1
  const from = at >= 0 ? at : 0
  let n = from + 1
  while (n < from + 3 && n < words.length && SUBCOMMAND.test(words[n])) n++
  const head = [at >= 0 ? words[at].replace(/^.*[\\/]/, '') : program, ...words.slice(from + 1, n)]
  const rest = words.slice(n)
  const flags = new Set<string>()
  rest.forEach((w, i) => {
    if (!/^--?[a-z]/i.test(w)) return
    const eq = w.indexOf('=')
    const name = eq < 0 ? w : w.slice(0, eq)
    const after = rest[i + 1]
    const value = eq >= 0 ? w.slice(eq + 1) : after !== undefined && !after.startsWith('-') ? after : undefined
    flags.add(value !== undefined && FLAG_VALUE.test(value) ? `${name} ${value}` : name)
  })
  return [...head, ...[...flags].sort()].join(' ')
}

// A heredoc's lines are the text it feeds a command, not commands: its marker goes, and its lines up to and with the one that ends it
// (`<<-` lets that one be indented with tabs). Not a here-string (`<<<`), nor a shift (`1<<3`).
const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/g
const withoutHeredocs = (command: string): string => {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const ends: Array<{ word: string; tabs: boolean }> = []
    kept.push(lines[i].replace(HEREDOC, (_, dash: string, s?: string, d?: string, w?: string) => {
      ends.push({ word: s ?? d ?? w ?? '', tabs: dash === '-' })
      return ''
    }))
    for (const end of ends) {
      while (++i < lines.length && (end.tabs ? lines[i].replace(/^\t+/, '') : lines[i]) !== end.word);
    }
  }
  return kept.join('\n')
}

// What a run is learned under: the tool, then each command of the chain as commandKey says, so `./build.ps1 -Target web` and
// `./build.ps1 -Quick` learn apart, `npm ci` apart from `npm ci && npm run build`, and `git add build.sh` never as build.sh. Quoted
// text counts for nothing unless it is a script's path (a path before any space in it: `"C:\My Scripts\x.ps1"`, not `"fix a/x.sh"`);
// a command never counts by the free text beside it, nor by a heredoc's. A subagent by its type; anything else by its skill or
// description.
export const keyOf = (tool: string, e: Record<string, unknown>): string => {
  let what: string
  if (typeof e.command === 'string') {
    const unquoted = withoutHeredocs(e.command).replace(/"([^"]*)"|'([^']*)'/g, (_, d?: string, s?: string) => {
      const q = (d ?? s ?? '').replace(/^[&.]\s+/, '')  // `-Command "& ./build.ps1"`, a dot-sourced script
      return SCRIPT.test(q) && /^\S*[\\/]|^\S+$/.test(q) ? q.replace(/^.*[\\/]/, '').replace(/\s+/g, '_') : '""'
    })
    what = unquoted.split(/\s*(?:&&|\|\||;|\n)\s*/).map(commandKey).filter(k => k !== '').join(' && ')
  } else if (tool === 'Agent') {
    what = typeof e.subagent_type === 'string' ? e.subagent_type : 'general-purpose'
  } else {
    what = (typeof e.skill === 'string' ? e.skill : '') || (typeof e.description === 'string' ? e.description : '')
  }
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
  return { words: `${Math.floor(share * 100)}% - ${clockOf(elapsed)} - ETA ${clockOf(left, true)}`, mood: share > NEAR ? 'near' : 'run', share }
}

// Whether a job is worth showing: a quick command comes and goes without opening the band.
export const isShown = (job: Job, t: number): boolean =>
  (job.doneAt ?? t) - job.startedAt >= SHOW_AFTER_MS || (job.expectedMs ?? 0) >= SHOW_AFTER_MS

// Clawd, animated, the band's full width. On the desktop one SVG a job: SMIL moves Clawd and the bar from where the job is at the
// drawing to the end of its usual time, switches the words, turns him red past the usual time, and walks his legs in a four-step
// cycle. In a terminal, which draws no SVG, the same sprite in half-block cells (clawdRows).
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
const SLOW_WORDS = 300  // minute texts a picture spends on the usual time at most: past 5 h, a text each few minutes

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

// Dust kicked up as he walks (to the right): a puff at each footfall, twice a walk cycle, from behind his back feet (the two back
// legs in turn: the second lands a quarter cycle in, the first three quarters in). Each puff is a little cloud of two circles that
// swells as it drifts back and up, and fades.
const DUST_S = STEP_S * 2  // a puff's life: four puffs alive at once, one a footfall
const DUST = '<defs><filter id="dust" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.7"/></filter></defs>' +
  '<g filter="url(#dust)" shape-rendering="auto">' + [0, 1, 2, 3].map(i => {
    const x = LEG_X[i % 2 === 0 ? 1 : 0] * PX  // at the back of the foot that lands
    const y = 5 * PX + 0.5  // on the ground under his feet
    const timing = `dur="${DUST_S}s" begin="${(STEP_S / 4 + i * STEP_S / 2).toFixed(2)}s" repeatCount="indefinite"`
    const cloud = ([dx, dy, k]: number[]) =>
      `<circle cx="${x + dx}" cy="${y + dy}" r="0" fill="#e2d8ca" opacity="0">` +
      `<animate attributeName="cx" values="${x + dx};${x + dx - 9 * k};${x + dx - 15 * k}" keyTimes="0;0.4;1" ${timing}/>` +
      `<animate attributeName="cy" values="${y + dy};${y + dy - 3};${y + dy - 6}" keyTimes="0;0.4;1" ${timing}/>` +
      `<animate attributeName="r" values="${1.2 * k};${3 * k};${4.4 * k}" keyTimes="0;0.4;1" ${timing}/>` +
      `<animate attributeName="opacity" values="0;0.6;0.35;0" keyTimes="0;0.1;0.5;1" ${timing}/></circle>`
    return [[0, 0, 1], [-2.5, -1.5, 0.7]].map(cloud).join('')
  }).join('') + '</g>'

// Sweat past the usual time: two drops on him, one at each side of his head (the head's outer columns, 2 and 8), each beading at the
// top, then running down him to his widest row and fading there, again and again.
const SWEAT = [[2.5 * PX, 0], [8.5 * PX, 0.55]].map(([x, d]) =>
  `<ellipse cx="${x}" cy="${0.6 * PX}" rx="1.6" ry="2.3" fill="#8fd0ff" opacity="0">` +
  `<animate attributeName="cy" values="${0.6 * PX};${0.6 * PX};${2.6 * PX}" keyTimes="0;0.3;1" dur="1.1s" begin="${d}s" repeatCount="indefinite"/>` +
  `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.25;0.8;1" dur="1.1s" begin="${d}s" repeatCount="indefinite"/></ellipse>`).join('')

// Confetti over him at the finish: little squares of colour falling and turning.
const CONFETTI = ['#ffd23f', '#5aa55a', '#7fc4ff', '#ff8cc6', '#D97757', '#b48cff', '#ffd23f', '#5aa55a'].map((c, i) => {
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

// The sprite's markup depends only on its colour: made once.
const WALK_ORANGE = walker(ORANGE)
const WALK_RED = walker(RED)
const STAND = body(ORANGE) + legs(ORANGE, [])

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
    return open + placed(1, `<g>${jump}${STAND}</g>${CONFETTI}`) + track +
      rect(0, BAR_Y, '100%', BAR_H, FILL_HEX.done, ' rx="4"') + text(`done in ${clockOf(elapsed)}`, FILL_HEX.done) + '</svg>'
  }
  const e = job.expectedMs
  if (e === null || e <= 0) {
    const z = `<text x="${SPRITE_W + 4}" y="2" font-size="13" font-family="monospace" fill="${FILL_HEX.sleep}">z<animate attributeName="opacity" values="1;0.2;1" dur="2s" repeatCount="indefinite"/></text>`
    const sweep = rect(0, BAR_Y, '8%', BAR_H, FILL_HEX.sleep, ' rx="4"', '<animate attributeName="x" values="0%;92%;0%" dur="4s" repeatCount="indefinite"/>')
    return open + placed(0, `${STAND}${z}`) + track + sweep +
      text('first run of its kind: no ETA yet', FILL_HEX.sleep) + '</svg>'
  }
  const left = Math.max(0, (e - elapsed) / 1000)  // seconds to the usual end, from the drawing
  const s0 = Math.min(1, elapsed / e)
  const near = Math.max(0, (NEAR * e - elapsed) / 1000)
  // Clawd walks from s0 to the end over `left` seconds, then stays there, red, walking on the spot
  const red = `<g opacity="${left > 0 ? 0 : 1}">${WALK_RED}${SWEAT}${left > 0 ? `<set attributeName="opacity" to="1" begin="${left}s"/>` : ''}</g>`
  const orange = left > 0 ? `<g>${WALK_ORANGE}<set attributeName="opacity" to="0" begin="${left}s"/></g>` : ''
  // a hop half way
  const hopAt = (0.5 * e - elapsed) / 1000
  const hop = hopAt > 0 ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${SPRITE_Y};0 0" dur="0.5s" begin="${hopAt}s"/>` : ''
  const w0 = `${Math.max(1, s0 * 100)}%`
  const fill = rect(0, BAR_Y, left > 0 ? w0 : '100%', BAR_H, left <= 0 ? FILL_HEX.over : elapsed >= NEAR * e ? FILL_HEX.near : FILL_HEX.run, ' rx="4"',
    (left > 0 ? `<animate attributeName="width" from="${w0}" to="100%" dur="${left}s" fill="freeze"/>` : '') +
    (near > 0 ? `<set attributeName="fill" to="${FILL_HEX.near}" begin="${near}s"/>` : '') +
    (left > 0 ? `<set attributeName="fill" to="${FILL_HEX.over}" begin="${left}s"/>` : ''))
  // the words, one text a step (a second while the times are in seconds, then a minute, or a few in a job of many hours; the first
  // until the next whole step of the job), each shown from its start to the next one's
  const slow = 60 * Math.max(1, Math.ceil(e / 60e3 / SLOW_WORDS))
  const steps: Array<{ at: number; said: string; colour: string }> = []
  let at = 0  // seconds from the drawing
  for (let i = 0; i < MAX_WORDS; i++) {
    const ms = elapsed + at * 1000
    const over = ms - e
    steps.push({
      at,
      colour: over >= 0 ? FILL_HEX.over : ms >= NEAR * e ? FILL_HEX.near : FILL_HEX.run,
      said: over >= 0 ? `${clockOf(ms)} - ${clockOf(over)} over the usual ${clockOf(e)}`
        : `${pct(ms / e)} - ${clockOf(ms)} - ETA ${clockOf(e - ms, true)} - ends ${hhmm(job.startedAt + e)}`,
    })
    // (seconds only in a job's first minute and in short jobs: a second a text all through a long one would outgrow the picture)
    const step = ms < 60e3 || e < 180e3 ? 1 : slow
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
  return open + placed(s0, `<g>${hop}${DUST}${orange}${red}</g>`, 1, left) + track + fill +
    `<g font-size="14" font-weight="600" font-family="system-ui, sans-serif">${words.join('')}</g></svg>`
}

// A picture animates from the moment its frame loads, as from the time it was made: a frame loaded again later (the desktop showing
// the session again after another one) would start over from that old time, the bar back near where it was then. So a picture is
// made anew once a client attaches or leaves. Otherwise it is kept while its estimate and its end stay the same, whenever the band
// is drawn again (a typed prompt, another job), since each new source reloads the frame, a blink; only a draw that finds it
// REFRESH_MS old makes it anew, which mends a frame reloaded without an attach. Nothing draws the band for that alone: the mending
// waits for the next draw that comes.
const REFRESH_MS = 60e3
const pictures = new Map<string, { sig: string; at: number; svg: string }>()
const pictureOf = (job: Job, t: number): string => {
  const sig = `${job.expectedMs}|${job.doneAt}`
  const kept = pictures.get(job.id)
  if (kept !== undefined && kept.sig === sig && t - kept.at < REFRESH_MS) return kept.svg
  const svg = clawdSvg(job, t)
  pictures.set(job.id, { sig, at: t, svg })
  return svg
}

// The terminal's Clawd: the desktop's sprite pixel for pixel, a pixel a cell wide and half a cell tall (▀ or ▄, a colour over
// another), in four rows the bar's width, the top one the air he hops into. A frame each FRAME_MS: his walk's four steps a second.
export type Cell = { ch: string; fg?: string; bg?: string }
const CLAWD_W = 11  // his width, in cells
const AIR_H = 8  // the pixel rows: four rows of cells
const FRAME_MS = 250
const EYE = '#1f1e1d'
const SWEAT_HEX = '#8fd0ff'
const DUST_HEX = '#e2d8ca'
const CONFETTI_HEX = ['#ffd23f', '#5aa55a', '#7fc4ff', '#ff8cc6', '#b48cff']
const CONFETTI_X = [-4, -1, 1, 4, 6, 9, -3, 3]  // where the bits fall, from his left edge

export const clawdRows = (job: Job, t: number): Cell[][] => {
  const p = progressOf(job, t)
  const k = Math.floor(t / FRAME_MS)
  const isAsleep = p.mood === 'sleep'
  const isDone = p.mood === 'done'
  const colour = p.mood === 'over' ? RED : ORANGE
  // he stands over the end of the filled part, inside the bar; asleep, at its start
  const lead = isAsleep ? 0 : Math.round(Math.min(p.share, 1) * (BAR_CELLS - CLAWD_W))
  const px: Array<Array<string | undefined>> = Array.from({ length: AIR_H }, () => Array<string | undefined>(BAR_CELLS).fill(undefined))
  const put = (x: number, y: number, c: string) => { if (x >= 0 && x < BAR_CELLS && y >= 0 && y < AIR_H) px[y][x] = c }
  const elapsed = (job.doneAt ?? t) - job.startedAt
  const e = job.expectedMs ?? 0
  const step = isAsleep || isDone ? { lifted: [] as number[], up: false } : STEPS[k % STEPS.length]
  // a hop half way, as on the desktop; done, he jumps every other frame
  const isUp = isDone ? k % 2 === 1 : e > 0 && elapsed >= 0.5 * e && elapsed < 0.5 * e + 500
  // his head's pixel row; no bob on the passes, as a pixel up (the desktop's is a fraction of one) stretched his legs by half
  const y0 = isUp ? 0 : 2
  CLAWD_BODY.forEach((r, y) => [...r].forEach((c, x) => { if (c !== '.') put(lead + x, y0 + y, c === 'E' ? EYE : colour) }))
  // the legs from under him to the ground, a lifted one a pixel short; in the air they hang two pixels
  LEG_X.forEach((x, i) => {
    const foot = isUp ? y0 + 5 : step.lifted.includes(i) ? AIR_H - 2 : AIR_H - 1
    for (let y = y0 + CLAWD_BODY.length; y <= foot; y++) put(lead + x, y, colour)
  })
  // sweat past the usual time: a drop at each side of his head, running down to his arms, then gone, the two in turn
  if (p.mood === 'over') [2, 8].forEach((x, i) => { const fall = (k + 2 * i) % 4; if (fall < 3) put(lead + x, y0 + fall, SWEAT_HEX) })
  if (isDone) CONFETTI_X.forEach((x, i) => {
    const y = (k + 3 * i) % AIR_H
    if (px[y][lead + x] === undefined) put(lead + x, y, CONFETTI_HEX[i % CONFETTI_HEX.length])
  })
  const rows: Cell[][] = Array.from({ length: AIR_H / 2 }, (_, row) => px[2 * row].map((top, x) => {
    const bottom = px[2 * row + 1][x]
    return top === undefined ? (bottom === undefined ? { ch: ' ' } : { ch: '▄', fg: bottom })
      : bottom === undefined ? { ch: '▀', fg: top } : top === bottom ? { ch: '█', fg: top } : { ch: '▀', fg: top, bg: bottom }
  }))
  const say = (x: number, row: number, cell: Cell) => { if (rows[row][x]?.ch === ' ') rows[row][x] = cell }
  // dust behind his back foot at each footfall; a z beside his head while he dozes, there one second in two
  if (!isAsleep && !isDone && !step.up) say(lead + (k % 4 === 0 ? 1 : 0), AIR_H / 2 - 1, { ch: '░', fg: DUST_HEX })
  if (isAsleep && Math.floor(t / 1000) % 2 === 0) say(lead + CLAWD_W + 1, 1, { ch: 'z', fg: FILL_HEX.sleep })
  return rows
}

// A row of cells as runs of one look, the blanks as boxes of their width (a terminal row is laid out in cells).
const runsOf = (row: Cell[]): Array<Cell & { n: number }> => {
  const runs: Array<Cell & { n: number }> = []
  for (const c of row) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.fg === c.fg && last.bg === c.bg && (last.ch.trim() === '') === (c.ch === ' ')) {
      last.ch += c.ch
      last.n++
    } else runs.push({ ...c, n: 1 })
  }
  return runs
}

// The functions `$` is handed to are top-level declarations (the engine follows `$` only into those).
let tick: { cancel: () => void } | null = null
let tickMs = 0
let drawsCells = true  // whether the band was last drawn in cells (a terminal's Clawd, redrawn each frame) or as pictures
let shownSig = ''  // the jobs shown at the last tick: a change draws the band again
const rechecked = new Set<string>()  // module state: empty again after each reload
const learning = new Map<string, Promise<void>>()  // one learn at a time a key, so two runs ending together both count
const asked = new Set<string>()  // jobs a permission dialog was put up for: the person's wait is no part of the run, which teaches nothing

// Learned durations live under STORE, keyed by keyOf, each `{ ms, at }`: the typical duration and when it was last taught. A change
// to what keyOf makes of a command takes a new prefix; session.start clears the old ones and, past MAX_KEYS, the least lately taught.
const STORE = 'd7:'
const OLD_STORE = /^d\d+:/
const MAX_KEYS = 1000

type Learned = { ms: number; at: number }
const learnedOf = (v: unknown): Learned | null => {
  const l = v as Partial<Learned> | null
  return typeof l === 'object' && l !== null && typeof l.ms === 'number' ? { ms: l.ms, at: typeof l.at === 'number' ? l.at : 0 } : null
}

async function expected($: EngineInterface, key: string): Promise<number | null> {
  return learnedOf(await $.store.get(`${STORE}${key}`))?.ms ?? null
}

async function learnNow($: EngineInterface, key: string, ms: number): Promise<void> {
  const old = await expected($, key)
  if (old === null && ms < SHOW_AFTER_MS) return  // a quick command of a new kind is not worth a key
  const typical = old === null ? ms : Math.round(0.6 * old + 0.4 * ms)  // the typical duration, recent runs weighed more
  await $.store.set(`${STORE}${key}`, { ms: typical, at: await $.clock.now() })
  // a first run of the same kind still going has its estimate now
  const isFirst = (j: Job) => j.key === key && j.expectedMs === null && j.doneAt === undefined
  if ((await read($, jobs)).some(isFirst)) await update($, jobs, all => all.map(j => (isFirst(j) ? { ...j, expectedMs: typical } : j)))
}

function learn($: EngineInterface, key: string, ms: number): Promise<void> {
  const run = (learning.get(key) ?? Promise.resolve()).then(() => learnNow($, key, ms))
  const settled = run.catch(() => undefined)
  learning.set(key, settled)
  void settled.then(() => { if (learning.get(key) === settled) learning.delete(key) })
  return run
}

async function tidyStore($: EngineInterface): Promise<void> {
  const mine: Array<{ key: string; at: number }> = []
  for (const key of await $.store.keys()) {
    if (key.startsWith(STORE)) mine.push({ key, at: 0 })
    else if (OLD_STORE.test(key)) await $.store.delete(key)
  }
  if (mine.length <= MAX_KEYS) return
  for (const m of mine) m.at = learnedOf(await $.store.get(m.key))?.at ?? 0
  mine.sort((a, b) => a.at - b.at)
  for (const m of mine.slice(0, mine.length - MAX_KEYS)) await $.store.delete(m.key)
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
  if ((await read($, jobs)).some(stale)) await update($, jobs, all => all.filter(j => !stale(j)))  // (a write each tick redrew the band each tick)
  // a job begun before a (re)load has its estimate looked up again: a run may have taught it meanwhile (learnNow hands a new one to
  // the jobs of its kind still going)
  for (const j of await read($, jobs)) {
    if (!rechecked.has(j.id)) {
      rechecked.add(j.id)
      const e = await expected($, j.key)
      if (e !== j.expectedMs) await update($, jobs, all => all.map(x => (x.id === j.id ? { ...x, expectedMs: e } : x)))
    }
  }
  const list = await read($, jobs)
  for (const ids of [rechecked, asked]) for (const id of ids) if (!list.some(j => j.id === id)) ids.delete(id)
  const shown = list.filter(j => isShown(j, t))
  const colour = urgencyOf(shown, t)
  if (colour !== (await read($, urgency))) await update($, urgency, () => colour)
  // the desktop draws only on a change: a job past SHOW_AFTER_MS is one
  const sig = shown.map(j => j.id).join(',')
  if (sig !== shownSig) {
    shownSig = sig
    await update($, redraw, n => n + 1)
  }
  if (list.length > 0) {
    ensureTick($)  // at the rate the surface drawn on last asks
  } else if (tick !== null) {
    tick.cancel()
    tick = null
    // a job started while this tick ran found the old timer still set: it gets a new one
    if ((await read($, jobs)).length > 0) ensureTick($)
  }
}

// The clock: a tick each FRAME_MS while the band is drawn in cells, for the terminal's Clawd; else each IDLE_MS, as the desktop's
// picture animates itself and the clock only ends jobs and recolours the frame. A reload drops the old module's timer, so
// `session.start` (run again by a reload) calls this too.
const IDLE_MS = 1000
function ensureTick($: EngineInterface): void {
  const ms = drawsCells ? FRAME_MS : IDLE_MS
  if (tick !== null && tickMs === ms) return
  tick?.cancel()
  tickMs = ms
  tick = $.clock.every(ms, () => onTick($))
}

async function start($: EngineInterface, job: Job): Promise<void> {
  rechecked.add(job.id)  // its estimate was just read
  await update($, jobs, list => [...list.filter(j => j.id !== job.id), job])
  await update($, now, () => job.startedAt)
  ensureTick($)
}

// A call that left a background task running becomes the task's job in one write, keeping its picture (its frame is not reloaded).
async function handOff($: EngineInterface, from: string, job: Job): Promise<void> {
  rechecked.add(job.id)
  if (asked.delete(from)) asked.add(job.id)
  const kept = pictures.get(from)
  if (kept !== undefined) pictures.set(job.id, kept)
  await update($, jobs, list => [...list.filter(j => j.id !== from && j.id !== job.id), job])
}

// A job's end: one that succeeded shows "done" a moment and teaches its duration, unless a permission dialog waited on the person;
// one that failed, was refused or stopped just goes, so a crash after five seconds does not teach a two-hour build that it takes five
// seconds.
async function finish($: EngineInterface, id: string, succeeded: boolean): Promise<void> {
  const job = (await read($, jobs)).find(j => j.id === id)
  if (job === undefined) return
  const wasAsked = asked.delete(id)
  if (!succeeded) {
    await update($, jobs, list => list.filter(j => j.id !== id))
    return
  }
  const t = await $.clock.now()
  await update($, jobs, list => list.map(j => (j.id === id ? { ...j, doneAt: t } : j)))
  if (!wasAsked) await learn($, job.key, t - job.startedAt)
}

// A permission dialog put up for a call (a settings hook answering puts up none): the jobs of that call wait on the person.
async function markAsked($: EngineInterface, tool: string, input: unknown): Promise<void> {
  if (typeof input !== 'object' || input === null) return
  const key = keyOf(tool, input as Record<string, unknown>)
  for (const j of await read($, jobs)) if (j.key === key && j.kind === 'tool' && j.doneAt === undefined) asked.add(j.id)
}

// The background task a call left running: a shell's record names it (`backgroundTaskId`, also when the person pressed Ctrl+B or the
// command hit its timeout), else its words do: `… running in background with ID: <id>`, an agent's `agentId: <id>`.
const taskIdOf = (ran: ToolCallResult): string | undefined => {
  const record = ran.result as { backgroundTaskId?: unknown } | null | undefined
  return typeof record === 'object' && record !== null && typeof record.backgroundTaskId === 'string' ? record.backgroundTaskId : undefined
}
export const backgroundIdOf = (ran: ToolCallResult): string | null => {
  const id = taskIdOf(ran)
  if (id !== undefined) return id
  const said = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '')
  return /(?:background with ID|agentId)[:=]?\s*"?([\w-]+)/.exec(said)?.[1] ?? null
}

// The background tasks a notification row says ended: each one's id, the call that started it when it says, and whether it succeeded.
// A row may carry several notifications; each is read on its own, and nothing outside one.
export type TaskEnd = { id: string; callId?: string; succeeded: boolean }
export const taskEndsOf = (said: string): TaskEnd[] =>
  (said.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []).flatMap(block => {
    const id = /<task-id>([\w-]+)<\/task-id>/.exec(block)?.[1]
    const status = /<status>(completed|failed|killed|stopped)<\/status>/.exec(block)?.[1]
    const callId = /<tool-use-id>([\w-]+)<\/tool-use-id>/.exec(block)?.[1]
    return id !== undefined && status !== undefined ? [{ id, callId, succeeded: status === 'completed' }] : []
  })

async function finishTask($: EngineInterface, end: TaskEnd): Promise<void> {
  const names = (id: string) => id === end.id || (end.callId !== undefined && id === end.callId)
  const job = (await read($, jobs)).find(j => names(j.id) || (j.callId !== undefined && names(j.callId)))
  if (job !== undefined) await finish($, job.id, end.succeeded)
}

// At a turn's end the engine lists the background work still in flight: a background job not on it ended without a notification
// this mod read (a missed or reworded one, a task stopped), and goes, teaching nothing (when it ended is not known). Its id is checked
// against the list only once another job's id is on it, or the list is empty, so a list naming tasks some other way never drops a job
// that still runs. A call of the main loop never outlasts its turn: one still here lost its end (a reload dropped the hook awaiting
// it) and goes too; a subagent's may go on in the background.
async function reconcile($: EngineInterface, tasks: ReadonlyArray<{ id: string }>): Promise<void> {
  const t = await $.clock.now()
  const live = new Set(tasks.map(k => k.id))
  const running = (await read($, jobs)).filter(j => j.doneAt === undefined && t - j.startedAt > 5000)
  const idsMatch = running.some(j => j.kind === 'background' && live.has(j.id))
  const gone = running.filter(j => (j.kind === 'background'
    ? !live.has(j.id) && (live.size === 0 || (idsMatch && j.id !== j.callId))
    : j.agentId === undefined))
  if (gone.length === 0) return
  for (const j of gone) asked.delete(j.id)
  await update($, jobs, all => all.filter(j => !gone.some(g => g.id === j.id)))
}

// A client came or went: the desktop loads the band's frames again when it shows the session again, so the pictures are made anew.
async function freshPictures($: EngineInterface): Promise<void> {
  pictures.clear()
  await update($, redraw, n => n + 1)
}

// The terminal band's rows: a job's are Clawd's four, the bar and the label; the frame's are the border and the footer.
const JOB_ROWS = AIR_H / 2 + 2
const LEAN_ROWS = 2  // a job without Clawd, where the band has no room for even one with him
const FRAME_ROWS = 3
const TYPED = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])  // a prompt of the person's own

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if ((await read($, jobs)).length > 0) ensureTick($)  // jobs begun before a reload go on ticking
    await update($, redraw, n => n + 1)  // the band drawn again by the new code
    await tidyStore($)
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
    if (QUICK.has(tool) || ON_PERSON.has(tool) || tool.startsWith('mcp__')) return next(e)
    const args = e as unknown as Record<string, unknown>
    const callId = e.tool_use_id
    const startedAt = await $.clock.now()
    const key = keyOf(tool, args)
    const label = labelOf(tool, args)
    const expectedMs = await expected($, key)
    await start($, { id: callId, kind: 'tool', label, key, startedAt, expectedMs, agentId: e.agentId })
    let ran: ToolCallResult
    try {
      ran = await next(e)
    } catch (err) {
      await finish($, callId, false).catch(() => undefined)
      throw err
    }
    try {
      const failed = ran.deny !== undefined || ran.isError === true
      if (!failed && (args.run_in_background === true || taskIdOf(ran) !== undefined)) {
        // the call returned while its work goes on as a background task (asked for, Ctrl+B, a timeout), until its notification, or a
        // turn's end finds it gone
        await handOff($, callId, { id: backgroundIdOf(ran) ?? callId, callId, kind: 'background', label, key, startedAt, expectedMs, agentId: e.agentId })
      } else {
        await finish($, callId, !failed)
      }
    } catch {
      // the band's bookkeeping never fails a call that has run: at worst its job waits for a turn's end
    }
    return ran
  }).catch(($, e, next) => next(e))

  // The dialog asking the person to allow a call.
  on('classic.PermissionRequest', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === undefined) await markAsked($, e.tool_name, e.tool_input)
    return r
  }).catch(($, e, next) => next(e))

  // A background task's end: the notification row names it, as a row of its own or delivered into a running turn (a queued command's
  // attachment). Only those rows are read, never a tool's output, a file or a reply that quotes one.
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    const isNotice = (e.origin as { kind?: string }).kind === 'task-notification' ||
      (e.message.type === 'attachment' && e.message.name === 'queued_command')
    if (isNotice) {
      const said = JSON.stringify(e.message.content)
      if (said.includes('<task-id>')) for (const end of taskEndsOf(said)) await finishTask($, end)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (Array.isArray(e.background_tasks)) await reconcile($, e.background_tasks)
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, jobs)
    if (e.props.hasSurvey || list.length === 0 || (await read($, isHidden))) return next(e)
    await read($, redraw)
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // the picture on the desktop; the terminal's table has no Svg, but what resolve hands back there is not undefined either
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const isPicture = Svg !== undefined
    drawsCells = !isPicture
    // the terminal redraws each tick by `now`; the desktop's picture animates itself, so it reads the clock without subscribing
    const t = isPicture ? await $.clock.now() : await read($, now)
    const visible = list.filter(j => isShown(j, t))
    if (visible.length === 0) return next(e)
    if (isPicture) for (const id of pictures.keys()) if (!list.some(j => j.id === id)) pictures.delete(id)
    // the terminal's band holds maxRows rows: as many jobs as fit there, the latest, Clawd left out where not even one fits with him
    const room = e.props.maxRows - FRAME_ROWS
    const hasClawd = isPicture || room >= JOB_ROWS
    const fits = isPicture ? SHOWN : Math.max(1, Math.min(SHOWN, Math.floor(room / (hasClawd ? JOB_ROWS : LEAN_ROWS))))
    const shown = [...visible].sort((a, b) => a.startedAt - b.startedAt).slice(-fits)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={await read($, urgency)} paddingX={1}>
        {shown.map(job => {
          const p = progressOf(job, t)
          const key = job.callId ?? job.id  // the same through a call's hand-off to its background task
          if (isPicture) {
            return (
              <Box key={key} flexDirection="column">
                <Svg source={pictureOf(job, t)} alt="Clawd walking along the job's progress bar" height={CLAWD_H} isInteractive />
                <Text dimColor>{job.label}</Text>
              </Box>
            )
          }
          const isAsleep = p.mood === 'sleep'
          const sweepLead = Math.round(p.share * (BAR_CELLS - 2))
          return (
            <Box key={key} flexDirection="column">
              {/* Clawd and the bar are laid out in cells, not drawn in characters: a constant length whatever the font */}
              {hasClawd ? clawdRows(job, t).map((row, y) => (
                <Box key={y} width={BAR_CELLS}>
                  {runsOf(row).map((r, i) => r.ch.trim() === ''
                    ? <Box key={i} width={r.n}><Text> </Text></Box>
                    : <Text key={i} color={r.fg} backgroundColor={r.bg}>{r.ch}</Text>)}
                </Box>
              )) : null}
              <Box>
                <Box width={BAR_CELLS} backgroundColor="#3a3a38">
                  {isAsleep
                    ? <Box width={BAR_CELLS}>
                        {sweepLead > 0 ? <Box width={sweepLead}><Text> </Text></Box> : null}
                        <Box width={2} backgroundColor={FILL_HEX.sleep}><Text> </Text></Box>
                      </Box>
                    : <Box width={`${Math.max(1, Math.round(p.share * 100))}%`} backgroundColor={FILL_HEX[p.mood]}><Text> </Text></Box>}
                </Box>
                <Text> </Text>
                <Text bold color={FILL_HEX[p.mood]}>{p.words}{p.mood === 'run' || p.mood === 'near' ? ` - ends ${hhmm(job.startedAt + (job.expectedMs as number))}` : ''}</Text>
              </Box>
              <Text dimColor>{job.label}</Text>
            </Box>
          )
        })}
        <Box justifyContent="space-between">
          <Text dimColor>{visible.length > shown.length ? `+${visible.length - shown.length} more` : ' '}</Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })

  // A new prompt of the person's shows the band again; a notification's or a trigger's turn leaves it hidden.
  on('prompt.submit', async ($, e, next) => {
    const origin = e.origin as { kind?: string; asUser?: boolean } | undefined
    const isTyped = origin?.kind === undefined || TYPED.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
    if (isTyped && e.isMeta !== true && (await read($, isHidden))) await update($, isHidden, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))
}
