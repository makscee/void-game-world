/**
 * Unit tests for the void-game play-assistant helper (VGM-27).
 *
 * Covers the PURE parsing functions: screen digest, buildMissionCommand,
 * handle resolution, readUntil (for onboarding shell), keypair reuse.
 * No live socket is touched by the unit suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseHandleFromScreen,
  parseScreen,
  buildMissionCommand,
  deriveHandle,
  resolveHandle,
  readUntil,
  ensureKeypair,
  readHandleFile,
  writeHandleFile,
  HANDLE_RE,
  NEEDLE_ONBOARDING,
} from "../helper.mjs";

// A real captured-shape overview screen (matches render.ts output order).
const SCREEN = [
  "=== void-game — tick 142 ===",
  "  explore · scavenge · survive — /help for commands, world/CANON.md for canon",
  "",
  "BUNKER rust_owl  (12, -4)        FOOD 7 / 40    STOCKPILE +3",
  "",
  "ROBOTS",
  "  shy-mole         home    BAT 8/10  INT 5/5   no mission",
  "  bold-fox         away    BAT 3/10  INT 4/5",
  '                           mission: "explore east toward (50, -8)"',
  "",
  "NOTES IN BUNKER (1)",
  '  [from world, 2 ticks ago] "a crate of rations"',
  "",
  "WORLD AROUND YOU (21×21)",
  "  . . . . . B . . . . .",
  "",
  "LAST 5 EVENTS (world public log)",
  "  tick 141: bold-fox found a sealed door",
  "  tick 140: shy-mole returned with food",
  "",
  "RECENT MISSIONS (last 3 — full history via /missions)",
  '  tick 138  shy-mole  "scavenge nearby"',
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
  "WORLD AROUND YOU (21×21)",
  "  . . . B . . .",
  "",
  "LAST 5 EVENTS (world public log)",
  "  (quiet so far)",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// parseHandleFromScreen
// ---------------------------------------------------------------------------

test("parseHandleFromScreen: extracts handle from BUNKER line", () => {
  assert.equal(parseHandleFromScreen(SCREEN), "rust_owl");
  assert.equal(parseHandleFromScreen("no bunker line"), null);
});

// ---------------------------------------------------------------------------
// parseScreen
// ---------------------------------------------------------------------------

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
// buildMissionCommand
// ---------------------------------------------------------------------------

test("buildMissionCommand: no robot name", () => {
  assert.equal(buildMissionCommand("explore north"), 'mission "explore north"');
});

test("buildMissionCommand: with robot name", () => {
  assert.equal(buildMissionCommand("scout east", "rust-owl"), 'mission rust-owl "scout east"');
});

test("buildMissionCommand: escapes internal quotes in text", () => {
  const cmd = buildMissionCommand('find "supplies"');
  assert.ok(cmd.includes('\\"supplies\\"'));
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
// readUntil (used for the onboarding shell path)
// ---------------------------------------------------------------------------

test("readUntil: resolves when predicate met across chunks", async () => {
  const ch = new PassThrough();
  const p = readUntil(ch, (b) => b.includes(NEEDLE_ONBOARDING), 1000);
  ch.write("Welcome to void-game. ");
  ch.write("Choose a handle (3–16 chars):\r\n");
  const buf = await p;
  assert.ok(buf.includes(NEEDLE_ONBOARDING));
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
  assert.equal(readFileSync(first.privPath, "utf8"), first.privateKey);
});

test("handle file round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "vg-handle-"));
  assert.equal(readHandleFile(dir), null);
  writeHandleFile("rust_owl", dir);
  assert.equal(readHandleFile(dir), "rust_owl");
});
