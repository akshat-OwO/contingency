import path from "node:path";

import {
  AgentSessionId,
  ContentHash,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "../../src/services/teaching-recording-learning.ts";
import {
  makeTeachingRecordingStoreLayer,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";

const recordingId = TeachingRecordingId.make("recording-large-timeline");

it.effect(
  "refuses one timeline event larger than the documented page budget",
  () =>
    Effect.gen(function* refuseOversizedTimelineEvent() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-large-timeline-",
      });
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const layer = Layer.mergeAll(
        storeLayer,
        TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
      ).pipe(Layer.provideMerge(NodeServices.layer));

      const failure = yield* Effect.gen(function* prepareLargeTimeline() {
        const store = yield* TeachingRecordingStore;
        const learning = yield* TeachingRecordingLearning;
        const now = new Date().toISOString();
        const begun = yield* store.begin({
          emulation: {
            permissions: [],
            userAgentProfile: UserAgentProfileId.make("default"),
            viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
          },
          flowSkillName: FlowSkillName.make("large-timeline"),
          operationId: OperationId.make("large-begin"),
          recordingId,
          sessionId: AgentSessionId.make("agent-large-timeline"),
        });
        yield* store.start({
          emulation: begun.emulation,
          operationId: OperationId.make("large-start"),
          recordingId,
        });
        const eventFile = path.join(
          store.directory(recordingId),
          "events.jsonl"
        );
        yield* fileSystem.writeFileString(
          eventFile,
          `${JSON.stringify({
            _tag: "instruction",
            at: now,
            seq: 0,
            text: "x".repeat(70_000),
          })}\n`
        );
        yield* store.stop({
          artifacts: [
            {
              capturedAt: now,
              hash: ContentHash.make(
                "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              ),
              id: "events",
              kind: "events",
              path: "events.jsonl",
            },
          ],
          operationId: OperationId.make("large-stop"),
          recordingId,
        });
        const claimOperationId = OperationId.make("large-claim");
        yield* store.startLearning({
          operationId: claimOperationId,
          recordingId,
        });
        return yield* Effect.flip(
          learning.timeline({ claimOperationId, cursor: 0, recordingId })
        );
      }).pipe(Effect.provide(layer));

      expect(failure.code).toBe("teaching_timeline_too_large");
      expect(failure.message).toContain("65536-character");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const withheldRecordingId = TeachingRecordingId.make("recording-withheld-fill");

const observation = {
  nodeCount: 1,
  title: "Catalog",
  url: "https://shop.test/catalog",
};

const actionEvent = (
  seq: number,
  target: {
    readonly value: string | null;
    readonly valueWithheld: boolean;
  }
) => ({
  _tag: "action",
  after: observation,
  appeared: [],
  at: "2026-09-18T00:00:01.000Z",
  before: observation,
  description: 'Fill textbox "SKU"',
  detail: null,
  disappeared: [],
  id: `action-${seq}`,
  kind: "fill",
  outcome: "succeeded",
  seq,
  target: {
    checked: null,
    context: [],
    disabled: null,
    name: "SKU",
    role: "textbox",
    ...target,
  },
});

it.effect(
  "keeps both legacy Variable placeholders and literal page values",
  () =>
    Effect.gen(function* projectWithheldFill() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-withheld-fill-",
      });
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const layer = Layer.mergeAll(
        storeLayer,
        TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
      ).pipe(Layer.provideMerge(NodeServices.layer));

      const timeline = yield* Effect.gen(function* prepareWithheldFill() {
        const store = yield* TeachingRecordingStore;
        const learning = yield* TeachingRecordingLearning;
        const now = new Date().toISOString();
        const begun = yield* store.begin({
          emulation: {
            permissions: [],
            userAgentProfile: UserAgentProfileId.make("default"),
            viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
          },
          flowSkillName: FlowSkillName.make("withheld-fill"),
          operationId: OperationId.make("withheld-begin"),
          recordingId: withheldRecordingId,
          sessionId: AgentSessionId.make("agent-withheld-fill"),
        });
        yield* store.start({
          emulation: begun.emulation,
          operationId: OperationId.make("withheld-start"),
          recordingId: withheldRecordingId,
        });
        yield* fileSystem.writeFileString(
          path.join(store.directory(withheldRecordingId), "events.jsonl"),
          `${[
            actionEvent(0, { value: "{{ACCOUNT_ID}}", valueWithheld: true }),
            actionEvent(1, { value: "4242-4242", valueWithheld: true }),
          ]
            .map((event) => JSON.stringify(event))
            .join("\n")}\n`
        );
        yield* store.stop({
          artifacts: [
            {
              capturedAt: now,
              hash: ContentHash.make(
                "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
              ),
              id: "events",
              kind: "events",
              path: "events.jsonl",
            },
          ],
          operationId: OperationId.make("withheld-stop"),
          recordingId: withheldRecordingId,
        });
        const claimOperationId = OperationId.make("withheld-claim");
        yield* store.startLearning({
          operationId: claimOperationId,
          recordingId: withheldRecordingId,
        });
        return yield* learning.timeline({
          claimOperationId,
          cursor: 0,
          recordingId: withheldRecordingId,
        });
      }).pipe(Effect.provide(layer));

      const [placeholder, secret] = timeline.entries;

      expect(placeholder?._tag === "action" && placeholder.target?.value).toBe(
        "{{ACCOUNT_ID}}"
      );
      expect(secret?._tag === "action" && secret.target?.value).toBe(
        "4242-4242"
      );
      expect(JSON.stringify(timeline)).toContain("4242-4242");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

for (const variant of [
  "guided-run",
  "legacy-guided-run",
  "teaching",
] as const) {
  const origin = variant === "teaching" ? "teaching" : "guided-run";
  const hasApprovedHosts = variant === "guided-run";
  it.effect(
    `stamps ${hasApprovedHosts ? "approved including unvisited" : "visited"} hosts for ${variant} recordings`,
    () =>
      Effect.gen(function* stampScope() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "recording-scope-",
        });
        const storeLayer = makeTeachingRecordingStoreLayer({
          root: () => root,
        });
        const layer = Layer.mergeAll(
          storeLayer,
          TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
        );
        yield* Effect.gen(function* saveScope() {
          const store = yield* TeachingRecordingStore;
          const learning = yield* TeachingRecordingLearning;
          const begun = yield* store.begin({
            emulation: null,
            flowSkillName: FlowSkillName.make("scope"),
            operationId: OperationId.make("begin"),
            origin,
            recordingId,
            sessionId: AgentSessionId.make("agent-scope"),
          });
          yield* store.start({
            emulation: begun.emulation,
            operationId: OperationId.make("start"),
            recordingId,
          });
          const at = "2026-10-23T00:00:00.000Z";
          yield* fs.writeFileString(
            path.join(store.directory(recordingId), "events.jsonl"),
            `${JSON.stringify({ _tag: "started", at, emulation: null, seq: 0, url: "https://shop.test" })}\n${JSON.stringify({ _tag: "url", at, from: "https://shop.test", seq: 1, url: "https://visited.test" })}\n`
          );
          const stopInput = {
            artifacts: [
              {
                capturedAt: at,
                hash: ContentHash.make(`sha256-${"a".repeat(64)}`),
                id: "events",
                kind: "events" as const,
                path: "events.jsonl",
              },
            ],
            operationId: OperationId.make("stop"),
            recordingId,
          };
          yield* store.stop(
            hasApprovedHosts
              ? { ...stopInput, approvedHosts: ["shop.test", "approved.test"] }
              : stopInput
          );
          const claimOperationId = OperationId.make("claim");
          yield* store.startLearning({
            operationId: claimOperationId,
            recordingId,
          });
          yield* learning.save({
            claimOperationId,
            files: [
              {
                content:
                  "---\nname: scope\ndescription: Inspect the shop.\ninputs:\n---\n\n# Inspect the shop\n\n1. Open the shop. Done when: the shop appears.\n",
                path: "SKILL.md",
              },
            ],
            operationId: OperationId.make("save"),
            recordingId,
          });
          const saved = yield* fs.readFileString(
            path.join(root, "scope", "SKILL.md")
          );
          expect(saved).toContain(
            hasApprovedHosts
              ? "hosts:\n  - approved.test\n  - shop.test"
              : "hosts:\n  - shop.test\n  - visited.test"
          );
          if (hasApprovedHosts) {
            expect(saved).not.toContain("visited.test");
          }
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}
