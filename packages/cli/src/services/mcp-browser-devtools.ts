import { createHash } from "node:crypto";
import path from "node:path";

import { AgentSessionId, BrowserDevtoolsInput } from "@contingency/protocol";
import { Effect, FileSystem, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { AgentSession } from "./agent-session.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import { AgentSessionFailure, failure } from "./mcp-agent-session.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";

export const BrowserDevtoolsTools = withStrictParameters(
  Toolkit.make(
    Tool.make("agent_browser_devtools", {
      dependencies: [AgentSession, FlowSkillCatalog, FileSystem.FileSystem],
      description:
        "Browser devtools, code only; native/Android unavailable. requests filters URL substring, method, statusMin/statusMax, resourceType; request reads headers/body by requestId. console/clear_console read/clear logs. storage reads current-origin cookies/local/session. Reads mask credentials, scrub secret Variables, and bound bodies to 64 KiB. har_start/har_stop capture up to 500 entries; stop returns a redacted Catalog Root file. emulation_get/set read/change session-wide pageZoom (25–500%) and textScale (50–300%); omit tabId. cookie_set/clear and storage_set/clear allow scoped writes in agent-held Teaching setup or Interactive Runs. Omit storage_clear key to clear the origin. route_add mocks/blocks a URL glob and optional resourceType; headers_set replaces context headers. Both require an Interactive Run. Routes persist across tabs and skills. eval takes script, mode read_only or mutating, and operationId. Read-only aborts on side effects. Mutating scripts (max 2 KiB, shown whole) require Interactive Run Confirmation for each attempt; Allow then agent_browser_resume dispatches once. Eval requests stay within Domain Scope; workers, service-worker registration, EventSource, RTCPeerConnection and WebTransport are unavailable. Top-level navigation uses the Execution Boundary. Takeover interrupts active mutating eval and preserves its spent receipt and irreversible evidence. Results are scrubbed and bounded. Read-only eval runs in the page realm; mutating eval runs in an isolated realm with page DOM access. Dry Runs refuse writes. All writes and HAR require stable operationId. modifications_list returns active ids; modification_remove restores prior state, except irreversible eval evidence.",
      failure: AgentSessionFailure,
      parameters: Schema.Struct({
        ...BrowserDevtoolsInput.fields,
        sessionId: AgentSessionId,
      }),
      success: Schema.Json,
    })
  )
);

const harFailure = (code: string, message: string) =>
  new AgentSessionFailure({ code, message: `${message} (${code})` });

export const BrowserDevtoolsToolHandlersLive = BrowserDevtoolsTools.toLayer({
  agent_browser_devtools: ({ sessionId, command, tabId }) =>
    Effect.gen(function* observeTab() {
      const sessions = yield* AgentSession;
      yield* sessions.noteAgentActivity(sessionId);
      const value = yield* sessions
        .devtools(sessionId, command, tabId)
        .pipe(Effect.mapError(failure));
      if (command.action !== "har_stop") {
        return value;
      }
      const catalog = yield* FlowSkillCatalog;
      const fs = yield* FileSystem.FileSystem;
      const directory = path.join(catalog.root(), ".devtools");
      const id = createHash("sha256")
        .update(`${sessionId}:${tabId ?? "active"}:${command.operationId}`)
        .digest("hex");
      const file = path.join(directory, `${id}.har`);
      const writeFailure = () =>
        harFailure(
          "agent_devtools_har_write_failed",
          "Could not write the HAR file inside Catalog Root."
        );
      yield* fs
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(writeFailure));
      yield* fs
        .writeFileString(file, JSON.stringify(value))
        .pipe(Effect.mapError(writeFailure));
      return { format: "har", path: file };
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
          JSON.stringify(value)
        ).pipe(
          Effect.mapError(() =>
            harFailure(
              "agent_devtools_encode_failed",
              "Could not encode this devtools result as JSON."
            )
          )
        )
      )
    ),
});
