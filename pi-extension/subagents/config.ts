/**
 * Shared config.json loading/validation helpers, used by status.ts and
 * mux.ts. Each module owns its own slice's shape and validation rules;
 * this file only owns the generic "read config.json, fall back to
 * config.json.example, parse JSON" mechanics and a few small strict-schema
 * primitives shared across slices.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
export const DEFAULT_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface ConfigFile {
  sourcePath: string;
  rawConfig: string;
}

/**
 * Read configPath, falling back to examplePath when configPath doesn't
 * exist. Returns null when neither exists — callers decide whether that's
 * an error (a required config slice) or a default (an optional one).
 */
export function tryReadConfigFile(configPath: string, examplePath: string): ConfigFile | null {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return null;
    throw error;
  }
}

export function parseConfigJson(rawConfig: string, sourcePath: string): unknown {
  try {
    return JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }
}

export function invalidConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent config in ${source}: ${message}`);
}

export function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidConfig(source, `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}
