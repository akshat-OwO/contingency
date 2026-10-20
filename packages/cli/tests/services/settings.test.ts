import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Result } from "effect";
import type { Schema } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { mcpConfig } from "../../src/cmds/mcp.ts";
import { webConfig } from "../../src/cmds/web.ts";
import {
  decodeSettingsFile,
  initSettingsFile,
  loadSettings,
  makeSettingsProvider,
  settingsSchemaUrl,
} from "../../src/services/settings.ts";
import { systemOneConfig } from "../../src/services/system-one.ts";

const port = Config.Number("PORT").pipe(
  Config.withDefault(1),
  Config.nested("CONTINGENCY_MCP")
);

/** A project directory, its Catalog Root, and a home, all disposable. */
const withDirectories = <A, E>(
  body: (input: {
    readonly catalogRoot: string;
    readonly home: string;
    readonly write: (
      file: string,
      json: Schema.Json
    ) => Effect.Effect<void, unknown, FileSystem.FileSystem>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>
) =>
  Effect.gen(function* prepareDirectories() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-settings-",
    });
    const catalogRoot = path.join(root, "project", ".contingency");
    const home = path.join(root, "home");
    const write = (file: string, json: Schema.Json) =>
      fileSystem
        .makeDirectory(path.dirname(file), { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.writeFileString(file, JSON.stringify(json)))
        );
    return yield* body({ catalogRoot, home, write });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("precedence", () => {
  const layers = {
    env: { CONTINGENCY_MCP_PORT: "2" },
    flags: { CONTINGENCY_MCP_PORT: "1" },
    project: { mcp: { port: 3 } },
    user: { mcp: { port: 4 } },
  };

  it.effect("a flag wins over every other layer", () =>
    Effect.gen(function* flagWins() {
      expect(yield* port.parse(makeSettingsProvider(layers))).toBe(1);
    })
  );

  it.effect("the environment wins over both files", () =>
    Effect.gen(function* envWins() {
      expect(
        yield* port.parse(makeSettingsProvider({ ...layers, flags: {} }))
      ).toBe(2);
    })
  );

  it.effect("the project file wins over the user file", () =>
    Effect.gen(function* projectWins() {
      expect(
        yield* port.parse(
          makeSettingsProvider({ ...layers, env: {}, flags: {} })
        )
      ).toBe(3);
    })
  );

  it.effect("the user file applies when nothing else names the Setting", () =>
    Effect.gen(function* userApplies() {
      expect(
        yield* port.parse(makeSettingsProvider({ env: {}, user: layers.user }))
      ).toBe(4);
    })
  );

  it.effect("the default applies when no layer names the Setting", () =>
    Effect.gen(function* defaultApplies() {
      expect(yield* port.parse(makeSettingsProvider({ env: {} }))).toBe(1);
    })
  );

  it.effect("an empty environment variable falls through to the file", () =>
    Effect.gen(function* emptyEnv() {
      expect(
        yield* port.parse(
          makeSettingsProvider({
            env: { CONTINGENCY_MCP_PORT: "" },
            project: layers.project,
          })
        )
      ).toBe(3);
    })
  );
});

describe("every v1 key reaches the Setting it stands in for", () => {
  const provider = makeSettingsProvider({
    env: {},
    project: {
      mcp: {
        channel: true,
        interface: "native",
        port: 7790,
        videoFastForward: "fixed",
      },
      systemOne: { first: true, url: "http://127.0.0.1:9100" },
      web: {
        host: "0.0.0.0",
        port: 7791,
        publicUrl: "https://workspace.example.test",
      },
    },
  });

  it.effect("mcp", () =>
    Effect.gen(function* mcpKeys() {
      expect(yield* mcpConfig(false).parse(provider)).toEqual({
        channel: true,
        interface: "native",
        port: 7790,
        videoFastForward: "fixed",
      });
    })
  );

  it.effect("web", () =>
    Effect.gen(function* webKeys() {
      const config = yield* webConfig.parse(provider);
      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(7791);
      expect(config.publicUrl).toEqual(
        Option.some("https://workspace.example.test")
      );
    })
  );

  it.effect("systemOne", () =>
    Effect.gen(function* systemOneKeys() {
      const config = Option.getOrThrow(yield* systemOneConfig.parse(provider));
      expect(config.first).toBe(true);
      expect(config.url).toBe("http://127.0.0.1:9100/v1/systemone");
      expect(config.apiKey).toEqual(Option.none());
    })
  );
});

/** What a strict decode reports about one file's contents. */
const failures = (json: Schema.Json) =>
  Result.match(decodeSettingsFile(JSON.stringify(json)), {
    onFailure: (lines) => lines,
    onSuccess: () => [],
  });

describe("strict validation", () => {
  it("accepts $schema", () => {
    expect(
      Result.isSuccess(
        decodeSettingsFile(JSON.stringify({ $schema: settingsSchemaUrl() }))
      )
    ).toBe(true);
  });

  it("refuses an unknown key by its JSON pointer", () => {
    expect(failures({ mcp: { prot: 1 } })).toEqual(["/mcp/prot: unknown key"]);
    expect(failures({ systemone: {} })).toEqual(["/systemone: unknown key"]);
  });

  it("refuses a wrong type by its JSON pointer", () => {
    expect(failures({ mcp: { port: "7777" } })).toEqual([
      "/mcp/port: Expected number",
    ]);
    expect(failures({ web: { port: 70_000 } })).toEqual([
      "/web/port: Expected a value between 0 and 65535",
    ]);
  });

  it("refuses every environment-only key and names its variable", () => {
    expect(
      failures({
        catalogRoot: "/tmp",
        globalCatalogRoot: "/tmp",
        systemOne: { apiKey: "secret" },
      })
    ).toEqual([
      "/systemOne/apiKey: environment-only; set CONTINGENCY_SYSTEM_ONE_API_KEY instead",
      "/catalogRoot: environment-only; set CONTINGENCY_CATALOG_ROOT instead",
      "/globalCatalogRoot: environment-only; set CONTINGENCY_GLOBAL_CATALOG_ROOT instead",
    ]);
  });

  it("reports every problem at once", () => {
    expect(
      failures({ mcp: { channel: "yes", extra: 1 }, systemOne: { apiKey: 1 } })
    ).toHaveLength(3);
  });

  it("refuses text that is not JSON", () => {
    expect(Result.isFailure(decodeSettingsFile("{ mcp: { port: 1 } }"))).toBe(
      true
    );
  });
});

describe("loading files", () => {
  it.effect("reads the project file from the Catalog Root it is given", () =>
    withDirectories(({ catalogRoot, home, write }) =>
      Effect.gen(function* projectFile() {
        yield* write(path.join(catalogRoot, "config.json"), {
          mcp: { port: 7801 },
        });
        const moved = path.join(path.dirname(catalogRoot), "elsewhere");
        yield* write(path.join(moved, "config.json"), { mcp: { port: 7802 } });
        const here = yield* loadSettings({ catalogRoot, env: {}, home });
        const there = yield* loadSettings({
          catalogRoot: moved,
          env: {},
          home,
        });
        expect(yield* port.parse(here.provider)).toBe(7801);
        expect(yield* port.parse(there.provider)).toBe(7802);
      })
    )
  );

  it.effect("reads the user file from ~/.contingency", () =>
    withDirectories(({ catalogRoot, home, write }) =>
      Effect.gen(function* userFile() {
        yield* write(path.join(home, ".contingency", "config.json"), {
          mcp: { port: 7803 },
        });
        const loaded = yield* loadSettings({ catalogRoot, env: {}, home });
        expect(yield* port.parse(loaded.provider)).toBe(7803);
      })
    )
  );

  it.effect("treats a missing file as no file", () =>
    withDirectories(({ catalogRoot, home }) =>
      Effect.gen(function* noFiles() {
        const loaded = yield* loadSettings({ catalogRoot, env: {}, home });
        expect(yield* port.parse(loaded.provider)).toBe(1);
        expect(loaded.warnings).toEqual([]);
      })
    )
  );

  it.effect("fails with the file path and JSON pointer", () =>
    withDirectories(({ catalogRoot, home, write }) =>
      Effect.gen(function* invalidFile() {
        const file = path.join(catalogRoot, "config.json");
        yield* write(file, { web: { prot: 1 } });
        const error = yield* Effect.flip(
          loadSettings({ catalogRoot, env: {}, home })
        );
        expect(error._tag).toBe("SettingsError");
        expect(error.message).toContain(file);
        expect(error.message).toContain("/web/prot: unknown key");
      })
    )
  );

  it.effect("warns once when $schema pins another CLI version", () =>
    withDirectories(({ catalogRoot, home, write }) =>
      Effect.gen(function* versionWarning() {
        const file = path.join(catalogRoot, "config.json");
        yield* write(file, { $schema: settingsSchemaUrl("0.0.0-other") });
        const loaded = yield* loadSettings({ catalogRoot, env: {}, home });
        expect(loaded.warnings).toEqual([
          `Contingency ${packageJson.version} is reading ${file}, whose $schema names version 0.0.0-other.`,
        ]);
      })
    )
  );

  it.effect("does not warn for this CLI's own schema", () =>
    withDirectories(({ catalogRoot, home, write }) =>
      Effect.gen(function* sameVersion() {
        yield* write(path.join(catalogRoot, "config.json"), {
          $schema: settingsSchemaUrl(),
        });
        const loaded = yield* loadSettings({ catalogRoot, env: {}, home });
        expect(loaded.warnings).toEqual([]);
      })
    )
  );
});

describe("config init", () => {
  it.effect("writes only the pinned $schema", () =>
    withDirectories(({ catalogRoot }) =>
      Effect.gen(function* init() {
        const fileSystem = yield* FileSystem.FileSystem;
        const file = yield* initSettingsFile(catalogRoot);
        expect(file).toBe(path.join(catalogRoot, "config.json"));
        expect(JSON.parse(yield* fileSystem.readFileString(file))).toEqual({
          $schema: `https://unpkg.com/@contingencyhq/cli@${packageJson.version}/config.schema.json`,
        });
      })
    )
  );

  it.effect("refuses to overwrite an existing file", () =>
    withDirectories(({ catalogRoot, write }) =>
      Effect.gen(function* refuse() {
        const fileSystem = yield* FileSystem.FileSystem;
        const file = path.join(catalogRoot, "config.json");
        yield* write(file, { mcp: { port: 7804 } });
        const error = yield* Effect.flip(initSettingsFile(catalogRoot));
        expect(error.message).toContain("already exists");
        expect(JSON.parse(yield* fileSystem.readFileString(file))).toEqual({
          mcp: { port: 7804 },
        });
      })
    )
  );
});
