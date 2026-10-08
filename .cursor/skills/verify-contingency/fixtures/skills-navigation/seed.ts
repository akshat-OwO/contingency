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
          path.join(root, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Reconcile invoices and verify the receipt.\nhosts:\n  - accounts.example.com\n---\n\n1. Open https://accounts.example.com/workspaces/enterprise/projects/quarter-end-reconciliation.\n   Done when: the invoices are visible.\n`
        );
      })
    );
    if (mode !== "empty" && mode !== "single") {
      const summaries = [
        {
          ...taskRunSummary,
          inputs: [],
          referencedSkills: names.length
            ? [
                {
                  flowSkillName: names[0],
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
          referencedSkills: [],
          runId: "agentrun-loose",
          title:
            "Reconcile invoices for Aleksandra Wiśniewska-Kowalczyk before quarter-end close",
        });
      }
      await Promise.all(
        summaries.map(async (summary) => {
          const directory = path.join(root, "agent-runs", summary.runId);
          await mkdir(directory, { recursive: true });
          await writeFile(
            path.join(directory, "summary.json"),
            JSON.stringify(summary)
          );
        })
      );
      const recordingId = "recording-retained";
      const directory = path.join(root, ".recordings", recordingId);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          artifacts: [],
          cleanup: { _tag: "pending" },
          createdAt: taskRunSummary.startedAt,
          emulation: taskRunSummary.startingEmulation,
          flowSkillName: "deleted-cart",
          lifecycle: {
            _tag: "skill-drafted",
            draftedAt: taskRunSummary.endedAt,
            readyAt: taskRunSummary.endedAt,
            skillPath: "deleted-cart",
            startedAt: taskRunSummary.startedAt,
            stoppedAt: taskRunSummary.endedAt,
          },
          receipts: [],
          recordingId,
          schemaVersion: 1,
          sessionId: "agent-teaching",
          updatedAt: taskRunSummary.endedAt,
        })
      );
    }
    if (mode === "worst") {
      const directory = path.join(root, "agent-runs", "agentrun-unreadable");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "summary.json"), "{invalid");
      await mkdir(path.join(state, "catalog", "procedure-wrapping"), {
        recursive: true,
      });
      await writeFile(
        path.join(state, "catalog", "procedure-wrapping", "SKILL.md"),
        await readFile(
          new URL("../procedure-wrapping/SKILL.md", import.meta.url),
          "utf-8"
        )
      );
    }
    process.stdout.write(
      `${JSON.stringify({ longestNameLength: longestName.length, mode, names, root })}\n`
    );
  })
);
