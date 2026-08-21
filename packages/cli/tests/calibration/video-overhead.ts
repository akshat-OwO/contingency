/**
 * The video-overhead calibration experiment (#25).
 *
 * Video capture adds overhead to the machine being measured, and because Core
 * Web Vitals are collected unthrottled (ADR 0008) that overhead lands directly
 * in the reported numbers rather than being absorbed by a device model. This
 * experiment measures how much, by running the same Flow against the same
 * unchanging local page with capture on and with capture off.
 *
 * It answers one design question: must capture be stopped and restarted
 * around each measured navigation — a segmented recording with gaps — or can
 * it run continuously for a whole Run? It also bounds what a later Baseline
 * comparison has to account for when one side of it was recorded and the
 * other was not.
 *
 * Not a test, and never one. An experiment informs a decision; it does not
 * gate CI (ADR 0010). This file is not named `*.test.ts`, so neither vitest
 * configuration picks it up. Run it by hand from `packages/cli`:
 *
 *   nub tests/calibration/video-overhead.ts [pairs]
 *
 * `pairs` defaults to 10, meaning ten Runs per condition, and a full
 * experiment takes a few minutes. The procedure:
 *
 * 1. Serve the calibration page from a local server. The page is fixed: a
 *    hero image the server answers after 120ms — so LCP lands mid-load, the
 *    way a real hero image does — and a button whose click handler blocks the
 *    main thread for 120ms, so INP is well above its 16ms reporting floor.
 * 2. Discard one Run of each condition. The first Runs pay one-time costs —
 *    browser install, daemon start, cold page cache — that no later Run pays.
 * 3. Interleave the two conditions in pairs, alternating which condition of
 *    the pair goes first. A machine that warms, cools, or busies itself over
 *    the experiment then does so to both conditions equally.
 * 4. A Run counts for its condition only if it completed, the hero image was
 *    actually fetched (a warm-cache Run measured a different page
 *    experience), and — for the video condition — the recording really was
 *    written. A video Run that silently produced no file would measure
 *    exactly nothing while claiming to measure the cost of recording.
 * 5. Report medians and spread for LCP and INP, both conditions, and write
 *    every Run's numbers to `results.json` beside this file.
 *
 * Every Run goes through the real Runner against the real bundled browser —
 * the same `IntegrationLive` layer the integration tests use — because the
 * number that matters is what `--video` costs a real Run, not what it costs a
 * mock.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { Flow, Run, RunVideoManifest } from "@contingency/protocol";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Data, Duration, Effect, FileSystem } from "effect";

import {
  canRecordVideo,
  IntegrationLive,
  runFlow,
} from "../integration/harness";

/** How many interleaved pairs to run when the caller does not say. */
const DEFAULT_PAIRS = 10;

/** The most pairs one experiment is allowed to ask for. */
const MAXIMUM_PAIRS = 50;

/**
 * The server-side delay before the page's hero image is answered. Server-side
 * on purpose: both conditions wait for it identically, so only what the
 * browser does while waiting — which is where recording contends — differs.
 */
const HERO_DELAY_MS = 120;

/** A breath between Runs, so one Run's teardown cannot bleed into the next. */
const BETWEEN_RUNS = Duration.millis(250);

/** Ceiling for one Run. Generous, because a failed Run is a lost sample. */
const RUN_CEILING = Duration.seconds(90);

class CalibrationError extends Data.TaggedError("CalibrationError")<{
  readonly message: string;
}> {}

/**
 * The bytes served as the page's hero image: a 1×1 PNG the page's layout
 * stretches to 1100×500. The delay is what makes it the LCP element; the
 * bytes are not what is being calibrated, and a real photograph would add
 * decode time that drowns the effect being measured rather than representing
 * it.
 */
const HERO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAACJVRQfAAAACklEQVR4nGNoAAAAggCBEjHWNAAAAABJRU5ExHyK4Q==",
  "base64"
);

interface CalibrationServer {
  /** Every path the page asked for, in order. */
  readonly requests: readonly string[];
  readonly url: (page: string) => string;
}

/**
 * Serve the calibration page for the whole experiment, on a port the
 * operating system picks.
 *
 * Real HTTP rather than `file://`, for the same reasons as the integration
 * suite: no navigation timing worth reading from a `file://` document.
 */
const calibrationServer = Effect.gen(function* serveCalibrationPage() {
  const fileSystem = yield* FileSystem.FileSystem;
  const page = yield* fileSystem.readFileString(
    path.join(import.meta.dirname, "fixtures", "calibration.html")
  );

  const requests: string[] = [];

  const server = yield* Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const created = createServer((request, response) => {
        const url = request.url ?? "/";
        requests.push(url);
        if (url === "/calibration.html") {
          response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(page);
          return;
        }
        if (url === "/hero.png") {
          setTimeout(() => {
            response
              .writeHead(200, { "content-type": "image/png" })
              .end(HERO_PNG);
          }, HERO_DELAY_MS);
          return;
        }
        response.writeHead(404).end();
      });
      created.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed(created));
      });
    }),
    (created) =>
      Effect.callback<null>((resume) => {
        // Connections first: `close` waits for open requests, and this server
        // deliberately leaves one in flight for 120ms.
        created.closeAllConnections();
        created.close(() => {
          resume(Effect.succeed(null));
        });
      })
  );

  const { port } = server.address() as AddressInfo;
  return {
    requests,
    url: (target: string) => `http://127.0.0.1:${port}/${target}`,
  } satisfies CalibrationServer;
});

/**
 * The Flow every Run executes: navigate to the calibration page with the
 * performance toggle set, then click the blocking button once, so the page
 * has exactly one interaction to report as INP.
 *
 * The identity is stable across experiments, so every Run files into the same
 * history if anyone ever points Runs at a durable output directory.
 */
const calibrationFlow = (url: string): Flow => ({
  contingency: { flowId: "video-overhead-calibration" },
  steps: [
    {
      contingency: { id: "open", performance: true },
      type: "navigate",
      url,
    },
    {
      contingency: { id: "block" },
      offsetX: 1,
      offsetY: 1,
      selectors: [["#block"]],
      type: "click",
    },
  ],
  title: "Video overhead calibration",
});

type Condition = "video" | "plain";

type Metric = "cls" | "fcp" | "inp" | "lcp" | "ttfb";

interface Sample {
  readonly condition: Condition;
  /** Why this Run does not count, when it does not. */
  readonly excluded?: string;
  readonly loadAverage: number;
  readonly order: number;
  readonly pair: number;
  readonly runId?: string;
  /** Wall-clock duration of the Run, from the Run's own timestamps. */
  readonly durationMs?: number;
  readonly cls?: number;
  readonly fcp?: number;
  readonly inp?: number;
  readonly lcp?: number;
  readonly ttfb?: number;
  /** Size of this Run's recording, video condition only. */
  readonly videoBytes?: number;
}

const runOnce = Effect.fn("calibration.runOnce")(function* runOnce(
  server: CalibrationServer,
  condition: Condition,
  order: number,
  pair: number
) {
  const requestedBefore = server.requests.length;

  // One scope per Run: the Run's output directory is temporary, and is gone
  // the moment this closes, so everything read out of it — the video manifest
  // and the recording's size — is read inside.
  const observed = yield* Effect.gen(function* observeOneRun() {
    const fileSystem = yield* FileSystem.FileSystem;
    const { directory, run } = yield* runFlow(
      calibrationFlow(server.url("calibration.html")),
      { retry: 0, timeout: RUN_CEILING, video: condition === "video" }
    );

    // The Flow toggles exactly one Step, and the Run attaches vitals to it
    // when the attempt ends; anything else is a bug somewhere else.
    const vitals = run.steps.find((step) => step.vitals !== undefined)?.vitals;

    let videoBytes: number | undefined;
    let videoFailure: string | undefined;
    if (condition === "video") {
      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(directory, "video.json"))
      ) as RunVideoManifest;
      const segment = manifest.segments.at(0);
      if (segment === undefined) {
        videoFailure = "the video manifest records no attempt at all";
      } else if (segment.recorded) {
        // Only a segment the manifest says was recorded has a file to size. A
        // capture that failed is described rather than written, so measuring
        // it first would abort the experiment on the very outcome the
        // manifest exists to report.
        videoBytes = Number(
          (yield* fileSystem.stat(path.join(directory, segment.file))).size
        );
        if (videoBytes === 0) {
          videoFailure = "the recording was written empty";
        }
      } else {
        videoFailure = segment.error ?? "the recorder reported no recording";
      }
    }

    return {
      environment: run.environment,
      run,
      videoBytes,
      videoFailure,
      vitals,
    };
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive));

  // Whether the page really fetched the hero image. A session that answered
  // it from cache measured a different page load than every other Run, and
  // the experiment's premise — identical page, identical wait — would not
  // hold for it.
  const heroFetched = server.requests
    .slice(requestedBefore)
    .includes("/hero.png");

  let excluded: string | undefined;
  if (observed.run.outcome !== "completed") {
    excluded = `the Run did not complete: ${
      observed.run.failure?.message ?? "no failure was recorded"
    }`;
  } else if (observed.videoFailure !== undefined) {
    excluded = `video was requested but cannot be counted on: ${observed.videoFailure}`;
  } else if (!heroFetched) {
    excluded =
      "the hero image was never requested, so this Run measured a warm cache rather than the page";
  }

  const { environment, run, videoBytes, vitals } = observed;
  const sample = {
    condition,
    ...(excluded === undefined ? {} : { excluded }),
    loadAverage: environment.loadAverage,
    order,
    pair,
    ...(run.runId === undefined ? {} : { runId: run.runId }),
    ...(Number.isNaN(Date.parse(run.startedAt))
      ? {}
      : {
          durationMs: Math.max(
            0,
            Date.parse(run.finishedAt) - Date.parse(run.startedAt)
          ),
        }),
    ...(vitals === undefined ? {} : { cls: vitals.cls }),
    ...(vitals?.fcp === undefined ? {} : { fcp: vitals.fcp }),
    ...(vitals?.inp === undefined ? {} : { inp: vitals.inp }),
    ...(vitals?.lcp === undefined ? {} : { lcp: vitals.lcp }),
    ...(vitals?.ttfb === undefined ? {} : { ttfb: vitals.ttfb }),
    ...(videoBytes === undefined ? {} : { videoBytes }),
  } satisfies Sample;

  return { environment, sample };
});

/**
 * The q-th quantile of already-sorted values, by linear interpolation. With
 * ten Runs a percentile is not pretending to be statistics; it is a robust
 * middle and a robust spread, which is what the ticket asks for.
 */
const quantile = (sorted: readonly number[], q: number): number => {
  const position = (sorted.length - 1) * q;
  const lower = sorted[Math.floor(position)] ?? 0;
  const upper = sorted[Math.ceil(position)] ?? 0;
  return lower + (upper - lower) * (position - Math.floor(position));
};

interface MetricStats {
  readonly n: number;
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly min: number;
  readonly max: number;
}

/**
 * The pairs where both conditions reported this metric.
 *
 * Missingness is not evenly spread: an uncaptured Run often reports no paint
 * at all, while a captured Run always does, because a capture forces the
 * browser to produce frames. Taking whatever each condition happened to report
 * would subtract the median of ten captured Runs from the median of the three
 * uncaptured ones that painted — two different populations, and a difference
 * that says more about which Runs survived than about what capture costs.
 */
const matchedPairs = (
  samples: readonly Sample[],
  metric: Metric
): readonly { readonly plain: number; readonly video: number }[] => {
  const byPair = new Map<number, Partial<Record<Condition, number>>>();
  for (const sample of samples) {
    if (sample.excluded !== undefined || sample.pair === 0) {
      continue;
    }
    const value = sample[metric];
    if (value === undefined) {
      continue;
    }
    const entry = byPair.get(sample.pair) ?? {};
    entry[sample.condition] = value;
    byPair.set(sample.pair, entry);
  }
  return [...byPair.values()].flatMap((entry) =>
    entry.plain === undefined || entry.video === undefined
      ? []
      : [{ plain: entry.plain, video: entry.video }]
  );
};

const metricStats = (
  pairs: readonly { readonly plain: number; readonly video: number }[],
  condition: Condition
): MetricStats | undefined => {
  const values = pairs
    .map((pair) => pair[condition])
    .toSorted((left, right) => left - right);
  if (values.length === 0) {
    return undefined;
  }
  return {
    max: quantile(values, 1),
    median: quantile(values, 0.5),
    min: quantile(values, 0),
    n: values.length,
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
  };
};

const milliseconds = (value: number): string =>
  `${Math.round(value * 10) / 10} ms`;

/** The headline of the experiment: the two metrics the decision turns on. */
const reportMetric = (
  samples: readonly Sample[],
  metric: "lcp" | "inp"
): Effect.Effect<void> => {
  const pairs = matchedPairs(samples, metric);
  const video = metricStats(pairs, "video");
  const plain = metricStats(pairs, "plain");
  const label = metric === "lcp" ? "LCP" : "INP";
  const reported = samples.filter(
    (sample) => sample.excluded === undefined && sample[metric] !== undefined
  ).length;

  const line = (name: Condition, stats: MetricStats | undefined): string => {
    if (stats === undefined) {
      return `  ${name.padEnd(5)} no pair reported ${label} in both conditions`;
    }
    return `  ${name.padEnd(5)} n=${String(stats.n).padEnd(2)} median ${milliseconds(
      stats.median
    ).padEnd(9)} IQR ${milliseconds(stats.p25)}–${milliseconds(
      stats.p75
    )}  min ${milliseconds(stats.min)}  max ${milliseconds(stats.max)}`;
  };

  return Effect.gen(function* report() {
    yield* Console.log(
      `${label} (ms) — ${pairs.length} matched pair${pairs.length === 1 ? "" : "s"}, from ${reported} Runs that reported it`
    );
    yield* Console.log(line("video", video));
    yield* Console.log(line("plain", plain));
    // The effect estimate is the median of the per-pair differences, not the
    // difference of the two medians. A paired design is discarded by the
    // second: the median of the differences and the difference of the medians
    // are not the same number, and on these samples they disagree by a third.
    const deltas = pairs
      .map((pair) => pair.video - pair.plain)
      .toSorted((left, right) => left - right);
    if (deltas.length > 0 && plain !== undefined) {
      const median = quantile(deltas, 0.5);
      const percent =
        plain.median === 0
          ? ""
          : ` (${Math.round((median / plain.median) * 100)}%)`;
      yield* Console.log(
        `  per-pair difference: median ${median >= 0 ? "+" : ""}${milliseconds(
          median
        )}${percent}  IQR ${milliseconds(quantile(deltas, 0.25))}–${milliseconds(
          quantile(deltas, 0.75)
        )}`
      );
    }
    yield* Console.log("");
  });
};

interface Results {
  readonly conditions: Readonly<
    Record<Condition, Readonly<Record<Metric, MetricStats | undefined>>>
  >;
  readonly environment: Run["environment"] | undefined;
  readonly generatedAt: string;
  readonly pairs: number;
  readonly samples: readonly Sample[];
}

const summarize = Effect.fn("calibration.summarize")(function* summarize(
  samples: readonly Sample[],
  pairs: number,
  environment: Run["environment"] | undefined
) {
  yield* Console.log("");
  yield* reportMetric(samples, "lcp");
  yield* reportMetric(samples, "inp");

  const excluded = samples.filter((sample) => sample.excluded !== undefined);
  if (excluded.length > 0) {
    yield* Console.log("Excluded Runs:");
    for (const sample of excluded) {
      yield* Console.log(
        `  #${sample.order} (${sample.condition}): ${sample.excluded}`
      );
    }
    yield* Console.log("");
  }

  // The per-Run table, because a median of ten can hide a bimodal shape that
  // changes what the numbers mean.
  yield* Console.log("Per-Run samples:");
  yield* Console.log("  #   cond   pair  LCP        INP       video");
  for (const sample of samples) {
    yield* Console.log(
      `  ${String(sample.order).padStart(2)}   ${sample.condition.padEnd(5)}  ${String(
        sample.pair
      ).padStart(
        4
      )}  ${sample.lcp === undefined ? "—" : milliseconds(sample.lcp).padEnd(9)} ${
        sample.inp === undefined ? "—" : milliseconds(sample.inp).padEnd(8)
      } ${sample.videoBytes === undefined ? "" : `${sample.videoBytes} B`}`
    );
  }
  yield* Console.log("");

  const results: Results = {
    conditions: {
      plain: {
        cls: metricStats(matchedPairs(samples, "cls"), "plain"),
        fcp: metricStats(matchedPairs(samples, "fcp"), "plain"),
        inp: metricStats(matchedPairs(samples, "inp"), "plain"),
        lcp: metricStats(matchedPairs(samples, "lcp"), "plain"),
        ttfb: metricStats(matchedPairs(samples, "ttfb"), "plain"),
      },
      video: {
        cls: metricStats(matchedPairs(samples, "cls"), "video"),
        fcp: metricStats(matchedPairs(samples, "fcp"), "video"),
        inp: metricStats(matchedPairs(samples, "inp"), "video"),
        lcp: metricStats(matchedPairs(samples, "lcp"), "video"),
        ttfb: metricStats(matchedPairs(samples, "ttfb"), "video"),
      },
    },
    environment,
    generatedAt: new Date().toISOString(),
    pairs,
    samples,
  };

  const fileSystem = yield* FileSystem.FileSystem;
  const resultsPath = path.join(import.meta.dirname, "results.json");
  yield* fileSystem.writeFileString(
    resultsPath,
    `${JSON.stringify(results, null, 2)}\n`
  );
  yield* Console.log(`Full results: ${resultsPath}`);
});

const program = Effect.gen(function* runExperiment() {
  if (!canRecordVideo()) {
    return yield* new CalibrationError({
      message:
        "ffmpeg is not on the PATH, so video Runs would encode nothing and the video condition would measure a lie. Install ffmpeg and rerun.",
    });
  }

  const [pairsArgument] = process.argv.slice(2);
  const pairs =
    pairsArgument === undefined
      ? DEFAULT_PAIRS
      : Math.trunc(Number(pairsArgument));
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > MAXIMUM_PAIRS) {
    return yield* new CalibrationError({
      message: `Usage: nub tests/calibration/video-overhead.ts [pairs, 1–${MAXIMUM_PAIRS}]`,
    });
  }

  const server = yield* calibrationServer;
  const total = pairs * 2;
  yield* Console.log(
    `Video overhead calibration: ${pairs} pair${pairs === 1 ? "" : "s"} (${total} Runs, interleaved), page ${server.url("calibration.html")}`
  );

  // Discarded first Runs of each condition: they pay one-time costs — browser
  // install, daemon start, a cold page cache — that no counted Run pays, and
  // the experiment measures recording, not installation.
  for (const condition of ["plain", "video"] as const) {
    yield* Console.log(`Warm-up Run (${condition}), discarded`);
    yield* runOnce(server, condition, 0, 0);
  }

  const samples: Sample[] = [];
  let environment: Run["environment"] | undefined;
  for (let pair = 1; pair <= pairs; pair += 1) {
    // Alternate which condition of the pair goes first, so a machine that
    // drifts over the experiment drifts on both conditions equally.
    const conditions =
      pair % 2 === 1
        ? (["video", "plain"] as const)
        : (["plain", "video"] as const);
    for (const condition of conditions) {
      const order = samples.length + 1;
      const { environment: runEnvironment, sample } = yield* runOnce(
        server,
        condition,
        order,
        pair
      );
      environment ??= runEnvironment;
      samples.push(sample);
      yield* Console.log(
        `[${order}/${total}] ${condition.padEnd(5)} LCP ${
          sample.lcp === undefined ? "—" : milliseconds(sample.lcp)
        }  INP ${sample.inp === undefined ? "—" : milliseconds(sample.inp)}${
          sample.excluded === undefined
            ? ""
            : `  — excluded: ${sample.excluded}`
        }`
      );
      yield* Effect.sleep(BETWEEN_RUNS);
    }
  }

  yield* summarize(samples, pairs, environment);
});

program.pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
