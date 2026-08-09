import { arch, homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Console, Context, Data, Effect, FileSystem, Layer } from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import agentBrowserPackage from "../../assets/agent-browser/package.json" with { type: "json" };

const AGENT_BROWSER_ASSETS_DIRECTORY = fileURLToPath(
  new URL("../../assets/agent-browser/bin/", import.meta.url)
);
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

export const AgentBrowser = Context.Service<AgentBrowser>(
  "@contingency/AgentBrowser"
);

const isMusl = (): boolean => {
  if (platform() !== "linux") {
    return false;
  }

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

const getAgentBrowserBinaryName = Effect.fn("getAgentBrowserBinaryName")(
  function* getAgentBrowserBinaryName() {
    const operatingSystem = platform();
    const architecture = arch();

    if (
      operatingSystem === "win32" &&
      (architecture === "x64" || architecture === "arm64")
    ) {
      return "agent-browser-win32-x64.exe";
    }

    if (
      (operatingSystem === "darwin" || operatingSystem === "linux") &&
      (architecture === "x64" || architecture === "arm64")
    ) {
      const operatingSystemKey =
        operatingSystem === "linux" && isMusl()
          ? "linux-musl"
          : operatingSystem;

      return `agent-browser-${operatingSystemKey}-${architecture}`;
    }

    return yield* new AgentBrowserSetupError({
      message: `agent-browser does not support ${operatingSystem}-${architecture}`,
    });
  }
);

const getStateDirectory = (): string => {
  const configuredStateDirectory = process.env.CONTINGENCY_STATE_DIR?.trim();
  if (configuredStateDirectory) {
    return configuredStateDirectory;
  }

  if (platform() === "win32") {
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

const makeAgentBrowser = Effect.gen(function* makeAgentBrowser() {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const init = Effect.fn("AgentBrowser.init")(function* init() {
    const stateDirectory = getStateDirectory();
    const installMarkerPath = path.join(stateDirectory, INSTALL_MARKER);

    if (yield* fileSystem.exists(installMarkerPath)) {
      return;
    }

    const binaryName = yield* getAgentBrowserBinaryName();
    const binaryPath = path.join(AGENT_BROWSER_ASSETS_DIRECTORY, binaryName);

    if (!(yield* fileSystem.exists(binaryPath))) {
      return yield* new AgentBrowserSetupError({
        message: `Bundled agent-browser executable is missing: ${binaryPath}`,
      });
    }

    if (platform() !== "win32") {
      yield* fileSystem.chmod(binaryPath, 0o755);
    }

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

    yield* fileSystem.makeDirectory(stateDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      installMarkerPath,
      `${agentBrowserPackage.version}\n`
    );
  });

  return AgentBrowser.of({ init });
});

export const AgentBrowserLive = Layer.effect(AgentBrowser, makeAgentBrowser);
