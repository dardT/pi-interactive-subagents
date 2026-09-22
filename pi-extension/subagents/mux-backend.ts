/**
 * Shared interface every terminal-multiplexer backend implements.
 *
 * A "surface" is an opaque backend-specific identifier for a pane (a tmux
 * pane id like `%12`, a herdr pane id, ...). Callers never inspect it —
 * they just pass it back into the same backend's functions.
 */
export interface MuxBackend {
  /** Backend identifier, used for config/env selection and error messages. */
  name: "tmux" | "herdr";

  /** True when this backend's CLI is on PATH and we're running inside it. */
  isAvailable(): boolean;

  /** Human-readable instructions for getting this backend available. */
  setupHint(): string;

  /**
   * Create a new pane for a subagent: a right split off the parent pi's
   * pane, so new panes follow the agent rather than the user's focus.
   * Returns the new pane's surface id.
   */
  createSurface(name: string): string;

  /**
   * Create a new split in the given direction from an optional source
   * surface. Returns the new pane's surface id.
   */
  createSurfaceSplit(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
  ): string;

  /** Send a command string to a pane and execute it (submits with Enter). */
  sendCommand(surface: string, command: string): void;

  /** Read the screen contents of a pane (sync). */
  readScreen(surface: string, lines?: number): string;

  /** Read the screen contents of a pane (async). */
  readScreenAsync(surface: string, lines?: number): Promise<string>;

  /** Close a pane. */
  closeSurface(surface: string): void;

  /**
   * Assign a display name to the agent process running in a pane, for
   * backends that track named agents (herdr's `agent rename`). Omitted by
   * backends with no such concept (tmux) — callers must treat a missing
   * implementation as a no-op.
   */
  nameAgent?(surface: string, name: string): Promise<void>;
}
