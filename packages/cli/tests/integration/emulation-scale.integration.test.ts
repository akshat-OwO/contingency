import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { makeChromiumAgentBrowser } from "../../src/services/chromium-agent-browser.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  agentProcessLayer,
  runTool,
  sessionTool,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const scaleViewport = { deviceScaleFactor: 1, height: 800, width: 1280 };

it.live(
  "reflows at 400% zoom and scales only relative text across navigation and tabs",
  () =>
    Effect.gen(function* scaleBrowser() {
      const fixture = yield* fixtureServer;
      const browser = yield* CreateBrowser;
      const id = yield* browser.create(
        "create-scale-browser",
        scaleViewport,
        true
      );
      yield* Effect.addFinalizer(() => browser.close(id).pipe(Effect.ignore));
      const { page } = yield* browser.activeTarget(id);
      const url = fixture.url("emulation-scale.html");
      yield* Effect.tryPromise(() => page.goto(url));
      const read = () =>
        Effect.tryPromise(() =>
          page.evaluate(`(() => {
            const fixed = document.querySelector(".fixed");
            const relative = document.querySelector(".relative");
            const main = document.querySelector("main");
            if (!fixed || !relative || !main) {
              throw new Error("Missing scale fixture");
            }
            return {
              columns:
                getComputedStyle(main).gridTemplateColumns.split(" ").length,
              dpr: devicePixelRatio,
              fixed: getComputedStyle(fixed).fontSize,
              pinch: visualViewport?.scale,
              relative: getComputedStyle(relative).fontSize,
              width: innerWidth,
            };
          })()`)
        );
      expect(yield* read()).toMatchObject({
        columns: 2,
        fixed: "16px",
        relative: "16px",
        width: 1280,
      });
      yield* browser.setEmulation(id, { textScale: 200 });
      expect(yield* read()).toMatchObject({
        fixed: "16px",
        relative: "32px",
        width: 1280,
      });
      yield* browser.setEmulation(id, { pageZoom: 400, textScale: 100 });
      expect(yield* read()).toMatchObject({
        columns: 1,
        dpr: 4,
        fixed: "16px",
        pinch: 1,
        relative: "16px",
        width: 320,
      });
      const frame = yield* browser.stream(id).pipe(
        Stream.filter((event) => event.type === "frame"),
        Stream.runHead,
        Effect.flatMap((result) =>
          result._tag === "Some"
            ? Effect.succeed(result.value)
            : Effect.die("Missing zoomed frame")
        ),
        Effect.timeout("30 seconds")
      );
      expect(frame.metadata).toMatchObject({
        deviceHeight: 800,
        deviceWidth: 1280,
        pageScaleFactor: 4,
      });
      yield* Effect.tryPromise(() =>
        page.getByRole("button", { name: "Check input" }).click()
      );
      expect(
        yield* Effect.tryPromise(() => page.getByRole("button").textContent())
      ).toBe("Clicked");
      yield* Effect.tryPromise(() => page.reload());
      expect(yield* read()).toMatchObject({ columns: 1, width: 320 });
      yield* browser.newTab(id);
      const tab = yield* browser.activeTarget(id);
      yield* Effect.tryPromise(() => tab.page.goto(url));
      expect(
        yield* Effect.tryPromise(() => tab.page.evaluate("innerWidth"))
      ).toBe(320);
      yield* browser.setEmulation(id, { pageZoom: 100, textScale: 200 });
      expect(yield* read()).toMatchObject({
        columns: 2,
        fixed: "16px",
        relative: "32px",
        width: 1280,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(CreateBrowserLive),
      Effect.provide(NodeServices.layer)
    )
);

it.live(
  "captures agent screenshots at 400% zoom and keeps the page zoomed",
  () =>
    Effect.gen(function* zoomedScreenshot() {
      const fixture = yield* fixtureServer;
      const browser = yield* CreateBrowser;
      const id = yield* browser.create(
        "create-scale-screenshot",
        scaleViewport,
        true
      );
      yield* Effect.addFinalizer(() => browser.close(id).pipe(Effect.ignore));
      const { page } = yield* browser.activeTarget(id);
      yield* Effect.tryPromise(() =>
        page.goto(fixture.url("emulation-scale.html"))
      );
      yield* Effect.tryPromise(() =>
        page.evaluate(`(() => {
          const input = document.createElement("input");
          input.type = "password";
          input.value = "hunter22";
          input.style.cssText = "display:block;width:200px;height:40px;background:#fff;border:0";
          document.body.prepend(input);
        })()`)
      );
      yield* browser.setEmulation(id, { pageZoom: 400 });
      const read = () =>
        Effect.tryPromise(() =>
          page.evaluate<Record<string, number>>(`(() => ({
              columns: getComputedStyle(document.querySelector("main"))
                .gridTemplateColumns.split(" ").length,
              dpr: devicePixelRatio,
              masks: document.querySelectorAll("[data-contingency-capture-mask]").length,
              width: innerWidth,
            }))()`)
        );
      const zoomed = { columns: 1, dpr: 4, masks: 0, width: 320 };
      expect(yield* read()).toEqual(zoomed);
      const agent = yield* makeChromiumAgentBrowser({
        browser,
        now: () => new Date(),
        scope: yield* Effect.scope,
        sessionId: id,
      });
      const tab = yield* agent.active();
      const plain = yield* tab.screenshot(false, [], []);
      const masked = yield* tab.screenshot(true, [], []);
      expect(yield* read()).toEqual(zoomed);
      expect(yield* browser.getEmulation(id)).toMatchObject({ pageZoom: 400 });
      // Decode both captures in the page: device pixels are CSS × zoom, and
      // password fields remain visible even when a legacy caller requests masking.
      const sample = (image: string, selector = "input") =>
        Effect.tryPromise(() =>
          page.evaluate<{ height: number; pixel: number[]; width: number }>(
            `(async () => {
              const field = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
              const bitmap = await createImageBitmap(
                await (await fetch("data:image/png;base64,${image}")).blob()
              );
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const context = canvas.getContext("2d");
              context.drawImage(bitmap, 0, 0);
              const x = Math.round((field.left + field.width / 2) * devicePixelRatio);
              const y = Math.round((field.top + field.height / 2) * devicePixelRatio);
              return {
                height: bitmap.height,
                pixel: [...context.getImageData(x, y, 1, 1).data.slice(0, 3)],
                width: bitmap.width,
              };
            })()`
          )
        );
      expect(yield* sample(plain.image)).toEqual({
        height: 800,
        pixel: [255, 255, 255],
        width: 1280,
      });
      expect(yield* sample(masked.image)).toEqual({
        height: 800,
        pixel: [255, 255, 255],
        width: 1280,
      });
      // A modal dialog renders in the top layer above ordinary overlays; its
      // field must also remain visible.
      yield* Effect.tryPromise(() =>
        page.evaluate(`(() => {
          const dialog = document.createElement("dialog");
          dialog.style.cssText = "margin:0;padding:0;border:0;position:fixed;left:0;top:60px";
          const input = document.createElement("input");
          input.type = "password";
          input.value = "hunter22";
          input.style.cssText = "display:block;width:200px;height:40px;background:#fff;border:0";
          dialog.append(input);
          document.body.append(dialog);
          dialog.showModal();
        })()`)
      );
      const dialogPlain = yield* tab.screenshot(false, [], []);
      const dialogMasked = yield* tab.screenshot(true, [], []);
      expect(yield* read()).toEqual(zoomed);
      expect(yield* sample(dialogPlain.image, "dialog input")).toMatchObject({
        pixel: [255, 255, 255],
      });
      expect(yield* sample(dialogMasked.image, "dialog input")).toMatchObject({
        pixel: [255, 255, 255],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(CreateBrowserLive),
      Effect.provide(NodeServices.layer)
    )
);

it.live(
  "records replay-safe Interactive Run changes in the persisted Summary and refuses Takeover writes",
  () =>
    Effect.gen(function* recordRunScale() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scale-run-" });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* changeRun() {
        const service = yield* AgentSession;
        const run = yield* runTool("agent_run_start", {
          inputs: [],
          operationId: OperationId.make("scale-start"),
          referencedSkills: [],
          requestedTask: "Check scale",
          url: fixture.url("emulation-scale.html"),
        });
        const change = {
          action: "emulation_set" as const,
          operationId: "scale-change",
          pageZoom: 400,
          textScale: 200,
        };
        expect(yield* service.devtools(run.id, change)).toMatchObject({
          pageZoom: 400,
          textScale: 200,
        });
        yield* service.devtools(run.id, change);
        expect(
          yield* Effect.flip(
            service.devtools(run.id, { ...change, textScale: 100 })
          )
        ).toMatchObject({ code: "agent_session_conflict" });
        yield* service.takeover(run.id, OperationId.make("scale-takeover"));
        expect(
          yield* Effect.flip(
            service.devtools(run.id, { ...change, operationId: "scale-denied" })
          )
        ).toMatchObject({ code: "agent_control_unavailable" });
        const summary = yield* runTool("agent_run_complete", {
          operationId: OperationId.make("scale-complete"),
          sessionId: run.id,
        });
        expect(summary).toMatchObject({
          emulationChanges: [
            {
              actor: "agent",
              after: { pageZoom: 400, textScale: 200 },
              before: { viewport: scaleViewport },
              operationId: "scale-change",
            },
          ],
        });
        expect(
          (yield* runTool("open_run", { runId: summary.runId })).summary
        ).toMatchObject({
          emulationChanges: [{ operationId: "scale-change" }],
        });
        yield* service.closeAll();
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "stamps Teaching scale, locks recording, and restores Teaching scale and allows Dry Run changes",
  () =>
    Effect.gen(function* teachScale() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "scale-teaching-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* teachAndRehearse() {
        const service = yield* AgentSession;
        const session = yield* service.start({
          activity: "teaching",
          name: "scale",
          openedBy: "agent",
          operationId: "scale-teaching",
          url: fixture.url("emulation-scale.html"),
          viewport: scaleViewport,
        });
        if (session.recordingId === null) {
          return yield* Effect.die("Missing recording");
        }
        yield* service.devtools(session.id, {
          action: "emulation_set",
          operationId: "scale-setup",
          pageZoom: 400,
          textScale: 200,
        });
        yield* sessionTool("agent_teaching_setup_handoff", {
          operationId: OperationId.make("scale-handoff"),
          sessionId: session.id,
        });
        yield* service.startTeachingRecording(
          session.id,
          OperationId.make("scale-record")
        );
        expect(
          yield* Effect.flip(
            service.setEmulation(session.id, { textScale: 100 })
          )
        ).toMatchObject({ code: "agent_session_conflict" });
        expect(
          yield* Effect.flip(
            service.devtools(session.id, {
              action: "emulation_set",
              operationId: "scale-record-deny",
              textScale: 100,
            })
          )
        ).toHaveProperty("code");
        yield* service.stopTeachingRecording(
          session.id,
          OperationId.make("scale-stop")
        );
        const { recordingId } = session;
        yield* teachingRecordingTool("agent_teaching_recording_claim", {
          action: "take",
          operationId: OperationId.make("scale-claim"),
          recordingId,
        });
        yield* teachingRecordingTool("agent_flow_skill_save", {
          claimOperationId: OperationId.make("scale-claim"),
          files: [
            {
              content:
                "---\nname: scale\ndescription: Inspect relative text and layout.\n---\n\nRead [targets](references/accessibility.md).\n\n1. Inspect the layout. Done when: Relative text is visible.\n",
              path: "SKILL.md",
            },
            {
              content:
                '# Targets\n\n- role=button name="Check input" context="Page zoom and text scale"\n\n## Why these targets are stable\n\nThe button has a visible label.\n',
              path: "references/accessibility.md",
            },
          ],
          operationId: OperationId.make("scale-save"),
          recordingId,
        });
        const skill = yield* fs.readFileString(`${root}/scale/SKILL.md`);
        expect(skill).toContain("pageZoom: 400");
        expect(skill).toContain("textScale: 200");
        const dry = yield* teachingRecordingTool(
          "agent_flow_skill_dry_run_start",
          {
            inputs: [],
            operationId: OperationId.make("scale-dry"),
            prerequisites: [],
            recordingId,
            url: fixture.url("emulation-scale.html"),
          }
        );
        expect(
          yield* service.devtools(dry.session.id, { action: "emulation_get" })
        ).toMatchObject({ pageZoom: 400, textScale: 200 });
        yield* service.devtools(dry.session.id, {
          action: "emulation_set",
          operationId: "scale-dry-change",
          pageZoom: 100,
        });
        expect(
          yield* service.devtools(dry.session.id, { action: "emulation_get" })
        ).toMatchObject({ pageZoom: 100, textScale: 200 });
        yield* service.closeAll();
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
