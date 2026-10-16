#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- Copy each evidence file after owned processes stop. */
// nub .cursor/skills/verify-contingency/bin/interface-eval.mjs cart haiku native
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  androidPrerequisite,
  checkAndroid,
} from "./interface-eval/android.mjs";
import { classify } from "./interface-eval/classify.mjs";
import { drive } from "./interface-eval/drivers.mjs";
import { browserTasks, prepareJourney } from "./interface-eval/journeys.mjs";
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
import { scriptedProbe } from "./interface-eval/scripted-probe.mjs";
import { checkCart, remaining } from "./interface-eval/tasks.mjs";

const checkTask = ({ journey, driver, task, mcp, android, resources }) => {
  if (journey) {
    return journey.check(driver.finalText);
  }
  if (task === "android") {
    return checkAndroid(android, driver.finalText, resources);
  }
  if (task === "cart") {
    return checkCart(mcp, driver.finalText);
  }
  return {
    complete: /^ready[.!]?$/iu.test(driver.finalText.trim()),
    extraEffects: [],
  };
};
const failureResult = ({
  directory,
  driver,
  error,
  iface,
  journey,
  mcp,
  model,
  runId,
  start,
  task,
}) => ({
  ...classify(mcp?.journal ?? [], {}, journey?.state.timeline),
  completion: false,
  error: String(error),
  exit: driver?.exit,
  finalText: driver?.finalText,
  harnessDefect: true,
  iface,
  isolation: driver?.isolation,
  model,
  modelLaunched: existsSync(path.join(directory, "driver.jsonl")),
  runId,
  task,
  usage: driver?.usage,
  wallMs: performance.now() - start,
});

const auditResult = async (journey, result, directory) => {
  if (!journey) {
    return;
  }
  const privacy = await journey.auditArtifacts();
  if (result.check) {
    result.check.privacy = privacy;
  }
  if (!privacy.literalAbsent) {
    if (result.check) {
      result.check.complete = false;
    }
    result.completion = false;
    result.harnessDefect = true;
  }
  json(path.join(directory, "result.json"), result);
};

const [task, model, iface] = process.argv.slice(2);
if (
  !["cart", "calibration", "android", ...browserTasks].includes(task) ||
  !["haiku", "sol"].includes(model) ||
  !["native", "single-tool"].includes(iface)
) {
  throw new Error(
    `Usage: interface-eval.mjs cart|calibration haiku|sol native|single-tool. Remaining tasks: ${JSON.stringify(remaining)}`
  );
}
const android = task === "android" ? androidPrerequisite() : null;
if (process.argv.includes("--dry-check")) {
  process.stdout.write(
    `${JSON.stringify({ modelLaunched: false, prerequisite: android, task })}\n`
  );
  process.exit(0);
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
    let journey;
    let driver;
    const start = performance.now();
    try {
      site = await fixture(resources);
      mcp = await stack({
        directory: path.join(temporary, "mcp"),
        iface,
        resources,
      });
      if (browserTasks.includes(task)) {
        journey = await prepareJourney({
          directory,
          mcp,
          resources,
          task,
          temporary,
          url: site.url,
        });
      }
      const androidContext = android
        ? await prepareAndroid(
            { directory, mcp, resources, temporary },
            android
          )
        : {};
      const prompts = JSON.parse(
        await readFile(
          new URL("interface-eval/prompts.json", import.meta.url),
          "utf-8"
        )
      );
      const values = {
        checkoutUrl: new URL("eval-checkout.html", site.url).href,
        deliveryUrl: new URL("eval-delivery.html", site.url).href,
        url: site.url,
        ...journey?.context,
        ...android,
        ...androidContext,
      };
      const prompt = prompts[task].replaceAll(
        /\{\{(?<key>\w+)\}\}/gu,
        (_, key) => values[key]
      );
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
      if (process.argv.includes("--scripted-check")) {
        const finalText = await scriptedProbe({
          context: journey.context,
          iface,
          mcp,
          task,
          url: site.url,
        });
        const check = await journey.check(finalText);
        result = {
          check,
          completion: check.complete,
          iface,
          model,
          modelLaunched: false,
          runId,
          task,
        };
        json(path.join(directory, "result.json"), result);
        if (!check.complete) {
          throw new Error("Scripted preflight final check failed");
        }
        return;
      }
      if (process.argv.includes("--seed-check")) {
        result = {
          completion: false,
          iface,
          model,
          modelLaunched: false,
          runId,
          seed: journey?.context,
          task,
        };
        json(path.join(directory, "result.json"), result);
        return;
      }
      const driverStart = performance.now();
      driver = await drive({
        directory,
        endpoint: mcp.url,
        model,
        prompt,
        resources,
        scrub: journey?.scrub,
        temporary,
      });
      json(path.join(directory, "driver-summary.json"), driver);
      const modelWallMs = performance.now() - driverStart;
      const check = await checkTask({
        android,
        driver,
        journey,
        mcp,
        resources,
        task,
      });
      result = {
        ...classify(mcp.journal, check, journey?.state.timeline),
        check,
        completion: check.complete && driver.exit[0] === 0,
        exit: driver.exit,
        finalMemory: memory(),
        finalText: driver.finalText,
        harnessDefect: Boolean(mcp.hooks.error),
        harnessError: mcp.hooks.error,
        iface,
        isolation: driver.isolation,
        model,
        modelLaunched: true,
        modelWallMs,
        runId,
        task,
        usage: driver.usage,
        wallMs: performance.now() - start,
      };
      json(path.join(directory, "result.json"), result);
    } catch (error) {
      result = failureResult({
        directory,
        driver,
        error,
        iface,
        journey,
        mcp,
        model,
        runId,
        start,
        task,
      });
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
              if (journey) {
                const text = await readFile(
                  path.join(mcp.directory, name),
                  "utf-8"
                );
                await writeFile(
                  path.join(directory, name),
                  journey.scrub(text)
                );
              } else {
                await copyFile(
                  path.join(mcp.directory, name),
                  path.join(directory, name)
                );
              }
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
        await auditResult(journey, result, directory);
        appendFileSync(
          path.join(artifacts, "runs.jsonl"),
          `${JSON.stringify(result)}\n`
        );
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
);
