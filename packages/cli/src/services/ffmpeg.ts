import type { ChildProcess } from "node:child_process";

import { registry as playwrightRegistry } from "playwright-core/lib/coreBundle";

/**
 * How long a finalizing encoder may take to flush and exit before it is
 * killed. Closing a session scope must never hang the Agent Session, and a
 * VP9 encoder with a full frame queue still drains well inside this window.
 */
const ENCODER_EXIT_TIMEOUT_MS = 10_000;

/**
 * Playwright's bundled ffmpeg. It is deliberately small: it reads MJPEG
 * (through `image2pipe` or Matroska) and VP9, writes VP9 webm, and has no
 * overlay, text, or retiming filters, so anything drawn into a video is drawn
 * before the frames reach it.
 */
export const findFfmpeg = (): string => {
  const executable = playwrightRegistry.registry.findExecutable("ffmpeg");
  if (executable === undefined) {
    throw new Error("Playwright's ffmpeg executable is unavailable.");
  }
  return executable.executablePath();
};

/** Wait for ffmpeg to flush and exit, killing it if it overstays. */
export const awaitExit = (process: ChildProcess): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- ChildProcess has no exit Promise.
  new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
    }, ENCODER_EXIT_TIMEOUT_MS);
    timer.unref?.();
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once("close", settle);
    process.once("error", settle);
  });
