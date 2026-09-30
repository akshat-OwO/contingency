import { BrowserStreamId, FrameSequence } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  emptyStreamMetrics,
  updateStreamMetrics,
} from "@/components/browser/browser-stream-metrics";

const frame = (sequence: number, streamId = "first") => ({
  data: new Uint8Array(10),
  metadata: {
    deviceHeight: 480,
    deviceWidth: 640,
    offsetTop: 0,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    timestamp: 1,
  },
  seq: FrameSequence.make(sequence),
  streamId: BrowserStreamId.make(streamId),
  type: "frame" as const,
});

test("distinguishes upstream gaps from replaced pending frames and capture generations", () => {
  let metrics = updateStreamMetrics(
    emptyStreamMetrics,
    { frame: frame(1), replaced: false, type: "received" },
    1001
  );
  metrics = updateStreamMetrics(metrics, { type: "decoding" }, 1002);
  metrics = updateStreamMetrics(
    metrics,
    { frame: frame(4), replaced: false, type: "received" },
    1003
  );
  metrics = updateStreamMetrics(
    metrics,
    { frame: frame(5), replaced: true, type: "received" },
    1004
  );
  metrics = updateStreamMetrics(
    metrics,
    { frame: frame(100, "second"), replaced: true, type: "received" },
    1005
  );
  expect(metrics.upstreamSkipped).toBe(2);
  expect(metrics.superseded).toBe(2);
  expect(metrics.pending).toBe(1);
  expect(metrics.decoding).toBe(1);
  metrics = updateStreamMetrics(metrics, { type: "cancelled" }, 1006);
  expect(metrics.stale).toBe(2);
  expect(metrics.pending + metrics.decoding).toBe(0);
});

test("bounds samples and publishes the final measurements while a page is static", () => {
  let metrics = emptyStreamMetrics;
  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    metrics = updateStreamMetrics(
      metrics,
      { frame: frame(sequence), replaced: false, type: "received" },
      1001
    );
    metrics = updateStreamMetrics(
      metrics,
      { decodeMs: 2, drawMs: 1, frame: frame(sequence), type: "rendered" },
      1005
    );
  }
  expect(metrics.samples).toHaveLength(120);
  expect(metrics.receiveAges).toHaveLength(120);
  const published = updateStreamMetrics(metrics, { type: "tick" }, 2000);
  expect(published.snapshot.rendered).toBe(1000);
  expect(published.snapshot.ageP95Ms).toBe(5);
  expect(published.snapshot.decodeP95Ms).toBe(2);
  expect(updateStreamMetrics(published, { type: "tick" }, 2001).snapshot).toBe(
    published.snapshot
  );
});

test("excludes a replayed static image from capture latency and uses server receipt time", () => {
  const replay = { ...frame(1), receivedAt: 1000, replayed: true };
  let metrics = updateStreamMetrics(
    emptyStreamMetrics,
    { frame: replay, replaced: false, type: "received" },
    60_000
  );
  metrics = updateStreamMetrics(
    metrics,
    { decodeMs: 2, drawMs: 1, frame: replay, type: "rendered" },
    60_003
  );
  metrics = updateStreamMetrics(metrics, { type: "tick" }, 61_000);
  expect(metrics.snapshot.replayed).toBe(1);
  expect(metrics.snapshot.ageP95Ms).toBeUndefined();
  const fresh = { ...frame(2), receivedAt: 61_001, replayed: false };
  metrics = updateStreamMetrics(
    metrics,
    { frame: fresh, replaced: false, type: "received" },
    61_004
  );
  metrics = updateStreamMetrics(
    metrics,
    { decodeMs: 2, drawMs: 1, frame: fresh, type: "rendered" },
    61_006
  );
  metrics = updateStreamMetrics(metrics, { type: "tick" }, 62_000);
  expect(metrics.snapshot.ageP95Ms).toBe(5);
  expect(metrics.snapshot.receiveP95Ms).toBe(3);
});
