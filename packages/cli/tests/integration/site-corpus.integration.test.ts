// Replays recorded real sites (see site-corpus/record.ts) through the
// product's own browser launch, then checks what must hold on any site:
// the agent's Snapshot is bounded and actionable, and a user's click in
// Teaching reaches the Timeline named by the control it hit. Recorded sites
// never touch the network here, so a verdict does not depend on the day.
// Without SITE_CORPUS_ROOT the suite reports itself skipped.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";

import {
  AgentSession,
  UNRESOLVED_CLICK_DESCRIPTION,
} from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  sessionTool,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import {
  loadCorpus,
  readSiteList,
  siteCorpusRoot,
} from "./site-corpus/corpus.ts";
import { siteCorpusProxy } from "./site-corpus/proxy.ts";

const viewport = { deviceScaleFactor: 1, height: 800, width: 1280 } as const;
/** A Snapshot an agent can read in one tool result. */
const SNAPSHOT_NODE_LIMIT = 4000;

/** Inspect's description of a control a person can click: `role: name`. */
const CLICKABLE = /^(?<role>button|link|tab|menuitem): (?<name>.+)$/u;
const SWEEP_STEP = { x: 80, y: 50 } as const;

const findInspectedControl = (sessionId: AgentSessionId) =>
  Effect.gen(function* sweepViewport() {
    const service = yield* AgentSession;
    for (let y = SWEEP_STEP.y / 2; y < viewport.height; y += SWEEP_STEP.y) {
      for (let x = SWEEP_STEP.x / 2; x < viewport.width; x += SWEEP_STEP.x) {
        const inspected = yield* Effect.result(
          service.inspectPoint(sessionId, x, y)
        );
        if (!Result.isSuccess(inspected)) {
          continue;
        }
        const element = inspected.success;
        const groups = CLICKABLE.exec(element.description)?.groups;
        const name = groups?.["name"];
        const role = groups?.["role"];
        if (
          name !== undefined &&
          role !== undefined &&
          name.trim() !== "" &&
          element.width > 4 &&
          element.height > 4 &&
          element.x >= 0 &&
          element.y >= 0 &&
          element.x + element.width <= viewport.width &&
          element.y + element.height <= viewport.height
        ) {
          return {
            name: name.trim(),
            point: {
              x: Math.round(element.x + element.width / 2),
              y: Math.round(element.y + element.height / 2),
            },
            role,
          };
        }
      }
    }
    return null;
  });

const root = siteCorpusRoot();
const recorded =
  root === undefined
    ? []
    : readdirSync(root)
        .filter((id) => existsSync(path.join(root, id, "site.json")))
        .toSorted();

describe.skipIf(recorded.length === 0)("site corpus replay", () => {
  it.live.each(recorded)("%s", (id) =>
    Effect.gen(function* replaySite() {
      const corpusRoot = root ?? "";
      const entry = (yield* loadCorpus(corpusRoot)).find(
        (candidate) => candidate.site.id === id
      );
      if (entry === undefined) {
        return yield* Effect.die(`No corpus entry ${id}`);
      }
      const sites = yield* readSiteList;
      const fileSystem = yield* FileSystem.FileSystem;
      const catalog = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-site-corpus-",
      });
      const proxy = yield* siteCorpusProxy({
        exchanges: entry.exchanges,
        mode: "replay",
      });

      yield* Effect.gen(function* teachOnRecordedSite() {
        const started = yield* startUserTeaching({
          activity: "teaching",
          clientName: "integration-recorder",
          clientVersion: "1.0.0",
          group: "",
          name: `corpus-${id}`,
          operationId: OperationId.make(`corpus-${id}-start`),
          url: entry.site.url,
          viewport,
        });
        const { recordingId } = started;
        if (recordingId === null) {
          return yield* Effect.die("Teaching did not allocate a recording.");
        }
        const snapshot = yield* sessionTool("agent_browser_snapshot", {
          sessionId: started.id,
        });
        expect(snapshot.nodes.length).toBeGreaterThan(0);
        expect(snapshot.nodes.length).toBeLessThanOrEqual(SNAPSHOT_NODE_LIMIT);
        for (const node of snapshot.nodes) {
          expect(node.name).not.toMatch(/\[object Object\]|undefined/u);
        }

        // Find a target the way a Workspace user does, with Inspect: sweep
        // the first viewport and take the first named button or link that
        // lies wholly inside it, the kind of control a journey starts from.
        const service = yield* AgentSession;
        const target = yield* findInspectedControl(started.id);
        if (target === null) {
          return yield* Effect.die(
            `${id} offers no named control in the first viewport`
          );
        }

        yield* service.startTeachingRecording(
          started.id,
          OperationId.make(`corpus-${id}-record`)
        );
        const { point } = target;
        for (const eventType of ["mousePressed", "mouseReleased"] as const) {
          yield* service.sendInput(started.id, {
            button: "left",
            clickCount: 1,
            eventType,
            type: "input_mouse",
            ...point,
          });
        }
        yield* service.stopTeachingRecording(
          started.id,
          OperationId.make(`corpus-${id}-stop`)
        );
        const claimOperationId = OperationId.make(`corpus-${id}-claim`);
        yield* teachingRecordingTool("agent_teaching_recording_claim", {
          action: "take",
          operationId: claimOperationId,
          recordingId,
        });
        const timeline = yield* teachingRecordingTool(
          "agent_teaching_timeline_get",
          { claimOperationId, recordingId }
        );
        const clicks = timeline.entries.flatMap((item) =>
          item._tag === "action" && item.kind === "click"
            ? [item.description]
            : []
        );
        // Teaching must name the click exactly as Inspect named the control
        // under the same point: one Page, one answer.
        const inspected = `Click ${target.role} "${target.name}"`;
        expect(clicks).toHaveLength(1);
        expect(clicks[0]).not.toBe(UNRESOLVED_CLICK_DESCRIPTION);
        const gap = sites.find((site) => site.id === id)?.gap;
        if (gap === undefined) {
          expect(clicks[0]).toBe(inspected);
        } else {
          expect(clicks[0], `known gap: ${gap}`).not.toBe(inspected);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          agentProcessLayer(catalog, {
            createBrowser: { extraLaunchArgs: proxy.launchArgs },
          })
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
