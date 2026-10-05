import { expect, it } from "vitest";

import {
  AGENT_PROFILES,
  agentArguments,
  currentInvocation,
  demoInitialMessage,
  olderThan,
  reconnectCommand,
  registrationCommand,
  sessionServerSpec,
  shellQuote,
  workInitialMessage,
} from "../../src/services/agent-launch.ts";

const invocation = currentInvocation({
  execPath: "/usr/local/bin/node",
  packageName: "@contingencyhq/cli",
  script: "/opt/contingency/dist/index.js",
  version: "1.2.3",
});
const spec = sessionServerSpec({
  agent: "claude",
  demo: false,
  directory: "/work/my app",
  invocation,
});

it("supplies a session-only server on an available port for this directory", () => {
  expect(spec).toEqual({
    args: [
      "/opt/contingency/dist/index.js",
      "mcp",
      "--agent",
      "claude",
      "--fallback-directory",
      "/work/my app",
    ],
    command: "/usr/local/bin/node",
    env: {
      CONTINGENCY_CATALOG_ROOT: "/work/my app/.contingency",
      CONTINGENCY_MCP_PORT: "0",
    },
  });
});

it("serves the demo store only to a session started with --demo", () => {
  expect(
    sessionServerSpec({
      agent: "claude",
      demo: true,
      directory: "/work/my app",
      invocation,
    }).args
  ).toEqual([
    "/opt/contingency/dist/index.js",
    "mcp",
    "--agent",
    "claude",
    "--fallback-directory",
    "/work/my app",
    "--demo",
  ]);
});

it("re-invokes an npx run through npx at the same version", () => {
  expect(
    currentInvocation({
      execPath: "/usr/local/bin/node",
      packageName: "@contingencyhq/cli",
      script:
        "/Users/a/.npm/_npx/abc/node_modules/@contingencyhq/cli/dist/index.js",
      version: "1.2.3",
    })
  ).toEqual({ args: ["-y", "@contingencyhq/cli@1.2.3"], command: "npx" });
});

it("passes Claude Code its MCP config and ends the variadic option before the prompt", () => {
  const args = agentArguments({
    agent: "claude",
    extra: ["-p"],
    message: "hello",
    spec,
  });
  expect(args.slice(0, 2)).toEqual(["-p", "--mcp-config"]);
  expect(JSON.parse(args[2] ?? "")).toEqual({
    mcpServers: {
      contingency: {
        args: spec.args,
        command: spec.command,
        env: spec.env,
        type: "stdio",
      },
    },
  });
  expect(args.slice(3)).toEqual(["--", "hello"]);
  // Nothing that changes permissions, models, or authentication.
  expect(args.join(" ")).not.toMatch(
    /permission|allowedTools|--model|dangerously|strict-mcp-config/u
  );
});

it("passes Codex TOML overrides and keeps the prompt last", () => {
  const codex = sessionServerSpec({
    agent: "codex",
    demo: false,
    directory: "/work/app",
    invocation,
  });
  const args = agentArguments({
    agent: "codex",
    extra: ["exec"],
    message: "hello",
    spec: codex,
  });
  expect(args).toEqual([
    "-c",
    'mcp_servers.contingency.command="/usr/local/bin/node"',
    "-c",
    'mcp_servers.contingency.args=["/opt/contingency/dist/index.js", "mcp", "--agent", "codex", "--fallback-directory", "/work/app"]',
    "-c",
    'mcp_servers.contingency.env={ CONTINGENCY_CATALOG_ROOT = "/work/app/.contingency", CONTINGENCY_MCP_PORT = "0" }',
    "-c",
    "mcp_servers.contingency.startup_timeout_sec=60",
    "exec",
    "hello",
  ]);
});

it("points the first message at the bundled prompt and the launch context", () => {
  const message = demoInitialMessage({
    agent: AGENT_PROFILES.claude,
    catalogRoot: "/work/my app/.contingency",
    directory: "/work/my app",
    registrationCommand: registrationCommand({
      agent: "claude",
      directory: "/work/my app",
      invocation,
    }),
  });
  expect(message).toContain("contingency://onboarding/starter-prompt");
  expect(message).toContain("- Catalog Root: /work/my app/.contingency");
  expect(message).toContain(
    "/usr/local/bin/node /opt/contingency/dist/index.js register --agent claude --fallback-directory '/work/my app'"
  );
});

it("points a work session at the work prompt and how to reconnect", () => {
  const message = workInitialMessage({
    agent: AGENT_PROFILES.codex,
    catalogRoot: "/work/my app/.contingency",
    directory: "/work/my app",
    reconnectCommand: reconnectCommand({ agent: "codex", invocation }),
  });
  expect(message).toContain("contingency://start/work-prompt");
  expect(message).not.toContain("contingency://onboarding/starter-prompt");
  expect(message).not.toContain("register");
  expect(message).toContain("- Catalog Root: /work/my app/.contingency");
  expect(message).toContain(
    "/usr/local/bin/node /opt/contingency/dist/index.js start --agent codex"
  );
});

it("quotes shell words and compares versions", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(shellQuote("/plain/path")).toBe("/plain/path");
  expect(olderThan("2.1.200", "2.1.289")).toBe(true);
  expect(olderThan("0.160.0", "0.160.0")).toBe(false);
  expect(olderThan("0.161.0", "0.160.0")).toBe(false);
});
