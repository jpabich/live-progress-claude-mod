# live-progress

![live-progress demo](assets/demo.gif)

![live-progress in a terminal](assets/demo-cli.gif)

A Claude Code mod: a band above the prompt showing what is running right now (long tool calls, background builds and tests, subagents), each with a progress bar that fills by the job's learned typical duration (ETA).

- On the desktop app, Clawd walks along an animated SVG bar, sweats when a job runs past its usual time and jumps with confetti when it finishes.
- In a terminal, the same Clawd in half-block characters (11 cells by 3 rows under a row of air for his hops, redrawn four times a second) walks, hops, sweats, dozes and jumps over a cell-laid bar with `% - elapsed - ETA - ends HH:MM`.
- Durations are learned per command kind (exponential average kept in the mod's store), so the second run of something gets an ETA. A kind is the script being run (by file name), or the program and up to two subcommands, plus the flags given, with their values when they name a mode or a place (`-Target web`, not `-OutName run7`). Each command of a chain counts, `cd`/`Set-Location` don't: `./build.ps1 -Quick` and `./build.ps1 -Target web` learn apart, as do `npm ci` and `npm ci && npm run build`. Subagents learn by their type.
- Only runs that succeed teach a duration: a failed, refused or killed run is dropped from the band without changing the ETA.
- Quick commands don't open the band: a job shows once it has run 2 s, or at once when its kind usually takes longer.
- Background tasks end on their notification; at each turn's end, any the engine no longer lists as in flight are dropped, so none get stuck.
- Everything is drawn locally from engine events and a local clock: no model calls, no tokens.
- **Hide** closes the band until your next prompt.

Quick tools (`Read`, `Grep`, `Edit`, …) and MCP tools are not shown.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install live-progress --marketplace OWNER/live-progress-claude-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope first).

From a shell:

```bash
claude plugin install live-progress --marketplace OWNER/live-progress-claude-mod
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `OWNER/live-progress-claude-mod`, then **Add plugin**.

Replace `OWNER` with the GitHub account the repository is pushed to. A private repository installs only for people who can read it on GitHub and already have a git credential for github.com.

## Develop

```bash
claude --plugin-dir /path/to/live-progress-claude-mod
```

Edits to `hooks/register.tsx` hot-reload. `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes the first time it loads the mod (it is git-ignored); after that, `tsc -p .` type-checks.

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## Layout

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | the mod's manifest |
| `.claude-plugin/marketplace.json` | makes this repository an installable marketplace |
| `hooks/hooks.json` | names the hooks module |
| `hooks/register.tsx` | the hooks: `tool.call`, `session.append`, `ui.render` (AbovePrompt), `prompt.submit`, `session.start` |
| `types/index.d.ts` | the `$.state` contract (`jobs`, `now`, `isHidden`, `urgency`) |
