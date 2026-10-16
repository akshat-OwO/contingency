#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- Copy each evidence file after owned processes stop. */
// nub .cursor/skills/verify-contingency/bin/interface-eval.mjs cart haiku native
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classify } from "./interface-eval/classify.mjs";
import { drive } from "./interface-eval/drivers.mjs";
import {
  artifacts,
  root,
  Effect,
  Resources,
  memory,
  json,
  fixture,
  stack,
} from "./interface-eval/runtime.mjs";
import { checkCart, remaining } from "./interface-eval/tasks.mjs";

const [task, model, iface] = process.argv.slice(2);
if (
  !["cart", "calibration"].includes(task) ||
  !["haiku", "sol"].includes(model) ||
  !["native", "single-tool"].includes(iface)
) {
  throw new Error(
    `Usage: interface-eval.mjs cart|calibration haiku|sol native|single-tool. Remaining tasks: ${JSON.stringify(remaining)}`
  );
}
await Effect.runPromise(
  Effect.tryPromise(async () => {
    const initialMemory = memory();
    const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${task}-${model}-${iface}`;
    const directory = path.join(artifacts, runId);
    await mkdir(directory, { recursive: true });
    const resources = new Resources(directory);
    const temporary = await mkdtemp(
      path.join(tmpdir(), "contingency-interface-eval-")
    );
    let site;
    let mcp;
    let result;
    const start = performance.now();
    try {
      site = await fixture(resources);
      mcp = await stack({
        directory: path.join(temporary, "mcp"),
        iface,
        resources,
      });
      const prompts = JSON.parse(
        await readFile(
          new URL("interface-eval/prompts.json", import.meta.url),
          "utf-8"
        )
      );
      const prompt = prompts[task].replace("{{url}}", site.url);
      json(path.join(directory, "conditions.json"), {
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf-8",
        }).trim(),
        driverVersion: execFileSync(
          model === "haiku" ? "claude" : "codex",
          ["--version"],
          { encoding: "utf-8" }
        ).trim(),
        iface,
        initialMemory,
        model,
        node: process.version,
        port: mcp.port,
        runId,
        task,
        temporary,
        url: site.url,
      });
      const driverStart = performance.now();
      const driver = await drive({
        directory,
        endpoint: mcp.url,
        model,
        prompt,
        resources,
        temporary,
      });
      json(path.join(directory, "driver-summary.json"), driver);
      const modelWallMs = performance.now() - driverStart;
      const check =
        task === "cart"
          ? await checkCart(mcp, driver.finalText)
          : {
              complete: /^ready[.!]?$/iu.test(driver.finalText.trim()),
              extraEffects: [],
            };
      result = {
        ...classify(mcp.journal, check),
        check,
        completion: check.complete && driver.exit[0] === 0,
        exit: driver.exit,
        finalMemory: memory(),
        finalText: driver.finalText,
        iface,
        isolation: driver.isolation,
        model,
        modelWallMs,
        runId,
        task,
        usage: driver.usage,
        wallMs: performance.now() - start,
      };
      json(path.join(directory, "result.json"), result);
    } catch (error) {
      result = {
        completion: false,
        error: String(error),
        iface,
        model,
        runId,
        task,
        wallMs: performance.now() - start,
      };
      json(path.join(directory, "result.json"), result);
      throw error;
    } finally {
      let cleaned = false;
      try {
        await resources.cleanup();
        cleaned = true;
      } finally {
        if (mcp) {
          for (const name of ["proxy.jsonl", "server.stderr"]) {
            try {
              await copyFile(
                path.join(mcp.directory, name),
                path.join(directory, name)
              );
            } catch (error) {
              json(
                path.join(directory, `${name}-copy-error.json`),
                String(error)
              );
            }
          }
        }
        // Delete the symlink itself, never its authentication target.
        await rm(path.join(directory, "codex-home/auth.json"), { force: true });
        if (cleaned) {
          await rm(temporary, { force: true, recursive: true });
        }
        appendFileSync(
          path.join(artifacts, "runs.jsonl"),
          `${JSON.stringify(result)}\n`
        );
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
);
