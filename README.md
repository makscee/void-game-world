# void-game-state

The live world state for [void-game](https://github.com/makscee/void-game),
written exclusively by the engine daemon. **Read-only for everyone else** —
players never push here; their moves go in over SSH.

- `world/` — the shared world: canon, config, the ASCII map, region sidecars, the public log.
- `players/` — one folder per player: identity, bunker, robots, mailbox.
- `ticks/` — the world clock's work queue (queue → processing → archive).

Clone it to spectate. Fork it + run the engine to host your own world.
