import { createServer } from "node:http";
import path from "node:path";

import {
  BrowserRpcError,
  BrowserStreamEvent,
  SessionId,
} from "@contingency/protocol";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import {
  Context,
  Effect,
  Deferred,
  Fiber,
  FileSystem,
  Layer,
  Schema,
  Ref,
  Stream,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import { Socket } from "effect/socket";
import type { Page } from "playwright-core";

import {
  defaultScreencastOptions,
  ScreencastOptions,
} from "../src/services/create-browser-screencast.ts";
import {
  CreateBrowser,
  CreateBrowserLive,
} from "../src/services/create-browser.ts";
import { makeTeachingEncoder } from "../src/services/teaching-encoder.ts";
import { draftEmulation } from "../tests/integration/harness.ts";
import {
  checkStreamingBudgets,
  streamingBenchmarkReportSchema,
  streamingBudgets,
} from "./browser-streaming-budget.ts";

/** Same frame schema and socket protocol as the product, isolated from Agent Session workflows. */
const BenchmarkRpcs = RpcGroup.make(
  Rpc.make("benchmark.stream", {
    error: BrowserRpcError,
    payload: Schema.Struct({ sessionId: SessionId }),
    stream: true,
    success: BrowserStreamEvent,
  })
);
const [FrameSchema] = BrowserStreamEvent.members;
type Frame = Extract<BrowserStreamEvent, { readonly type: "frame" }>;
const qualitySchema = Schema.Struct({
  decodeMs: Schema.Number,
  drawMs: Schema.Number,
  height: Schema.Number,
  psnr: Schema.NullOr(Schema.Number),
  textPsnr: Schema.NullOr(Schema.Number),
  width: Schema.Number,
});

const p95 = (samples: readonly number[]) =>
  samples.toSorted((left, right) => left - right)[
    Math.ceil(samples.length * 0.95) - 1
  ] ?? 0;
const imageUrl = (image: Uint8Array, format: string) =>
  `data:image/${format};base64,${Buffer.from(image).toString("base64")}`;

const compareImages = (
  page: Page,
  reference: Uint8Array,
  image: Uint8Array,
  format: string
) =>
  Effect.tryPromise(() =>
    page.evaluate(
      `(async () => {` +
        `const load = async (url) => createImageBitmap(await (await fetch(url)).blob());` +
        `const reference = await load(${JSON.stringify(imageUrl(reference, "png"))});` +
        `const started = performance.now();` +
        `const image = await load(${JSON.stringify(imageUrl(image, format))});` +
        `const decoded = performance.now();` +
        `const canvas = new OffscreenCanvas(reference.width, reference.height);` +
        `const context = canvas.getContext('2d', { willReadFrequently: true });` +
        `context.drawImage(reference, 0, 0);` +
        `const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;` +
        `const drawStart = performance.now(); context.drawImage(image, 0, 0, canvas.width, canvas.height);` +
        `const drawMs = performance.now() - drawStart;` +
        `const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;` +
        `let error = 0, textError = 0, textSamples = 0; const textRows = Math.round(canvas.height * 0.4);` +
        `for (let index = 0; index < actual.length; index += 4) {` +
        `for (let channel = 0; channel < 3; channel += 1) {` +
        `const difference = expected[index + channel] - actual[index + channel]; error += difference * difference;` +
        `if (index < canvas.width * textRows * 4) { textError += difference * difference; textSamples += 1; } } }` +
        `reference.close(); image.close();` +
        `const psnr = (mse) => mse === 0 ? null : 10 * Math.log10(255 * 255 / mse);` +
        `return { width: canvas.width, height: canvas.height, psnr: psnr(error / (actual.length / 4 * 3)),` +
        `textPsnr: psnr(textError / textSamples), decodeMs: decoded - started, drawMs }; })()`
    )
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(qualitySchema)));

const decoderTiming = (page: Page, frames: readonly Frame[]) =>
  Effect.tryPromise(() =>
    page.evaluate(
      `(async () => {` +
        `const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d'); const measurements = [];` +
        `for (const url of ${JSON.stringify(frames.map((frame) => imageUrl(frame.data, "jpeg")))}) {` +
        `const blob = await (await fetch(url)).blob();` +
        `const start = performance.now(), bitmap = await createImageBitmap(blob), decoded = performance.now();` +
        `if (canvas.width !== bitmap.width) canvas.width = bitmap.width;` +
        `if (canvas.height !== bitmap.height) canvas.height = bitmap.height;` +
        `context.drawImage(bitmap, 0, 0); bitmap.close();` +
        `measurements.push({ decodeMs: decoded - start, drawMs: performance.now() - decoded }); }` +
        `return { measurements, width: canvas.width, height: canvas.height }; })()`
    )
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          height: Schema.Number,
          measurements: Schema.Array(
            Schema.Struct({ decodeMs: Schema.Number, drawMs: Schema.Number })
          ),
          width: Schema.Number,
        })
      )
    )
  );

const verifyBudgets = (report: typeof streamingBenchmarkReportSchema.Type) => {
  const failures = checkStreamingBudgets(report);
  return failures.length > 0
    ? Effect.fail(new Error(failures.join("\n")))
    : Effect.sync(() => process.stdout.write("Streaming budgets passed.\n"));
};

const main = Effect.gen(function* benchmarkBrowserStreaming() {
  const fs = yield* FileSystem.FileSystem;
  const focus = process.env["STREAM_BENCHMARK_FOCUS"] === "1";
  const baseline = process.env["STREAM_BENCHMARK_BASELINE"] === "1";
  const captureOptions: ScreencastOptions["Service"] = baseline
    ? { format: "jpeg", maxPixelRatio: 1, quality: 80 }
    : defaultScreencastOptions;
  const binarySerialization = Context.get(
    yield* Layer.build(RpcSerialization.layerSchemaBinary()),
    RpcSerialization.RpcSerialization
  );
  const profileName = baseline ? "baseline" : "candidate";
  const outputName = focus ? `${profileName}-focus` : profileName;
  const output = path.resolve(
    import.meta.dirname,
    "../../../.cursor/skills/verify-contingency/artifacts/streaming-benchmark",
    outputName
  );
  if (process.argv.includes("--check-existing")) {
    const saved = yield* fs.readFileString(path.join(output, "results.json"));
    const report = yield* Schema.decodeUnknownEffect(
      streamingBenchmarkReportSchema
    )(JSON.parse(saved));
    yield* verifyBudgets(report);
    return;
  }
  yield* fs.makeDirectory(output, { recursive: true });
  const html = yield* fs.readFileString(
    path.resolve(
      import.meta.dirname,
      "../tests/integration/fixtures/streaming-benchmark.html"
    )
  );
  const quality: Record<string, number | string | null | undefined>[] = [];
  const streaming: Record<string, number | string | boolean | undefined>[] = [];
  const sampleMs = Number(process.env["STREAM_BENCHMARK_SAMPLE_MS"] ?? "1500");
  if (!Number.isFinite(sampleMs) || sampleMs < 500 || sampleMs > 30_000) {
    return yield* Effect.fail(
      new Error("STREAM_BENCHMARK_SAMPLE_MS must be 500–30000.")
    );
  }
  const qualityOnly = process.argv.includes("--quality-only");
  for (const dpr of focus ? [1] : [1, 2, 3]) {
    yield* Effect.scoped(
      Effect.gen(function* benchmarkPixelRatio() {
        const browser = yield* CreateBrowser;
        const viewport = { deviceScaleFactor: dpr, height: 480, width: 640 };
        const { sessionId } = yield* browser.open(
          undefined,
          `data:text/html,${encodeURIComponent(html)}`,
          draftEmulation("default", viewport)
        );
        const page = yield* browser.activePage(sessionId);
        const reference = yield* Effect.tryPromise(() =>
          page.screenshot({ type: "png" })
        );
        yield* fs.writeFile(
          path.join(output, `reference-dpr${dpr}.png`),
          reference
        );
        const captureImage = (format: "jpeg" | "png", qualityValue: number) =>
          browser.stream(sessionId).pipe(
            Stream.provideService(ScreencastOptions, {
              ...captureOptions,
              format,
              quality: qualityValue,
            }),
            Stream.filter((event) => event.type === "frame"),
            Stream.take(1),
            Stream.runCollect,
            Effect.flatMap((frames) =>
              frames[0] === undefined
                ? Effect.fail(new Error("The capture ended without an image."))
                : Effect.succeed(frames[0].data)
            ),
            Effect.timeout("10 seconds")
          );
        const captureReference = yield* captureImage("png", 100);
        yield* fs.writeFile(
          path.join(output, `capture-reference-dpr${dpr}.png`),
          captureReference
        );
        for (const setting of [80, 90, 95, "png"] as const) {
          const image = yield* Effect.tryPromise(() =>
            setting === "png"
              ? page.screenshot({ type: "png" })
              : page.screenshot({ quality: setting, type: "jpeg" })
          );
          const format = setting === "png" ? "png" : "jpeg";
          const comparisons = [];
          for (let attempt = 0; attempt < 5; attempt += 1) {
            comparisons.push(
              yield* compareImages(page, reference, image, format)
            );
          }
          const comparison = comparisons.at(-1);
          quality.push({
            bytes: image.byteLength,
            dpr,
            setting,
            source: "screenshot",
            ...comparison,
            decodeP95Ms: p95(comparisons.map((value) => value.decodeMs)),
            drawP95Ms: p95(comparisons.map((value) => value.drawMs)),
          });
          yield* fs.writeFile(
            path.join(output, `quality-${setting}-dpr${dpr}.${format}`),
            image
          );
          const captured = yield* captureImage(
            format,
            setting === "png" ? 100 : setting
          );
          const captureComparison = yield* compareImages(
            page,
            captureReference,
            captured,
            format
          );
          const nativeComparison = yield* compareImages(
            page,
            reference,
            captured,
            format
          );
          quality.push({
            ...captureComparison,
            bytes: captured.byteLength,
            dpr,
            nativePsnr: nativeComparison.psnr,
            setting,
            source: "screencast",
          });
          yield* fs.writeFile(
            path.join(output, `capture-quality-${setting}-dpr${dpr}.${format}`),
            captured
          );
        }
        if (qualityOnly) {
          yield* browser.close(sessionId);
          return;
        }
        const wireCounts = yield* Ref.make({ binary: 0, json: 0 });
        const measuredSerialization = (binary: boolean) => {
          const serialization = binary
            ? binarySerialization
            : RpcSerialization.json;
          return Layer.succeed(RpcSerialization.RpcSerialization, {
            ...serialization,
            makeUnsafe: () => {
              const parser = serialization.makeUnsafe();
              return {
                decode: parser.decode,
                encode: (response) => {
                  const encoded = parser.encode(response);
                  if (encoded !== undefined) {
                    const bytes = Buffer.byteLength(encoded);
                    Effect.runSync(
                      Ref.update(wireCounts, (current) =>
                        binary
                          ? { ...current, binary: current.binary + bytes }
                          : { ...current, json: current.json + bytes }
                      )
                    );
                  }
                  return encoded;
                },
              };
            },
          });
        };
        const handlers = BenchmarkRpcs.toLayer({
          "benchmark.stream": ({ sessionId: id }) =>
            browser
              .stream(id)
              .pipe(Stream.provideService(ScreencastOptions, captureOptions)),
        });
        const routes = Layer.merge(
          RpcServer.layerHttp({ group: BenchmarkRpcs, path: "/ws" }).pipe(
            Layer.provide(measuredSerialization(false))
          ),
          RpcServer.layerHttp({
            group: BenchmarkRpcs,
            path: "/ws/browser",
          }).pipe(Layer.provide(measuredSerialization(true)))
        ).pipe(Layer.provide(handlers));
        const serverContext = yield* Layer.build(
          HttpRouter.serve(routes).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
            )
          )
        );
        const { address } = Context.get(serverContext, HttpServer.HttpServer);
        if (address._tag === "UnixPathAddress") {
          return yield* Effect.fail(
            new Error("Benchmark server did not bind TCP.")
          );
        }
        const origin = `ws://127.0.0.1:${address.port}`;
        for (const binary of baseline ? [false] : [false, true]) {
          for (const recording of [false, true]) {
            for (const slow of [false, true]) {
              for (const workload of [
                "static",
                "scroll",
                "typing",
                "animation",
              ]) {
                if (focus && (recording || slow || workload !== "animation")) {
                  continue;
                }
                const result = yield* Effect.scoped(
                  Effect.gen(function* benchmarkStreamCase() {
                    const clientContext = yield* Layer.build(
                      RpcClient.layerProtocolSocket().pipe(
                        Layer.provide(
                          Socket.layerWebSocket(
                            origin + (binary ? "/ws/browser" : "/ws")
                          ).pipe(
                            Layer.provide(
                              Socket.layerWebSocketConstructorGlobal
                            )
                          )
                        ),
                        Layer.provide(
                          binary
                            ? RpcSerialization.layerSchemaBinary()
                            : RpcSerialization.layerJson
                        )
                      )
                    );
                    const client = yield* RpcClient.make(BenchmarkRpcs, {
                      flatten: true,
                    }).pipe(Effect.provideContext(clientContext));
                    const events = client(
                      "benchmark.stream",
                      { sessionId },
                      { streamBufferSize: 1 }
                    );
                    const ready = yield* Deferred.make<boolean>();
                    const frames: Frame[] = [];
                    const ages: number[] = [];
                    const wireStarted = yield* Ref.get(wireCounts);
                    const wallStarted = Date.now();
                    const cpuStarted = process.cpuUsage();
                    let imageBytes = 0;
                    let previous: number | undefined;
                    let skipped = 0;
                    let encoder;
                    if (recording) {
                      encoder = yield* makeTeachingEncoder({
                        maxBytes: 100_000_000,
                        output: path.join(
                          output,
                          `recording-dpr${dpr}-${binary}-${slow}-${workload}.webm`
                        ),
                      });
                      const writer = encoder;
                      yield* browser.stream(sessionId).pipe(
                        Stream.provideService(
                          ScreencastOptions,
                          captureOptions
                        ),
                        Stream.runForEach((event) =>
                          event.type === "frame"
                            ? writer.write(event.data)
                            : Effect.void
                        ),
                        Effect.forkChild
                      );
                    }
                    const workloadStarted = Date.now();
                    yield* Effect.tryPromise(() =>
                      page.evaluate(
                        `window.startWorkload(${JSON.stringify(workload)})`
                      )
                    );
                    const reader = yield* events.pipe(
                      Stream.runForEach((event) =>
                        Effect.gen(function* consumeFrame() {
                          if (event.type !== "frame") {
                            return;
                          }
                          const frame =
                            yield* Schema.decodeUnknownEffect(FrameSchema)(
                              event
                            );
                          if (previous !== undefined) {
                            skipped += Math.max(0, frame.seq - previous - 1);
                          }
                          previous = frame.seq;
                          yield* Deferred.succeed(ready, true);
                          imageBytes += frame.data.byteLength;
                          if (
                            workload === "static" ||
                            frame.metadata.timestamp * 1000 >= workloadStarted
                          ) {
                            ages.push(
                              Date.now() - frame.metadata.timestamp * 1000
                            );
                          }
                          if (frames.length < 12) {
                            frames.push(frame);
                          }
                          if (slow) {
                            yield* Effect.sleep("100 millis");
                          }
                        })
                      ),
                      Effect.forkChild
                    );
                    yield* Effect.race(
                      Deferred.await(ready),
                      Fiber.join(reader)
                    ).pipe(Effect.timeout("10 seconds"));
                    const startupCpu = process.cpuUsage(cpuStarted);
                    const sampleCpuStarted = process.cpuUsage();
                    yield* Effect.sleep(sampleMs);
                    yield* Fiber.interrupt(reader);
                    yield* Effect.tryPromise(() =>
                      page.evaluate('window.startWorkload("static")')
                    );
                    const cpu = process.cpuUsage(sampleCpuStarted);
                    const decoded = yield* decoderTiming(page, frames);
                    const encoderBytes =
                      encoder === undefined ? 0 : yield* encoder.bytesWritten;
                    const encoderFailure =
                      encoder === undefined
                        ? undefined
                        : yield* encoder.failure;
                    const wireFinished = yield* Ref.get(wireCounts);
                    return {
                      binary,
                      captureToReceiveP95Ms: p95(ages),
                      decodeP95Ms: p95(
                        decoded.measurements.map((value) => value.decodeMs)
                      ),
                      dpr,
                      drawP95Ms: p95(
                        decoded.measurements.map((value) => value.drawMs)
                      ),
                      elapsedMs: Date.now() - wallStarted,
                      encoderBytes,
                      encoderFailure,
                      height: decoded.height,
                      imageBytes,
                      received: ages.length,
                      recording,
                      rpcProcessCpuMs: (cpu.user + cpu.system) / 1000,
                      skipped,
                      slow,
                      startupCpuMs:
                        (startupCpu.user + startupCpu.system) / 1000,
                      width: decoded.width,
                      wireBytes: binary
                        ? wireFinished.binary - wireStarted.binary
                        : wireFinished.json - wireStarted.json,
                      workload,
                    };
                  })
                );
                streaming.push(result);
                process.stdout.write(`${JSON.stringify(result)}\n`);
              }
            }
          }
        }
        yield* browser.close(sessionId);
      }).pipe(Effect.provide(CreateBrowserLive))
    );
  }
  const report = {
    budgets: streamingBudgets,
    captureOptions,
    createdAt: new Date().toISOString(),
    limits: {
      retainedDecoderFrames: 12,
      subscriberFrameQueue: 1,
      webUiPendingFrames: 1,
    },
    notes: [
      "RPC process CPU includes both Node client and server; it excludes Chromium and ffmpeg. Draw time measures command submission.",
      "Changing-workload freshness excludes replay captured before the workload started.",
      "Capture age uses local clocks and ends at RPC receipt; decode/draw are measured separately in Chromium.",
      "Static pages emit frames on paint; their frame counts are not an FPS measurement.",
      "Typing workload updates a controlled field; real Shift/Backspace input is covered by the Workspace input-check.",
      "Recording uses the real Teaching encoder; PNG is a lossless reference, not a supported Teaching encoder input.",
    ],
    quality,
    sampleMs,
    streaming,
  };
  yield* fs.writeFileString(
    path.join(output, "results.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  if (process.argv.includes("--check")) {
    yield* Schema.decodeUnknownEffect(streamingBenchmarkReportSchema)(
      report
    ).pipe(Effect.flatMap(verifyBudgets));
  }
  process.stdout.write(
    `Benchmark results: ${path.join(output, "results.json")}\n`
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(main);
