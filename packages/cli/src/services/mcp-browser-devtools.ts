import { createHash } from "node:crypto";
import path from "node:path";

import { AgentSessionId, BrowserDevtoolsInput } from "@contingency/protocol";
import { Effect, FileSystem, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { AgentSession } from "./agent-session.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.Error is a class factory.
class DevtoolsFailure extends Schema.Error<DevtoolsFailure>("DevtoolsFailure")({
  code: Schema.String,
  message: Schema.String,
}) {}

export const BrowserDevtoolsTools = withStrictParameters(
  Toolkit.make(
    readOnly(
      Tool.make("agent_browser_devtools", {
        dependencies: [AgentSession, FlowSkillCatalog, FileSystem.FileSystem],
        description:
          "Observe this browser tab in Interactive Runs, Teaching setup, or Dry Runs. requests filters URL substring, method, inclusive statusMin/statusMax, and resourceType, returning bounded metadata and dropped count. request fetches headers and bounded body by requestId, with bodyTruncated. console includes uncaught errors; clear_console clears retained messages. storage reads current-origin cookies/local/session. Credential headers and cookie values are masked; secret Variables are scrubbed. har_start/har_stop require distinct stable operationId values. Stop returns a redacted HAR file reference inside Catalog Root, never bytes. Capture holds at most 500 entries and 64 KiB per body. No page writes. Available only through agent_code_execute; native and Android do not support it.",
        failure: DevtoolsFailure,
        parameters: Schema.Struct({
          ...BrowserDevtoolsInput.fields,
          sessionId: AgentSessionId,
        }),
        success: Schema.Json,
      })
    )
  )
);

export const BrowserDevtoolsToolHandlersLive = BrowserDevtoolsTools.toLayer({
  agent_browser_devtools: ({ sessionId, command, tabId }) =>
    Effect.gen(function* observeTab() {
      const sessions = yield* AgentSession;
      yield* sessions.noteAgentActivity(sessionId);
      const value = yield* sessions.devtools(sessionId, command, tabId);
      if (command.action !== "har_stop") {
        return value;
      }
      const catalog = yield* FlowSkillCatalog;
      const fs = yield* FileSystem.FileSystem;
      const directory = path.join(catalog.root(), ".devtools");
      yield* fs.makeDirectory(directory, { recursive: true });
      const id = createHash("sha256")
        .update(`${sessionId}:${tabId ?? "active"}:${command.operationId}`)
        .digest("hex");
      const file = path.join(directory, `${id}.har`);
      yield* fs.writeFileString(file, JSON.stringify(value));
      return { format: "har", path: file };
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
          JSON.stringify(value)
        )
      ),
      Effect.mapError(
        () =>
          new DevtoolsFailure({
            code: "agent_devtools_failed",
            message:
              "Could not observe this live browser tab or write its HAR. It may be closed, the request dropped, or capture inactive. Native and Android interfaces do not support devtools.",
          })
      )
    ),
});
