import path from "node:path";

import { ByteSize, Effect, FileSystem, Schema } from "effect";

import {
  parseNpmPackOutput,
  runInstallCheckCommand,
} from "./verify-cli-install.ts";

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);
export const FootprintSchema = Schema.Struct({
  files: Schema.Record(Schema.String, Count),
  packed: Count,
  version: Schema.String,
});
export type Footprint = typeof FootprintSchema.Type;
export const RegistryBaselinesSchema = Schema.Struct({
  alpha: Schema.NullOr(FootprintSchema),
  latest: Schema.NullOr(FootprintSchema),
});
export type RegistryBaselines = typeof RegistryBaselinesSchema.Type;
export const marker = "<!-- contingency-cli-footprint -->";

export interface Thresholds {
  readonly bytes: number;
  readonly percent: number;
}
export const defaultThresholds: Thresholds = { bytes: 50 * 1024, percent: 1 };

export const delta = (base: number, head: number) => {
  if (base === head) {
    return { absolute: 0, percent: 0 };
  }
  return {
    absolute: head - base,
    percent: base === 0 ? null : ((head - base) / base) * 100,
  };
};

/** Byte metrics warn on either limit; file counts warn on percentage growth. */
export const exceedsThreshold = (
  base: number,
  head: number,
  thresholds: Thresholds,
  bytes: boolean
): boolean => {
  const change = delta(base, head);
  return (
    change.absolute > 0 &&
    ((bytes && change.absolute > thresholds.bytes) ||
      change.percent === null ||
      change.percent > thresholds.percent)
  );
};

const size = (bytes: number) => `${(bytes / 1024).toFixed(2)} KiB`;
const signed = (value: number, format: (n: number) => string) =>
  `${value > 0 ? "+" : ""}${format(value)}`;
export const formatDelta = (
  base: number,
  head: number,
  bytes: boolean
): string => {
  const change = delta(base, head);
  const percent =
    change.percent === null
      ? "new"
      : `${signed(change.percent, (n) => n.toFixed(2))}%`;
  return `${change.absolute > 0 ? "⚠️ " : ""}${signed(change.absolute, bytes ? (n) => `${n} B` : String)} (${percent})`;
};

const unpacked = (snapshot: Footprint) =>
  Object.values(snapshot.files).reduce((sum, n) => sum + n, 0);
const metrics = [
  {
    bytes: true,
    label: "Packed tarball",
    read: (s: Footprint) => s.packed,
  },
  {
    bytes: true,
    label: "Installed file bytes",
    read: unpacked,
  },
  {
    bytes: false,
    label: "Installed files",
    read: (s: Footprint) => Object.keys(s.files).length,
  },
] as const;

// File names are data from a package, never Markdown or HTML.
const safeName = (value: string) =>
  value.replaceAll(/[^a-zA-Z0-9@/._+-]/gu, "?");
export const growth = (base: Footprint, head: Footprint) =>
  Object.entries(head.files)
    .flatMap(([file, bytes]) =>
      bytes > (base.files[file] ?? 0)
        ? [{ bytes: bytes - (base.files[file] ?? 0), file }]
        : []
    )
    .toSorted((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))
    .slice(0, 5);

export const compareFootprints = (
  base: Footprint,
  head: Footprint,
  registry: RegistryBaselines,
  thresholds: Thresholds = defaultThresholds
) => {
  const baselines = [
    { name: "main", snapshot: base, warn: true },
    { name: "npm latest", snapshot: registry.latest, warn: true },
    { name: "npm alpha", snapshot: registry.alpha, warn: false },
  ];
  const warnings = baselines.flatMap(({ name, snapshot, warn }) =>
    snapshot === null || !warn
      ? []
      : metrics
          .filter((metric) =>
            exceedsThreshold(
              metric.read(snapshot),
              metric.read(head),
              thresholds,
              metric.bytes
            )
          )
          .map(
            (metric) =>
              `${metric.label} grew vs. ${name}: ${formatDelta(metric.read(snapshot), metric.read(head), metric.bytes).replace("⚠️ ", "")}`
          )
  );
  const headers = baselines.flatMap(({ name, snapshot }) => [
    `${name}${snapshot === null ? " (n/a)" : ` ${safeName(snapshot.version)}`}`,
    `Δ vs. ${name}`,
  ]);
  const rows = metrics.map((metric) => {
    const format = metric.bytes ? size : String;
    return `| ${metric.label} | ${format(metric.read(head))} | ${baselines.flatMap(({ snapshot }) => (snapshot === null ? ["n/a", "n/a"] : [format(metric.read(snapshot)), formatDelta(metric.read(snapshot), metric.read(head), metric.bytes)])).join(" | ")} |`;
  });
  const breakdown = baselines.map(({ name, snapshot }) => {
    const entries = snapshot === null ? [] : growth(snapshot, head);
    let detail = "n/a";
    if (snapshot !== null) {
      detail =
        entries.length === 0
          ? "No files grew."
          : entries
              .map(
                (entry) =>
                  `- \`${safeName(entry.file)}\`: +${size(entry.bytes)}`
              )
              .join("\n");
    }
    return `### Largest file increases vs. ${name}\n\n${detail}`;
  });
  const markdown = [
    marker,
    "## CLI install footprint",
    "",
    warnings.length === 0
      ? "No growth above the warning thresholds."
      : `⚠️ ${warnings.length} metric comparison(s) exceeded the warning thresholds.`,
    "",
    `| Metric | PR ${safeName(head.version)} | ${headers.join(" | ")} |`,
    `| ${Array.from({ length: 8 }, () => "---").join(" | ")} |`,
    ...rows,
    "",
    `Warnings apply against main and npm latest when byte growth exceeds ${size(thresholds.bytes)} OR growth exceeds ${thresholds.percent}%. File counts use the percentage limit. Every positive delta is marked. Alpha is informational.`,
    "",
    "Installed bytes sum regular file lengths after a clean offline install, excluding filesystem block allocation and npm metadata. Startup timing is omitted because CI timing is noisy.",
    "",
    breakdown.join("\n\n"),
    "",
  ].join("\n");
  return { markdown, warnings };
};

/** Same pack flags as publication; no lifecycle scripts or registry dependencies on install. */
export const measureFootprint = Effect.fn("measureFootprint")(function* measure(
  spec: string,
  cwd: string
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({
    prefix: "cli-footprint-",
  });
  const packed = yield* runInstallCheckCommand(
    "npm",
    [
      "pack",
      spec,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporary,
    ],
    cwd
  );
  const tarball = path.join(temporary, yield* parseNpmPackOutput(packed));
  const packedBytes = ByteSize.toNumberUnsafe((yield* fs.stat(tarball)).size);
  yield* fs.writeFileString(
    path.join(temporary, "package.json"),
    '{"private":true}'
  );
  yield* runInstallCheckCommand(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--strict-peer-deps",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(temporary, "cache"),
      tarball,
    ],
    temporary
  );
  const installed = path.join(temporary, "node_modules/@contingencyhq/cli");
  const manifestText = yield* fs.readFileString(
    path.join(installed, "package.json")
  );
  const manifest = yield* Effect.try(() =>
    Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
      JSON.parse(manifestText)
    )
  );
  const files: Record<string, number> = {};
  for (const relative of yield* fs.readDirectory(installed, {
    recursive: true,
  })) {
    const info = yield* fs.stat(path.join(installed, relative));
    if (info.type === "File") {
      files[relative.split(path.sep).join("/")] = ByteSize.toNumberUnsafe(
        info.size
      );
    }
  }
  return { files, packed: packedBytes, version: manifest.version };
}, Effect.scoped);
