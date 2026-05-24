#!/usr/bin/env node
/**
 * void-game play-assistant helper.
 *
 * Standalone Node ESM client for the void-game SSH server
 * (`ssh play@void.game.makscee.ru`, port 22 since VGM-23). Drives ONE action
 * per invocation via one-shot exec commands (VGM-27):
 *
 *   render                    exec("overview")  — print the current state screen.
 *   map                       exec("map")       — print the local map window.
 *   send '<mission text>'     exec('mission "<text>"') — set a robot's mission
 *                             (optional: send '<robot> <text>' to target by name).
 *   onboard [<handle>]        bare shell for first-time registration (interactive).
 *
 * Each invocation opens a TCP connection, runs one exec, collects stdout, exits.
 * No session stays open; the server is stateless per exec.
 *
 * Identity = a PERSISTENT ed25519 keypair under ~/.config/void-game/. The
 * server keys player state by the SHA256 fingerprint of that key, so reusing
 * the key resumes the same player across invocations. World state advances on
 * the server's own tick schedule regardless of whether we are connected.
 *
 * First-time players: run `node helper.mjs onboard [<handle>]` once to register
 * (bare shell drives the interactive onboarding prompt). After that all play
 * goes through the exec commands.
 *
 * The parsing/screen logic is exported as pure functions for unit tests; the
 * CLI wrapper at the bottom only runs when invoked directly.
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

/** Max ms to wait for exec stdout to complete. */
export const EXEC_TIMEOUT_MS = 20000;

/** Handle charset rule — must match onboarding.ts HANDLE_RE exactly. */
export const HANDLE_RE = /^[a-z][a-z0-9_]{2,15}$/;

/** Needle that marks the onboarding prompt in a bare shell. */
export const NEEDLE_ONBOARDING = "Choose a handle";

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

/**
 * SHA256 fingerprint (hex) of an OpenSSH public key string. Used only to
 * derive a stable default handle; the server computes its own fingerprint.
 */
export function pubkeyFingerprintHex(pubkeyText) {
  const body = (pubkeyText || "").trim().split(/\s+/)[1] || pubkeyText || "";
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Derive a default handle from a key fingerprint when none is supplied.
 */
export function deriveHandle(fingerprintHex) {
  const six = (fingerprintHex || "").replace(/[^a-f0-9]/g, "").slice(0, 6) || "000000";
  return `player_${six}`;
}

/**
 * Choose the handle for onboarding from explicit arg → env → derived default.
 */
export function resolveHandle({ argHandle, envHandle, fingerprintHex }) {
  const candidate = (argHandle || envHandle || "").trim().toLowerCase();
  if (candidate && HANDLE_RE.test(candidate)) return candidate;
  return deriveHandle(fingerprintHex);
}

// ---------------------------------------------------------------------------
// Screen parsing (pure; no live socket).
// ---------------------------------------------------------------------------

/**
 * Parse the known section headers of a rendered screen into a compact object.
 * Tolerant: any field that is absent comes back null/empty.
 */
export function parseScreen(screen) {
  const tickM = /=== void-game — tick (\d+) ===/.exec(screen);
  const bunkerM = /^BUNKER\s+(\S+)\s+\((-?\d+),\s*(-?\d+)\)\s+FOOD\s+(\d+)\s*\/\s*(\d+)\s+STOCKPILE\s+\+(\d+)/m.exec(screen);
  const fasting = /FASTING — no new missions/.test(screen);

  const robots = [];
  const lines = screen.split(/\r?\n/);
  const rIdx = lines.findIndex((l) => l === "ROBOTS");
  if (rIdx >= 0) {
    for (let i = rIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === "") break;
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

  const notesM = /NOTES IN BUNKER\s*(?:\((\d+)\))?/.exec(screen);
  const notes = notesM ? (notesM[1] ? Number(notesM[1]) : 0) : 0;

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

/**
 * Build the exec command string for a mission.
 * Optional robot name must match `^[a-z]+-[a-z]+$` (name shape from engine).
 * The text is always double-quoted (the server strips the quotes via its tokenizer).
 */
export function buildMissionCommand(text, robotName = null) {
  const quoted = `"${text.replace(/"/g, '\\"')}"`;
  return robotName ? `mission ${robotName} ${quoted}` : `mission ${quoted}`;
}

// ---------------------------------------------------------------------------
// readUntil (used only for onboarding shell; not needed for exec path).
// ---------------------------------------------------------------------------

export function readUntil(stream, predicate, timeoutMs = EXEC_TIMEOUT_MS) {
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

// ---------------------------------------------------------------------------
// Live connection helpers.
// ---------------------------------------------------------------------------

/**
 * Run one exec command against the live server. Returns { stdout, code }.
 * Rejects on connection error or timeout.
 */
export function execCommand(privateKey, command, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const done = (val) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      if (val instanceof Error) reject(val);
      else resolve(val);
    };

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) { done(err); return; }
        let stdout = "";
        let code = 0;
        const timer = setTimeout(() => {
          done(new Error(`exec timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        stream.stderr.on("data", () => {}); // drain stderr
        stream.on("close", (exitCode) => {
          clearTimeout(timer);
          code = exitCode ?? 0;
          done({ stdout, code });
        });
      });
    });

    conn.on("error", (err) => { done(err); });

    conn.connect({
      host: HOST,
      port: PORT,
      username: USERNAME,
      privateKey,
      hostVerifier: () => true,
      readyTimeout: 15000,
    });
  });
}

/**
 * Open a bare shell for interactive onboarding (first-time players only).
 * Returns { conn, stream } — caller is responsible for ending both.
 */
function connectShell(privateKey) {
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
      hostVerifier: () => true,
      readyTimeout: 15000,
    });
  });
}

// ---------------------------------------------------------------------------
// CLI commands.
// ---------------------------------------------------------------------------

/** Write text to stdout, resolving after flush (handles both TTY and pipe). */
function writeStdout(text) {
  return new Promise((resolve) => {
    if (!text) { resolve(); return; }
    // Always wait for drain to ensure the pipe buffer is flushed before the
    // process exits. process.stdout.write() can return false when the OS pipe
    // buffer is full; we must wait for drain in that case. Even when it returns
    // true, registering a drain listener that resolves is safe (it fires once).
    process.stdout.write(text, () => resolve());
  });
}

/** render: exec("overview") and print the state screen. */
async function cmdRender() {
  const kp = ensureKeypair();
  const { stdout, code } = await execCommand(kp.privateKey, "overview");
  await writeStdout(stdout);
  // Cache the handle from the screen so the SKILL knows which player this is.
  const handle = parseHandleFromScreen(stdout);
  if (handle) writeHandleFile(handle, kp.dir);
  if (code !== 0) process.exit(code);
}

/** map: exec("map") and print the map window. */
async function cmdMap() {
  const kp = ensureKeypair();
  const { stdout, code } = await execCommand(kp.privateKey, "map");
  await writeStdout(stdout);
  if (code !== 0) process.exit(code);
}

/**
 * send '<text>' [<robot>]: exec mission command and print the confirmation.
 * Optionally target a specific robot by name as the second argument.
 */
async function cmdSend(text, robotName = null) {
  if (!text) {
    process.stderr.write("usage: helper.mjs send '<mission text>' [<robot-name>]\n");
    process.exit(2);
  }
  const kp = ensureKeypair();
  const cmd = buildMissionCommand(text, robotName || null);
  const { stdout, code } = await execCommand(kp.privateKey, cmd);
  await writeStdout(stdout);
  if (code !== 0) process.exit(code);
}

/**
 * onboard [<handle>]: bare shell for first-time players. The server asks for a
 * handle interactively; after registration the screen is shown once and the
 * session closes. After this, use render/map/send for all subsequent play.
 */
async function cmdOnboard({ argHandle }) {
  const kp = ensureKeypair();
  const fpHex = pubkeyFingerprintHex(kp.publicKey);

  // Check if already registered (exec overview; if it works, no onboarding needed).
  try {
    const { stdout, code } = await execCommand(kp.privateKey, "overview", 8000);
    if (code === 0) {
      process.stdout.write(stdout);
      const handle = parseHandleFromScreen(stdout);
      if (handle) writeHandleFile(handle, kp.dir);
      process.stderr.write("\nAlready registered — use `node helper.mjs render` to play.\n");
      return;
    }
  } catch {
    // Not registered or other error; proceed with onboarding.
  }

  // Not registered: open a bare shell for onboarding.
  const { conn, stream } = await connectShell(kp.privateKey);
  try {
    const banner = await readUntil(stream, (b) => b.includes(NEEDLE_ONBOARDING), 10000);
    process.stdout.write(banner);

    const handle = resolveHandle({
      argHandle,
      envHandle: process.env.VOID_GAME_HANDLE,
      fingerprintHex: fpHex,
    });

    // Ask the user interactively if not given.
    if (!argHandle && !process.env.VOID_GAME_HANDLE) {
      process.stdout.write(`\n(auto-selecting handle: ${handle})\n`);
    }

    stream.write(handle + "\n");
    // Read the session screen that follows onboarding.
    const screen = await readUntil(stream, (b) => b.includes("BUNKER"), 10000);
    process.stdout.write(screen);
    writeHandleFile(handle, kp.dir);
    process.stderr.write(`\nRegistered as "${handle}". Use \`node helper.mjs render\` to play.\n`);
  } finally {
    try { stream.end(); } catch {}
    try { conn.end(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Arg parsing + main.
// ---------------------------------------------------------------------------

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
    await cmdRender();
  } else if (sub === "map") {
    await cmdMap();
  } else if (sub === "send") {
    const text = args._[1];
    const robot = args._[2] || null; // optional robot name as 3rd arg
    await cmdSend(text, robot);
  } else if (sub === "onboard") {
    await cmdOnboard({ argHandle: args.argHandle || args._[1] });
  } else {
    process.stderr.write(
      "usage: helper.mjs render | map | send '<text>' [<robot>] | onboard [<handle>] [--handle <h>]\n",
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
