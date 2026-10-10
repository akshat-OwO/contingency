/**
 * Spike: how fast can a System One model drive a Flow Skill?
 *
 * Each cycle reads one Browser Snapshot and asks Jev one request. The request
 * checks the current step's `Done when:` outcome and picks its next operation,
 * target, and per-field input value. It also asks the same of the following
 * step, so a finished step hands straight to the next step's first action
 * without another round trip. Actions go through the MCP tools an external
 * agent calls. Nothing here is product code, and every outcome is checked in
 * code, never taken from Jev.
 *
 *   OPENCODE_API_KEY=… nub packages/cli/benchmarks/jev-fast-loop.ts
 *   TYPESAFE_API_KEY=… JEV_PROVIDER=typesafe nub …/jev-fast-loop.ts
 *   nub …/jev-fast-loop.ts --dry   # prints the first request; no model call
 *
 * Environment:
 *   JEV_BENCHMARK_REPEATS  repeats of every scenario (default 1)
 *   JEV_LOOKAHEAD=0        ask about the current step only
 *   JEV_SCENARIOS          "demo" (default), "catalog", or "all"
 *   JEV_SKILL_DIR          a verified Flow Skill directory, copied into a
 *                          throwaway Catalog Root for the "catalog" scenario
 *   JEV_SKILL_URL          where its Run starts
 *   JEV_SKILL_INPUTS       NAME=value pairs separated by ";"
 *   JEV_SKILL_EXPECT       phrases the final page must show, separated by ";";
 *                          alternatives within one phrase separated by "|"
 *   JEV_PROVIDER=local     a local System One server such as Kev, at JEV_URL
 *                          (default http://127.0.0.1:8009/v1/systemone)
 *   JEV_RECORD             a JSONL file that gets every request and answer,
 *                          with the Run's verified outcome, for training
 */
import path from "node:path";

import { FlowSkillName, OperationId } from "@contingency/protocol";
import type {
  AgentActionEffect,
  AgentBrowserSnapshot,
  AgentSessionId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Layer, Option } from "effect";
import type { Redacted } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { makeDemoSiteLayer } from "../src/services/demo-site-server.ts";
import { readFlowSkillFrontmatter } from "../src/services/flow-skill-package.ts";
import {
  OnboardingToolHandlersLive,
  OnboardingTools,
} from "../src/services/mcp-onboarding.ts";
import {
  actionSpace,
  buildRequest,
  NEXT,
  SystemOneResponseSchema,
  targetKey,
  valueKey,
} from "../src/services/system-one-request.ts";
import type {
  ActionSpace,
  Candidate,
  ChoiceAnswer,
  Cue,
  Operation,
  SystemOneRequest,
  SystemOneResponse,
} from "../src/services/system-one-request.ts";
import {
  agentProcessLayer,
  makeCall,
  runTool,
  sessionTool,
} from "../tests/integration/agent-harness.ts";
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

const PROVIDERS = {
  local: {
    keyVariable: undefined,
    model: "kev-latest",
    url: "http://127.0.0.1:8009/v1/systemone",
  },
  typesafe: {
    keyVariable: "TYPESAFE_API_KEY",
    model: "jev-latest",
    url: "https://api.typesafe.ai/v1/systemone",
  },
  zen: {
    keyVariable: "OPENCODE_API_KEY",
    model: "jev-1.13-free",
    url: "https://opencode.ai/zen/v1/systemone",
  },
} as const;

const MAX_CYCLES_PER_STEP = 6;
const DONE_THRESHOLD = 0.5;
/**
 * A step with no action yet is usually not finished: a literal reading of its
 * `Done when:` can hold before the step's work is done (a search box that is
 * visible before its city is chosen). Such a step needs stronger evidence.
 */
const UNACTED_DONE_THRESHOLD = Number(
  process.env["JEV_UNACTED_DONE_THRESHOLD"] ?? "0.9"
);
const RECORDED_PAGE_LINES = 40;

const choiceOf = (
  response: SystemOneResponse,
  key: string
): ChoiceAnswer | undefined => {
  const answer = response.answers[key];
  return answer?.type === "choice" ? answer : undefined;
};

const noulOf = (response: SystemOneResponse, key: string): number => {
  const answer = response.answers[key];
  return answer?.type === "noul" ? answer.noul : 0;
};

interface Provider {
  readonly key: Option.Option<Redacted.Redacted<string>>;
  readonly url: string;
}

const askJev = (provider: Provider, body: SystemOneRequest) =>
  Effect.gen(function* askSystemOne() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(provider.url).pipe(
        (request) =>
          Option.match(provider.key, {
            onNone: () => request,
            onSome: (key) => HttpClientRequest.bearerToken(request, key),
          }),
        HttpClientRequest.bodyJsonUnsafe(body)
      )
    );
    if (response.status < 200 || response.status >= 300) {
      const detail = yield* response.text;
      return yield* Effect.fail(
        new Error(
          `Jev answered HTTP ${response.status}: ${detail.slice(0, 600)}`
        )
      );
    }
    return yield* HttpClientResponse.schemaBodyJson(SystemOneResponseSchema)(
      response
    );
  });

// ---------------------------------------------------------------------------
// The loop

interface Cycle {
  readonly actMs?: number;
  readonly decision: string;
  readonly done: number;
  readonly effect?: string;
  readonly elements: number;
  readonly error?: string;
  readonly inputTokens: number;
  readonly jevMs: number;
  /** This action came from the request that finished the previous step. */
  readonly lookahead?: boolean;
  readonly operation: string | undefined;
  readonly operationConfidence: number | undefined;
  /** The page Jev judged, kept wherever a step ended or the Run stopped. */
  readonly page?: readonly string[];
  readonly questions: number;
  readonly requestBytes: number;
  readonly step: number;
  readonly targetConfidence?: number | undefined;
  readonly valueConfidence?: number | undefined;
}

/** One request and its answer, kept for training data. */
interface Exchange {
  readonly request: SystemOneRequest;
  readonly response: SystemOneResponse;
  readonly step: number;
}

type Stop = "blocked" | "error" | "exhausted" | "intervention";

interface RunContext {
  actions: number;
  readonly cycles: Cycle[];
  readonly exchanges: Exchange[];
  readonly lookahead: boolean;
  readonly model: string;
  readonly pages: string[];
  readonly provider: Provider;
  readonly recent: string[];
  readonly sessionId: AgentSessionId;
  snapshot: AgentBrowserSnapshot;
  readonly tag: string;
}

/** What one request decided for one step. */
type Decision =
  | {
      readonly candidate: Candidate;
      readonly kind: "act";
      readonly operation: Operation;
      readonly target: ChoiceAnswer;
      readonly value: ChoiceAnswer | undefined;
    }
  | { readonly kind: "blocked"; readonly reason: string };

const effectLabel = (effect: AgentActionEffect | null | undefined) => {
  if (effect === undefined || effect === null) {
    return "unknown";
  }
  return effect.kind === "none" ? "none" : effect.signals.join("+");
};

const readSnapshot = (sessionId: AgentSessionId) =>
  sessionTool("agent_browser_snapshot", { format: "structured", sessionId });

const chosenOperation = (
  answer: ChoiceAnswer | undefined
): Operation | undefined =>
  answer?.choice === "CLICK" ||
  answer?.choice === "FILL" ||
  answer?.choice === "SELECT"
    ? answer.choice
    : undefined;

const decide = (
  response: SystemOneResponse,
  prefix: string,
  space: ActionSpace
): Decision => {
  const answer = choiceOf(response, `${prefix}operation`);
  const operation = chosenOperation(answer);
  if (operation === undefined) {
    return {
      kind: "blocked",
      reason: `Jev chose ${answer?.choice ?? "nothing"}.`,
    };
  }
  const target = choiceOf(response, `${prefix}${targetKey(operation)}`);
  const candidate =
    target === undefined
      ? undefined
      : space.targets.get(operation)?.get(target.choice);
  if (target === undefined || candidate === undefined) {
    return { kind: "blocked", reason: `Jev named no ${operation} target.` };
  }
  return {
    candidate,
    kind: "act",
    operation,
    target,
    value: choiceOf(response, `${prefix}${valueKey(target.choice)}`),
  };
};

const act = (
  context: RunContext,
  cue: Cue,
  record: Omit<Cycle, "decision">,
  decision: Extract<Decision, { kind: "act" }>
) =>
  Effect.gen(function* performChosenAction() {
    context.actions += 1;
    const value =
      decision.value === undefined
        ? ""
        : (cue.inputs[decision.value.choice] ?? "");
    const valueNote = decision.operation === "CLICK" ? "" : ` ← "${value}"`;
    const described = `${decision.operation} ${decision.candidate.describe}${valueNote}`;
    const actedAt = yield* now;
    const acted = yield* sessionTool("agent_browser_act", {
      action: decision.candidate.action(value),
      format: "structured",
      operationId: OperationId.make(`${context.tag}-act-${context.actions}`),
      sessionId: context.sessionId,
    }).pipe(Effect.result);
    const actMs = yield* elapsedSince(actedAt);
    const base = {
      ...record,
      actMs,
      decision: described,
      targetConfidence: decision.target.confidence,
      valueConfidence:
        decision.operation === "CLICK" ? undefined : decision.value?.confidence,
    };
    if (acted._tag === "Failure") {
      context.cycles.push({ ...base, error: acted.failure.message });
      context.recent.push(`${described} → failed: ${acted.failure.message}`);
      context.snapshot = yield* readSnapshot(context.sessionId);
      return null;
    }
    const result = acted.success;
    context.cycles.push({ ...base, effect: effectLabel(result.entry.effect) });
    if (result.intervention !== undefined && result.intervention !== null) {
      return result.intervention.reason;
    }
    context.recent.push(
      `${described} → effect: ${effectLabel(result.entry.effect)}`
    );
    context.snapshot =
      result.snapshot.settle?.settled === false
        ? yield* readSnapshot(context.sessionId)
        : result.snapshot;
    context.pages.push(pageText(context.snapshot));
    return null;
  });

interface StepState {
  /** Whether the current step has taken an action. */
  acted: boolean;
  /** Index of the step the loop is working on. */
  at: number;
  /** Whether a BLOCKED answer already earned one fresh read of the page. */
  reread: boolean;
  /** Requests spent on that step so far. */
  spent: number;
}

/**
 * One request and, unless the step is done, one action. With lookahead, a
 * finished step acts on the next step's answers from the same request.
 */
const runCycle = (
  context: RunContext,
  cues: readonly Cue[],
  state: StepState
) =>
  Effect.gen(function* decideAndAct() {
    const current = cues[state.at];
    if (current === undefined) {
      return null;
    }
    const next = context.lookahead ? cues[state.at + 1] : undefined;
    const space = actionSpace(context.snapshot);
    const body = buildRequest(
      context.model,
      { current, next },
      space,
      context.snapshot,
      context.recent
    );
    const askedAt = yield* now;
    const answered = yield* askJev(context.provider, body).pipe(Effect.result);
    const jevMs = yield* elapsedSince(askedAt);
    if (answered._tag === "Failure") {
      return {
        failure: String(answered.failure),
        stop: "error",
      } satisfies StopReason;
    }
    const response = answered.success;
    context.exchanges.push({ request: body, response, step: current.step });
    const done = noulOf(response, "done");
    const record = {
      done: Number(done.toFixed(3)),
      elements: space.elements.length,
      inputTokens: response.usage.input_tokens,
      jevMs,
      operation: choiceOf(response, "operation")?.choice,
      operationConfidence: choiceOf(response, "operation")?.confidence,
      questions: Object.keys(body.questions).length,
      requestBytes: JSON.stringify(body).length,
      step: current.step,
    };
    state.spent += 1;
    let cue = current;
    let prefix = "";
    if (done >= (state.acted ? DONE_THRESHOLD : UNACTED_DONE_THRESHOLD)) {
      context.cycles.push({
        ...record,
        decision: "step done",
        page: space.page.slice(0, RECORDED_PAGE_LINES),
      });
      state.at += 1;
      state.acted = false;
      state.reread = false;
      state.spent = 0;
      // Without an answer for the next step, or when it is already done,
      // the next request reads the page afresh.
      if (
        next === undefined ||
        noulOf(response, `${NEXT}done`) >= UNACTED_DONE_THRESHOLD
      ) {
        return null;
      }
      cue = next;
      prefix = NEXT;
      state.spent = 1;
    }
    const decision = decide(response, prefix, space);
    if (decision.kind === "blocked") {
      context.cycles.push({
        ...record,
        decision: state.reread ? "blocked" : "blocked: reread the page",
        page: space.page.slice(0, RECORDED_PAGE_LINES),
        step: cue.step,
      });
      // A Page still loading or animating reads as a dead end. Read it once
      // more, as an agent would, before handing back.
      if (!state.reread) {
        state.reread = true;
        context.snapshot = yield* readSnapshot(context.sessionId);
        context.pages.push(pageText(context.snapshot));
        return null;
      }
      return {
        failure: `Step ${cue.step}: ${decision.reason}`,
        stop: "blocked",
      } satisfies StopReason;
    }
    const intervention = yield* act(
      context,
      cue,
      { ...record, lookahead: prefix === NEXT, step: cue.step },
      decision
    );
    if (intervention !== null) {
      return {
        failure: intervention,
        stop: "intervention",
      } satisfies StopReason;
    }
    state.acted = true;
    state.reread = false;
    return null;
  });

interface StopReason {
  readonly failure: string;
  readonly stop: Stop;
}

const runSteps = (context: RunContext, cues: readonly Cue[]) =>
  Effect.gen(function* driveSteps() {
    const state: StepState = { acted: false, at: 0, reread: false, spent: 0 };
    while (state.at < cues.length) {
      if (state.spent >= MAX_CYCLES_PER_STEP) {
        return {
          failure: `Step ${state.at + 1} did not reach its outcome within ${MAX_CYCLES_PER_STEP} requests.`,
          stop: "exhausted",
        } satisfies StopReason;
      }
      const stopped: StopReason | null = yield* runCycle(context, cues, state);
      if (stopped !== null) {
        return stopped;
      }
    }
    return null;
  });

const exampleTool = makeCall(OnboardingTools);

/** Start the scenario's Run and read its Flow Skill. */
const startScenario = (scenario: Scenario, tag: string, root: string) =>
  Effect.gen(function* startRun() {
    const fs = yield* FileSystem.FileSystem;
    const operationId = OperationId.make(`${tag}-start`);
    if (scenario.skill.kind === "example") {
      const skill = yield* fs.readFileString(
        path.resolve(
          import.meta.dirname,
          "../examples",
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
      return { sessionId: started.id, skill };
    }
    const skill = yield* fs.readFileString(
      path.join(scenario.skill.directory, "SKILL.md")
    );
    const name = readFlowSkillFrontmatter(skill)?.name;
    if (name === undefined) {
      return yield* Effect.fail(
        new Error(`${scenario.skill.directory} has no Flow Skill name.`)
      );
    }
    const flowSkillName = FlowSkillName.make(name);
    const copy = path.join(root, path.basename(scenario.skill.directory));
    if (!(yield* fs.exists(copy))) {
      yield* fs.copy(scenario.skill.directory, copy);
    }
    const started = yield* runTool("agent_run_start", {
      clientName: "jev-fast-loop",
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
    return { sessionId: started.id, skill };
  });

const runScenario = (
  scenario: Scenario,
  tag: string,
  root: string,
  options: {
    readonly lookahead: boolean;
    readonly model: string;
    readonly provider: Provider;
  }
) =>
  Effect.gen(function* runFlowSkill() {
    const { sessionId, skill } = yield* startScenario(scenario, tag, root);
    const startedAt = yield* now;
    const snapshot = yield* readSnapshot(sessionId);
    const context: RunContext = {
      actions: 0,
      cycles: [],
      exchanges: [],
      lookahead: options.lookahead,
      model: options.model,
      pages: [pageText(snapshot)],
      provider: options.provider,
      recent: [],
      sessionId,
      snapshot,
      tag,
    };
    const stopped = yield* runSteps(context, cuesFor(skill, scenario.inputs));
    const totalMs = yield* elapsedSince(startedAt);
    yield* runTool("agent_run_complete", {
      operationId: OperationId.make(`${tag}-complete`),
      sessionId,
    }).pipe(Effect.ignore);
    // A lookahead action shares its request with the step-done record.
    const requests = context.cycles.filter((cycle) => cycle.lookahead !== true);
    const jevTimes = requests.map((cycle) => cycle.jevMs);
    const actTimes = context.cycles.flatMap((cycle) =>
      cycle.actMs === undefined ? [] : [cycle.actMs]
    );
    return {
      actions: context.actions,
      cycles: context.cycles,
      decisions: context.cycles.length,
      exchanges: context.exchanges,
      failure: stopped?.failure,
      finalPage: actionSpace(context.snapshot).page.slice(
        0,
        RECORDED_PAGE_LINES
      ),
      inputTokens: requests.reduce((sum, cycle) => sum + cycle.inputTokens, 0),
      inputs: scenario.inputs,
      label: scenario.label,
      medianActMs: percentile(actTimes, 0.5),
      medianJevMs: percentile(jevTimes, 0.5),
      outcome: stopped?.stop ?? "done",
      p90JevMs: percentile(jevTimes, 0.9),
      requests: requests.length,
      totalMs,
      verified:
        stopped === null &&
        scenario.verify(context.pages, pageText(context.snapshot)),
    };
  });

/** Print the first request without calling Jev, to check its shape and size. */
const dryRun = (scenario: Scenario, root: string, model: string) =>
  Effect.gen(function* printFirstRequest() {
    const { sessionId, skill } = yield* startScenario(
      scenario,
      "jev-dry",
      root
    );
    const snapshot = yield* readSnapshot(sessionId);
    const space = actionSpace(snapshot);
    const [current, next] = cuesFor(skill, scenario.inputs);
    if (current === undefined) {
      return;
    }
    const body = buildRequest(model, { current, next }, space, snapshot, []);
    const bytes = JSON.stringify(body).length;
    yield* Console.log(JSON.stringify(body, null, 2));
    yield* Console.log(
      `\nRequest: ${bytes} bytes (~${Math.round(bytes / 4)} tokens), ${Object.keys(body.questions).length} questions, ${space.elements.length} elements, ${snapshot.nodes.length} snapshot nodes.`
    );
  });

const scenariosFor = (which: "all" | "catalog" | "demo") =>
  Effect.gen(function* chooseScenarios() {
    if (which === "demo") {
      return DEMO_SCENARIOS;
    }
    const catalog = yield* catalogScenario;
    return which === "catalog" ? [catalog] : [...DEMO_SCENARIOS, catalog];
  });

const benchmark = (root: string) =>
  Effect.gen(function* benchmarkJevFastLoop() {
    const fs = yield* FileSystem.FileSystem;
    const providerName = yield* Config.Literals(
      ["local", "typesafe", "zen"],
      "JEV_PROVIDER"
    ).pipe(
      Config.withDefault(
        process.env["OPENCODE_API_KEY"] === undefined ? "typesafe" : "zen"
      )
    );
    const settings = PROVIDERS[providerName];
    const model = yield* Config.String("JEV_MODEL").pipe(
      Config.withDefault(settings.model)
    );
    const scenarios = yield* scenariosFor(
      yield* Config.Literals(["all", "catalog", "demo"], "JEV_SCENARIOS").pipe(
        Config.withDefault("demo")
      )
    );
    const [first] = scenarios;
    if (process.argv.includes("--dry")) {
      if (first !== undefined) {
        yield* dryRun(first, root, model);
      }
      return;
    }
    const key =
      settings.keyVariable === undefined
        ? Option.none()
        : yield* Config.option(Config.Redacted(settings.keyVariable));
    if (settings.keyVariable !== undefined && Option.isNone(key)) {
      return yield* Effect.fail(
        new Error(
          `Set ${settings.keyVariable}, or pass --dry to print a request without calling Jev.`
        )
      );
    }
    const options = {
      lookahead:
        (yield* Config.String("JEV_LOOKAHEAD").pipe(
          Config.withDefault("1")
        )) !== "0",
      model,
      provider: {
        key,
        url: yield* Config.String("JEV_URL").pipe(
          Config.withDefault(settings.url)
        ),
      },
    };
    const repeats = yield* Config.Int("JEV_BENCHMARK_REPEATS").pipe(
      Config.withDefault(1)
    );
    const record = yield* Config.option(Config.String("JEV_RECORD"));
    const runs = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const [ordinal, scenario] of scenarios.entries()) {
        const run = yield* runScenario(
          scenario,
          `jev-${repeat}-${ordinal}`,
          root,
          options
        );
        const { exchanges, ...measured } = run;
        runs.push({ ...measured, repeat });
        if (Option.isSome(record)) {
          const lines = exchanges.map((exchange) =>
            JSON.stringify({
              ...exchange,
              inputs: run.inputs,
              label: run.label,
              outcome: run.outcome,
              verified: run.verified,
            })
          );
          yield* fs.writeFileString(record.value, `${lines.join("\n")}\n`, {
            flag: "a",
          });
        }
        const stop =
          run.failure === undefined ? "" : ` — ${run.outcome}: ${run.failure}`;
        yield* Console.log(
          `${run.verified ? "PASS" : "FAIL"} ${run.label} ${JSON.stringify(run.inputs)}: ${run.totalMs} ms, ${run.requests} requests, ${run.actions} actions, Jev median ${run.medianJevMs} ms (p90 ${run.p90JevMs}), act median ${run.medianActMs} ms, ${run.inputTokens} input tokens${stop}`
        );
      }
    }
    const allJev = runs.flatMap((run) =>
      run.cycles.flatMap((cycle) =>
        cycle.lookahead === true ? [] : [cycle.jevMs]
      )
    );
    const allAct = runs.flatMap((run) =>
      run.cycles.flatMap((cycle) =>
        cycle.actMs === undefined ? [] : [cycle.actMs]
      )
    );
    const summary = {
      actMs: { median: percentile(allAct, 0.5), p90: percentile(allAct, 0.9) },
      inputTokens: runs.reduce((sum, run) => sum + run.inputTokens, 0),
      jevMs: { median: percentile(allJev, 0.5), p90: percentile(allJev, 0.9) },
      lookahead: options.lookahead,
      model,
      passed: runs.filter((run) => run.verified).length,
      provider: providerName,
      requests: runs.reduce((sum, run) => sum + run.requests, 0),
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
      "../../../.cursor/skills/verify-contingency/artifacts/jev-fast-loop"
    );
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = path.join(
      directory,
      `${process.env["JEV_BENCHMARK_LABEL"] ?? providerName}.json`
    );
    yield* fs.writeFileString(file, JSON.stringify({ runs, summary }, null, 2));
    yield* Console.log(`Wrote ${file}`);
  });

/** Runs and their evidence land in a throwaway Catalog Root. */
const main = Effect.gen(function* withTemporaryCatalog() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "jev-fast-loop-" });
  yield* benchmark(root).pipe(
    Effect.provide(
      Layer.mergeAll(
        OnboardingToolHandlersLive.pipe(
          Layer.provideMerge(makeDemoSiteLayer()),
          Layer.provideMerge(agentProcessLayer(root))
        ),
        FetchHttpClient.layer
      )
    )
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(main);
