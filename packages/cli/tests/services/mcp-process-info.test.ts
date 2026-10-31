import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Redacted } from "effect";

import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import type { LocalSystemOneState } from "../../src/services/local-system-one.ts";
import {
  availablePlatforms,
  describeSettings,
  describeSystemOne,
} from "../../src/services/mcp-process-info.ts";
import {
  loadSettings,
  projectSettingsPath,
  userSettingsPath,
} from "../../src/services/settings.ts";
import type { SystemOneConfig } from "../../src/services/system-one.ts";

const remote: SystemOneConfig = {
  apiKey: Option.some(Redacted.make("must-not-leak")),
  first: false,
  model: "test",
  url: "https://user:must-not-leak@example.test?token=must-not-leak",
};
const installation: LocalSystemOneState = {
  current: {
    directory: "install-test",
    kevCommit: "a".repeat(40),
    model: "nev",
    modelId: "test",
    nevRevision: "b".repeat(40),
  },
  previous: null,
  server: null,
  version: 1,
};

it("reports unconfigured and remote System One without probing or leaking credentials", () => {
  expect(
    describeSystemOne(undefined, { running: false, state: undefined })
  ).toMatchObject({
    available: false,
    installState: "not-installed",
    kind: "not-configured",
    reachable: null,
    running: false,
  });
  const info = describeSystemOne(remote, { running: false, state: undefined });
  expect(info).toMatchObject({
    available: true,
    kind: "configured-remote",
    reachable: null,
    running: null,
  });
  expect(JSON.stringify(info)).not.toContain("must-not-leak");
  expect(describeSystemOne().installState).toBe("unknown");
});

it.each(["starting", "ready", "crashed"] as const)(
  "reports Local System One phase %s and process liveness",
  (phase) => {
    const local = {
      ...remote,
      local: () => Effect.succeed({ model: "test", url: "http://127.0.0.1" }),
    };
    const state: LocalSystemOneState = {
      ...installation,
      server: {
        kevPid: 124,
        kevPort: 1235,
        kevStartIdentity: "two",
        phase,
        pid: 123,
        port: 1234,
        startIdentity: "one",
        startedAt: "now",
      },
    };
    expect(describeSystemOne(local, { running: true, state })).toMatchObject({
      available: true,
      installState: "installed",
      kind: "local",
      phase,
      reachable: phase === "ready",
      running: true,
    });
    expect(describeSystemOne(local, { running: false, state }).reachable).toBe(
      false
    );
    expect(
      describeSystemOne(local, { running: false, state: installation })
    ).toMatchObject({ phase: null, reachable: false, running: false });
    expect(
      describeSystemOne(undefined, { running: false, state: installation })
    ).toMatchObject({ available: false, installState: "installed" });
  }
);

it.effect(
  "reports loaded paths, defaults, disk edits and interface mismatches without reloading the active interface",
  () =>
    Effect.gen(function* settingsDiagnostics() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const input = {
        catalogRoot: path.join(root, "catalog"),
        env: { CONTINGENCY_MCP_INTERFACE: "native" },
        home: path.join(root, "home"),
      };
      const defaults = yield* loadSettings(input);
      expect(describeSettings(defaults, defaults, "native")).toMatchObject({
        changedSinceStart: false,
        restartRequired: false,
        sources: ["defaults"],
      });
      const project = projectSettingsPath(input.catalogRoot);
      const user = userSettingsPath(input.home);
      yield* fs.makeDirectory(path.dirname(project), { recursive: true });
      yield* fs.makeDirectory(path.dirname(user), { recursive: true });
      yield* fs.writeFileString(project, '{"mcp":{"interface":"native"}}');
      yield* fs.writeFileString(user, '{"mcp":{"interface":"single-tool"}}');
      const started = yield* loadSettings(input);
      expect(describeSettings(started, started, "native")).toMatchObject({
        fileInterface: "native",
        restartRequired: false,
        sources: [project, user],
      });
      yield* fs.writeFileString(project, '{"mcp":{"interface":"single-tool"}}');
      const current = yield* loadSettings(input);
      expect(describeSettings(started, current, "native")).toMatchObject({
        changedSinceStart: true,
        diagnostic: expect.stringContaining(
          "Settings changed since the server started"
        ),
        fileInterface: "single-tool",
        restartRequired: true,
      });
      expect(describeSettings(current, current, "native")).toMatchObject({
        changedSinceStart: false,
        restartRequired: true,
      });
      expect(describeSettings(started, undefined, "native")).toMatchObject({
        diagnostic: expect.stringContaining("could not be read"),
        restartRequired: true,
      });
      yield* fs.remove(project);
      const removed = yield* loadSettings(input);
      expect(
        describeSettings(started, removed, "native").changedSinceStart
      ).toBe(true);
      const deduplicated = yield* loadSettings({
        ...input,
        catalogRoot: path.dirname(user),
      });
      expect(deduplicated.sources).toEqual([user]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "reports browser and only the native runtimes bound in this process",
  () =>
    Effect.gen(function* runtimeAvailability() {
      expect(yield* availablePlatforms).toEqual(["browser"]);
      expect(
        yield* availablePlatforms.pipe(
          Effect.provide(Layer.mock(AndroidWorkspace, {}))
        )
      ).toEqual(["browser", "android"]);
      expect(
        yield* availablePlatforms.pipe(
          Effect.provide(Layer.mock(IosWorkspace, {}))
        )
      ).toEqual(["browser", "ios"]);
      expect(
        yield* availablePlatforms.pipe(
          Effect.provide(
            Layer.merge(
              Layer.mock(AndroidWorkspace, {}),
              Layer.mock(IosWorkspace, {})
            )
          )
        )
      ).toEqual(["browser", "android", "ios"]);
    })
);
