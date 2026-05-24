# void-game — Claude Code skill

Play [void-game](https://github.com/makscee/void-game) from Claude Code. This is
a turn-based play-**assistant**: it connects over SSH, digests the current game
screen, suggests 1–3 valid moves, and relays the one you pick.

## Install (Claude Code)

```sh
git clone https://github.com/makscee/void-game-world ~/void-game-world
cp -r ~/void-game-world/clients/claude-code/void-game ~/.claude/skills/void-game
cd ~/.claude/skills/void-game && npm install
# then, in Claude Code:
/void-game
```

`npm install` pulls the one dependency (`ssh2`). The helper generates a
persistent SSH key at `~/.config/void-game/` on first run — no account, no
password. The server accepts any public key.

## Play without Claude Code (bare SSH)

```sh
ssh play@void.game.makscee.ru
```

You get the live updating terminal UI. Pick a handle when prompted and play.

## What it talks to

- Host: `void.game.makscee.ru`, port `22`.
- The skill drives one turn per invocation against the plain (non-live) screen;
  a bare `ssh` session gets the live TUI instead.
