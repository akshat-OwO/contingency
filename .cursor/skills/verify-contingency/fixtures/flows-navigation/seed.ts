import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as Effect from "../../../../../packages/cli/node_modules/effect/dist/Effect.js";
import * as Schema from "../../../../../packages/cli/node_modules/effect/dist/Schema.js";
import { taskRunSummary } from "../../../../../packages/cli/tests/helpers/task-run.ts";

const verifyDir = process.env.CONTINGENCY_VERIFY_DIR;
const mode = process.argv[2] ?? "demo";
const longestName = `reconcile-international-distributor-invoices-before-quarter-end-close-${"regional-".repeat(6)}fini`;

await Effect.runPromise(
  Effect.tryPromise(async () => {
    if (
      verifyDir === undefined ||
      !["demo", "worst", "empty", "single", "history", "global"].includes(mode)
    ) {
      throw new Error(
        "Use an isolated CONTINGENCY_VERIFY_DIR and demo, worst, empty, single, history, or global."
      );
    }
    const instance = Schema.decodeUnknownSync(
      Schema.Struct({ stateDir: Schema.String })
    )(
      JSON.parse(await readFile(path.join(verifyDir, "instance.json"), "utf-8"))
    );
    const state = path.join(verifyDir, "state");
    if (instance.stateDir !== state) {
      throw new Error("Verification instance stateDir does not match.");
    }
    await Promise.all(
      ["catalog", "global-catalog"].map(async (location) => {
        await rm(path.join(state, location), { force: true, recursive: true });
        await mkdir(path.join(state, location), { recursive: true });
      })
    );
    const root = path.join(
      state,
      mode === "global" ? "global-catalog" : "catalog"
    );
    const datasets = new Map([
      ["demo", ["add-mug"]],
      ["empty", []],
      ["global", []],
      ["history", []],
      ["single", ["add-mug"]],
      ["worst", [longestName, "j", "verify-checkout"]],
    ]);
    const names = datasets.get(mode) ?? [];
    await Promise.all(
      names.map(async (name) => {
        await mkdir(path.join(root, name), { recursive: true });
        await writeFile(
          path.join(root, name, "flow.md"),
          `---\nname: ${name}\ndescription: Reconcile invoices and verify the receipt.\nhosts:\n  - accounts.example.com\n---\n\n1. Open https://accounts.example.com/workspaces/enterprise/projects/quarter-end-reconciliation.\n   Done when: the invoices are visible.\n`
        );
      })
    );
    if (mode !== "empty" && mode !== "single") {
      const summaries = [
        {
          ...taskRunSummary,
          inputs: [],
          referencedFlows: names.length
            ? [
                {
                  flowName: names[0],
                  referencedAt: taskRunSummary.startedAt,
                },
              ]
            : [],
          variables: [],
        },
      ];
      if (mode === "worst") {
        summaries.push({
          ...summaries[0],
          referencedFlows: [],
          runId: "agentrun-loose",
          title:
            "Reconcile invoices for Aleksandra Wiśniewska-Kowalczyk before quarter-end close",
        });
      }
      await Promise.all(
        summaries.map(async (summary) => {
          const directory = path.join(
            root,
            ...(summary.referencedFlows.length === 1
              ? summary.referencedFlows.map((flow) => flow.flowName)
              : []),
            "runs",
            summary.runId
          );
          await mkdir(directory, { recursive: true });
          await writeFile(
            path.join(directory, "summary.json"),
            JSON.stringify(summary)
          );
        })
      );
      const recordingId = "recording-retained";
      const directory = path.join(
        root,
        "deleted-cart",
        "recordings",
        recordingId
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          artifacts: [],
          cleanup: { _tag: "pending" },
          createdAt: taskRunSummary.startedAt,
          emulation: taskRunSummary.startingEmulation,
          flowName: "deleted-cart",
          lifecycle: {
            _tag: "flow-drafted",
            draftedAt: taskRunSummary.endedAt,
            readyAt: taskRunSummary.endedAt,
            startedAt: taskRunSummary.startedAt,
            stoppedAt: taskRunSummary.endedAt,
          },
          origin: "teaching",
          receipts: [],
          recordingId,
          schemaVersion: 1,
          sessionId: "agent-teaching",
          updatedAt: taskRunSummary.endedAt,
        })
      );
    }
    if (mode === "worst") {
      const directory = path.join(root, "runs", "agentrun-unreadable");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "summary.json"), "{invalid");
      await mkdir(path.join(state, "catalog", "procedure-wrapping"), {
        recursive: true,
      });
      await writeFile(
        path.join(state, "catalog", "procedure-wrapping", "flow.md"),
        await readFile(
          new URL("../procedure-wrapping/flow.md", import.meta.url),
          "utf-8"
        )
      );
    }
    process.stdout.write(
      `${JSON.stringify({ longestNameLength: longestName.length, mode, names, root })}\n`
    );
  })
);
