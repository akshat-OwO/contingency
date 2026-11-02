import path from "node:path";

import {
  AgentSessionId,
  ContentHash,
  FlowName,
  OperationId,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
} from "effect";

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
          flowName: FlowName.make("large-timeline"),
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
          flowName: FlowName.make("withheld-fill"),
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
            flowName: FlowName.make("scope"),
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
                path: "flow.md",
              },
            ],
            operationId: OperationId.make("save"),
            recordingId,
          });
          const saved = yield* fs.readFileString(
            path.join(root, "scope", "flow.md")
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
for (const value of ["login", "anvil"]) {
  it.effect(
    `saves metadata and reviewed checks matching Variable value ${value}`,
    () =>
      Effect.gen(function* preserveStructuredFiles() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "variable-save-",
        });
        const storeLayer = makeTeachingRecordingStoreLayer({
          root: () => root,
        });
        const layer = Layer.mergeAll(
          storeLayer,
          TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
        );
        yield* Effect.gen(function* saveVariableSkill() {
          const store = yield* TeachingRecordingStore;
          const learning = yield* TeachingRecordingLearning;
          const begun = yield* store.begin({
            emulation: null,
            flowName: FlowName.make("login"),
            operationId: OperationId.make("begin"),
            recordingId,
            sessionId: AgentSessionId.make("agent-variable-save"),
          });
          yield* store.start({
            emulation: begun.emulation,
            operationId: OperationId.make("start"),
            recordingId,
          });
          const at = "2026-10-28T00:00:00.000Z";
          const check = {
            demonstrated: true,
            expectation: {
              itemPath: [],
              predicates: [
                { expected: value, operator: "equals", path: ["product"] },
              ],
            },
            id: "product",
            kind: "response",
            request: {
              method: "GET",
              origin: "https://shop.test",
              path: "/cart",
              query: {},
            },
            response: "matching",
            timeoutMs: 1000,
            when: "After adding the product",
          };
          const events = [
            {
              _tag: "started",
              at,
              emulation: null,
              seq: 0,
              url: "https://shop.test",
            },
            {
              ...actionEvent(1, { value, valueWithheld: false }),
              variableName: "USER",
            },
            {
              _tag: "instruction",
              at,
              attachments: [
                {
                  candidate: check,
                  id: "product",
                  label: "Product",
                  requirement: check,
                },
              ],
              seq: 2,
              text: "Check the product",
            },
          ];
          yield* fs.writeFileString(
            path.join(store.directory(recordingId), "events.jsonl"),
            `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
          );
          yield* store.stop({
            artifacts: [
              {
                capturedAt: at,
                hash: ContentHash.make(`sha256-${"a".repeat(64)}`),
                id: "events",
                kind: "events",
                path: "events.jsonl",
              },
            ],
            operationId: OperationId.make("stop"),
            recordingId,
          });
          const claimOperationId = OperationId.make("claim");
          yield* store.startLearning({
            operationId: claimOperationId,
            recordingId,
          });
          const structured = `${JSON.stringify({ requirements: [check], schemaVersion: 1 }, null, 2)}\n`;
          yield* learning.save({
            claimOperationId,
            files: [
              {
                content: `---\nname: login\ndescription: Sign in to login.\ninputs:\n  - USER\n---\n\nRequire product from [checks](checks.json) and [notes](references/notes.md).\n\n1. Enter ${value} as {{USER}}. Done when: signed in.\n`,
                path: "flow.md",
              },
              { content: "# Setup\nUse {{USER}}.", path: "setup.md" },
              {
                content: `# Inputs\nUse ${value} as {{USER}}.`,
                path: "knowledge/deep/inputs.md",
              },
              { content: "{{undeclared}}", path: "ignored.txt" },
              { content: "", path: "empty.bin" },
              { content: "ignored", path: "runs/ignored.txt" },
              { content: "ignored", path: "../ignored.txt" },
              { content: structured, path: "checks.json" },
              {
                content: `Use ${value} as {{USER}}.`,
                path: "references/notes.md",
              },
            ],
            operationId: OperationId.make("save"),
            recordingId,
          });
          const saved = yield* fs.readFileString(
            path.join(root, "login", "flow.md")
          );
          expect(saved).toContain(
            "name: login\ndescription: Sign in to login."
          );
          expect(
            yield* fs.readFileString(
              path.join(root, "login", "knowledge/deep/inputs.md")
            )
          ).toBe("# Inputs\nUse {{USER}} as {{USER}}.");
          expect(
            yield* fs.exists(path.join(root, "login", "ignored.txt"))
          ).toBe(false);
          expect(yield* fs.exists(path.join(root, "login", "empty.bin"))).toBe(
            false
          );
          expect(saved).toContain("Enter {{USER}} as {{USER}}");
          expect(
            yield* fs.readFileString(
              path.join(root, "login", "references/notes.md")
            )
          ).toBe("Use {{USER}} as {{USER}}.");
          expect(
            yield* fs.readFileString(path.join(root, "login", "checks.json"))
          ).toBe(structured);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}

for (const failure of ["none", "document", "receipt"] as const) {
  const refuse = failure !== "none";
  it.effect(
    `preserves concurrent evidence with ${failure} failure during document installation`,
    () =>
      Effect.gen(function* concurrentEvidence() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const target = path.join(root, "scope");
        const entered = yield* Deferred.make<boolean>();
        const resume = yield* Deferred.make<boolean>();
        let held = false;
        const adapted: FileSystem.FileSystem = {
          ...fs,
          rename: (source, destination) =>
            Effect.gen(function* gatedInstall() {
              // Both the former directory swap and the per-document install reach
              // this boundary after staging. The concurrent writer finishes first.
              if (
                !held &&
                ((source === target && destination.endsWith(".backup")) ||
                  (source.includes(".flow-") &&
                    destination === path.join(target, "flow.md")))
              ) {
                held = true;
                yield* Deferred.succeed(entered, true);
                yield* Deferred.await(resume);
              }
              if (
                failure === "document" &&
                destination === path.join(target, "references", "new.md")
              ) {
                return yield* Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    method: "rename",
                    module: "FileSystem",
                  })
                );
              }
              return yield* fs.rename(source, destination);
            }),
          writeFileString: (file, contents, options) =>
            failure === "receipt" && contents.includes('"flow-drafted"')
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    method: "writeFileString",
                    module: "FileSystem",
                  })
                )
              : fs.writeFileString(file, contents, options),
        };
        const storeLayer = makeTeachingRecordingStoreLayer({
          root: () => root,
        });
        const layer = Layer.mergeAll(
          storeLayer,
          TeachingRecordingLearningLive.pipe(Layer.provide(storeLayer))
        );
        yield* Effect.gen(function* saveAlongsideEvidence() {
          const store = yield* TeachingRecordingStore;
          const learning = yield* TeachingRecordingLearning;
          yield* store.begin({
            emulation: null,
            flowName: FlowName.make("scope"),
            operationId: OperationId.make("begin"),
            recordingId,
            sessionId: AgentSessionId.make("agent-save"),
          });
          yield* store.start({
            emulation: null,
            operationId: OperationId.make("start"),
            recordingId,
          });
          yield* fs.writeFileString(
            path.join(store.directory(recordingId), "events.jsonl"),
            ""
          );
          yield* store.stop({
            artifacts: [
              {
                capturedAt: "2026-10-23T00:00:00.000Z",
                hash: ContentHash.make(`sha256-${"a".repeat(64)}`),
                id: "events",
                kind: "events",
                path: "events.jsonl",
              },
            ],
            operationId: OperationId.make("stop"),
            recordingId,
          });
          const claimOperationId = OperationId.make("claim");
          yield* store.startLearning({
            operationId: claimOperationId,
            recordingId,
          });
          yield* fs.writeFileString(
            path.join(target, "flow.md"),
            "old document"
          );
          yield* fs.makeDirectory(path.join(target, "knowledge", "deep"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(target, "knowledge/deep/old.md"),
            "old nested support"
          );
          yield* fs.writeFileString(
            path.join(target, "notes.txt"),
            "keep this file"
          );
          yield* fs.makeDirectory(path.join(target, "references"));
          yield* fs.writeFileString(
            path.join(target, "references", "old.md"),
            "old support"
          );
          const saving = yield* learning
            .save({
              claimOperationId,
              files: [
                {
                  content:
                    "---\nname: scope\ndescription: Inspect the shop.\ninputs:\n---\n\n1. Open the shop. Done when: the shop appears.\n",
                  path: "flow.md",
                },
                {
                  content: "new nested support",
                  path: "knowledge/deep/new.md",
                },
                { content: "new support", path: "references/new.md" },
              ],
              operationId: OperationId.make("save"),
              recordingId,
            })
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered).pipe(
            Effect.raceFirst(
              Fiber.join(saving).pipe(
                Effect.flatMap((result) => Effect.die(JSON.stringify(result)))
              )
            )
          );
          const otherId = TeachingRecordingId.make("recording-concurrent");
          yield* store.begin({
            emulation: null,
            flowName: FlowName.make("scope"),
            operationId: OperationId.make("other-begin"),
            recordingId: otherId,
            sessionId: AgentSessionId.make("agent-other"),
          });
          yield* store.start({
            emulation: null,
            operationId: OperationId.make("other-start"),
            recordingId: otherId,
          });
          const runFile = path.join(
            target,
            "runs",
            "agentrun-concurrent",
            "summary.json"
          );
          yield* fs.makeDirectory(path.dirname(runFile), { recursive: true });
          yield* fs.writeFileString(runFile, "concurrent Run evidence");
          yield* Deferred.succeed(resume, true);
          const result = yield* Fiber.join(saving);
          expect(result._tag).toBe(refuse ? "Failure" : "Success");
          expect((yield* store.read(otherId)).lifecycle._tag).toBe("recording");
          expect(yield* fs.readFileString(runFile)).toBe(
            "concurrent Run evidence"
          );
          expect(
            yield* fs.readFileString(path.join(target, "flow.md"))
          ).toContain(refuse ? "old document" : "Inspect the shop");
          expect(
            yield* fs.exists(path.join(target, "references", "old.md"))
          ).toBe(refuse);
          expect(
            yield* fs.exists(path.join(target, "references", "new.md"))
          ).toBe(!refuse);
          expect(
            yield* fs.exists(path.join(target, "knowledge/deep/old.md"))
          ).toBe(refuse);
          expect(
            yield* fs.exists(path.join(target, "knowledge/deep/new.md"))
          ).toBe(!refuse);
          expect(yield* fs.readFileString(path.join(target, "notes.txt"))).toBe(
            "keep this file"
          );
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(FileSystem.FileSystem, adapted)
        );
        expect(
          (yield* fs.readDirectory(root)).some((name) =>
            name.startsWith(".flow-")
          )
        ).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}
