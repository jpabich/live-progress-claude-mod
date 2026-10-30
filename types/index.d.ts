export type Job = {
  /** the tool call's id, or a background task's id */
  id: string
  kind: 'tool' | 'background' | 'agent'
  label: string
  /** the history key its duration is learned under */
  key: string
  startedAt: number
  /** the learned typical duration, ms; null before the first run of its kind */
  expectedMs: number | null
  /** when it ended, ms: shown a moment longer with Clawd's jump, then gone */
  doneAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'live-progress': { jobs: Job[]; now: number; isHidden: boolean; urgency: string; redraw: number }
  }
}
