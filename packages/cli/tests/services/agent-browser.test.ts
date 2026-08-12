import { Geolocation as GeolocationSchema } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema, Sink, Stream } from "effect";
import type { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";

import agentBrowserPackage from "../../assets/agent-browser/package.json" with { type: "json" };
import {
  AgentBrowser,
  makeAgentBrowserLive,
} from "../../src/services/agent-browser";
import type { AgentBrowserRuntime } from "../../src/services/agent-browser";

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
  readonly exitCode?: number | ((command: ChildProcess.Command) => number);
  readonly markerExists?: boolean;
  readonly runtime?: AgentBrowserRuntime;
  readonly stdout?: (command: ChildProcess.Command) => string;
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
    makeTempDirectoryScoped: () => Effect.succeed("/tmp/ctg-test"),
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
          ChildProcessSpawner.ExitCode(
            typeof options.exitCode === "function"
              ? options.exitCode(command)
              : (options.exitCode ?? 0)
          )
        ),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(1),
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout:
          options.stdout === undefined
            ? Stream.empty
            : Stream.make(Buffer.from(options.stdout(command))),
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

it.effect("closes every owned session namespace when its scope ends", () => {
  const fixture = makeFixture({ markerExists: true });

  return Effect.gen(function* verifyScopedSessionCleanup() {
    const sessionId = yield* AgentBrowser.use((agentBrowser) =>
      agentBrowser.create("checkout", {
        deviceScaleFactor: 1,
        height: 720,
        width: 1280,
      })
    ).pipe(Effect.provide(fixture.layer));

    expect(sessionId).toBe("create-checkout");
    expect(fixture.commands).toHaveLength(3);
    const [openCommand, viewportCommand, closeCommand] = fixture.commands;
    if (
      openCommand?._tag !== "StandardCommand" ||
      viewportCommand?._tag !== "StandardCommand" ||
      closeCommand?._tag !== "StandardCommand"
    ) {
      return yield* Effect.die(new Error("Expected standard commands"));
    }

    const [, namespace] = openCommand.args;
    expect(openCommand.options.env).toMatchObject({
      AGENT_BROWSER_SOCKET_DIR: "/tmp/ctg-test",
      AGENT_BROWSER_STREAM_MAX_HEIGHT: "10000",
      AGENT_BROWSER_STREAM_MAX_WIDTH: "10000",
      AGENT_BROWSER_STREAM_QUALITY: "100",
    });
    expect(namespace).toMatch(/^contingency-/u);
    expect(openCommand.args).toContain("create-checkout");
    expect(openCommand.args).toContain("open");
    expect(viewportCommand.args).toContain("viewport");
    expect(closeCommand.args).toEqual([
      "--namespace",
      namespace,
      "close",
      "--all",
      "--json",
    ]);
  });
});

it.effect(
  "rejects invalid create session names before starting Chromium",
  () => {
    const fixture = makeFixture({ markerExists: true });

    return Effect.gen(function* rejectInvalidSessionName() {
      const error = yield* AgentBrowser.use((agentBrowser) =>
        Effect.flip(
          agentBrowser.create("contains spaces", {
            deviceScaleFactor: 1,
            height: 720,
            width: 1280,
          })
        )
      ).pipe(Effect.provide(fixture.layer));

      expect(error.code).toBe("invalid_session");
      expect(fixture.commands).toHaveLength(0);
    });
  }
);

it.effect("relaunches a session when its user agent changes", () => {
  const defaultUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.1234.0 Safari/537.36";
  const fixture = makeFixture({
    markerExists: true,
    stdout: (command) => {
      if (command._tag !== "StandardCommand") {
        return "";
      }
      if (command.args.includes("eval")) {
        return JSON.stringify({
          data: { result: defaultUserAgent },
          success: true,
        });
      }
      if (command.args.includes("list")) {
        return JSON.stringify({
          data: { sessions: ["create-user-agent"] },
          success: true,
        });
      }
      return "";
    },
  });
  const viewport = {
    deviceScaleFactor: 1,
    height: 720,
    width: 1280,
  } as const;

  return AgentBrowser.use((agentBrowser) =>
    Effect.gen(function* verifyUserAgentRelaunch() {
      const sessionId = yield* agentBrowser.create("user-agent", viewport);
      yield* agentBrowser.open(
        sessionId,
        "https://example.com",
        viewport,
        "chrome-windows"
      );
      yield* agentBrowser.setUserAgent(
        sessionId,
        "https://example.com",
        viewport,
        "default"
      );

      const launchCommands = fixture.commands.filter(
        (command): command is ChildProcess.StandardCommand =>
          command._tag === "StandardCommand" &&
          command.args.includes("--user-agent")
      );
      expect(launchCommands).toHaveLength(2);
      const [chromeWindows, browserDefault] = launchCommands;
      expect(chromeWindows?.args.join(" ")).toContain("Chrome/151.0.1234.0");
      expect(browserDefault?.args).toContain(defaultUserAgent);
      expect(
        fixture.commands.some(
          (command) =>
            command._tag === "StandardCommand" && command.args.includes("geo")
        )
      ).toBe(false);
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect("applies and remembers geolocation for a session", () => {
  const fixture = makeFixture({ markerExists: true });
  const viewport = {
    deviceScaleFactor: 1,
    height: 720,
    width: 1280,
  } as const;

  return AgentBrowser.use((agentBrowser) =>
    Effect.gen(function* applyGeolocation() {
      const sessionId = yield* agentBrowser.create("geolocation", viewport);
      const initialGeolocation = yield* agentBrowser.getGeolocation(sessionId);

      expect(initialGeolocation).toBeNull();

      const geolocation = yield* agentBrowser.setGeolocation(sessionId, {
        latitude: 12.9716,
        longitude: 77.5946,
      });

      expect(geolocation).toEqual({
        latitude: 12.9716,
        longitude: 77.5946,
      });
      const rememberedGeolocation =
        yield* agentBrowser.getGeolocation(sessionId);
      expect(rememberedGeolocation).toEqual(geolocation);

      const replacement = yield* agentBrowser.setGeolocation(sessionId, {
        latitude: 51.5072,
        longitude: -0.1276,
      });
      const rememberedReplacement =
        yield* agentBrowser.getGeolocation(sessionId);
      expect(rememberedReplacement).toEqual(replacement);

      const geolocationCommand = fixture.commands.find(
        (command): command is ChildProcess.StandardCommand =>
          command._tag === "StandardCommand" && command.args.includes("geo")
      );
      const sessionArgumentIndex =
        geolocationCommand?.args.indexOf("--session") ?? -1;
      expect(geolocationCommand?.args.slice(sessionArgumentIndex)).toEqual([
        "--session",
        sessionId,
        "set",
        "geo",
        "12.9716",
        "77.5946",
        "--json",
      ]);
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect("preserves the last geolocation when an update fails", () => {
  const fixture = makeFixture({
    exitCode: (command) =>
      command._tag === "StandardCommand" && command.args.includes("51.5072")
        ? 1
        : 0,
    markerExists: true,
  });
  const viewport = {
    deviceScaleFactor: 1,
    height: 720,
    width: 1280,
  } as const;

  return AgentBrowser.use((agentBrowser) =>
    Effect.gen(function* preserveGeolocation() {
      const sessionId = yield* agentBrowser.create("geolocation", viewport);
      const lastSuccessful = yield* agentBrowser.setGeolocation(sessionId, {
        latitude: 12.9716,
        longitude: 77.5946,
      });

      const error = yield* Effect.flip(
        agentBrowser.setGeolocation(sessionId, {
          latitude: 51.5072,
          longitude: -0.1276,
        })
      );

      expect(error.code).toBe("agent_browser_failed");
      const rememberedGeolocation =
        yield* agentBrowser.getGeolocation(sessionId);
      expect(rememberedGeolocation).toEqual(lastSuccessful);
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect("reapplies geolocation after changing the user agent", () => {
  const fixture = makeFixture({
    markerExists: true,
    stdout: (command) => {
      if (command._tag !== "StandardCommand") {
        return "";
      }
      if (command.args.includes("eval")) {
        return JSON.stringify({
          data: {
            result: "Mozilla/5.0 Chrome/151.0.1234.0 Safari/537.36",
          },
          success: true,
        });
      }
      if (command.args.includes("list")) {
        return JSON.stringify({
          data: { sessions: ["create-geolocation"] },
          success: true,
        });
      }
      return "";
    },
  });
  const viewport = {
    deviceScaleFactor: 1,
    height: 720,
    width: 1280,
  } as const;

  return AgentBrowser.use((agentBrowser) =>
    Effect.gen(function* reapplyGeolocation() {
      const sessionId = yield* agentBrowser.create("geolocation", viewport);
      yield* agentBrowser.setGeolocation(sessionId, {
        latitude: -33.8688,
        longitude: 151.2093,
      });
      yield* agentBrowser.setUserAgent(
        sessionId,
        "https://example.com",
        viewport,
        "chrome-windows"
      );

      const geolocationCommands = fixture.commands.filter(
        (command): command is ChildProcess.StandardCommand =>
          command._tag === "StandardCommand" && command.args.includes("geo")
      );
      expect(geolocationCommands).toHaveLength(2);
      expect(geolocationCommands[1]?.args).toContain("-33.8688");
      expect(geolocationCommands[1]?.args).toContain("151.2093");
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect("forgets geolocation when relaunch reapplication fails", () => {
  let geolocationCommandCount = 0;
  const fixture = makeFixture({
    exitCode: (command) => {
      if (command._tag !== "StandardCommand" || !command.args.includes("geo")) {
        return 0;
      }
      geolocationCommandCount += 1;
      return geolocationCommandCount === 2 ? 1 : 0;
    },
    markerExists: true,
    stdout: (command) => {
      if (command._tag !== "StandardCommand") {
        return "";
      }
      if (command.args.includes("eval")) {
        return JSON.stringify({
          data: {
            result: "Mozilla/5.0 Chrome/151.0.1234.0 Safari/537.36",
          },
          success: true,
        });
      }
      if (command.args.includes("list")) {
        return JSON.stringify({
          data: { sessions: ["create-geolocation"] },
          success: true,
        });
      }
      return "";
    },
  });
  const viewport = {
    deviceScaleFactor: 1,
    height: 720,
    width: 1280,
  } as const;

  return AgentBrowser.use((agentBrowser) =>
    Effect.gen(function* forgetFailedReapplication() {
      const sessionId = yield* agentBrowser.create("geolocation", viewport);
      yield* agentBrowser.setGeolocation(sessionId, {
        latitude: -33.8688,
        longitude: 151.2093,
      });

      const error = yield* Effect.flip(
        agentBrowser.setUserAgent(
          sessionId,
          "https://example.com",
          viewport,
          "chrome-windows"
        )
      );

      expect(error.code).toBe("agent_browser_failed");
      expect(geolocationCommandCount).toBe(2);
      expect(yield* agentBrowser.getGeolocation(sessionId)).toBeNull();
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect("rejects invalid geolocation before invoking agent-browser", () => {
  const fixture = makeFixture({ markerExists: true });
  const viewport = {
    deviceScaleFactor: 1,
    height: 720,
    width: 1280,
  } as const;

  return AgentBrowser.use((agentBrowser) =>
    Effect.gen(function* rejectInvalidGeolocation() {
      const sessionId = yield* agentBrowser.create("geolocation", viewport);
      const commandCount = fixture.commands.length;

      const invalidGeolocations = [
        { latitude: 90.000001, longitude: 77.5946 },
        { latitude: 0, longitude: 180.000001 },
        { latitude: Number.NaN, longitude: 0 },
        { latitude: 0, longitude: Number.POSITIVE_INFINITY },
      ];
      for (const geolocation of invalidGeolocations) {
        const error = yield* Effect.flip(
          agentBrowser.setGeolocation(sessionId, geolocation)
        );
        expect(error.code).toBe("invalid_geolocation");
      }

      const malformedGeolocations: readonly unknown[] = [
        { latitude: "12.9716", longitude: 77.5946 },
        { latitude: 12.9716 },
      ];
      for (const geolocation of malformedGeolocations) {
        yield* Schema.decodeUnknownEffect(GeolocationSchema)(geolocation).pipe(
          Effect.flip
        );
      }
      expect(fixture.commands).toHaveLength(commandCount);
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "keeps geolocation isolated by session and forgets closed sessions",
  () => {
    const fixture = makeFixture({ markerExists: true });
    const viewport = {
      deviceScaleFactor: 1,
      height: 720,
      width: 1280,
    } as const;

    return AgentBrowser.use((agentBrowser) =>
      Effect.gen(function* isolateGeolocation() {
        const firstSession = yield* agentBrowser.create("first", viewport);
        const secondSession = yield* agentBrowser.create("second", viewport);
        const firstGeolocation = yield* agentBrowser.setGeolocation(
          firstSession,
          { latitude: 90, longitude: -180 }
        );
        const secondGeolocation = yield* agentBrowser.setGeolocation(
          secondSession,
          { latitude: -90, longitude: 180 }
        );
        const rememberedFirst =
          yield* agentBrowser.getGeolocation(firstSession);
        const rememberedSecond =
          yield* agentBrowser.getGeolocation(secondSession);

        expect(rememberedFirst).toEqual(firstGeolocation);
        expect(rememberedSecond).toEqual(secondGeolocation);

        yield* agentBrowser.close(firstSession);
        const closedGeolocation =
          yield* agentBrowser.getGeolocation(firstSession);
        const remainingGeolocation =
          yield* agentBrowser.getGeolocation(secondSession);

        expect(closedGeolocation).toBeNull();
        expect(remainingGeolocation).toEqual(secondGeolocation);
      })
    ).pipe(Effect.provide(fixture.layer));
  }
);
