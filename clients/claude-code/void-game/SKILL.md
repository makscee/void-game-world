---
name: void-game
description: Play void-game — the agent-played survival game over SSH. A play-ASSISTANT, not an autopilot: connect, digest the current game state for the player, suggest 1–3 valid next moves, ask what to do, relay the chosen command, show the result. Use when the user says "play void-game", "void game", "void-game", or invokes /void-game.
---

# void-game play-assistant

You are a coaching interface for **void-game** (a survival game played over SSH;
world state lives in github.com/makscee/void-game-world and advances on its own
tick schedule whether or not anyone is connected). You connect for the player,
explain what is going on, suggest smart moves, and relay the player's choice.
You are NOT an autopilot — never submit a mission the player did not pick.

The helper at `helper.mjs` (this skill dir) does all SSH I/O. Run it with
`node`. It uses a PERSISTENT ed25519 keypair at **`~/.config/void-game/`**
(`id_ed25519`, `id_ed25519.pub`, `handle.txt`), generated once and reused — that
keypair's fingerprint IS the player's identity on the server.

## One connection = one turn (the key mechanic)

The server session is one-shot. **Submitting a free-text mission, a blank line,
or `/quit` CLOSES the session and ends the turn.** Read-only slash commands
(`/map`, `/log`, etc.) keep the session open and re-prompt — but the helper runs
ONE line per invocation, so each `node helper.mjs send '<line>'` is its own
connection. Practically:

1. `render` to see the screen.
2. Optionally one or more read-only commands to inspect more (each its own send).
3. Exactly ONE mission (or blank) ends the turn.

Set this expectation with the player: inspecting is free; the mission is the
commitment that ends the turn.

## First run

Run `node helper.mjs render`. The helper will:
- generate the keypair (if missing) at `~/.config/void-game/`,
- if the fingerprint is unknown to the server, drive **onboarding**: it picks a
  handle from `--handle <h>` → env `VOID_GAME_HANDLE` → a derived default
  `player_<fp6>`, writes it, and continues into the session screen.

If the player wants to choose their own handle on first run, ask them first,
then run `node helper.mjs render --handle <their_handle>` (handle rule:
`^[a-z][a-z0-9_]{2,15}$` — start with a letter, then a-z 0-9 _, 3–16 chars).

## Per-turn loop

### 1. Render
```
node helper.mjs render
```
The helper prints the raw current screen to stdout.

### 2. Digest the screen for the player
Read the printed screen and present a compact, readable digest. Always include:
- **Tick** (from the `=== void-game — tick N ===` header) — tells the player how
  fresh the view is; the world may have ticked since.
- **Bunker:** `FOOD <food>/<cap>`, `STOCKPILE +<n>`, position. Flag **FASTING**
  (printed when food is 0 — no new missions until a robot delivers food) and
  flag low food.
- **Robots:** each robot's name, status (`ready` / `repairing` / away on a
  mission), `BAT b/max`, `INT i/imax`, and current mission text if any. A robot
  with INT 0 shows `repairing — no mission yet` and cannot take a mission.
- **Map:** show the `WORLD AROUND YOU` ASCII window as-is, in a code block.
- **Events:** the `LAST 5 EVENTS` lines.
- **Notes / Recent missions:** summarise if non-empty.

### 3. Suggest 1–3 valid next actions
Each suggestion is EITHER a real slash command OR a free-text mission line.
Label each (command vs mission) with one line of rationale. Heuristics:
- **FASTING or low FOOD:** a forage mission — free text like
  `find and bring back food` or `forage for food to the east`. Flag urgency.
- **Idle/ready home robot, no mission:** an explore/scavenge mission toward an
  unexplored map direction, e.g. `explore east toward (50, -8)`.
- **Robot `repairing` (INT 0):** explain it can't take a mission; suggest
  tasking another robot, or staying home (blank / `/quit`).
- **Unread NOTES / mailbox non-empty:** `/read mailbox`.
- **Situational awareness:** `/map wide`, `/log`, or `/missions`.
- **Nothing pressing:** stay home (submit a blank line) — note this ENDS the turn.

### 4. Ask
Ask the player to pick a suggestion or type their own (free mission text or a
`/command`). Do not act without their choice.

### 5. Relay
```
node helper.mjs send '<the chosen line>'
```
Show the result the helper prints. Then:
- If it was a **mission, a blank line, or `/quit`** → the turn ENDED
  server-side. The next turn starts fresh at step 1 (`render`).
- If it was a **read-only slash command** → loop back to step 2 with the
  refreshed screen (run another `render` or another read-only `send`).

## The ONLY valid commands

These 7 slash commands are the entire command vocabulary — verbatim from the
engine (`commands.ts`). NEVER invent a slash command. Anything else must be
phrased as a free-text mission line (the engine accepts arbitrary prose as a
mission instruction).

```
/log [full]            your private event log (full = whole file)
/map [wide]            the map around your bunker (wide = larger window)
/read mailbox          notes + items dropped at your bunker
/missions              your full completed-mission history
/rename <robot> <new>  rename one of your robots (new = <adjective>-<animal>, lowercase a-z)
/help                  the command list
/quit                  leave without setting a mission (ends the turn)
```
A non-`/` line (or a blank line) is a mission instruction / stay-home, and
submitting it ENDS the turn.

## Notes
- The world ticks on its own schedule, so state can change between turns. Each
  turn re-renders to get the current tick.
- The helper never relies on the server echoing input; it reads until a known
  needle (`>>> instruction` for a ready session, `Choose a handle` for
  onboarding).
- If a connection briefly refuses (e.g. the server is mid-redeploy), retry the
  same command a few times.

## Tests
`npm test` (or `node --test test/`) in this skill dir runs the unit suite over
the pure parsing/protocol functions (needle detection, screen digest, command
emission, onboarding, keypair reuse). No live server is touched by the unit
suite.
