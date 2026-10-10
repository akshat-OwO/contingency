import { Schema } from "effect";

export const streamingBenchmarkReportSchema = Schema.Struct({
  captureOptions: Schema.Struct({ quality: Schema.Number }),
  quality: Schema.Array(
    Schema.Struct({
      dpr: Schema.Number,
      psnr: Schema.NullOr(Schema.Number),
      setting: Schema.Union([Schema.Number, Schema.Literal("png")]),
      source: Schema.Literals(["screenshot", "screencast"]),
      textPsnr: Schema.NullOr(Schema.Number),
    })
  ),
  streaming: Schema.Array(
    Schema.Struct({
      binary: Schema.Boolean,
      captureToReceiveP95Ms: Schema.Number,
      decodeP95Ms: Schema.Number,
      dpr: Schema.Number,
      encoderBytes: Schema.Number,
      encoderFailure: Schema.optional(Schema.String),
      imageBytes: Schema.Number,
      received: Schema.Number,
      recording: Schema.Boolean,
      slow: Schema.Boolean,
      wireBytes: Schema.Number,
      workload: Schema.Literals(["static", "scroll", "typing", "animation"]),
    })
  ),
});

type Report = typeof streamingBenchmarkReportSchema.Type;

export const streamingBudgets = {
  binaryWireToImageRatio: 1.08,
  decodeP95Ms: 20,
  fastCaptureToReceiveP95Ms: 100,
  jpeg90Psnr: 38,
  jpeg90TextPsnr: 36,
  slowCaptureToReceiveP95Ms: 400,
} as const;

const checkImageQuality = (report: Report, dpr: number): readonly string[] => {
  const failures: string[] = [];
  const image = report.quality.find(
    (row) =>
      row.dpr === dpr && row.source === "screencast" && row.setting === 90
  );
  if (image === undefined) {
    failures.push(`Missing JPEG 90 screencast comparison for DPR ${dpr}`);
  } else {
    if (image.psnr !== null && image.psnr < streamingBudgets.jpeg90Psnr) {
      failures.push(`JPEG 90 fidelity below budget at DPR ${dpr}`);
    }
    if (
      image.textPsnr !== null &&
      image.textPsnr < streamingBudgets.jpeg90TextPsnr
    ) {
      failures.push(`JPEG 90 text fidelity below budget at DPR ${dpr}`);
    }
  }
  return failures;
};

const checkStreamingCase = (
  row: Report["streaming"][number],
  name: string
): readonly string[] => {
  const { binary, recording, slow, workload } = row;
  const failures: string[] = [];
  if (row.received <= 0) {
    failures.push(`No frames received in ${name}`);
  }
  if (row.decodeP95Ms > streamingBudgets.decodeP95Ms) {
    failures.push(`Decode latency above budget in ${name}`);
  }
  // Static images remain valid after their capture timestamp. Only changing workloads measure freshness.
  if (
    workload !== "static" &&
    row.captureToReceiveP95Ms >
      (slow
        ? streamingBudgets.slowCaptureToReceiveP95Ms
        : streamingBudgets.fastCaptureToReceiveP95Ms)
  ) {
    failures.push(`Capture freshness above budget in ${name}`);
  }
  if (
    recording &&
    (row.encoderBytes <= 0 || row.encoderFailure !== undefined)
  ) {
    failures.push(`Teaching encoder failed in ${name}`);
  }
  if (
    binary &&
    !slow &&
    workload !== "static" &&
    row.imageBytes > 0 &&
    row.wireBytes / row.imageBytes > streamingBudgets.binaryWireToImageRatio
  ) {
    failures.push(`Binary transport overhead above budget in ${name}`);
  }
  return failures;
};

/** Timing budgets are opt-in on a quiet local machine; structural regressions run in normal tests. */
export const checkStreamingBudgets = (report: Report): readonly string[] => {
  const failures: string[] = [];
  for (const dpr of [1, 2, 3]) {
    failures.push(...checkImageQuality(report, dpr));
    const hasBinary = report.streaming.some((row) => row.binary);
    for (const binary of hasBinary ? [false, true] : [false]) {
      for (const recording of [false, true]) {
        for (const slow of [false, true]) {
          for (const workload of ["static", "scroll", "typing", "animation"]) {
            const row = report.streaming.find(
              (value) =>
                value.dpr === dpr &&
                value.binary === binary &&
                value.recording === recording &&
                value.slow === slow &&
                value.workload === workload
            );
            const name = [dpr, binary, recording, slow, workload].join("/");
            if (row === undefined) {
              failures.push(`Missing streaming case ${name}`);
              continue;
            }
            failures.push(...checkStreamingCase(row, name));
          }
        }
      }
    }
  }
  return failures;
};
