/**
 * Terminal-multiplexer backend dispatcher.
 *
 * index.ts and the test harness talk to *this* module, never to tmux.ts /
 * herdr.ts directly. It resolves which MuxBackend is active (env override,
 * then auto-detect) and re-exports a flat function API that delegates to
 * whichever backend won — the exact same shape tmux.ts used to expose on
 * its own, before herdr existed.
 *
 * Backend-agnostic logic (shellEscape, sendLongCommand, pollForExit) lives
 * here rather than in either backend module, since none of it depends on
 * which multiplexer is active — only on the active backend's sendCommand /
 * readScreenAsync primitives.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MuxBackend } from "./mux-backend.ts";
import { tmuxBackend } from "./tmux.ts";

export type MuxBackendName = "tmux" | "herdr";

const backends: Partial<Record<MuxBackendName, MuxBackend>> = {
  tmux: tmuxBackend,
};

function parseBackendName(raw: string): MuxBackendName | "auto" {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "tmux" || normalized === "herdr" || normalized === "auto") {
    return normalized;
  }
  throw new Error(`Invalid PI_SUBAGENT_MUX value "${raw}": expected "tmux", "herdr", or "auto".`);
}

function autoDetectBackendName(): MuxBackendName | undefined {
  // Whichever multiplexer pi was launched inside is what a bare split-off-
  // the-parent-pane should target, so auto-detection mirrors that: prefer
  // whichever of these env vars the parent process actually has set.
  if (process.env.TMUX) return "tmux";
  if (process.env.HERDR_ENV === "1") return "herdr";
  return undefined;
}

/**
 * Resolve which backend is active. Precedence: `PI_SUBAGENT_MUX` env var
 * override, then auto-detect from the environment pi is running in.
 * Throws when nothing can be determined — callers that must not throw
 * (isMuxAvailable, muxSetupHint) catch and fall back.
 */
export function resolveMuxBackendName(): MuxBackendName {
  const rawOverride = process.env.PI_SUBAGENT_MUX?.trim();
  if (rawOverride) {
    const parsed = parseBackendName(rawOverride);
    if (parsed !== "auto") return parsed;
  }

  const detected = autoDetectBackendName();
  if (detected) return detected;

  throw new Error(
    "Could not determine a terminal multiplexer backend. Start pi inside tmux or herdr, " +
      "or set PI_SUBAGENT_MUX=tmux|herdr explicitly.",
  );
}

function getMuxBackend(): MuxBackend {
  const name = resolveMuxBackendName();
  const backend = backends[name];
  if (!backend) {
    throw new Error(`The "${name}" multiplexer backend is not available in this build.`);
  }
  return backend;
}

/** True when a supported multiplexer backend is resolvable and available. */
export function isMuxAvailable(): boolean {
  try {
    return getMuxBackend().isAvailable();
  } catch {
    return false;
  }
}

export function muxSetupHint(): string {
  try {
    return getMuxBackend().setupHint();
  } catch {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or a herdr pane (see https://herdr.dev).";
  }
}

/** Name of the resolved backend, or "unknown" when none can be determined. */
export function activeMuxBackendName(): MuxBackendName | "unknown" {
  try {
    return resolveMuxBackendName();
  } catch {
    return "unknown";
  }
}

export function createSurface(name: string): string {
  return getMuxBackend().createSurface(name);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  return getMuxBackend().createSurfaceSplit(name, direction, fromSurface);
}

export function sendCommand(surface: string, command: string): void {
  getMuxBackend().sendCommand(surface, command);
}

export function readScreen(surface: string, lines = 50): string {
  return getMuxBackend().readScreen(surface, lines);
}

export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return getMuxBackend().readScreenAsync(surface, lines);
}

export function closeSurface(surface: string): void {
  getMuxBackend().closeSurface(surface);
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
