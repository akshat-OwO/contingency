import type { AgentSessionId, BrowserStreamEvent } from "@contingency/protocol";
import { Atom } from "effect/reactivity";

type Frame = Extract<BrowserStreamEvent, { readonly type: "frame" }>;
const SAMPLE_LIMIT = 120;

interface Sample {
  readonly ageMs: number | undefined;
  readonly decodeMs: number;
  readonly drawMs: number;
}

export interface StreamMetrics {
  readonly replayed: number;
  readonly received: number;
  readonly rendered: number;
  readonly bytes: number;
  readonly upstreamSkipped: number;
  readonly superseded: number;
  readonly stale: number;
  readonly failed: number;
  readonly pending: number;
  readonly decoding: number;
  readonly maxPending: number;
  readonly samples: readonly Sample[];
  readonly receiveAges: readonly number[];
  readonly lastSequence: number | undefined;
  readonly streamId: string | undefined;
  readonly publishedAt: number;
  readonly snapshot: StreamMetricsSnapshot;
}

export interface StreamMetricsSnapshot {
  readonly replayed: number;
  readonly received: number;
  readonly rendered: number;
  readonly bytes: number;
  readonly upstreamSkipped: number;
  readonly superseded: number;
  readonly stale: number;
  readonly failed: number;
  readonly pending: number;
  readonly decoding: number;
  readonly maxPending: number;
  readonly ageP95Ms: number | undefined;
  readonly receiveP95Ms: number | undefined;
  readonly decodeP95Ms: number | undefined;
  readonly drawP95Ms: number | undefined;
}

const emptySnapshot: StreamMetricsSnapshot = {
  ageP95Ms: undefined,
  bytes: 0,
  decodeP95Ms: undefined,
  decoding: 0,
  drawP95Ms: undefined,
  failed: 0,
  maxPending: 0,
  pending: 0,
  receiveP95Ms: undefined,
  received: 0,
  rendered: 0,
  replayed: 0,
  stale: 0,
  superseded: 0,
  upstreamSkipped: 0,
};

export const emptyStreamMetrics: StreamMetrics = {
  ...emptySnapshot,
  lastSequence: undefined,
  publishedAt: 0,
  receiveAges: [],
  samples: [],
  snapshot: emptySnapshot,
  streamId: undefined,
};

export const browserStreamMetricsAtom = Atom.family(
  (_sessionId: AgentSessionId | undefined) =>
    Atom.make<StreamMetrics>(emptyStreamMetrics)
);
export const browserStreamMetricsSnapshotAtom = Atom.family(
  (sessionId: AgentSessionId) =>
    Atom.map(browserStreamMetricsAtom(sessionId), (metrics) => metrics.snapshot)
);

export type StreamMetricEvent =
  | { readonly type: "tick" | "cancelled" }
  | {
      readonly type: "received";
      readonly frame: Frame;
      readonly replaced: boolean;
    }
  | { readonly type: "decoding" }
  | { readonly type: "stale" | "failed" }
  | {
      readonly type: "rendered";
      readonly frame: Frame;
      readonly decodeMs: number;
      readonly drawMs: number;
    };

export const percentile95 = (values: readonly number[]): number | undefined =>
  values.toSorted((left, right) => left - right)[
    Math.ceil(values.length * 0.95) - 1
  ];

/** Retain a fixed sample window; publish a stable display snapshot twice per second. */
export const updateStreamMetrics = (
  previous: StreamMetrics,
  event: StreamMetricEvent,
  now = Date.now()
): StreamMetrics => {
  let metrics = previous;
  switch (event.type) {
    case "received": {
      const gap =
        previous.streamId === event.frame.streamId &&
        previous.lastSequence !== undefined
          ? Math.max(0, event.frame.seq - previous.lastSequence - 1)
          : 0;
      metrics = {
        ...previous,
        bytes: previous.bytes + event.frame.data.byteLength,
        lastSequence: event.frame.seq,
        maxPending: 1,
        pending: 1,
        receiveAges:
          event.frame.replayed === true
            ? previous.receiveAges
            : [
                ...previous.receiveAges.slice(-(SAMPLE_LIMIT - 1)),
                now -
                  (event.frame.receivedAt ??
                    event.frame.metadata.timestamp * 1000),
              ],
        received: previous.received + 1,
        replayed: previous.replayed + Number(event.frame.replayed === true),
        streamId: event.frame.streamId,
        superseded: previous.superseded + Number(event.replaced),
        upstreamSkipped: previous.upstreamSkipped + gap,
      };
      break;
    }
    case "decoding": {
      metrics = { ...previous, decoding: 1, pending: 0 };
      break;
    }
    case "rendered": {
      const ageMs =
        event.frame.replayed === true
          ? undefined
          : now -
            (event.frame.receivedAt ?? event.frame.metadata.timestamp * 1000);
      metrics = {
        ...previous,
        decoding: 0,
        rendered: previous.rendered + 1,
        samples: [
          ...previous.samples.slice(-(SAMPLE_LIMIT - 1)),
          {
            ageMs,
            decodeMs: event.decodeMs,
            drawMs: event.drawMs,
          },
        ],
      };
      break;
    }
    case "stale": {
      metrics = { ...previous, decoding: 0, stale: previous.stale + 1 };
      break;
    }
    case "failed": {
      metrics = { ...previous, decoding: 0, failed: previous.failed + 1 };
      break;
    }
    case "tick": {
      break;
    }
    case "cancelled": {
      metrics = {
        ...previous,
        decoding: 0,
        pending: 0,
        stale: previous.stale + previous.pending + previous.decoding,
      };
      break;
    }
    default: {
      return metrics;
    }
  }
  if (now - metrics.publishedAt < 500) {
    return metrics;
  }
  return {
    ...metrics,
    publishedAt: now,
    snapshot: {
      ageP95Ms: percentile95(
        metrics.samples.flatMap((sample) =>
          sample.ageMs === undefined ? [] : [sample.ageMs]
        )
      ),
      bytes: metrics.bytes,
      decodeP95Ms: percentile95(
        metrics.samples.map((sample) => sample.decodeMs)
      ),
      decoding: metrics.decoding,
      drawP95Ms: percentile95(metrics.samples.map((sample) => sample.drawMs)),
      failed: metrics.failed,
      maxPending: metrics.maxPending,
      pending: metrics.pending,
      receiveP95Ms: percentile95(metrics.receiveAges),
      received: metrics.received,
      rendered: metrics.rendered,
      replayed: metrics.replayed,
      stale: metrics.stale,
      superseded: metrics.superseded,
      upstreamSkipped: metrics.upstreamSkipped,
    },
  };
};
