import os from "node:os";
import path from "node:path";

import { Effect, FileSystem, Option } from "effect";

import { CATALOG_DIRECTORY } from "./flow-skill-catalog.ts";

/**
 * Which directory an MCP process takes its Catalog Root from (ADR 0049).
 *
 * A permanent registration serves every project, so each session uses its
 * current project's `.contingency` catalog. The selected agent names how that
 * directory is found: Claude Code documents `CLAUDE_PROJECT_DIR` for the stdio
 * servers it spawns, and Codex starts the server in its current working
 * directory. A Claude variable inherited by a Codex process never redirects it.
 *
 * Discovery and catalog access are separate. A usable directory without
 * `.contingency` simply gets a new catalog when work is first saved, and a
 * permission failure there is reported there. Only the absence of a usable
 * project directory selects the original onboarding directory, and the
 * selection says so, so the agent can name it before using it.
 */

export const REGISTERED_AGENTS = ["claude", "codex"] as const;
export type RegisteredAgent = (typeof REGISTERED_AGENTS)[number];

export interface CatalogDirectoryInput {
  readonly agent: RegisteredAgent | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fallbackDirectory: string | undefined;
  readonly home: string;
}

export interface CatalogDirectoryChoice {
  readonly fallback:
    | { readonly directory: string; readonly reason: string }
    | undefined;
  readonly root: string;
}

/** The project directory the selected agent reports, before usability checks. */
export const reportedProjectDirectory = (
  input: Pick<CatalogDirectoryInput, "agent" | "cwd" | "env">
): string | undefined => {
  if (input.agent === "claude") {
    const reported = input.env.CLAUDE_PROJECT_DIR?.trim();
    return reported === undefined || reported.length === 0
      ? input.cwd
      : reported;
  }
  return input.cwd;
};

/**
 * Why a directory cannot hold a project catalog, or `undefined` when it can.
 * The filesystem root and the home directory are where clients without a
 * project start their servers; a catalog there would be a user-global
 * catalog by accident.
 */
const unusableReason = (
  directory: string,
  home: string,
  exists: boolean,
  isDirectory: boolean
): string | undefined => {
  if (!path.isAbsolute(directory)) {
    return `${directory} is not an absolute path`;
  }
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) {
    return `${resolved} is the filesystem root, not a project directory`;
  }
  if (resolved === path.resolve(home)) {
    return `${resolved} is the home directory, not a project directory`;
  }
  if (!exists) {
    return `${resolved} does not exist`;
  }
  if (!isDirectory) {
    return `${resolved} is not a directory`;
  }
  return undefined;
};

export const resolveCatalogDirectory = (input: CatalogDirectoryInput) =>
  Effect.gen(function* resolveCatalogDirectoryEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const configured = input.env.CONTINGENCY_CATALOG_ROOT?.trim();
    if (configured !== undefined && configured.length > 0) {
      return {
        fallback: undefined,
        root: path.resolve(configured),
      } satisfies CatalogDirectoryChoice;
    }
    const candidate = reportedProjectDirectory(input) ?? input.cwd;
    const info = yield* fileSystem.stat(candidate).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none())
      )
    );
    const reason = unusableReason(
      candidate,
      input.home,
      info._tag === "Some",
      info._tag === "Some" && info.value.type === "Directory"
    );
    if (reason === undefined || input.fallbackDirectory === undefined) {
      return {
        fallback: undefined,
        root: path.join(path.resolve(candidate), CATALOG_DIRECTORY),
      } satisfies CatalogDirectoryChoice;
    }
    const directory = path.resolve(input.fallbackDirectory);
    return {
      fallback: {
        directory,
        reason: `No usable current project directory: ${reason}.`,
      },
      root: path.join(directory, CATALOG_DIRECTORY),
    } satisfies CatalogDirectoryChoice;
  });

export const defaultHomeDirectory = (): string => os.homedir();
