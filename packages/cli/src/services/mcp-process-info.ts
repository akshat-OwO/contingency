import { Context, Effect, Option, Schema } from "effect";

import { AndroidWorkspace } from "./android-workspace.ts";
import { IosWorkspace } from "./ios-workspace.ts";
import type { LocalSystemOneState } from "./local-system-one.ts";
import { DEFAULT_MCP_INTERFACE } from "./settings.ts";
import type { LoadedSettings, McpInterface } from "./settings.ts";
import type { SystemOneConfig } from "./system-one.ts";

/** Safe diagnostics only: never serialize Settings, endpoints, or credentials. */
export const McpProcessInfo = Schema.Struct({
  mcpInterface: Schema.Literals(["native", "single-tool"]),
  platforms: Schema.Array(Schema.Literals(["browser", "android", "ios"])),
  settings: Schema.Struct({
    changedSinceStart: Schema.Boolean,
    diagnostic: Schema.NullOr(Schema.String),
    fileInterface: Schema.NullOr(Schema.Literals(["native", "single-tool"])),
    restartRequired: Schema.Boolean,
    sources: Schema.Array(Schema.String),
  }),
  systemOne: Schema.Struct({
    available: Schema.Boolean,
    installState: Schema.Literals(["not-installed", "installed", "unknown"]),
    kind: Schema.Literals(["not-configured", "configured-remote", "local"]),
    phase: Schema.NullOr(Schema.Literals(["starting", "ready", "crashed"])),
    reachable: Schema.NullOr(Schema.Boolean),
    running: Schema.NullOr(Schema.Boolean),
  }),
});

export const McpProcessDiagnostics = Context.Service<{
  readonly read: Effect.Effect<typeof McpProcessInfo.Type>;
}>("@contingency/McpProcessDiagnostics");

export const describeSystemOne = (
  config?: SystemOneConfig,
  local?:
    | {
        readonly state: LocalSystemOneState | undefined;
        readonly running: boolean;
      }
    | undefined
): typeof McpProcessInfo.Type.systemOne => {
  const isLocal = config?.local !== undefined;
  let kind: typeof McpProcessInfo.Type.systemOne.kind = "not-configured";
  if (config !== undefined) {
    kind = isLocal ? "local" : "configured-remote";
  }
  let installState: typeof McpProcessInfo.Type.systemOne.installState =
    "unknown";
  if (local !== undefined) {
    installState = local.state === undefined ? "not-installed" : "installed";
  }
  return {
    available: config !== undefined,
    installState,
    kind,
    phase: local?.state?.server?.phase ?? null,
    // No remote health request or model inference. A local ready state is
    // meaningful only while the identity-checked server is alive.
    reachable:
      isLocal && local !== undefined
        ? local.running && local.state?.server?.phase === "ready"
        : null,
    running: config !== undefined && !isLocal ? null : (local?.running ?? null),
  };
};

export const describeSettings = (
  started: LoadedSettings | undefined,
  current: LoadedSettings | undefined,
  active: McpInterface
): typeof McpProcessInfo.Type.settings => {
  const changed =
    started !== undefined &&
    current !== undefined &&
    started.snapshot !== current.snapshot;
  const mismatch =
    current?.fileInterface !== undefined && current.fileInterface !== active;
  const unreadable = started !== undefined && current === undefined;
  const restartRequired = changed || mismatch || unreadable;
  let diagnostic: string | null = null;
  if (unreadable) {
    diagnostic =
      "Settings could not be read. Fix config.json and restart the agent and any background service.";
  } else if (restartRequired) {
    diagnostic = `${changed ? "Settings changed since the server started. " : "The active MCP interface differs from config.json. "}Restart the agent and any background service to reload Settings.`;
  }
  return {
    changedSinceStart: changed,
    diagnostic,
    fileInterface: current?.fileInterface ?? null,
    restartRequired,
    sources:
      started === undefined || started.sources.length === 0
        ? ["defaults"]
        : [...started.sources],
  };
};

/** Bound runtime services, without discovering or starting a device. */
export const availablePlatforms = Effect.gen(function* readPlatforms() {
  const platforms: ("browser" | "android" | "ios")[] = ["browser"];
  if (Option.isSome(yield* Effect.serviceOption(AndroidWorkspace))) {
    platforms.push("android");
  }
  if (Option.isSome(yield* Effect.serviceOption(IosWorkspace))) {
    platforms.push("ios");
  }
  return platforms;
});

export const defaultProcessInfo = (
  mcpInterface: McpInterface = DEFAULT_MCP_INTERFACE,
  systemOne?: SystemOneConfig
) =>
  availablePlatforms.pipe(
    Effect.map((platforms) => ({
      mcpInterface,
      platforms,
      settings: describeSettings(undefined, undefined, mcpInterface),
      systemOne: describeSystemOne(systemOne),
    }))
  );
