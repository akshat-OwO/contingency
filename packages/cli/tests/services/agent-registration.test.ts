import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Result } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  claudeRegistrationServerSpec,
  readClaudeEntries,
} from "../../src/services/agent-harness-claude.ts";
import {
  codexEntryFromToml,
  codexRegistrationServerSpec,
  codexTable,
  codexTrustsProject,
} from "../../src/services/agent-harness-codex.ts";
import {
  opencodeEntry,
  opencodeEntryFromJsonc,
  opencodeRegistrationServerSpec,
  withOpencodeEntry,
} from "../../src/services/agent-harness-opencode.ts";
import { AgentHarnessesLive } from "../../src/services/agent-harnesses.ts";
import {
  describeDifferences,
  register,
} from "../../src/services/agent-registration.ts";
import {
  findTomlTable,
  replaceTomlTable,
} from "../../src/services/toml-table.ts";

const SPEC = codexRegistrationServerSpec({
  fallbackDirectory: "/work/onboarding",
  invocation: { args: ["/opt/contingency/index.js"], command: "/usr/bin/node" },
});

const UNRELATED = `# Personal settings stay exactly as written.
model = "gpt-5"

[mcp_servers.other]
command = "other-server"
args = ["--flag"]

[projects."/work/app"]
trust_level = "trusted"
`;

it("starts every registration on an available port with its agent and fallback", () => {
  expect(SPEC).toEqual({
    args: [
      "/opt/contingency/index.js",
      "mcp",
      "--agent",
      "codex",
      "--fallback-directory",
      "/work/onboarding",
    ],
    command: "/usr/bin/node",
    env: { CONTINGENCY_MCP_PORT: "0" },
    startupTimeoutSeconds: 60,
  });
});

it("reads and replaces one TOML table without touching the rest", () => {
  const withEntry = replaceTomlTable(
    UNRELATED,
    ["mcp_servers", "contingency"],
    codexTable(SPEC)
  );
  expect(withEntry.startsWith(UNRELATED.trimEnd())).toBe(true);
  const lookup = findTomlTable(withEntry, ["mcp_servers", "contingency"]);
  expect(lookup).toEqual({
    _tag: "found",
    table: {
      values: {
        args: SPEC.args,
        command: SPEC.command,
        env: { CONTINGENCY_MCP_PORT: "0" },
        startup_timeout_sec: 60,
      },
    },
  });
  const replaced = replaceTomlTable(
    withEntry,
    ["mcp_servers", "contingency"],
    codexTable({ ...SPEC, command: "/other/node" })
  );
  expect(replaced.match(/\[mcp_servers\.contingency\]/gu)).toHaveLength(1);
  expect(replaced).toContain('command = "/other/node"');
  expect(replaced).toContain('[mcp_servers.other]\ncommand = "other-server"');
  expect(replaced).toContain('trust_level = "trusted"');
});

it.effect(
  "requires replacement when a Codex registration lacks its cold-start timeout",
  () =>
    Effect.gen(function* timeoutDiffers() {
      const text = codexTable(SPEC).replace("startup_timeout_sec = 60\n", "");
      const entry = yield* codexEntryFromToml(text, "config.toml");
      expect(Option.isSome(entry)).toBe(true);
      if (Option.isSome(entry)) {
        expect(describeDifferences(entry.value.spec, SPEC)).toEqual([
          "the startup timeout is unset; Contingency would use 60 seconds",
        ]);
      }
    })
);

it.effect("reports the removed Claude entry when replacement fails", () =>
  Effect.gen(function* replacementFailure() {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.writeFileString(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { contingency: { command: "old-server" } },
      })
    );
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let calls = 0;
    const result = yield* register({
      env: { CLAUDE_CONFIG_DIR: home },
      harness: "claude",
      home,
      projectDirectory: home,
      replace: true,
      scope: "user",
      spec: claudeRegistrationServerSpec({
        fallbackDirectory: home,
        invocation: { args: [], command: "new-server" },
      }),
    }).pipe(
      // The harness captures its process spawner when its Layer is built.
      Effect.provide(AgentHarnessesLive),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
        ...spawner,
        exitCode: () =>
          Effect.sync(() => {
            calls += 1;
            return ChildProcessSpawner.ExitCode(calls === 1 ? 0 : 1);
          }),
      }),
      Effect.result
    );
    expect(calls).toBe(2);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain(
        "The previous Claude Code user scope registration was removed."
      );
      expect(result.failure.message).not.toContain(
        "No other configuration was changed"
      );
    }
  }).pipe(Effect.provide(NodeServices.layer))
);

it("refuses a server defined in a form it does not edit", () => {
  expect(
    findTomlTable(`mcp_servers.contingency.command = "node"\n`, [
      "mcp_servers",
      "contingency",
    ])._tag
  ).toBe("unsupported");
  expect(
    findTomlTable(`[mcp_servers]\ncontingency = { command = "node" }\n`, [
      "mcp_servers",
      "contingency",
    ])._tag
  ).toBe("unsupported");
});

it("reads a multi-line array and escaped strings", () => {
  const lookup = findTomlTable(
    `[mcp_servers.contingency]\ncommand = "C:\\\\node"\nargs = [\n  "a b",\n  'raw\\path',\n]\nenabled = false\n`,
    ["mcp_servers", "contingency"]
  );
  expect(lookup).toEqual({
    _tag: "found",
    table: {
      values: {
        args: ["a b", "raw\\path"],
        command: "C:\\node",
        enabled: false,
      },
    },
  });
});

it("preserves CRLF and table-like text inside an unrelated multiline prompt", () => {
  const unrelated =
    'instructions = """\r\n[mcp_servers.contingency]\r\ncommand = fake\r\n"""\r\n\r\n';
  const current = `${unrelated}${codexTable(SPEC).replaceAll("\n", "\r\n")}\r\n`;
  const changed = replaceTomlTable(
    current,
    ["mcp_servers", "contingency"],
    codexTable({ ...SPEC, command: "/new/node" })
  );
  expect(changed.startsWith(unrelated)).toBe(true);
  expect(changed).toContain('command = "/new/node"\r\n');
  expect(findTomlTable(changed, ["mcp_servers", "contingency"])).toMatchObject({
    _tag: "found",
    table: { values: { command: "/new/node" } },
  });
});

it("refuses malformed configuration before appending a new registration", () => {
  expect(() =>
    replaceTomlTable(
      'model = "unfinished\n',
      ["mcp_servers", "contingency"],
      codexTable(SPEC)
    )
  ).toThrow();
});

it("decodes escaped server names and preserves unrelated quoted table names", () => {
  const current = `${codexTable(SPEC).replace("contingency", '"conting\\u0065ncy"')}\n[projects."/work/a]b"]\ntrust_level = "trusted"\n`;
  expect(findTomlTable(current, ["mcp_servers", "contingency"])._tag).toBe(
    "found"
  );
  const next = replaceTomlTable(
    current,
    ["mcp_servers", "contingency"],
    codexTable({ ...SPEC, command: "/new/node" })
  );
  expect(next).toContain('[projects."/work/a]b"]\ntrust_level = "trusted"');
  expect(next).not.toContain('"conting\\u0065ncy"');
});

it.effect(
  "treats a disabled entry as different even when its command matches",
  () =>
    Effect.gen(function* disabledDiffers() {
      const entry = yield* codexEntryFromToml(
        `${codexTable(SPEC)}\n`.replace(
          "[mcp_servers.contingency]\n",
          "[mcp_servers.contingency]\nenabled = false\n"
        ),
        "config.toml"
      );
      expect(Option.isSome(entry)).toBe(true);
      const existing = Option.getOrThrow(entry);
      expect(describeDifferences(existing.spec, SPEC, existing.extras)).toEqual(
        ["enabled is set to false"]
      );
    })
);

it("names every difference a user must decide on", () => {
  expect(
    describeDifferences(
      { args: ["old.js", "mcp"], command: "/usr/bin/node", env: {} },
      SPEC
    )
  ).toEqual([
    "the startup timeout is unset; Contingency would use 60 seconds",
    `args are ["old.js","mcp"]; Contingency would use ${JSON.stringify(SPEC.args)}`,
    'env CONTINGENCY_MCP_PORT is unset; Contingency would use "0"',
  ]);
});

it("reads Codex project trust from the user configuration", () => {
  expect(codexTrustsProject(Option.some(UNRELATED), "/work/app")).toBe(true);
  expect(codexTrustsProject(Option.some(UNRELATED), "/work/other")).toBe(false);
  expect(codexTrustsProject(Option.none(), "/work/app")).toBe(false);
});

it.effect("registers, keeps, reports, and replaces a Codex project entry", () =>
  Effect.gen(function* codexProjectLifecycle() {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-registration-home-",
    });
    const project = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-registration-project-",
    });
    const codexHome = path.join(home, ".codex");
    yield* fileSystem.makeDirectory(codexHome, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(codexHome, "config.toml"),
      UNRELATED
    );
    const projectConfig = path.join(project, ".codex", "config.toml");
    yield* fileSystem.makeDirectory(path.dirname(projectConfig), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(
      projectConfig,
      '# project settings\nmodel_reasoning_effort = "high"\n'
    );
    const request = {
      env: { CODEX_HOME: codexHome, PATH: process.env.PATH },
      harness: "codex" as const,
      home,
      projectDirectory: project,
      replace: false,
      scope: "project" as const,
      spec: SPEC,
    };

    const first = yield* register(request);
    expect(first._tag).toBe("registered");
    expect(first.notes.join(" ")).toContain("trusted projects");
    const afterFirst = yield* fileSystem.readFileString(projectConfig);
    expect(afterFirst).toContain('model_reasoning_effort = "high"');
    expect(afterFirst).toContain("# project settings");

    const second = yield* register(request);
    expect(second._tag).toBe("kept");
    expect(yield* fileSystem.readFileString(projectConfig)).toBe(afterFirst);

    const other = { ...SPEC, command: "/elsewhere/node" };
    const differs = yield* register({ ...request, spec: other });
    expect(differs._tag).toBe("differs");
    expect(yield* fileSystem.readFileString(projectConfig)).toBe(afterFirst);

    const replaced = yield* register({
      ...request,
      replace: true,
      spec: other,
    });
    expect(replaced._tag).toBe("replaced");
    const afterReplace = yield* fileSystem.readFileString(projectConfig);
    expect(afterReplace).toContain('command = "/elsewhere/node"');
    expect(afterReplace).toContain('model_reasoning_effort = "high"');
    expect(afterReplace.match(/\[mcp_servers\.contingency\]/gu)).toHaveLength(
      1
    );
    // The user configuration was never written.
    expect(
      yield* fileSystem.readFileString(path.join(codexHome, "config.toml"))
    ).toBe(UNRELATED);
  }).pipe(
    Effect.provide(AgentHarnessesLive),
    Effect.provide(NodeServices.layer)
  )
);

it.effect("reads Claude Code scopes from its configuration files", () =>
  Effect.gen(function* claudeScopes() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-claude-config-",
    });
    const configPath = path.join(directory, ".claude.json");
    const project = path.join(directory, "project");
    yield* fileSystem.makeDirectory(project);
    yield* fileSystem.writeFileString(
      configPath,
      JSON.stringify({
        mcpServers: {
          contingency: { args: ["user.js"], command: "node", type: "stdio" },
          unrelated: { args: [1, 2], url: "https://example.test" },
        },
        projects: {
          [project]: {
            mcpServers: { contingency: { command: "node", type: "http" } },
          },
        },
      })
    );
    yield* fileSystem.writeFileString(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { contingency: { command: "shared" } } })
    );
    const entries = yield* readClaudeEntries({
      configPath,
      projectDirectory: project,
    });
    expect(entries.user?.spec).toEqual({
      args: ["user.js"],
      command: "node",
      env: {},
    });
    expect(entries.project?.extras).toEqual(["type is http, not stdio"]);
    expect(entries.shared?.spec.command).toBe("shared");
  }).pipe(Effect.provide(NodeServices.layer))
);

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

const OPENCODE_SPEC = opencodeRegistrationServerSpec({
  fallbackDirectory: "/work/onboarding",
  invocation: { args: ["/opt/contingency/index.js"], command: "/usr/bin/node" },
});

const OPENCODE_UNRELATED = `{
\t// Personal settings stay exactly as written.
\t"$schema": "https://opencode.ai/config.json",
\t"model": "opencode/free", // trailing comment
\t"mcp": {
\t\t"servers": {
\t\t\t"other": { "type": "local", "command": ["other-server"] },
\t\t},
\t},
}
`;

it("writes OpenCode's local entry with native tools and a cold-start timeout", () => {
  expect(opencodeEntry(OPENCODE_SPEC)).toEqual({
    codemode: false,
    command: [
      "/usr/bin/node",
      "/opt/contingency/index.js",
      "mcp",
      "--agent",
      "opencode",
      "--fallback-directory",
      "/work/onboarding",
    ],
    environment: { CONTINGENCY_MCP_PORT: "0" },
    timeout: { startup: 60_000 },
    type: "local",
  });
});

it.effect("edits one JSONC entry and keeps every other byte", () =>
  Effect.gen(function* jsoncEdit() {
    const next = withOpencodeEntry(
      OPENCODE_UNRELATED,
      opencodeEntry(OPENCODE_SPEC)
    );
    const [head, tail] = OPENCODE_UNRELATED.split("\t\t},\n");
    expect(next.startsWith(head ?? "")).toBe(true);
    expect(next.endsWith(`\t\t},\n${tail ?? ""}`)).toBe(true);
    // The new entry follows the file's tab indentation.
    expect(next).toContain('\t\t\t"contingency": {\n\t\t\t\t"codemode": false');
    const entry = yield* opencodeEntryFromJsonc(next, "opencode.jsonc");
    expect(Option.getOrThrow(entry)).toEqual({
      extras: [],
      location: "opencode.jsonc",
      spec: OPENCODE_SPEC,
    });
    expect(withOpencodeEntry("", opencodeEntry(OPENCODE_SPEC))).toMatch(
      /^\{\n {2}"mcp": \{\n[\s\S]*\}\n$/u
    );
  })
);

/** The Contingency entry as `withOpencodeEntry` writes it with tabs. */
const entryLines = (indent: string, closing = "}") => [
  `${indent}"contingency": {`,
  `${indent}\t"codemode": false,`,
  `${indent}\t"command": [`,
  `${indent}\t\t"node"`,
  `${indent}\t],`,
  `${indent}\t"environment": {},`,
  `${indent}\t"type": "local"`,
  `${indent}${closing}`,
];

it("adds the entry on its own line, after a comment and with CRLF", () => {
  const value = opencodeEntry({ args: [], command: "node", env: {} });
  expect(
    withOpencodeEntry('{\n\t"model": "x" // note\n}\n', value).split("\n")
  ).toEqual([
    "{",
    '\t"model": "x", // note',
    '\t"mcp": {',
    '\t\t"servers": {',
    ...entryLines("\t\t\t"),
    "\t\t}",
    "\t}",
    "}",
    "",
  ]);
  // A trailing comma after the last member is kept, and matched.
  expect(
    withOpencodeEntry(
      '{\r\n\t"mcp": {\r\n\t\t"servers": {\r\n\t\t\t"a": 1, /* c */\r\n\t\t}\r\n\t}\r\n}\r\n',
      value
    ).split("\r\n")
  ).toEqual([
    "{",
    '\t"mcp": {',
    '\t\t"servers": {',
    '\t\t\t"a": 1, /* c */',
    ...entryLines("\t\t\t", "},"),
    "\t\t}",
    "\t}",
    "}",
    "",
  ]);
});

it.effect("names what differs in an OpenCode entry, including Code Mode", () =>
  Effect.gen(function* opencodeDiffers() {
    const written = `{ "mcp": { "servers": { "contingency": ${JSON.stringify({
      command: ["/usr/bin/node", "old.js"],
      cwd: "/elsewhere",
      disabled: true,
      type: "local",
    })} } } }`;
    const entry = Option.getOrThrow(
      yield* opencodeEntryFromJsonc(written, "opencode.json")
    );
    expect(
      describeDifferences(entry.spec, OPENCODE_SPEC, entry.extras)
    ).toEqual([
      "the startup timeout is unset; Contingency would use 60 seconds",
      `args are ["old.js"]; Contingency would use ${JSON.stringify(OPENCODE_SPEC.args)}`,
      'env CONTINGENCY_MCP_PORT is unset; Contingency would use "0"',
      "disabled is set to true",
      'cwd is set to "/elsewhere"',
      "codemode is unset; Contingency would set it to false so its tools stay native",
    ]);
    const remote = Option.getOrThrow(
      yield* opencodeEntryFromJsonc(
        '{ "mcp": { "servers": { "contingency": { "type": "remote", "url": "https://example.test" } } } }',
        "opencode.json"
      )
    );
    expect(remote.extras).toEqual([
      "the entry is not a local command Contingency can read",
    ]);
    const malformed = yield* opencodeEntryFromJsonc(
      '{ "mcp": ',
      "opencode.json"
    ).pipe(Effect.result);
    expect(Result.isFailure(malformed)).toBe(true);
  })
);

it.effect(
  "registers, keeps, reports, and replaces an OpenCode project entry",
  () =>
    Effect.gen(function* opencodeProjectLifecycle() {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-opencode-home-",
      });
      const project = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-opencode-project-",
      });
      const userConfig = path.join(
        home,
        ".config",
        "opencode",
        "opencode.jsonc"
      );
      yield* fileSystem.makeDirectory(path.dirname(userConfig), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(userConfig, OPENCODE_UNRELATED);
      // OpenCode writes to the first project file that exists, as it does.
      const projectConfig = path.join(project, ".opencode", "opencode.jsonc");
      yield* fileSystem.makeDirectory(path.dirname(projectConfig));
      yield* fileSystem.writeFileString(projectConfig, OPENCODE_UNRELATED);
      const request = {
        env: {},
        harness: "opencode" as const,
        home,
        projectDirectory: project,
        replace: false,
        scope: "project" as const,
        spec: OPENCODE_SPEC,
      };

      const first = yield* register(request);
      expect(first).toEqual({
        _tag: "registered",
        location: projectConfig,
        notes: [],
      });
      const afterFirst = yield* fileSystem.readFileString(projectConfig);
      expect(afterFirst).toContain(
        "// Personal settings stay exactly as written."
      );
      expect(afterFirst).toContain(
        '"model": "opencode/free", // trailing comment'
      );

      const second = yield* register(request);
      expect(second._tag).toBe("kept");
      expect(yield* fileSystem.readFileString(projectConfig)).toBe(afterFirst);

      const other = { ...OPENCODE_SPEC, command: "/elsewhere/node" };
      const differs = yield* register({ ...request, spec: other });
      expect(differs._tag).toBe("differs");
      expect(yield* fileSystem.readFileString(projectConfig)).toBe(afterFirst);

      const replaced = yield* register({
        ...request,
        replace: true,
        spec: other,
      });
      expect(replaced._tag).toBe("replaced");
      const afterReplace = yield* fileSystem.readFileString(projectConfig);
      expect(afterReplace).toContain('"/elsewhere/node"');
      expect(afterReplace).toContain(
        "// Personal settings stay exactly as written."
      );
      expect(afterReplace).toContain(
        '"other": { "type": "local", "command": ["other-server"] }'
      );
      expect(afterReplace.match(/"contingency"/gu)).toHaveLength(1);
      // No other file was created, and the user configuration was never written.
      expect(
        yield* fileSystem.exists(path.join(project, "opencode.json"))
      ).toBe(false);
      expect(yield* fileSystem.readFileString(userConfig)).toBe(
        OPENCODE_UNRELATED
      );
    }).pipe(
      Effect.provide(AgentHarnessesLive),
      Effect.provide(NodeServices.layer)
    )
);

it.effect(
  "registers OpenCode user scope in its configuration directory and notes a project entry",
  () =>
    Effect.gen(function* opencodeUserScope() {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-opencode-home-",
      });
      const configDirectory = path.join(home, "custom-config");
      const project = path.join(home, "project");
      yield* fileSystem.makeDirectory(project);
      yield* fileSystem.writeFileString(
        path.join(project, "opencode.json"),
        withOpencodeEntry(
          "",
          opencodeEntry({ ...OPENCODE_SPEC, command: "/project/node" })
        )
      );
      const outcome = yield* register({
        env: { OPENCODE_CONFIG_DIR: configDirectory },
        harness: "opencode",
        home,
        projectDirectory: project,
        replace: false,
        scope: "user",
        spec: OPENCODE_SPEC,
      });
      const written = path.join(configDirectory, "opencode.json");
      expect(outcome._tag).toBe("registered");
      expect(outcome.location).toBe(written);
      expect(outcome.notes.join(" ")).toContain(
        "OpenCode merges project configuration over the user configuration"
      );
      const entry = yield* opencodeEntryFromJsonc(
        yield* fileSystem.readFileString(written),
        written
      );
      expect(Option.getOrThrow(entry).spec).toEqual(OPENCODE_SPEC);
    }).pipe(
      Effect.provide(AgentHarnessesLive),
      Effect.provide(NodeServices.layer)
    )
);

it.effect("refuses malformed OpenCode configuration without writing it", () =>
  Effect.gen(function* opencodeMalformed() {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-opencode-home-",
    });
    const projectConfig = path.join(home, "opencode.jsonc");
    yield* fileSystem.writeFileString(projectConfig, '{ "model": ');
    const result = yield* register({
      env: {},
      harness: "opencode",
      home,
      projectDirectory: home,
      replace: true,
      scope: "project",
      spec: OPENCODE_SPEC,
    }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain(
        "is not JSONC Contingency can read"
      );
    }
    expect(yield* fileSystem.readFileString(projectConfig)).toBe('{ "model": ');
  }).pipe(
    Effect.provide(AgentHarnessesLive),
    Effect.provide(NodeServices.layer)
  )
);
