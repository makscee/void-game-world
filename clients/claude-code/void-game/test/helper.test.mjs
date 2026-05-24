/**
 * Unit tests for the void-game play-assistant helper.
 *
 * Covers the PURE parsing/protocol functions with a stubbed PassThrough channel
 * (no live socket). Verifies: needle detection, screen-digest parsing, command
 * classification + line emission, read-until terminators, onboarding flow, and
 * keypair reuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findNeedle,
  hasTerminator,
  classifyLine,
  deriveHandle,
  resolveHandle,
  parseHandleFromScreen,
  parseScreen,
  readUntil,
  readUntilSettled,
  driveOnboarding,
  sendLine,
  countOccurrences,
  ensureKeypair,
  readHandleFile,
  writeHandleFile,
  NEEDLE_PROMPT,
  NEEDLE_ONBOARDING,
  HANDLE_RE,
} from "../helper.mjs";

// A real captured-shape session screen (matches render.ts output order).
const SCREEN = [
  "=== void-game — tick 142 ===",
  "",
  "  Rules: explore, scavenge, survive. Food is your hunger clock,",
  "  battery is your robot's range. Robots break and can be lost.",
  "  See world/CANON.md for canon. /help for commands.",
  "",
  "BUNKER rust_owl  (12, -4)        FOOD 7 / 40    STOCKPILE +3",
  "",
  "ROBOTS",
  "  shy-mole         home    BAT 8/10  INT 5/5   no mission",
  "  bold-fox         away    BAT 3/10  INT 4/5",
  '                           mission: "explore east toward (50, -8)"',
  "",
  "NOTES IN BUNKER (1)",
  "  [from world, 2 ticks ago] \"a crate of rations\"",
  "",
  "WORLD AROUND YOU (11×11)",
  "  . . . . . B . . . . .",
  "  . . . # . . . . . . .",
  "",
  "LAST 5 EVENTS (world public log)",
  "  tick 141: bold-fox found a sealed door",
  "  tick 140: shy-mole returned with food",
  "",
  "RECENT MISSIONS (last 3 — full history via /missions)",
  "  tick 138  shy-mole  \"scavenge nearby\"",
  "",
  ">>> instruction for shy-mole (blank = stay home, /help for commands):",
  "",
].join("\n");

const FASTING_SCREEN = [
  "=== void-game — tick 9 ===",
  "",
  "BUNKER hungry_one  (0, 0)        FOOD 0 / 40    STOCKPILE +0",
  "  FASTING — no new missions until a robot delivers food.",
  "",
  "ROBOTS",
  "  tin-bat          home    BAT 0/10  INT 0/5   repairing — no mission yet",
  "",
  "NOTES IN BUNKER",
  "  (empty)",
  "",
  "WORLD AROUND YOU (11×11)",
  "  . . . B . . .",
  "",
  "LAST 5 EVENTS (world public log)",
  "  (quiet so far)",
  "",
  ">>> instruction (blank = stay home, /help for commands):",
  "",
].join("\n");

const ONBOARDING_BANNER =
  "\r\nWelcome to void-game. Choose a handle (3–16 chars, a-z 0-9 _):\r\n";

// ---------------------------------------------------------------------------
// findNeedle
// ---------------------------------------------------------------------------

test("findNeedle: session prompt", () => {
  assert.equal(findNeedle(SCREEN), "prompt");
});

test("findNeedle: onboarding banner", () => {
  assert.equal(findNeedle(ONBOARDING_BANNER), "onboarding");
});

test("findNeedle: null when neither present", () => {
  assert.equal(findNeedle("just some bytes\n"), null);
});

test("findNeedle: onboarding wins when it appears first", () => {
  const both = ONBOARDING_BANNER + "\n" + SCREEN;
  assert.equal(findNeedle(both), "onboarding");
});

test("findNeedle: prompt wins when onboarding banner is absent but prompt present", () => {
  assert.equal(findNeedle("..." + NEEDLE_PROMPT + " for x:"), "prompt");
});

// ---------------------------------------------------------------------------
// hasTerminator
// ---------------------------------------------------------------------------

test("hasTerminator: mission queued", () => {
  assert.ok(hasTerminator("\r\nqueued — disconnect any time.\r\n"));
});

test("hasTerminator: blank stay-home", () => {
  assert.ok(
    hasTerminator("\r\nno instruction — robots stay home. disconnect any time.\r\n"),
  );
});

test("hasTerminator: quit", () => {
  assert.ok(hasTerminator("\r\ndisconnected — no mission set.\r\n"));
});

test("hasTerminator: false on a plain screen", () => {
  assert.equal(hasTerminator(SCREEN), false);
});

// ---------------------------------------------------------------------------
// classifyLine
// ---------------------------------------------------------------------------

test("classifyLine: free text is a mission", () => {
  assert.equal(classifyLine("explore east toward (50, -8)"), "mission");
});

test("classifyLine: blank is a mission (stay home, ends turn)", () => {
  assert.equal(classifyLine(""), "mission");
  assert.equal(classifyLine("   "), "mission");
});

test("classifyLine: /quit is quit", () => {
  assert.equal(classifyLine("/quit"), "quit");
  assert.equal(classifyLine("  /QUIT  "), "quit");
});

test("classifyLine: read-only slash commands are command", () => {
  for (const c of ["/map", "/map wide", "/log", "/log full", "/read mailbox", "/missions", "/help", "/rename a b"]) {
    assert.equal(classifyLine(c), "command", c);
  }
});

// ---------------------------------------------------------------------------
// handle resolution
// ---------------------------------------------------------------------------

test("deriveHandle: player_<fp6> satisfies HANDLE_RE", () => {
  const h = deriveHandle("ab12cd34ef56");
  assert.equal(h, "player_ab12cd");
  assert.ok(HANDLE_RE.test(h));
});

test("deriveHandle: empty fingerprint falls back, still valid", () => {
  const h = deriveHandle("");
  assert.ok(HANDLE_RE.test(h));
});

test("resolveHandle: arg wins when valid", () => {
  assert.equal(
    resolveHandle({ argHandle: "rust_owl", envHandle: "envone", fingerprintHex: "abc123" }),
    "rust_owl",
  );
});

test("resolveHandle: env used when arg absent", () => {
  assert.equal(
    resolveHandle({ argHandle: undefined, envHandle: "env_pilot", fingerprintHex: "abc123" }),
    "env_pilot",
  );
});

test("resolveHandle: invalid candidate falls back to derived", () => {
  const h = resolveHandle({ argHandle: "X!bad", envHandle: "", fingerprintHex: "deadbeef" });
  assert.equal(h, "player_deadbe");
});

// ---------------------------------------------------------------------------
// screen parsing
// ---------------------------------------------------------------------------

test("parseHandleFromScreen", () => {
  assert.equal(parseHandleFromScreen(SCREEN), "rust_owl");
  assert.equal(parseHandleFromScreen("no bunker line"), null);
});

test("parseScreen: tick / bunker / fasting", () => {
  const p = parseScreen(SCREEN);
  assert.equal(p.tick, 142);
  assert.equal(p.bunker.food, 7);
  assert.equal(p.bunker.foodCap, 40);
  assert.equal(p.bunker.stockpile, 3);
  assert.deepEqual(p.bunker.position, [12, -4]);
  assert.equal(p.bunker.handle, "rust_owl");
  assert.equal(p.fasting, false);
});

test("parseScreen: robots with status, stats, mission", () => {
  const p = parseScreen(SCREEN);
  assert.equal(p.robots.length, 2);
  assert.equal(p.robots[0].name, "shy-mole");
  assert.equal(p.robots[0].status, "home");
  assert.equal(p.robots[0].battery, "8/10");
  assert.equal(p.robots[0].integrity, "5/5");
  assert.equal(p.robots[1].name, "bold-fox");
  assert.equal(p.robots[1].mission, "explore east toward (50, -8)");
});

test("parseScreen: notes count + events", () => {
  const p = parseScreen(SCREEN);
  assert.equal(p.notes, 1);
  assert.equal(p.events.length, 2);
  assert.ok(p.events[0].includes("bold-fox found a sealed door"));
});

test("parseScreen: FASTING flag + repairing robot + empty notes", () => {
  const p = parseScreen(FASTING_SCREEN);
  assert.equal(p.fasting, true);
  assert.equal(p.bunker.food, 0);
  assert.equal(p.notes, 0);
  assert.equal(p.robots[0].status, "home");
  assert.equal(p.robots[0].integrity, "0/5");
});

// ---------------------------------------------------------------------------
// countOccurrences
// ---------------------------------------------------------------------------

test("countOccurrences", () => {
  assert.equal(countOccurrences("aXbXc", "X"), 2);
  assert.equal(countOccurrences("none", "X"), 0);
  assert.equal(countOccurrences("aaa", ""), 0);
});

// ---------------------------------------------------------------------------
// readUntil over a stub PassThrough
// ---------------------------------------------------------------------------

test("readUntil: resolves when predicate met across chunks", async () => {
  const ch = new PassThrough();
  const p = readUntil(ch, (b) => b.includes(NEEDLE_PROMPT), 1000);
  ch.write("=== void-game — tick 1 ===\n");
  ch.write("...some screen...\n");
  ch.write(">>> instruction for x:\n");
  const buf = await p;
  assert.ok(buf.includes(NEEDLE_PROMPT));
});

test("readUntil: rejects on idle timeout with captured buffer", async () => {
  const ch = new PassThrough();
  const p = readUntil(ch, (b) => b.includes("NEVER"), 60);
  ch.write("partial bytes");
  await assert.rejects(p, (e) => {
    assert.match(e.message, /read idle/);
    assert.equal(e.buffer, "partial bytes");
    return true;
  });
});

test("readUntilSettled: detects onboarding needle", async () => {
  const ch = new PassThrough();
  const p = readUntilSettled(ch, 1000);
  ch.write(ONBOARDING_BANNER);
  const buf = await p;
  assert.equal(findNeedle(buf), "onboarding");
});

// ---------------------------------------------------------------------------
// driveOnboarding: writes handle, reads on to the session prompt
// ---------------------------------------------------------------------------

test("driveOnboarding: emits handle line then resolves on prompt", async () => {
  // Two ends of a pipe: helper writes to `client`, reads from `client`; the
  // fake server echoes via the same duplex by writing the session screen.
  const client = new PassThrough();
  const written = [];
  const origWrite = client.write.bind(client);
  client.write = (chunk, ...rest) => {
    written.push(chunk.toString());
    return true; // do not loop our own write back into the read buffer
  };

  const p = driveOnboarding(client, "rust_owl", 1000);
  // Server responds with the session screen once the handle is accepted.
  setImmediate(() => origWrite(SCREEN));
  const handle = await p;

  assert.equal(handle, "rust_owl");
  assert.equal(written.length, 1);
  assert.equal(written[0], "rust_owl\n");
});

// ---------------------------------------------------------------------------
// sendLine: classification + emission + terminator detection
// ---------------------------------------------------------------------------

function stubChannel() {
  const ch = new PassThrough();
  const written = [];
  const origWrite = ch.write.bind(ch);
  ch.write = (chunk, ...rest) => {
    written.push(chunk.toString());
    return true;
  };
  ch._server = origWrite; // server-side injection
  ch._written = written;
  return ch;
}

test("sendLine: mission writes one line and reads to 'queued'", async () => {
  const ch = stubChannel();
  const p = sendLine(ch, "explore east toward (50, -8)", 1000);
  setImmediate(() => ch._server("\r\nqueued — disconnect any time.\r\n"));
  const { kind, output } = await p;
  assert.equal(kind, "mission");
  assert.ok(output.includes("queued"));
  assert.deepEqual(ch._written, ["explore east toward (50, -8)\n"]);
});

test("sendLine: blank stays home, ends on stay-home terminator", async () => {
  const ch = stubChannel();
  const p = sendLine(ch, "", 1000);
  setImmediate(() =>
    ch._server("\r\nno instruction — robots stay home. disconnect any time.\r\n"),
  );
  const { kind, output } = await p;
  assert.equal(kind, "mission");
  assert.ok(output.includes("robots stay home"));
  assert.deepEqual(ch._written, ["\n"]);
});

test("sendLine: /quit reads to 'disconnected'", async () => {
  const ch = stubChannel();
  const p = sendLine(ch, "/quit", 1000);
  setImmediate(() => ch._server("\r\ndisconnected — no mission set.\r\n"));
  const { kind, output } = await p;
  assert.equal(kind, "quit");
  assert.ok(output.includes("disconnected"));
  assert.deepEqual(ch._written, ["/quit\n"]);
});

test("sendLine: read-only /map reads to the re-prompt", async () => {
  const ch = stubChannel();
  const p = sendLine(ch, "/map", 1000);
  setImmediate(() =>
    ch._server(
      "\n=== map (11×11, centred on your bunker) ===\n  . . B . .\n" +
        "\r\n>>> instruction (blank = stay home, /help for commands):\r\n",
    ),
  );
  const { kind, output } = await p;
  assert.equal(kind, "command");
  assert.ok(output.includes("=== map"));
  assert.ok(output.includes(NEEDLE_PROMPT));
  assert.deepEqual(ch._written, ["/map\n"]);
});

// ---------------------------------------------------------------------------
// keypair reuse
// ---------------------------------------------------------------------------

test("ensureKeypair: creates 0600 private key, reuses identical bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "vg-key-"));
  const first = ensureKeypair(dir);
  assert.ok(first.privateKey.includes("PRIVATE KEY"));
  const mode = statSync(first.privPath).mode & 0o777;
  assert.equal(mode, 0o600);

  const second = ensureKeypair(dir);
  assert.equal(second.privateKey, first.privateKey);
  assert.equal(second.publicKey, first.publicKey);
  // Bytes on disk match what was returned.
  assert.equal(readFileSync(first.privPath, "utf8"), first.privateKey);
});

test("handle file round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "vg-handle-"));
  assert.equal(readHandleFile(dir), null);
  writeHandleFile("rust_owl", dir);
  assert.equal(readHandleFile(dir), "rust_owl");
});
