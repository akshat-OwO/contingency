import { BrowserTabId, SessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Layer,
  Schema,
  Semaphore,
  Sink,
  Stream,
} from "effect";
import type { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";

import agentBrowserPackage from "../../assets/agent-browser/package.json" with { type: "json" };
import {
  AgentBrowser,
  makeAgentBrowserLive,
  serializeBrowserStreamEvent,
} from "../../src/services/agent-browser";
import type { AgentBrowserRuntime } from "../../src/services/agent-browser";
import { commandIncludesCookiesClear } from "../../src/services/browser-storage";

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
          ChildProcessSpawner.ExitCode(options.exitCode ?? 0)
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

it.effect("attributes events after earlier tab transitions finish", () => {
  const semaphore = Semaphore.makeUnsafe(1);
  let activeTab = "t1";
  const attributedTabs: string[] = [];

  const delayedPopupTransition = serializeBrowserStreamEvent(
    semaphore,
    Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.sync(() => {
          activeTab = "t2";
        })
      )
    )
  );
  const consoleEvent = serializeBrowserStreamEvent(
    semaphore,
    Effect.sync(() => {
      attributedTabs.push(activeTab);
    })
  );

  return Effect.all([delayedPopupTransition, consoleEvent], {
    concurrency: "unbounded",
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(attributedTabs).toEqual(["t2"]);
      })
    )
  );
});

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
      if (command.args.includes("network")) {
        return JSON.stringify({ data: { requests: [] }, success: true });
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

      const closeIndex = fixture.commands.findIndex(
        (command) =>
          command._tag === "StandardCommand" &&
          command.args.includes("close") &&
          command.args.includes("create-user-agent")
      );
      if (browserDefault === undefined) {
        return yield* Effect.die(
          new Error("Expected a browser-default relaunch command")
        );
      }
      const defaultLaunchIndex = fixture.commands.indexOf(browserDefault);
      expect(closeIndex).toBeGreaterThan(-1);
      expect(closeIndex).toBeLessThan(defaultLaunchIndex);
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect("enables network capture before navigating a new session", () => {
  const fixture = makeFixture({
    markerExists: true,
    stdout: (command) => {
      if (
        command._tag === "StandardCommand" &&
        command.args.includes("network")
      ) {
        return JSON.stringify({ data: { requests: [] }, success: true });
      }
      return "";
    },
  });

  return AgentBrowser.use((agentBrowser) =>
    Effect.gen(function* verifyNetworkCaptureOrdering() {
      yield* agentBrowser.open(
        undefined,
        "https://example.com",
        { deviceScaleFactor: 1, height: 720, width: 1280 },
        "default"
      );

      const networkIndex = fixture.commands.findIndex(
        (command) =>
          command._tag === "StandardCommand" &&
          command.args.includes("network") &&
          command.args.includes("requests")
      );
      const navigationIndex = fixture.commands.findIndex(
        (command) =>
          command._tag === "StandardCommand" &&
          command.args.includes("https://example.com/")
      );

      expect(networkIndex).toBeGreaterThan(-1);
      expect(navigationIndex).toBeGreaterThan(networkIndex);
    })
  ).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "keeps an observed title when its tab moves to the background",
  () => {
    let tabReadCount = 0;
    const fixture = makeFixture({
      markerExists: true,
      stdout: (command) => {
        if (command._tag !== "StandardCommand") {
          return "";
        }
        if (command.args.includes("list")) {
          return JSON.stringify({
            data: { sessions: ["create-title"] },
            success: true,
          });
        }
        if (command.args.includes("title")) {
          return JSON.stringify({
            data: { title: "Online Pharmacy India" },
            success: true,
          });
        }
        if (command.args.includes("url")) {
          return JSON.stringify({
            data: { url: "https://www.1mg.com/" },
            success: true,
          });
        }
        if (command.args.includes("tab")) {
          tabReadCount += 1;
          return JSON.stringify({
            data: {
              tabs:
                tabReadCount === 1
                  ? [
                      {
                        active: true,
                        label: null,
                        tabId: "t1",
                        title: "1mg.com",
                        type: "page",
                        url: "https://www.1mg.com/",
                      },
                    ]
                  : [
                      {
                        active: false,
                        label: null,
                        tabId: "t1",
                        title: "1mg.com",
                        type: "page",
                        url: "https://www.1mg.com/",
                      },
                      {
                        active: true,
                        label: null,
                        tabId: "t2",
                        title: "Cancer Care",
                        type: "page",
                        url: "https://www.1mg.com/cancer-care",
                      },
                    ],
            },
            success: true,
          });
        }
        return "";
      },
    });

    return AgentBrowser.use((agentBrowser) =>
      Effect.gen(function* verifyTitleCache() {
        const sessionId =
          yield* Schema.decodeUnknownEffect(SessionId)("create-title");
        yield* agentBrowser.getTabs(sessionId);
        const tabs = yield* agentBrowser.getTabs(sessionId);

        expect(tabs[0]?.title).toBe("Online Pharmacy India");
      })
    ).pipe(Effect.provide(fixture.layer));
  }
);

it.effect(
  "discovers the private CDP endpoint without exposing it in RPC data",
  () => {
    const fixture = makeFixture({
      markerExists: true,
      stdout: (command) => {
        if (command._tag !== "StandardCommand") {
          return "";
        }
        if (command.args.includes("list")) {
          return JSON.stringify({
            data: { sessions: ["create-recorder"] },
            success: true,
          });
        }
        if (command.args.includes("cdp-url")) {
          return JSON.stringify({
            data: { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test" },
            success: true,
          });
        }
        return "";
      },
    });

    return AgentBrowser.use((agentBrowser) =>
      Effect.gen(function* discoverRecorderEndpoint() {
        const sessionId =
          Schema.decodeUnknownSync(SessionId)("create-recorder");
        const url = yield* agentBrowser.cdpUrl(sessionId);

        expect(url).toBe("ws://127.0.0.1:9222/devtools/browser/test");
        const command = fixture.commands.find(
          (candidate) =>
            candidate._tag === "StandardCommand" &&
            candidate.args.includes("cdp-url")
        );
        expect(command?._tag).toBe("StandardCommand");
      })
    ).pipe(Effect.provide(fixture.layer));
  }
);

const storageTab = {
  active: true,
  label: null,
  tabId: "t1",
  title: "App",
  type: "page",
  url: "https://app.example.com/home",
} as const;

const originCookies = [
  {
    domain: "app.example.com",
    expires: -1,
    httpOnly: false,
    name: "theme",
    path: "/",
    secure: false,
    session: true,
    size: 9,
    value: "dark",
  },
  {
    domain: ".example.com",
    expires: -1,
    httpOnly: true,
    name: "sid",
    path: "/",
    sameSite: "Lax",
    secure: true,
    session: true,
    size: 12,
    value: "abc",
  },
  {
    domain: "app.example.com",
    expires: -1,
    httpOnly: false,
    name: "locale",
    path: "/",
    secure: false,
    session: true,
    size: 8,
    value: "en",
  },
  {
    domain: "stripe.com",
    expires: -1,
    httpOnly: false,
    name: "third",
    path: "/",
    secure: true,
    session: true,
    size: 8,
    value: "x",
  },
] as const;

const storageStdout = (command: ChildProcess.Command, sessionName: string) => {
  if (command._tag !== "StandardCommand") {
    return "";
  }
  const { args } = command;
  if (args.includes("list")) {
    return JSON.stringify({
      data: { sessions: [sessionName] },
      success: true,
    });
  }
  if (
    args.includes("tab") &&
    !args.includes("new") &&
    !args.includes("close")
  ) {
    return JSON.stringify({
      data: { tabs: [storageTab] },
      success: true,
    });
  }
  if (args.includes("title")) {
    return JSON.stringify({ data: { title: "App" }, success: true });
  }
  if (args.includes("url")) {
    return JSON.stringify({
      data: { url: storageTab.url },
      success: true,
    });
  }
  if (args.includes("cookies") && args.includes("get")) {
    return JSON.stringify({
      data: { cookies: originCookies },
      success: true,
    });
  }
  if (
    args.includes("storage") &&
    args.includes("local") &&
    !args.includes("set") &&
    !args.includes("clear")
  ) {
    return JSON.stringify({
      data: { data: { flag: "on" } },
      success: true,
    });
  }
  if (
    args.includes("storage") &&
    args.includes("session") &&
    !args.includes("set") &&
    !args.includes("clear")
  ) {
    return JSON.stringify({
      data: { data: { nonce: "1" } },
      success: true,
    });
  }
  if (args.includes("eval")) {
    return JSON.stringify({ data: { result: "" }, success: true });
  }
  return "";
};

const commandArgs = (
  commands: readonly ChildProcess.Command[]
): readonly (readonly string[])[] =>
  commands.flatMap((command) =>
    command._tag === "StandardCommand" ? [command.args] : []
  );

it.effect(
  "filters cookies to the current tab origin and maps Web Storage JSON",
  () => {
    const fixture = makeFixture({
      markerExists: true,
      stdout: (command) => storageStdout(command, "create-storage"),
    });

    return AgentBrowser.use((agentBrowser) =>
      Effect.gen(function* inspectOriginStorage() {
        const sessionId = yield* agentBrowser.create("storage", {
          deviceScaleFactor: 1,
          height: 720,
          width: 1280,
        });
        const tabId = Schema.decodeUnknownSync(BrowserTabId)("t1");
        const cookies = yield* agentBrowser.getStorage(
          sessionId,
          tabId,
          "cookies"
        );
        const local = yield* agentBrowser.getStorage(sessionId, tabId, "local");
        const session = yield* agentBrowser.getStorage(
          sessionId,
          tabId,
          "session"
        );

        expect(cookies).toEqual({
          cookies: [
            {
              domain: "app.example.com",
              expires: -1,
              httpOnly: false,
              name: "locale",
              path: "/",
              secure: false,
              session: true,
              size: 8,
              value: "en",
            },
            {
              domain: ".example.com",
              expires: -1,
              httpOnly: true,
              name: "sid",
              path: "/",
              sameSite: "Lax",
              secure: true,
              session: true,
              size: 12,
              value: "abc",
            },
            {
              domain: "app.example.com",
              expires: -1,
              httpOnly: false,
              name: "theme",
              path: "/",
              secure: false,
              session: true,
              size: 9,
              value: "dark",
            },
          ],
          kind: "cookies",
          tabId: "t1",
        });
        expect(local).toEqual({
          entries: { flag: "on" },
          kind: "local",
          tabId: "t1",
        });
        expect(session).toEqual({
          entries: { nonce: "1" },
          kind: "session",
          tabId: "t1",
        });
      })
    ).pipe(Effect.provide(fixture.layer));
  }
);

it.effect(
  "returns an empty snapshot when the requested tab is not active",
  () => {
    const fixture = makeFixture({
      markerExists: true,
      stdout: (command) => storageStdout(command, "create-storage"),
    });

    return AgentBrowser.use((agentBrowser) =>
      Effect.gen(function* skipInactiveTab() {
        const sessionId = yield* agentBrowser.create("storage", {
          deviceScaleFactor: 1,
          height: 720,
          width: 1280,
        });
        const otherTabId = Schema.decodeUnknownSync(BrowserTabId)("t-other");
        fixture.commands.length = 0;
        const snapshot = yield* agentBrowser.getStorage(
          sessionId,
          otherTabId,
          "cookies"
        );
        expect(snapshot).toEqual({
          cookies: [],
          kind: "cookies",
          tabId: otherTabId,
        });
        expect(
          commandArgs(fixture.commands).some((args) => args.includes("cookies"))
        ).toBe(false);
      })
    ).pipe(Effect.provide(fixture.layer));
  }
);

it.effect(
  "sets, deletes, and clears storage without running cookies clear",
  () => {
    const fixture = makeFixture({
      markerExists: true,
      stdout: (command) => storageStdout(command, "create-storage"),
    });

    return AgentBrowser.use((agentBrowser) =>
      Effect.gen(function* mutateOriginStorage() {
        const sessionId = yield* agentBrowser.create("storage", {
          deviceScaleFactor: 1,
          height: 720,
          width: 1280,
        });
        const tabId = Schema.decodeUnknownSync(BrowserTabId)("t1");
        fixture.commands.length = 0;
        yield* agentBrowser.setStorage(sessionId, tabId, {
          cookie: {
            domain: "app.example.com",
            httpOnly: true,
            name: "sid",
            path: "/",
            secure: true,
            value: "next",
          },
          kind: "cookies",
        });
        yield* agentBrowser.setStorage(sessionId, tabId, {
          key: "flag",
          kind: "local",
          value: "off",
        });
        yield* agentBrowser.deleteStorage(sessionId, tabId, {
          domain: "app.example.com",
          kind: "cookies",
          name: "sid",
          path: "/",
        });
        yield* agentBrowser.deleteStorage(sessionId, tabId, {
          key: "nonce",
          kind: "session",
        });
        yield* agentBrowser.clearStorage(sessionId, tabId, "cookies");
        yield* agentBrowser.clearStorage(sessionId, tabId, "local");

        const args = commandArgs(fixture.commands);
        expect(
          args.some(
            (command) =>
              command.includes("cookies") &&
              command.includes("set") &&
              command.includes("next")
          )
        ).toBe(true);
        expect(
          args.some(
            (command) =>
              command.includes("storage") &&
              command.includes("local") &&
              command.includes("set") &&
              command.includes("flag")
          )
        ).toBe(true);
        expect(
          args.some(
            (command) =>
              command.includes("cookies") &&
              command.includes("set") &&
              command.includes("--expires") &&
              command.includes("0")
          )
        ).toBe(true);
        expect(
          args.some((command) => commandIncludesCookiesClear(command))
        ).toBe(false);
        expect(
          args.some(
            (command) =>
              command.includes("storage") &&
              command.includes("local") &&
              command.includes("clear")
          )
        ).toBe(true);
        expect(
          args.some(
            (command) =>
              command.includes("cookies") && command.includes("stripe.com")
          )
        ).toBe(false);
      })
    ).pipe(Effect.provide(fixture.layer));
  }
);
