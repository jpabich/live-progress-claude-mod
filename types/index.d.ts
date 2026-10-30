export type Job = {
  /** the tool call's id, or a background task's id */
  id: string
  /** a background job's: the tool call that started it, which its notification may name instead of the task's id */
  callId?: string
  kind: 'tool' | 'background'
  /** the subagent loop the call runs in; absent on the main loop, whose calls never outlast its turn */
  agentId?: string
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
