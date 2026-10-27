import { describe, expect, it } from "vitest";

import {
  compareFootprints,
  delta,
  exceedsThreshold,
  formatDelta,
  growth,
} from "../src/footprint.ts";
import type { Footprint } from "../src/footprint.ts";

const defaultFiles = { "dist/index.js": 100 };
const snapshot = (
  packed: number,
  files: Record<string, number> = defaultFiles
): Footprint => ({ files, packed, version: "1.2.3" });
const unavailable = { alpha: null, latest: null };

describe("CLI footprint comparisons", () => {
  it("handles unchanged, shrinking, and zero baselines", () => {
    expect(delta(100, 90)).toEqual({ absolute: -10, percent: -10 });
    expect(delta(0, 0)).toEqual({ absolute: 0, percent: 0 });
    expect(delta(0, 1)).toEqual({ absolute: 1, percent: null });
    expect(formatDelta(0, 1, false)).toBe("⚠️ +1 (new)");
    expect(formatDelta(100, 90, false)).toBe("-10 (-10.00%)");
    expect(formatDelta(100, 100, true)).toBe("0 B (0.00%)");
  });
  it("uses strict configurable byte OR percentage limits and ignores decreases", () => {
    const thresholds = { bytes: 50, percent: 1 };
    expect(exceedsThreshold(100, 101, thresholds, true)).toBe(false);
    expect(exceedsThreshold(100, 102, thresholds, true)).toBe(true);
    expect(exceedsThreshold(100_000, 100_051, thresholds, true)).toBe(true);
    expect(exceedsThreshold(100_000, 100_051, thresholds, false)).toBe(false);
    expect(exceedsThreshold(100, 0, thresholds, true)).toBe(false);
    expect(exceedsThreshold(0, 1, thresholds, false)).toBe(true);
  });
  it("labels all resolved versions and flags latest even when main shrinks", () => {
    const report = compareFootprints(snapshot(200), snapshot(150), {
      alpha: { ...snapshot(160), version: "2.0.0-alpha.1" },
      latest: { ...snapshot(100), version: "1.0.0" },
    });
    expect(report.markdown).toContain(
      "npm latest 1.0.0 | Δ vs. npm latest | npm alpha 2.0.0-alpha.1"
    );
    expect(report.warnings).toEqual([
      "Packed tarball grew vs. npm latest: +50 B (+50.00%)",
    ]);
    expect(report.markdown).toContain("<!-- contingency-cli-footprint -->");
  });
  it("reports missing registry tags without warning or hiding main growth", () => {
    const report = compareFootprints(snapshot(100), snapshot(150), unavailable);
    expect(report.markdown).toContain("npm latest (n/a)");
    expect(report.markdown).toContain("| n/a | n/a | n/a | n/a |");
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("vs. main");
  });
  it("marks all increases but warns only above thresholds, never against alpha", () => {
    const report = compareFootprints(snapshot(100_000), snapshot(100_001), {
      alpha: snapshot(1),
      latest: null,
    });
    expect(report.warnings).toEqual([]);
    expect(report.markdown).toContain("⚠️ +1 B");
  });
  it("warns for installed bytes and keeps every table row at eight columns", () => {
    const report = compareFootprints(
      snapshot(100),
      snapshot(100, { "dist/index.js": 102 }),
      unavailable
    );
    expect(report.warnings).toEqual([
      "Installed file bytes grew vs. main: +2 B (+2.00%)",
    ]);
    const rows = report.markdown
      .split("\n")
      .filter((line) => line.startsWith("|"));
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.split("|")).toHaveLength(10);
    }
  });
  it("ranks new and growing files, omits removed files, and escapes package paths", () => {
    const base = snapshot(100, { removed: 900, small: 10, unchanged: 20 });
    const head = snapshot(100, {
      a: 40,
      b: 40,
      "bad|<script>\n": 400,
      c: 30,
      d: 20,
      small: 11,
      unchanged: 20,
    });
    expect(growth(base, head).map((entry) => entry.file)).toEqual([
      "bad|<script>\n",
      "a",
      "b",
      "c",
      "d",
    ]);
    const report = compareFootprints(base, head, unavailable);
    expect(report.markdown).toContain("`bad??script??`");
    expect(report.markdown).not.toContain("<script>");
    expect(
      report.warnings.some((line) => line.startsWith("Installed files"))
    ).toBe(true);
    expect(
      report.warnings.some((line) => line.startsWith("Installed file bytes"))
    ).toBe(false);
  });
});
