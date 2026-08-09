import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Sink, Stream } from "effect";
import type { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";

import agentBrowserPackage from "../../assets/agent-browser/package.json" with { type: "json" };
import {
  AgentBrowser,
  makeAgentBrowserLive,
} from "../../src/services/agent-browser.ts";
import type { AgentBrowserRuntime } from "../../src/services/agent-browser.ts";

interface FileSystemCalls {
  readonly chmod: string[];
  readonly exists: string[];
  readonly makeDirectory: string[];
  readonly writeFileString: (readonly [path: string, data: string])[];
}

interface TestFixture {
  readonly commands: ChildProcess.Command[];
  readonly fileSystemCalls: FileSystemCalls;
  readonly layer: Layer.Layer<AgentBrowser>;
}

const makeFixture = (options: {
  readonly exitCode?: number;
  readonly markerExists?: boolean;
  readonly runtime?: AgentBrowserRuntime;
}): TestFixture => {
  const commands: ChildProcess.Command[] = [];
  const fileSystemCalls: FileSystemCalls = {
    chmod: [],
    exists: [],
    makeDirectory: [],
    writeFileString: [],
  };

  const fileSystemLayer = FileSystem.layerNoop({
    chmod: (target) =>
      Effect.sync(() => {
        fileSystemCalls.chmod.push(target);
      }),
    exists: (target) =>
      Effect.sync(() => {
        fileSystemCalls.exists.push(target);
        return (
          options.markerExists === true || fileSystemCalls.exists.length > 1
        );
      }),
    makeDirectory: (target) =>
      Effect.sync(() => {
        fileSystemCalls.makeDirectory.push(target);
      }),
    writeFileString: (target, data) =>
      Effect.sync(() => {
        fileSystemCalls.writeFileString.push([target, data]);
      }),
  });

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      commands.push(command);

      return ChildProcessSpawner.makeHandle({
        all: Stream.empty,
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(options.exitCode ?? 0)
        ),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(1),
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout: Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    })
  );
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    spawner
  );
  const dependencies = Layer.merge(fileSystemLayer, spawnerLayer);

  return {
    commands,
    fileSystemCalls,
    layer: makeAgentBrowserLive(options.runtime).pipe(
      Layer.provide(dependencies)
    ),
  };
};

it.effect("skips installation when the version marker exists", () => {
  const fixture = makeFixture({ markerExists: true });

  return Effect.gen(function* skipExistingMarker() {
    const agentBrowser = yield* AgentBrowser;
    yield* agentBrowser.init();

    expect(fixture.fileSystemCalls.exists).toHaveLength(1);
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.fileSystemCalls.writeFileString).toHaveLength(0);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("installs Chrome and writes the version marker on first run", () => {
  const fixture = makeFixture({});

  return Effect.gen(function* installOnFirstRun() {
    const agentBrowser = yield* AgentBrowser;
    yield* agentBrowser.init();

    expect(fixture.commands).toHaveLength(1);
    const [command] = fixture.commands;
    if (command?._tag !== "StandardCommand") {
      return yield* Effect.die(
        new Error("Expected agent-browser to run as a standard command")
      );
    }

    expect(command.args).toEqual(["install"]);
    expect(command.command).toContain("agent-browser-");
    expect(fixture.fileSystemCalls.makeDirectory).toHaveLength(1);
    expect(fixture.fileSystemCalls.writeFileString).toHaveLength(1);
    expect(fixture.fileSystemCalls.writeFileString[0]?.[1]).toBe(
      `${agentBrowserPackage.version}\n`
    );
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("does not write the marker when installation fails", () => {
  const fixture = makeFixture({ exitCode: 1 });

  return Effect.gen(function* handleInstallFailure() {
    const agentBrowser = yield* AgentBrowser;
    const error = yield* Effect.flip(agentBrowser.init());

    expect(error._tag).toBe("AgentBrowserSetupError");
    expect(error.message).toContain("exited with code 1");
    expect(fixture.fileSystemCalls.makeDirectory).toHaveLength(0);
    expect(fixture.fileSystemCalls.writeFileString).toHaveLength(0);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("skips the unsupported Chrome download on Linux ARM64", () => {
  const fixture = makeFixture({
    runtime: {
      architecture: "arm64",
      isMusl: false,
      operatingSystem: "linux",
    },
  });

  return Effect.gen(function* handleLinuxArm64() {
    const agentBrowser = yield* AgentBrowser;
    yield* agentBrowser.init();

    expect(fixture.commands).toHaveLength(0);
    expect(fixture.fileSystemCalls.exists[1]).toContain(
      "agent-browser-linux-arm64"
    );
    expect(fixture.fileSystemCalls.writeFileString).toHaveLength(1);
  }).pipe(Effect.provide(fixture.layer));
});
