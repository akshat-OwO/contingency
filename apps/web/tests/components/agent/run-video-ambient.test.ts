import { expect, test } from "vitest";

import {
  AMBIENT_SETTLE_MS,
  ambientFrameAlpha,
  makeAmbientBlend,
} from "@/components/agent/run-video-ambient";
import type { FrameScheduler } from "@/components/agent/run-video-ambient";

/** A 60Hz display the test advances by hand. */
const fakeDisplay = () => {
  let now = 0;
  let next = 1;
  const queued = new Map<number, (time: number) => void>();
  const frames: FrameScheduler = {
    cancel: (handle) => queued.delete(handle),
    request: (onFrame) => {
      const handle = next;
      next += 1;
      queued.set(handle, onFrame);
      return handle;
    },
  };
  const advance = (ms: number) => {
    for (const end = now + ms; now < end;) {
      now += 1000 / 60;
      const due = [...queued.values()];
      queued.clear();
      for (const onFrame of due) {
        onFrame(now);
      }
    }
  };
  return { advance, frames };
};

/** A backdrop that records the opacity of every draw. */
const fakeBackdrop = (options: { playing: boolean; reduced: boolean }) => {
  const alphas: number[] = [];
  return {
    alphas,
    target: {
      draw: (alpha: number) => {
        alphas.push(alpha);
      },
      playing: () => options.playing,
      reducedMotion: () => options.reduced,
    },
  };
};

test.each([30, 60, 120])(
  "backdrop reaches 95%% of a new scene in 400ms at %iHz",
  (hz) => {
    let remaining = 1;
    for (let frame = 1; frame <= hz * 0.4; frame += 1) {
      remaining *= 1 - ambientFrameAlpha(1000 / hz, false);
    }
    expect(remaining).toBeCloseTo(0.05, 3);
  }
);

test("reduced motion replaces the backdrop outright", () => {
  expect(ambientFrameAlpha(16, true)).toBe(1);
});

test("a seek while paused blends over several frames, then stops", () => {
  const display = fakeDisplay();
  const backdrop = fakeBackdrop({ playing: false, reduced: false });
  makeAmbientBlend(backdrop.target, display.frames).frameChanged();
  display.advance(AMBIENT_SETTLE_MS * 4);
  // Each frame paints part of the new scene, never all of it at once.
  expect(backdrop.alphas.length).toBeGreaterThan(10);
  expect(Math.max(...backdrop.alphas)).toBeLessThan(0.5);
  const drawn = backdrop.alphas.length;
  display.advance(AMBIENT_SETTLE_MS * 4);
  // A settled, paused player schedules no more frames.
  expect(backdrop.alphas).toHaveLength(drawn);
});

test("the first frame and reduced motion paint at full opacity", () => {
  const display = fakeDisplay();
  const first = fakeBackdrop({ playing: false, reduced: false });
  makeAmbientBlend(first.target, display.frames).frameChanged(true);
  const reduced = fakeBackdrop({ playing: true, reduced: true });
  makeAmbientBlend(reduced.target, display.frames).frameChanged();
  display.advance(AMBIENT_SETTLE_MS * 4);
  expect(first.alphas).toEqual([1]);
  expect(reduced.alphas).toEqual([1]);
});

test("playback keeps blending until stopped", () => {
  const display = fakeDisplay();
  const backdrop = fakeBackdrop({ playing: true, reduced: false });
  const blend = makeAmbientBlend(backdrop.target, display.frames);
  blend.frameChanged();
  display.advance(AMBIENT_SETTLE_MS * 4);
  // A playing video keeps drawing after the first blend settles.
  expect(backdrop.alphas.length).toBeGreaterThan(90);
  blend.stop();
  const drawn = backdrop.alphas.length;
  display.advance(AMBIENT_SETTLE_MS * 4);
  expect(backdrop.alphas).toHaveLength(drawn);
});
