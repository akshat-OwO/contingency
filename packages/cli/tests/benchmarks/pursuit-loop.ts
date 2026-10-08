/**
 * Delegated sub-goals on real Flow Skills (ADR 0057).
 *
 * A scripted agent hands each Flow Skill step to `agent_browser_pursue` as
 * one sub-goal, the way an agent under `CONTINGENCY_SYSTEM_ONE_FIRST=true` is
 * told to, and moves on only when the Pursuit ends `done`. The outcome is
 * checked in code from the final Page, never taken from System One.
 *
 *   CONTINGENCY_SYSTEM_ONE_URL=https://api.typesafe.ai \
 *   CONTINGENCY_SYSTEM_ONE_API_KEY=… nub packages/cli/tests/benchmarks/pursuit-loop.ts
 *
 * Environment:
 *   CONTINGENCY_SYSTEM_ONE_*  the endpoint, as `contingency mcp` reads it
 *   PURSUIT_BENCHMARK_REPEATS repeats of every scenario (default 1)
 *   JEV_SCENARIOS             "demo" (default), "catalog", or "all", with the
 *                             JEV_SKILL_* variables of jev-fast-loop.ts
 *   PURSUIT_BENCHMARK_LABEL   the results file name (default "pursuit")
 */
import path from "node:path";

import {
  AgentPursuitResult,
  FlowSkillName,
  OperationId,
} from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";

import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import { readFlowSkillFrontmatter } from "../../src/services/flow-skill-package.ts";
import {
  OnboardingToolHandlersLive,
  OnboardingTools,
} from "../../src/services/mcp-onboarding.ts";
import {
  PursuitToolHandlersLive,
  PursuitTools,
} from "../../src/services/mcp-pursuit.ts";
import type { SystemOneResponse } from "../../src/services/system-one-request.ts";
import {
  makeSystemOneLayer,
  SystemOne,
  systemOneConfig,
} from "../../src/services/system-one.ts";
import {
  agentProcessLayer,
  makeCall,
  runTool,
} from "../integration/agent-harness.ts";
import {
  catalogScenario,
  cuesFor,
  DEMO_SCENARIOS,
  elapsedSince,
  now,
  pageText,
  percentile,
} from "./flow-skill-scenarios.ts";
import type { Scenario } from "./flow-skill-scenarios.ts";

const exampleTool = makeCall(OnboardingTools);
const pursueTool = makeCall(PursuitTools, "agent");

/** What System One was asked and how long it took, across one benchmark. */
interface Usage {
  /** Every answer, in order, to explain a step that did not end done. */
  readonly answers: SystemOneResponse["answers"][];
  inputTokens: number;
  outputTokens: number;
  readonly requestMs: number[];
}

/** The configured endpoint, metered so the benchmark can report its cost. */
const meteredSystemOne = (usage: Usage) =>
  Layer.effect(
    SystemOne,
    Effect.gen(function* meterSystemOne() {
      const config = yield* systemOneConfig;
      if (Option.isNone(config)) {
        return yield* Effect.die(
          new Error(
            "Set CONTINGENCY_SYSTEM_ONE_URL to the System One endpoint."
          )
        );
      }
      const inner = yield* Effect.gen(function* configuredSystemOne() {
        return yield* SystemOne;
      }).pipe(Effect.provide(makeSystemOneLayer(config.value)));
      return {
        ask: (request) =>
          Effect.gen(function* askAndMeter() {
            const startedAt = yield* now;
            const response = yield* inner.ask(request);
            usage.requestMs.push(yield* elapsedSince(startedAt));
            usage.answers.push(response.answers);
            usage.inputTokens += response.usage.input_tokens;
            usage.outputTokens += response.usage.output_tokens;
            return response;
          }),
        first: inner.first,
      };
    })
  );

const startScenario = (scenario: Scenario, tag: string, root: string) =>
  Effect.gen(function* startRun() {
    const fs = yield* FileSystem.FileSystem;
    const operationId = OperationId.make(`${tag}-start`);
    if (scenario.skill.kind === "example") {
      const skill = yield* fs.readFileString(
        path.resolve(
          import.meta.dirname,
          "../../examples",
          scenario.skill.example,
          "SKILL.md"
        )
      );
      const started = yield* exampleTool("agent_example_run_start", {
        example: FlowSkillName.make(scenario.skill.example),
        inputs: Object.entries(scenario.inputs).map(([name, value]) => ({
          name,
          value,
        })),
        operationId,
      });
      return {
        flowSkillName: FlowSkillName.make(scenario.skill.example),
        sessionId: started.id,
        skill,
      };
    }
    const skill = yield* fs.readFileString(
      path.join(scenario.skill.directory, "SKILL.md")
    );
    const name = readFlowSkillFrontmatter(skill)?.name;
    if (name === undefined) {
      return yield* Effect.die(
        new Error(`${scenario.skill.directory} has no Flow Skill name.`)
      );
    }
    const flowSkillName = FlowSkillName.make(name);
    const copy = path.join(root, path.basename(scenario.skill.directory));
    if (!(yield* fs.exists(copy))) {
      yield* fs.copy(scenario.skill.directory, copy);
    }
    const started = yield* runTool("agent_run_start", {
      clientName: "pursuit-loop",
      inputs: Object.entries(scenario.inputs).map(([input, value]) => ({
        flowSkillName,
        name: input,
        value,
      })),
      operationId,
      referencedSkills: [flowSkillName],
      requestedTask: `Run the ${name} Flow Skill.`,
      url: scenario.skill.url,
    });
    return { flowSkillName, sessionId: started.id, skill };
  });

const pursueStep = (
  sessionId: AgentSessionId,
  flowSkillName: FlowSkillName,
  cue: { readonly doneWhen: string; readonly instruction: string },
  operationId: string
) =>
  pursueTool("agent_browser_pursue", {
    doneWhen: cue.doneWhen,
    flowSkillName,
    format: "structured",
    goal: cue.instruction,
    operationId: OperationId.make(operationId),
    sessionId,
  }).pipe(
    Effect.flatMap((answer) =>
      Schema.decodeUnknownEffect(AgentPursuitResult)(answer).pipe(Effect.orDie)
    )
  );

const runScenario = (scenario: Scenario, tag: string, root: string) =>
  Effect.gen(function* runFlowSkill() {
    const { flowSkillName, sessionId, skill } = yield* startScenario(
      scenario,
      tag,
      root
    );
    const startedAt = yield* now;
    const steps = [];
    const pages: string[] = [];
    let finalPage = "";
    let failure: string | undefined;
    for (const cue of cuesFor(skill, scenario.inputs)) {
      const stepStartedAt = yield* now;
      const pursued = yield* Effect.result(
        pursueStep(sessionId, flowSkillName, cue, `${tag}-step-${cue.step}`)
      );
      const ms = yield* elapsedSince(stepStartedAt);
      if (pursued._tag === "Failure") {
        failure = `Step ${cue.step} failed: ${pursued.failure.message}`;
        break;
      }
      const result = pursued.success;
      if (result.snapshot !== null) {
        finalPage = pageText(result.snapshot);
        pages.push(finalPage);
      }
      steps.push({
        actions: result.actions.map((action) => ({
          confidence: action.confidence,
          description: action.entry.description,
          effect: action.entry.effect ?? null,
        })),
        ending: result.ending,
        ms,
        reason: result.reason,
        step: cue.step,
      });
      if (result.ending !== "done") {
        failure = `Step ${cue.step} ended ${result.ending}: ${result.reason}`;
        break;
      }
    }
    const totalMs = yield* elapsedSince(startedAt);
    yield* runTool("agent_run_complete", {
      operationId: OperationId.make(`${tag}-complete`),
      sessionId,
    }).pipe(Effect.ignore);
    return {
      actions: steps.reduce((sum, step) => sum + step.actions.length, 0),
      failure,
      inputs: scenario.inputs,
      label: scenario.label,
      steps,
      totalMs,
      verified: failure === undefined && scenario.verify(pages, finalPage),
    };
  });

const benchmark = (root: string, usage: Usage) =>
  Effect.gen(function* benchmarkPursuits() {
    const fs = yield* FileSystem.FileSystem;
    const which = yield* Config.Literals(
      ["all", "catalog", "demo"],
      "JEV_SCENARIOS"
    ).pipe(Config.withDefault("demo"));
    const catalog = which === "demo" ? [] : [yield* catalogScenario];
    const scenarios =
      which === "catalog" ? catalog : [...DEMO_SCENARIOS, ...catalog];
    const repeats = yield* Config.Int("PURSUIT_BENCHMARK_REPEATS").pipe(
      Config.withDefault(1)
    );
    const runs = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const [ordinal, scenario] of scenarios.entries()) {
        const run = yield* runScenario(
          scenario,
          `pursuit-${repeat}-${ordinal}`,
          root
        );
        runs.push({ ...run, repeat });
        const stop = run.failure === undefined ? "" : ` — ${run.failure}`;
        yield* Console.log(
          `${run.verified ? "PASS" : "FAIL"} ${run.label} ${JSON.stringify(run.inputs)}: ${run.totalMs} ms, ${run.steps.length} Pursuits, ${run.actions} actions${stop}`
        );
      }
    }
    const pursuits = runs.flatMap((run) => run.steps);
    const summary = {
      endings: Object.fromEntries(
        ["done", "blocked", "unsure", "paused", "needs-input"].map((ending) => [
          ending,
          pursuits.filter((step) => step.ending === ending).length,
        ])
      ),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      passed: runs.filter((run) => run.verified).length,
      pursuitMs: {
        median: percentile(
          pursuits.map((step) => step.ms),
          0.5
        ),
        p90: percentile(
          pursuits.map((step) => step.ms),
          0.9
        ),
      },
      requestMs: {
        median: percentile(usage.requestMs, 0.5),
        p90: percentile(usage.requestMs, 0.9),
      },
      requests: usage.requestMs.length,
      runMs: {
        median: percentile(
          runs.map((run) => run.totalMs),
          0.5
        ),
      },
      runs: runs.length,
    };
    yield* Console.log(`\n${JSON.stringify(summary, null, 2)}`);
    const directory = path.resolve(
      import.meta.dirname,
      "../../../../.cursor/skills/verify-contingency/artifacts/pursuit-loop"
    );
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = path.join(
      directory,
      `${process.env["PURSUIT_BENCHMARK_LABEL"] ?? "pursuit"}.json`
    );
    yield* fs.writeFileString(
      file,
      JSON.stringify({ answers: usage.answers, runs, summary }, null, 2)
    );
    yield* Console.log(`Wrote ${file}`);
  });

/** Runs and their evidence land in a throwaway Catalog Root. */
const main = Effect.gen(function* withTemporaryCatalog() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pursuit-loop-" });
  const usage: Usage = {
    answers: [],
    inputTokens: 0,
    outputTokens: 0,
    requestMs: [],
  };
  yield* benchmark(root, usage).pipe(
    Effect.provide(
      Layer.mergeAll(
        OnboardingToolHandlersLive,
        PursuitToolHandlersLive.pipe(Layer.provide(meteredSystemOne(usage)))
      ).pipe(
        Layer.provideMerge(makeDemoSiteLayer()),
        Layer.provideMerge(agentProcessLayer(root))
      )
    )
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(main);
