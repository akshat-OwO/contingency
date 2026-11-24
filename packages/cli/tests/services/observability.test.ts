import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import type { LogLevel } from "effect";
import { Command } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";

import { diagnosticLogFileName } from "../../src/services/diagnostic-log.ts";
import {
  applyLaunchFlags,
  cliConfigLayer,
  DebugFlag,
  diagnosticLogDirectory,
  environmentLevel,
  flagLevel,
  LogLevelFlag,
  makeObservabilityLayer,
  makeTelemetryLayer,
  Observability,
} from "../../src/services/observability.ts";
import type { LogLevelName } from "../../src/services/observability.ts";
import { makeSettingsProvider } from "../../src/services/settings.ts";
import { ShareSafeSpan } from "../../src/services/share-safe-tracer.ts";

const NOW = new Date("2026-11-24T12:03:04.512Z");

/** An Observability layer whose terminal is an array. */
const terminal = (level: LogLevel.LogLevel = "Warn") => {
  const lines: string[] = [];
  const layer = makeObservabilityLayer({
    colors: false,
    home: "/Users/someone",
    level,
    logFile: false,
    now: NOW,
    pid: 42,
    writeTerminal: (line) => {
      lines.push(line);
    },
  }).pipe(Layer.provide(NodeServices.layer));
  return { layer, lines };
};

/** Settings whose project file sets `log.level`. */
const logLevelFile = (level: LogLevelName) =>
  makeSettingsProvider({ env: {}, project: { log: { level } } });

describe("the terminal", () => {
  it.effect("shows Warn and above as plain sentences by default", () => {
    const { layer, lines } = terminal();
    return Effect.gen(function* plainByDefault() {
      yield* Effect.logDebug("Response sent", { "http.status": 204 });
      yield* Effect.logInfo("Workspace ready");
      yield* Effect.logWarning("Stream stopped", { reason: "lost" });
      expect(lines).toEqual([
        "contingency: warning: Stream stopped  reason=lost",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("switches to one compact line per record at Debug", () => {
    const { layer, lines } = terminal();
    return Effect.gen(function* compactAtDebug() {
      const observability = yield* Observability;
      yield* observability.applySettings(logLevelFile("debug"));
      expect(yield* observability.terminalLevel).toBe("Debug");
      yield* Effect.logDebug("Response sent", { "http.status": 204 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^\d{2}:\d{2}:\d{2}\.\d{3} DEBUG - +Response sent {2}http\.status=204$/u
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows Trace records when asked for trace", () => {
    const { layer, lines } = terminal();
    return Effect.gen(function* traceShown() {
      const observability = yield* Observability;
      yield* observability.applyFlags(Option.some("Trace"));
      yield* Effect.logTrace("Polled the device");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(" TRACE ");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a flag's level outranks every Setting", () => {
    const { layer } = terminal();
    return Effect.gen(function* flagPins() {
      const observability = yield* Observability;
      yield* observability.applyFlags(Option.some("Debug"));
      yield* observability.applySettings(logLevelFile("error"));
      expect(yield* observability.terminalLevel).toBe("Debug");
    }).pipe(Effect.provide(layer));
  });

  it.effect("no flag and no Setting keeps the starting level", () => {
    const { layer } = terminal("Info");
    return Effect.gen(function* unchanged() {
      const observability = yield* Observability;
      yield* observability.applyFlags(Option.none());
      yield* observability.applySettings(makeSettingsProvider({ env: {} }));
      expect(yield* observability.terminalLevel).toBe("Info");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays quiet while an agent holds it", () => {
    const { layer, lines } = terminal();
    return Effect.gen(function* silenced() {
      const observability = yield* Observability;
      yield* Effect.scoped(
        observability.silenceTerminal.pipe(
          Effect.andThen(Effect.logError("Agent harness exited"))
        )
      );
      yield* Effect.logError("Run failed");
      expect(lines).toEqual(["contingency: error: Run failed"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows nothing at none", () => {
    const { layer, lines } = terminal("None");
    return Effect.logFatal("Run failed").pipe(
      Effect.andThen(Effect.sync(() => expect(lines).toEqual([]))),
      Effect.provide(layer)
    );
  });
});

describe("choosing a level", () => {
  it("--log-level outranks --debug", () => {
    expect(flagLevel({ debug: true, logLevel: Option.some("error") })).toEqual(
      Option.some("Error")
    );
    expect(flagLevel({ debug: true, logLevel: Option.none() })).toEqual(
      Option.some("Debug")
    );
    expect(flagLevel({ debug: false, logLevel: Option.none() })).toEqual(
      Option.none()
    );
  });

  it("reads CONTINGENCY_LOG_LEVEL and ignores a value it does not know", () => {
    expect(environmentLevel({})).toBe("Warn");
    expect(environmentLevel({ CONTINGENCY_LOG_LEVEL: "DEBUG" })).toBe("Debug");
    expect(environmentLevel({ CONTINGENCY_LOG_LEVEL: "loud" })).toBe("Warn");
  });

  it.effect.each([
    [[], "Warn"],
    [["--debug"], "Debug"],
    [["--log-level", "info"], "Info"],
    [["--debug", "--log-level", "error"], "Error"],
  ] as const)("a launch with %j shows %s", ([args, expected]) => {
    const { layer } = terminal();
    let seen: LogLevel.LogLevel | undefined;
    const command = Command.make("contingency", {}, () =>
      Effect.gen(function* readLevel() {
        seen = yield* (yield* Observability).terminalLevel;
      })
    ).pipe(
      Command.provideEffectDiscard(applyLaunchFlags),
      Command.withGlobalFlags([DebugFlag, LogLevelFlag])
    );
    return Command.runWith(command, { version: "0.0.0" })([...args]).pipe(
      Effect.andThen(Effect.sync(() => expect(seen).toBe(expected))),
      Effect.provide(Layer.mergeAll(layer, cliConfigLayer, NodeServices.layer))
    );
  });
});

describe("the Diagnostic Log", () => {
  it.effect("records Debug, never Trace, while the terminal shows Warn", () =>
    Effect.gen(function* fileAtDebug() {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-observability-",
      });
      const lines: string[] = [];
      yield* Effect.logTrace("Polled the device").pipe(
        Effect.andThen(
          Effect.logDebug("Response sent", { "http.status": 204 })
        ),
        Effect.provide(
          makeObservabilityLayer({
            colors: false,
            home,
            level: "Warn",
            logFile: true,
            now: NOW,
            pid: 42,
            writeTerminal: (line) => {
              lines.push(line);
            },
          })
        )
      );
      expect(lines).toEqual([]);
      const directory = diagnosticLogDirectory(home);
      expect(directory).toBe(path.join(home, ".contingency", "logs"));
      const text = yield* fileSystem.readFileString(
        path.join(directory, diagnosticLogFileName(NOW, 42))
      );
      expect(text).toMatch(
        /^\S+Z DEBUG - +Response sent {2}http\.status=204\n$/u
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

const HOME = "/Users/someone";
const SECRET = "hunter2";

class BoomError extends Error {
  readonly _tag = "Boom";
  readonly code = "E_BOOM";
  override readonly name = "BoomError";
}

/** A collector that keeps each request body it receives. */
const collector = () => {
  const bodies: string[] = [];
  const decoder = new TextDecoder();
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") {
          bodies.push(decoder.decode(request.body.body));
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: 200 })
        );
      })
    )
  );
  return { bodies, layer };
};

describe("telemetry", () => {
  it.effect("exports nothing and keeps spans working without an endpoint", () =>
    Effect.gen(function* noEndpoint() {
      const span = yield* Effect.currentSpan.pipe(
        Effect.withSpan("session.open")
      );
      expect(span.name).toBe("session.open");
      expect(span).toBeInstanceOf(ShareSafeSpan);
    }).pipe(
      Effect.provide(
        makeTelemetryLayer(makeSettingsProvider({ env: {} }), { home: HOME })
      )
    )
  );

  it.effect("exports a span by its shape, through the allowlist", () => {
    const { bodies, layer } = collector();
    const provider = makeSettingsProvider({
      env: {},
      user: { telemetry: { otlpEndpoint: "http://collector.test:4318" } },
    });
    return Effect.gen(function* exportSpan() {
      yield* Effect.scoped(
        Layer.build(
          makeTelemetryLayer(provider, { home: HOME, httpClient: layer })
        ).pipe(
          Effect.flatMap((context) =>
            Effect.fail(new BoomError(SECRET)).pipe(
              Effect.withSpan("session.open", {
                attributes: {
                  "http.response.status_code": 500,
                  typed: SECRET,
                  "url.full": `https://shop.test/cart?password=${SECRET}`,
                  "url.path": `/users/${SECRET}/cart`,
                },
              }),
              Effect.exit,
              Effect.provideContext(context)
            )
          )
        )
      );
      const body = bodies.join("\n");
      expect(body).toContain('"session.open"');
      expect(body).toContain("fail Boom(E_BOOM)");
      expect(body).toContain('"shop.test"');
      expect(body).toContain(
        '{"key":"http.response.status_code","value":{"intValue":500}}'
      );
      expect(body).not.toContain(SECRET);
    });
  });
});
