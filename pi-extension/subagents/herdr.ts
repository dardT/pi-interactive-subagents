/**
 * herdr MuxBackend implementation.
 *
 * herdr's control commands (split, close, run, ...) talk JSON over stdout/
 * stderr; `pane read --format text` is the one exception and prints plain
 * text directly, mirroring tmux's `capture-pane -p`. See https://herdr.dev.
 *
 * Panes are identified by herdr pane ids (e.g. `w1:p3`, workspace-qualified —
 * not tmux's `%N`). Splits always target the parent pi's pane
 * (`$HERDR_PANE_ID`) so they follow the agent rather than the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { MuxBackend } from "./mux-backend.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside a herdr-managed pane with the herdr binary on
 * PATH. `HERDR_ENV=1` is set by herdr in every process it spawns.
 */
function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function herdrSetupHint(): string {
  return "Start pi inside a herdr pane (see https://herdr.dev/docs).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${herdrSetupHint()}`);
  }
}

// ── JSON control-command helper ──

/**
 * Run a herdr control subcommand and parse its JSON response. Control
 * commands (split, close, run, ...) print `{"id": ..., "result": {...}}` on
 * success, or `{"id": ..., "error": {"code", "message"}}` on stderr with
 * exit status 1 — execFileSync throws in that case, surfacing the raw
 * stderr in the thrown error.
 */
function runHerdrJson(args: string[]): any {
  const stdout = execFileSync("herdr", args, { encoding: "utf8" });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Unexpected herdr output for "herdr ${args.join(" ")}": ${stdout.slice(0, 500)}`,
    );
  }
}

// ── Surface primitives ──

const SPLITTABLE_DIRECTIONS = new Set(["right", "down"]);

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * Returns the new pane's id (e.g. `w1:p7`).
 */
function createSurface(name: string): string {
  void name; // herdr panes are not named at the pane level; pi's own title shows in the tab.
  return createSurfaceSplit(name, "right", process.env.HERDR_PANE_ID);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * herdr only supports splitting "right" or "down" (unlike tmux, which also
 * supports "left"/"up") — this codebase only ever requests "right" in
 * practice (createSurface above; the test harness's direction-parameterized
 * helper is exercised with "right" too).
 * Returns the new pane's id (e.g. `w1:p7`).
 */
function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireHerdr();

  if (!SPLITTABLE_DIRECTIONS.has(direction)) {
    throw new Error(
      `herdr does not support "${direction}" splits (only "right" and "down" are available).`,
    );
  }

  const args = ["pane", "split", "--direction", direction, "--no-focus"];
  if (fromSurface) {
    args.push("--pane", fromSurface);
  }

  const response = runHerdrJson(args);
  const pane = response?.result?.pane?.pane_id;
  if (typeof pane !== "string" || pane.length === 0) {
    throw new Error(`Unexpected "herdr pane split" response: ${JSON.stringify(response)}`);
  }

  return pane;
}

/**
 * Send a command string to a pane and execute it. `pane run` sends the
 * command text plus Enter atomically (bracketed paste), matching tmux's
 * `send-keys -l` + `send-keys Enter` combo used by the tmux backend.
 */
function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
}

/**
 * Read the screen contents of a pane (sync). `--source recent-unwrapped`
 * matches tmux's `capture-pane -S -N` semantics (recent history, not just
 * the currently-rendered viewport) rather than `visible`.
 */
function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return execFileSync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines)), "--format", "text"],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines)), "--format", "text"],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
function closeSurface(surface: string): void {
  requireHerdr();
  execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
}

// ── Agent naming ──

/**
 * herdr agent names must match `[a-z][a-z0-9_-]{0,31}`. Subagent display
 * names are usually already-safe — derived from an agent definition's
 * filename under ./agents/ (see discoverAgentDefinitions in index.ts), with
 * a numeric "-2", "-3", ... suffix for duplicates — but a user-supplied
 * cosmetic `name` isn't constrained the same way, so sanitize before handing
 * it to herdr.
 */
function sanitizeAgentName(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "agent";
  if (!/^[a-z]/.test(slug)) slug = `a-${slug}`;
  return slug.slice(0, 32);
}

/**
 * Tag the agent process running in a pane with its subagent display name.
 *
 * The pane run we use to launch a subagent (see sendCommand) is what herdr's
 * docs call a "manually launched agent": herdr auto-detects the pi/claude
 * process by kind but leaves it unnamed, addressable only by pane id, until
 * renamed. See https://herdr.dev/docs/cli-reference/#agents ("agent rename").
 *
 * Detection lags the shell actually exec'ing into the agent process, so
 * `agent rename` can fail for a moment right after launch — retry briefly.
 * Naming is cosmetic: give up silently rather than fail the spawn.
 */
async function nameAgent(surface: string, name: string): Promise<void> {
  if (!isHerdrAvailable()) return;

  const agentName = sanitizeAgentName(name);
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await execFileAsync("herdr", ["agent", "rename", surface, agentName], { encoding: "utf8" });
      return;
    } catch {
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

// ── MuxBackend ──

export const herdrBackend: MuxBackend = {
  name: "herdr",
  isAvailable: isHerdrAvailable,
  setupHint: herdrSetupHint,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  nameAgent,
};
