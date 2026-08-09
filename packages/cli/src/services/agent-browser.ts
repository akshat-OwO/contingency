import { arch, homedir, platform } from "node:os";
import path from "node:path";

import { Console, Context, Data, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import agentBrowserPackage from "../../assets/agent-browser/package.json" with { type: "json" };

const getAgentBrowserAssetsDirectory = (): string => {
  const moduleDirectory = import.meta.dirname;
  const packageDirectory =
    path.basename(moduleDirectory) === "dist"
      ? path.dirname(moduleDirectory)
      : path.resolve(moduleDirectory, "../..");

  return path.join(packageDirectory, "assets", "agent-browser", "bin");
};

const AGENT_BROWSER_ASSETS_DIRECTORY = getAgentBrowserAssetsDirectory();
const INSTALL_MARKER = `agent-browser-${agentBrowserPackage.version}.installed`;

class AgentBrowserSetupError extends Data.TaggedError(
  "AgentBrowserSetupError"
)<{
  readonly message: string;
}> {}

type AgentBrowserInitError =
  | AgentBrowserSetupError
  | PlatformError.PlatformError;

export interface AgentBrowser {
  readonly init: () => Effect.Effect<void, AgentBrowserInitError>;
}

export interface AgentBrowserRuntime {
  readonly architecture: string;
  readonly isMusl: boolean;
  readonly operatingSystem: NodeJS.Platform;
}

export const AgentBrowser = Context.Service<AgentBrowser>(
  "@contingency/AgentBrowser"
);

const isMusl = (): boolean => {
  const report = process.report.getReport();
  if (
    !("header" in report) ||
    report.header === null ||
    typeof report.header !== "object"
  ) {
    return false;
  }

  return !("glibcVersionRuntime" in report.header);
};

const getRuntime = (): AgentBrowserRuntime => {
  const operatingSystem = platform();

  return {
    architecture: arch(),
    isMusl: operatingSystem === "linux" && isMusl(),
    operatingSystem,
  };
};

const getAgentBrowserExecutable = Effect.fn("getAgentBrowserExecutable")(
  function* getAgentBrowserExecutable(runtime: AgentBrowserRuntime) {
    const { architecture, operatingSystem } = runtime;

    if (
      operatingSystem === "win32" &&
      (architecture === "x64" || architecture === "arm64")
    ) {
      return {
        browserInstallSupported: true,
        name: "agent-browser-win32-x64.exe",
      } as const;
    }

    if (
      (operatingSystem === "darwin" || operatingSystem === "linux") &&
      (architecture === "x64" || architecture === "arm64")
    ) {
      const operatingSystemKey =
        operatingSystem === "linux" && runtime.isMusl
          ? "linux-musl"
          : operatingSystem;

      return {
        browserInstallSupported: !(
          operatingSystem === "linux" && architecture === "arm64"
        ),
        name: `agent-browser-${operatingSystemKey}-${architecture}`,
      } as const;
    }

    return yield* new AgentBrowserSetupError({
      message: `agent-browser does not support ${operatingSystem}-${architecture}`,
    });
  }
);

const getStateDirectory = (operatingSystem: NodeJS.Platform): string => {
  const configuredStateDirectory = process.env.CONTINGENCY_STATE_DIR?.trim();
  if (configuredStateDirectory) {
    return configuredStateDirectory;
  }

  if (operatingSystem === "win32") {
    const localApplicationData = process.env.LOCALAPPDATA?.trim();
    return path.join(
      localApplicationData || path.join(homedir(), "AppData", "Local"),
      "contingency"
    );
  }

  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  return path.join(
    xdgStateHome || path.join(homedir(), ".local", "state"),
    "contingency"
  );
};

const makeAgentBrowser = (runtime: AgentBrowserRuntime) =>
  Effect.gen(function* buildAgentBrowser() {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const init = Effect.fn("AgentBrowser.init")(function* init() {
      const stateDirectory = getStateDirectory(runtime.operatingSystem);
      const installMarkerPath = path.join(stateDirectory, INSTALL_MARKER);

      if (yield* fileSystem.exists(installMarkerPath)) {
        return;
      }

      const executable = yield* getAgentBrowserExecutable(runtime);
      const binaryPath = path.join(
        AGENT_BROWSER_ASSETS_DIRECTORY,
        executable.name
      );

      if (!(yield* fileSystem.exists(binaryPath))) {
        return yield* new AgentBrowserSetupError({
          message: `Bundled agent-browser executable is missing: ${binaryPath}`,
        });
      }

      if (runtime.operatingSystem !== "win32") {
        yield* fileSystem.chmod(binaryPath, 0o755);
      }

      if (executable.browserInstallSupported) {
        yield* Console.log(
          "Setting up the browser for Contingency. This one-time download may take a moment..."
        );

        const exitCode = yield* spawner.exitCode(
          ChildProcess.make(binaryPath, ["install"], {
            stderr: "inherit",
            stdin: "inherit",
            stdout: "inherit",
          })
        );

        if (Number(exitCode) !== 0) {
          return yield* new AgentBrowserSetupError({
            message: `agent-browser install exited with code ${Number(exitCode)}`,
          });
        }
      } else {
        yield* Console.warn(
          "Chrome for Testing is unavailable on Linux ARM64. Install Chromium with your system package manager and set AGENT_BROWSER_EXECUTABLE_PATH to its executable."
        );
      }

      yield* fileSystem.makeDirectory(stateDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        installMarkerPath,
        `${agentBrowserPackage.version}\n`
      );
    });

    return AgentBrowser.of({ init });
  });

export const makeAgentBrowserLive = (
  runtime: AgentBrowserRuntime = getRuntime()
): Layer.Layer<
  AgentBrowser,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(AgentBrowser, makeAgentBrowser(runtime));

export const AgentBrowserLive = makeAgentBrowserLive();
