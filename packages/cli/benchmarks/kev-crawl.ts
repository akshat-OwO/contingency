/**
 * Collects Browser Snapshots for training a System One model such as Kev.
 *
 * Each site gets one Run that starts at its URL and takes a seeded random walk
 * of clicks and fills through `agent_browser_act`, so Domain Scope, the
 * Execution Boundary, and Confirmation apply as they do for any agent. Every
 * page visited is written as one JSON line holding the exact action space the
 * fast loop would send, plus the action the walk took from it and that
 * action's effect. Labelled requests are generated from these lines offline.
 *
 *   KEV_CRAWL_SITES=sites.txt KEV_CRAWL_OUT=pages.jsonl nub …/kev-crawl.ts
 *
 * Environment:
 *   KEV_CRAWL_SITES  a file with one start URL per line; `#` starts a comment
 *   KEV_CRAWL_OUT    the JSONL file pages are appended to
 *   KEV_CRAWL_STEPS  actions per walk (default 12)
 *   KEV_CRAWL_SEED   seed of the walk's random choices (default 1)
 */
import { OperationId } from "@contingency/protocol";
import type {
  AgentActionEffect,
  AgentBrowserSnapshot,
  AgentSessionId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Layer } from "effect";

import { makeDemoSiteLayer } from "../src/services/demo-site-server.ts";
import { OnboardingToolHandlersLive } from "../src/services/mcp-onboarding.ts";
import { actionSpace } from "../src/services/system-one-request.ts";
import type {
  ActionSpace,
  Operation,
} from "../src/services/system-one-request.ts";
import {
  agentProcessLayer,
  runTool,
  sessionTool,
} from "../tests/integration/agent-harness.ts";

/** Names a random walk never clicks, even though a Run would confirm them. */
const AVOIDED =
  /delete|remove|log ?out|sign ?out|unsubscribe|buy now|place order|\bpay\b|purchase|cancel|report|block/iu;
const FILL_WORDS = [
  "shoes",
  "laptop",
  "paracetamol",
  "London",
  "coffee",
  "river",
  "history",
  "headphones",
  "Mumbai",
  "garden",
];

/** A small seeded generator (Park-Miller), so a crawl can be repeated. */
const randomFrom = (seed: number) => {
  const modulus = 2_147_483_647;
  let state = (Math.abs(Math.trunc(seed)) % (modulus - 1)) + 1;
  return () => {
    state = (state * 48_271) % modulus;
    return (state - 1) / (modulus - 1);
  };
};

interface Move {
  readonly index: string;
  readonly operation: Operation;
  readonly value: string;
}

const chooseMove = (
  space: ActionSpace,
  random: () => number
): Move | undefined => {
  const fills = [...(space.targets.get("FILL") ?? new Map()).keys()];
  if (fills.length > 0 && random() < 0.2) {
    return {
      index: fills[Math.floor(random() * fills.length)] ?? "",
      operation: "FILL",
      value: FILL_WORDS[Math.floor(random() * FILL_WORDS.length)] ?? "",
    };
  }
  const clicks = [...(space.targets.get("CLICK") ?? new Map())].filter(
    ([, candidate]) => !AVOIDED.test(candidate.describe)
  );
  const picked = clicks[Math.floor(random() * clicks.length)];
  return picked === undefined
    ? undefined
    : { index: picked[0], operation: "CLICK", value: "" };
};

const effectLabel = (effect: AgentActionEffect | null | undefined) => {
  if (effect === undefined || effect === null) {
    return "unknown";
  }
  return effect.kind === "none" ? "none" : effect.signals.join("+");
};

const pageRecord = (
  site: string,
  position: number,
  snapshot: AgentBrowserSnapshot,
  space: ActionSpace
) => ({
  elements: space.elements,
  page: space.page,
  position,
  site,
  targets: Object.fromEntries(
    [...space.targets].map(([operation, candidates]) => [
      operation,
      Object.fromEntries(
        [...candidates].map(([index, candidate]) => [index, candidate.describe])
      ),
    ])
  ),
  title: snapshot.title,
  url: snapshot.url,
});

const readSnapshot = (sessionId: AgentSessionId) =>
  sessionTool("agent_browser_snapshot", { format: "structured", sessionId });

const walkSite = (
  site: string,
  ordinal: number,
  options: {
    readonly out: string;
    readonly seed: number;
    readonly steps: number;
  }
) =>
  Effect.gen(function* randomWalk() {
    const fs = yield* FileSystem.FileSystem;
    const tag = `kev-crawl-${ordinal}`;
    const random = randomFrom(options.seed * 7919 + ordinal);
    const started = yield* runTool("agent_run_start", {
      clientName: "kev-crawl",
      inputs: [],
      operationId: OperationId.make(`${tag}-start`),
      referencedSkills: [],
      requestedTask: `Browse ${site} to collect page snapshots.`,
      url: site,
    });
    const sessionId = started.id;
    let snapshot = yield* readSnapshot(sessionId);
    let pages = 0;
    for (let position = 0; position <= options.steps; position += 1) {
      const space = actionSpace(snapshot);
      const move =
        position === options.steps ? undefined : chooseMove(space, random);
      const record = pageRecord(site, position, snapshot, space);
      if (move === undefined) {
        yield* fs.writeFileString(options.out, `${JSON.stringify(record)}\n`, {
          flag: "a",
        });
        pages += 1;
        break;
      }
      const candidate = space.targets.get(move.operation)?.get(move.index);
      if (candidate === undefined) {
        break;
      }
      const acted = yield* sessionTool("agent_browser_act", {
        action: candidate.action(move.value),
        format: "structured",
        operationId: OperationId.make(`${tag}-act-${position}`),
        sessionId,
      }).pipe(Effect.result);
      const effect =
        acted._tag === "Failure"
          ? `failed: ${acted.failure.message}`
          : effectLabel(acted.success.entry.effect);
      yield* fs.writeFileString(
        options.out,
        `${JSON.stringify({ ...record, move: { ...move, effect } })}\n`,
        { flag: "a" }
      );
      pages += 1;
      if (
        acted._tag === "Success" &&
        acted.success.intervention !== undefined &&
        acted.success.intervention !== null
      ) {
        break;
      }
      snapshot =
        acted._tag === "Success" &&
        acted.success.snapshot.settle?.settled !== false
          ? acted.success.snapshot
          : yield* readSnapshot(sessionId);
    }
    yield* runTool("agent_run_complete", {
      operationId: OperationId.make(`${tag}-complete`),
      sessionId,
    }).pipe(Effect.ignore);
    return pages;
  });

const crawl = Effect.gen(function* crawlSites() {
  const fs = yield* FileSystem.FileSystem;
  const sites = (yield* fs.readFileString(
    yield* Config.String("KEV_CRAWL_SITES")
  ))
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter((line) => line !== "");
  const options = {
    out: yield* Config.String("KEV_CRAWL_OUT"),
    seed: yield* Config.Int("KEV_CRAWL_SEED").pipe(Config.withDefault(1)),
    steps: yield* Config.Int("KEV_CRAWL_STEPS").pipe(Config.withDefault(12)),
  };
  for (const [ordinal, site] of sites.entries()) {
    const walked = yield* walkSite(site, ordinal, options).pipe(Effect.result);
    yield* Console.log(
      walked._tag === "Success"
        ? `${site}: ${walked.success} pages`
        : `${site}: failed: ${String(walked.failure)}`
    );
  }
});

const main = Effect.gen(function* withTemporaryCatalog() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "kev-crawl-" });
  yield* crawl.pipe(
    Effect.provide(
      OnboardingToolHandlersLive.pipe(
        Layer.provideMerge(makeDemoSiteLayer()),
        Layer.provideMerge(agentProcessLayer(root))
      )
    )
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(main);
