#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- The paired benchmark must alternate operations and never run stacks concurrently. */
// Two production processes, no model; 20 paired reads and actions.
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  artifacts,
  Effect,
  Resources,
  memory,
  json,
  fixture,
  stack,
  closeServer,
} from "./interface-eval/runtime.mjs";

const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: (sorted[9] + sorted[10]) / 2,
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
  };
};
await Effect.runPromise(
  Effect.tryPromise(async () => {
    const initialMemory = memory();
    const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-overhead`;
    const directory = path.join(artifacts, runId);
    await mkdir(directory, { recursive: true });
    const resources = new Resources(directory);
    const temporary = await mkdtemp(
      path.join(tmpdir(), "contingency-overhead-")
    );
    const stacks = [];
    let site;
    try {
      site = await fixture(resources);
      for (const iface of ["native", "single-tool"]) {
        const mcp = await stack({
          directory: path.join(temporary, iface),
          iface,
          resources,
        });
        stacks.push(mcp);
        mcp.iface = iface;
        const session = await mcp.operation("agent_run_start", {
          inputs: [],
          operationId: "overhead-start",
          referencedSkills: [],
          requestedTask:
            "Add twenty Giant anvils for a disposable latency measurement",
          url: site.url,
          view: "compact",
        });
        mcp.sessionId = session.id;
      }
      const samples = [];
      const memoryChecks = [];
      for (const operation of ["agent_session_get", "agent_browser_act"]) {
        for (let pair = 0; pair < 20; pair += 1) {
          memoryChecks.push(memory());
          // Alternate the leading interface to balance systematic first-call drift.
          for (const mcp of pair % 2 ? stacks.toReversed() : stacks) {
            const args = { sessionId: mcp.sessionId };
            if (operation === "agent_session_get") {
              args.view = "compact";
            } else {
              const page = await mcp.operation("agent_browser_snapshot", {
                format: "structured",
                sessionId: mcp.sessionId,
              });
              const add = page.nodes.find(
                (node) =>
                  node.name === "Add Giant anvil to cart" &&
                  node.role === "button"
              );
              if (!add) {
                throw new Error("Overhead fixture add button absent");
              }
              args.action = { ref: add.ref, type: "click" };
              args.operationId = `overhead-${pair}`;
            }
            const start = performance.now();
            const response = await mcp.operation(operation, args);
            const elapsedMs = performance.now() - start;
            if (
              operation === "agent_browser_act" &&
              response.entry?.outcome !== "completed"
            ) {
              throw new Error("Overhead action did not complete");
            }
            samples.push({ elapsedMs, iface: mcp.iface, operation, pair });
          }
        }
      }
      const summary = {};
      for (const operation of ["agent_session_get", "agent_browser_act"]) {
        summary[operation] = {};
        for (const iface of ["native", "single-tool"]) {
          summary[operation][iface] = stats(
            samples
              .filter(
                (row) => row.operation === operation && row.iface === iface
              )
              .map((row) => row.elapsedMs)
          );
        }
        summary[operation].pairedDifference = stats(
          Array.from(
            { length: 20 },
            (_, pair) =>
              samples.find(
                (row) =>
                  row.operation === operation &&
                  row.pair === pair &&
                  row.iface === "single-tool"
              ).elapsedMs -
              samples.find(
                (row) =>
                  row.operation === operation &&
                  row.pair === pair &&
                  row.iface === "native"
              ).elapsedMs
          )
        );
      }
      const finalStates = [];
      for (const mcp of stacks) {
        finalStates.push({
          iface: mcp.iface,
          snapshot: await mcp.operation("agent_browser_snapshot", {
            format: "structured",
            sessionId: mcp.sessionId,
          }),
        });
      }
      for (const state of finalStates) {
        if (
          !state.snapshot.nodes.some((node) => node.name === "20 items in cart")
        ) {
          throw new Error(`Overhead final cart mismatch for ${state.iface}`);
        }
      }
      json(path.join(directory, "result.json"), {
        finalMemory: memory(),
        finalStates,
        initialMemory,
        memoryChecks,
        runId,
        samples,
        summary,
      });
      process.stdout.write(`${JSON.stringify({ runId, summary })}\n`);
    } finally {
      for (const mcp of stacks) {
        await closeServer(mcp.server);
        await writeFile(
          path.join(directory, `${mcp.iface}-proxy.jsonl`),
          await readFile(path.join(mcp.directory, "proxy.jsonl"))
        );
      }
      if (site) {
        await closeServer(site.server);
      }
      await resources.cleanup();
      await rm(temporary, { force: true, recursive: true });
    }
  })
);
