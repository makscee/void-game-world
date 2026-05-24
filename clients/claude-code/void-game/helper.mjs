#!/usr/bin/env node
/**
 * void-game play-assistant helper.
 *
 * Standalone Node ESM client for the void-game SSH server
 * (`ssh play@void.game.makscee.ru`, port 22 since VGM-23). Drives ONE turn per
 * invocation:
 *   - `render`           connect, drive onboarding if first time, print the screen.
 *   - `send '<line>'`    connect, read to prompt, emit one line, print the result.
 *
 * The server (workspace/void-game) is line-oriented and does NOT echo
 * programmatic input, so the helper never relies on seeing its own command
 * bounce back. It reads the channel until a known needle:
 *   - `>>> instruction`  the session screen is ready.
 *   - `Choose a handle`  an unknown fingerprint → onboarding.
 * Both are raced on the first read so the helper detects which flow it is in.
 *
 * Identity = a PERSISTENT ed25519 keypair under ~/.config/void-game/. The
 * server keys player state by the SHA256 fingerprint of that key, so reusing
 * the key resumes the same player across invocations. World state advances on
 * the server's own tick schedule regardless of whether we are connected.
 *
 * Verbatim protocol strings (the contract, from the engine `main` 2026-05-24):
 *   session prompt   `>>> instruction`              (render.ts / index.ts)
 *   onboarding       `Welcome to void-game. Choose a handle (3–16 chars...)`
 *   handle regex     ^[a-z][a-z0-9_]{2,15}$         (onboarding.ts)
 *   mission queued   `queued — disconnect any time.`            → session ends
 *   blank stay-home  `no instruction — robots stay home...`     → session ends
 *   /quit            `disconnected — no mission set.`           → session ends
 *
 * The parsing/protocol logic is exported as pure functions for unit tests; the
 * CLI wrapper at the bottom only runs when invoked directly (no live socket in
 * the unit suite).
 */
import ssh2 from "ssh2";
import { createHash } from "node:crypto";

const { Client, utils: ssh2utils } = ssh2;
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Connection constants.
// ---------------------------------------------------------------------------

export const HOST = "void.game.makscee.ru";
// VGM-23 moved the public bind to port 22 (`ssh play@void.game.makscee.ru`, no -p).
export const PORT = 22;
export const USERNAME = "play";

/**
 * Per-read idle timeout. The live server renders the first session screen
 * quickly but re-prints slash-command output (e.g. /map) noticeably slower,
 * so allow generous headroom for a read-only command's re-prompt to arrive.
 */
export const READ_TIMEOUT_MS = 20000;

/** Needles that mark a settled server state. */
export const NEEDLE_PROMPT = ">>> instruction";
export const NEEDLE_ONBOARDING = "Choose a handle";

/** Terminators that mean "the session has ended server-side". */
export const TERMINATORS = [
  "queued — disconnect any time.",
  "no instruction — robots stay home. disconnect any time.",
  "disconnected — no mission set.",
];

/** Handle charset rule — must match onboarding.ts HANDLE_RE exactly. */
export const HANDLE_RE = /^[a-z][a-z0-9_]{2,15}$/;

// ---------------------------------------------------------------------------
// Pure protocol helpers (unit-tested against a stub channel).
// ---------------------------------------------------------------------------

/**
 * Classify an accumulated channel buffer.
 * @returns 'onboarding' | 'prompt' | null
 * Whichever needle appears FIRST in the buffer wins (the onboarding banner is
 * printed before the session screen, so on a fresh fingerprint the handle
 * prompt is seen first).
 */
export function findNeedle(buf) {
  const iPrompt = buf.indexOf(NEEDLE_PROMPT);
  const iOnboard = buf.indexOf(NEEDLE_ONBOARDING);
  if (iOnboard === -1 && iPrompt === -1) return null;
  if (iOnboard === -1) return "prompt";
  if (iPrompt === -1) return "onboarding";
  return iOnboard < iPrompt ? "onboarding" : "prompt";
}

/** True once the buffer contains any session-ending terminator. */
export function hasTerminator(buf) {
  return TERMINATORS.some((t) => buf.includes(t));
}

/**
 * Classify the line the player is about to send.
 *   - 'mission'   free text (no leading `/`) or blank → submitting ends session.
 *   - 'quit'      `/quit` → ends session.
 *   - 'command'   any other slash command → session stays open (re-prompts).
 */
export function classifyLine(line) {
  const t = line.trim();
  if (t === "") return "mission"; // blank = stay home, also ends the session
  if (!t.startsWith("/")) return "mission";
  const verb = t.slice(1).split(/\s+/)[0].toLowerCase();
  return verb === "quit" ? "quit" : "command";
}

/**
 * Derive a default handle from a key fingerprint when none is supplied.
 * `player_<first 6 hex>` sanitised to satisfy HANDLE_RE.
 */
export function deriveHandle(fingerprintHex) {
  const six = (fingerprintHex || "").replace(/[^a-f0-9]/g, "").slice(0, 6) || "000000";
  return `player_${six}`;
}

/**
 * Choose the handle for onboarding from explicit arg → env → derived default.
 * Always returns a value satisfying HANDLE_RE (the derived default does).
 */
export function resolveHandle({ argHandle, envHandle, fingerprintHex }) {
  const candidate = (argHandle || envHandle || "").trim().toLowerCase();
  if (candidate && HANDLE_RE.test(candidate)) return candidate;
  return deriveHandle(fingerprintHex);
}

/**
 * SHA256 fingerprint (hex) of an OpenSSH public key string. Used only to derive
 * a stable default handle; the server computes its own fingerprint from the key
 * for identity. We hash the base64 body to get a deterministic per-key hex.
 */
export function pubkeyFingerprintHex(pubkeyText) {
  const body = (pubkeyText || "").trim().split(/\s+/)[1] || pubkeyText || "";
  return createHash("sha256").update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Keypair management.
// ---------------------------------------------------------------------------

export function defaultKeyDir() {
  return process.env.VOID_GAME_DIR || join(homedir(), ".config", "void-game");
}

/**
 * Ensure an ed25519 keypair exists at `dir` and return its material. Generates
 * once (private key 0600) and reuses the same bytes on every later call so the
 * server-side fingerprint — and thus the player — stays stable.
 */
export function ensureKeypair(dir = defaultKeyDir()) {
  mkdirSync(dir, { recursive: true });
  const privPath = join(dir, "id_ed25519");
  const pubPath = join(dir, "id_ed25519.pub");
  if (!existsSync(privPath)) {
    // ssh2's keygen emits an OpenSSH-format private key the Client can parse
    // (node:crypto's PKCS8 PEM is rejected by ssh2 with "Unsupported key
    // format") and a standard `ssh-ed25519 <base64>` public key.
    const { private: privateKey, public: publicKey } =
      ssh2utils.generateKeyPairSync("ed25519");
    writeFileSync(privPath, privateKey, { mode: 0o600 });
    writeFileSync(pubPath, publicKey, { mode: 0o644 });
    chmodSync(privPath, 0o600);
  }
  const privateKey = readFileSync(privPath, "utf8");
  const publicKey = existsSync(pubPath) ? readFileSync(pubPath, "utf8") : "";
  return { dir, privPath, pubPath, privateKey, publicKey };
}

export function readHandleFile(dir = defaultKeyDir()) {
  const p = join(dir, "handle.txt");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

export function writeHandleFile(handle, dir = defaultKeyDir()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "handle.txt"), handle + "\n");
}

/** Extract `BUNKER <handle>` from a rendered screen, or null. */
export function parseHandleFromScreen(screen) {
  const m = /^BUNKER\s+(\S+)\s+\(/m.exec(screen);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Best-effort digest parser (raw screen stays authoritative; this is a hint).
// ---------------------------------------------------------------------------

/**
 * Parse the known section headers of a rendered screen into a compact object.
 * Tolerant: any field that is absent comes back null/empty. The RAW screen is
 * the source of truth for the player digest; this just makes Claude's job
 * reliable.
 */
export function parseScreen(screen) {
  const tickM = /=== void-game — tick (\d+) ===/.exec(screen);
  const bunkerM = /^BUNKER\s+(\S+)\s+\((-?\d+),\s*(-?\d+)\)\s+FOOD\s+(\d+)\s*\/\s*(\d+)\s+STOCKPILE\s+\+(\d+)/m.exec(screen);
  const fasting = /FASTING — no new missions/.test(screen);

  // ROBOTS block: lines between "ROBOTS" and the next blank line.
  const robots = [];
  const lines = screen.split(/\r?\n/);
  const rIdx = lines.findIndex((l) => l === "ROBOTS");
  if (rIdx >= 0) {
    for (let i = rIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === "") break;
      // robot head line: "  <name> <status> BAT b/max  INT i/imax ..."
      const rm = /^\s{2}(\S+)\s+(\S+)\s+BAT\s+(\d+)\/(\d+)\s+INT\s+([\d.]+)\/(\d+)/.exec(l);
      if (rm) {
        robots.push({
          name: rm[1],
          status: rm[2],
          battery: `${rm[3]}/${rm[4]}`,
          integrity: `${rm[5]}/${rm[6]}`,
          mission: null,
        });
      } else {
        const mm = /mission:\s+"(.*)"/.exec(l);
        if (mm && robots.length) robots[robots.length - 1].mission = mm[1];
      }
    }
  }

  // NOTES IN BUNKER (<n>) count.
  const notesM = /NOTES IN BUNKER\s*(?:\((\d+)\))?/.exec(screen);
  const notes = notesM ? (notesM[1] ? Number(notesM[1]) : 0) : 0;

  // LAST 5 EVENTS lines.
  const events = [];
  const eIdx = lines.findIndex((l) => l.startsWith("LAST 5 EVENTS"));
  if (eIdx >= 0) {
    for (let i = eIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === "") break;
      events.push(l.trim());
    }
  }

  return {
    tick: tickM ? Number(tickM[1]) : null,
    handle: bunkerM ? null : parseHandleFromScreen(screen),
    bunker: bunkerM
      ? {
          handle: parseHandleFromScreen(screen),
          position: [Number(bunkerM[2]), Number(bunkerM[3])],
          food: Number(bunkerM[4]),
          foodCap: Number(bunkerM[5]),
          stockpile: Number(bunkerM[6]),
        }
      : null,
    fasting,
    robots,
    notes,
    events,
  };
}

// ---------------------------------------------------------------------------
// Channel read-until logic (pure over a duplex; unit-tested with PassThrough).
// ---------------------------------------------------------------------------

/**
 * Accumulate `data` from `stream` until `predicate(buf)` is truthy, then
 * resolve the full buffer. Rejects with an idle-timeout error (carrying the
 * captured buffer) if no progress within `timeoutMs`. Resolves on stream
 * end/close if the predicate is satisfied by the final buffer, else rejects.
 */
export function readUntil(stream, predicate, timeoutMs = READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    let timer = null;

    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        const e = new Error(`read idle: predicate unmet within ${timeoutMs}ms`);
        e.buffer = buf;
        reject(e);
      }, timeoutMs);
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("close", onEnd);
      stream.removeListener("end", onEnd);
    };

    const tryResolve = () => {
      if (done) return false;
      if (predicate(buf)) {
        done = true;
        cleanup();
        resolve(buf);
        return true;
      }
      return false;
    };

    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      if (!tryResolve()) arm();
    };
    const onEnd = () => {
      if (done) return;
      if (tryResolve()) return;
      done = true;
      cleanup();
      const e = new Error("stream closed before predicate met");
      e.buffer = buf;
      reject(e);
    };

    stream.on("data", onData);
    stream.on("close", onEnd);
    stream.on("end", onEnd);
    arm();
  });
}

/** Read until a settled needle (prompt OR onboarding) appears. */
export function readUntilSettled(stream, timeoutMs = READ_TIMEOUT_MS) {
  return readUntil(stream, (b) => findNeedle(b) !== null, timeoutMs);
}

/**
 * Drive onboarding on `stream`: the buffer already shows the `Choose a handle`
 * banner. Write the resolved handle, then read on until the session prompt
 * appears (the server drops straight into the session screen after a valid
 * handle). Returns the handle that was sent.
 */
export async function driveOnboarding(stream, handle, timeoutMs = READ_TIMEOUT_MS) {
  stream.write(handle + "\n");
  await readUntil(stream, (b) => b.includes(NEEDLE_PROMPT), timeoutMs);
  return handle;
}

/**
 * Send one line and read the result per its classification:
 *   - mission/quit/blank → read until a terminator, capture, session ends.
 *   - read-only command  → read until the NEXT prompt re-print; the text after
 *                          the sent line up to that prompt is the command output.
 * Returns { kind, output } where output is the freshly-arrived bytes.
 */
export async function sendLine(stream, line, timeoutMs = READ_TIMEOUT_MS) {
  const kind = classifyLine(line);
  stream.write(line + "\n");
  if (kind === "mission" || kind === "quit") {
    const buf = await readUntil(stream, hasTerminator, timeoutMs);
    return { kind, output: buf };
  }
  // read-only command: a fresh prompt re-print follows the command output.
  // Wait for a prompt occurrence; since the channel already held one prompt
  // before we sent, require that the buffer gains additional prompt text.
  const buf = await readUntil(stream, (b) => countOccurrences(b, NEEDLE_PROMPT) >= 1, timeoutMs);
  return { kind, output: buf };
}

export function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Live connection (CLI only; not exercised by unit tests).
// ---------------------------------------------------------------------------

/**
 * Open a shell channel against the live server with the persistent key.
 *
 * VGM-24: request NO pty (`conn.shell(false, cb)`). The server gates its LIVE
 * cursor-redraw TUI on a pty-req being seen; a no-pty channel is its explicit
 * signal to stay on the PLAIN one-shot turn render, which is the escape-free
 * text this helper parses. `conn.shell(cb)` would request a pty by default and
 * wrongly opt the agent into the human live mode.
 */
function connect(privateKey) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.on("ready", () => {
      conn.shell(false, (err, stream) => {
        if (err) {
          if (!settled) { settled = true; conn.end(); reject(err); }
          return;
        }
        if (!settled) { settled = true; resolve({ conn, stream }); }
      });
    });
    conn.on("error", (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    conn.connect({
      host: HOST,
      port: PORT,
      username: USERNAME,
      privateKey,
      // It is a public game server; accept any host key.
      hostVerifier: () => true,
      readyTimeout: 15000,
    });
  });
}

/**
 * One-turn `render`: connect, drive onboarding if needed, capture + print the
 * screen, disconnect. No mission is submitted.
 */
async function cmdRender({ argHandle }) {
  const kp = ensureKeypair();
  const fpHex = pubkeyFingerprintHex(kp.publicKey);
  const { conn, stream } = await connect(kp.privateKey);
  try {
    const first = await readUntilSettled(stream);
    let screen = first;
    if (findNeedle(first) === "onboarding") {
      const handle = resolveHandle({
        argHandle,
        envHandle: process.env.VOID_GAME_HANDLE,
        fingerprintHex: fpHex,
      });
      await driveOnboarding(stream, handle);
      writeHandleFile(handle, kp.dir);
      // After onboarding the prompt screen is in the buffer; re-read snapshot.
      screen = await readUntil(stream, (b) => b.includes(NEEDLE_PROMPT));
    }
    const parsedHandle = parseHandleFromScreen(screen);
    if (parsedHandle) writeHandleFile(parsedHandle, kp.dir);
    process.stdout.write(screen);
  } finally {
    try { stream.end(); } catch {}
    try { conn.end(); } catch {}
  }
}

/**
 * One-turn `send`: connect, read to a settled state (driving onboarding if a
 * brand-new key somehow reaches here), emit `<line>`, capture + print the
 * result, disconnect.
 */
async function cmdSend(line, { argHandle }) {
  const kp = ensureKeypair();
  const fpHex = pubkeyFingerprintHex(kp.publicKey);
  const { conn, stream } = await connect(kp.privateKey);
  try {
    const first = await readUntilSettled(stream);
    if (findNeedle(first) === "onboarding") {
      const handle = resolveHandle({
        argHandle,
        envHandle: process.env.VOID_GAME_HANDLE,
        fingerprintHex: fpHex,
      });
      await driveOnboarding(stream, handle);
      writeHandleFile(handle, kp.dir);
      await readUntil(stream, (b) => b.includes(NEEDLE_PROMPT));
    }
    const { output } = await sendLine(stream, line);
    process.stdout.write(output);
  } finally {
    try { stream.end(); } catch {}
    try { conn.end(); } catch {}
  }
}

function parseArgs(argv) {
  const out = { _: [], argHandle: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--handle") { out.argHandle = argv[++i]; continue; }
    out._.push(argv[i]);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  if (sub === "render") {
    await cmdRender({ argHandle: args.argHandle });
  } else if (sub === "send") {
    const line = args._[1];
    if (line === undefined) {
      process.stderr.write("usage: helper.mjs send '<line>'\n");
      process.exit(2);
    }
    await cmdSend(line, { argHandle: args.argHandle });
  } else {
    process.stderr.write(
      "usage: helper.mjs render | helper.mjs send '<line>' [--handle <h>]\n",
    );
    process.exit(2);
  }
}

// Run the CLI only when invoked directly (not on import for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`error: ${err && err.message ? err.message : err}\n`);
    if (err && err.buffer) {
      process.stderr.write(`--- captured buffer ---\n${err.buffer}\n`);
    }
    process.exit(1);
  });
}
