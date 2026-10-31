import { Clock, Effect } from "effect";

export type LocalSystemOneStage =
  | "Environment"
  | "Packages"
  | "Model weights"
  | "Smoke test";

const bytes = (value: number): string => {
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

const downloadLine = (
  name: string,
  received: number,
  size: number | undefined,
  percentage: number | undefined,
  rate: number,
  tty: boolean
): string => {
  const filled = Math.floor((percentage ?? 0) / 5);
  const bar = tty ? `[${"=".repeat(filled)}${" ".repeat(20 - filled)}] ` : "";
  return `${name}: ${bar}${bytes(received)}${size === undefined ? "" : ` / ${bytes(size)}`} ${percentage === undefined ? "?%" : `${percentage}%`} ${bytes(rate)}/s`;
};

/** One active download at a time. Writes to stderr so stdout remains usable. */
export const makeLocalSystemOneProgress = <E>(
  tty: boolean,
  write: (text: string) => Effect.Effect<void, E>
) => {
  const stage = (name: LocalSystemOneStage) => write(`${name}...\n`);
  const download = (name: string, total?: number) =>
    Effect.gen(function* beginDownload() {
      const started = yield* Clock.currentTimeMillis;
      let lastBucket = -1;
      let lastRender = started;
      let active = false;
      const update = (received: number, size = total, done = false) =>
        Effect.gen(function* renderDownload() {
          const now = yield* Clock.currentTimeMillis;
          const known = size !== undefined && Number.isFinite(size) && size > 0;
          const percentage = known
            ? Math.min(100, Math.floor((received / size) * 100))
            : undefined;
          const bucket =
            percentage === undefined ? 0 : Math.floor(percentage / 10);
          if (
            !done &&
            lastBucket >= 0 &&
            (tty ? now - lastRender < 100 : bucket === lastBucket)
          ) {
            return;
          }
          if (done && !tty && known && bucket === lastBucket) {
            return;
          }
          lastBucket = bucket;
          lastRender = now;
          const rate = now > started ? (received * 1000) / (now - started) : 0;
          const line = downloadLine(
            name,
            received,
            known ? size : undefined,
            percentage,
            rate,
            tty
          );
          yield* write(
            `${tty ? "\r\u001B[2K" : ""}${line}${!tty || done ? "\n" : ""}`
          );
          active = tty && !done;
        });
      yield* update(0);
      return {
        finish: Effect.suspend(() => {
          if (!active) {
            return Effect.void;
          }
          active = false;
          return write("\n");
        }),
        update,
      };
    });
  return { download, stage };
};

/** HF 1.32, pinned by Kev, exposes aggregate byte bars through tqdm_class. */
export const modelDownloadScript = `
import io
import json
import sys
from huggingface_hub import snapshot_download
from tqdm.auto import tqdm

class Progress(tqdm):
    def __init__(self, *args, **kwargs):
        self.report_bytes = kwargs.get("desc", "").startswith("Reconstructing")
        kwargs["file"] = io.StringIO()
        kwargs["disable"] = False
        super().__init__(*args, **kwargs)

    def display(self, msg=None, pos=None):
        if self.report_bytes and self.unit == "B":
            print("CONTINGENCY_PROGRESS " + json.dumps({"received": self.n, "total": self.total or 0}), flush=True)

repo, _, revision = sys.argv[1].partition("@")
snapshot_download(repo, revision=revision or None,
    allow_patterns=["*.json", "*.safetensors", "*.pt", "*.txt", "*.jinja"],
    tqdm_class=Progress)
`;
