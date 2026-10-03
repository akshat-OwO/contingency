import type { AgentSessionId } from "@contingency/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Fiber } from "effect";
import { useEffect } from "react";

import {
  browserStreamMetricsAtom,
  browserStreamMetricsSnapshotAtom,
  updateStreamMetrics,
} from "@/components/browser/browser-stream-metrics";
import { browserStreamTransportAtom } from "@/components/browser/browser-stream-settings";
import { SegmentedControl } from "@/components/browser/segmented-control";
import type { SegmentedOption } from "@/components/browser/segmented-control";

const transportOptions: readonly SegmentedOption<"binary" | "json">[] = [
  { label: "Local performance", value: "json" },
  { label: "Lower bandwidth", value: "binary" },
];

const milliseconds = (value: number | undefined) =>
  value === undefined ? "Waiting for frames" : `${value.toFixed(1)} ms`;

export const BrowserStreamDiagnostics = ({
  sessionId,
}: {
  readonly sessionId: AgentSessionId;
}) => {
  const metrics = useAtomValue(browserStreamMetricsSnapshotAtom(sessionId));
  const [transport, setTransport] = useAtom(
    browserStreamTransportAtom(sessionId)
  );
  const setMetrics = useAtomSet(browserStreamMetricsAtom(sessionId));
  useEffect(() => {
    const fiber = Effect.runFork(
      Effect.gen(function* publishDiagnostics() {
        while (true) {
          yield* Effect.sleep("500 millis");
          setMetrics((current) =>
            updateStreamMetrics(current, { type: "tick" })
          );
        }
      })
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [setMetrics]);
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span>Streaming preference</span>
        <SegmentedControl
          label="Streaming preference"
          onChange={setTransport}
          options={transportOptions}
          value={transport}
        />
      </div>
      <dl
        className="[&_dt]:text-muted-foreground grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 [&_dd]:text-right [&_dd]:tabular-nums"
        aria-label="Stream diagnostics"
      >
        <dt>Capture receipt to canvas, p95 (local clock)</dt>
        <dd>{milliseconds(metrics.ageP95Ms)}</dd>
        <dt>Capture receipt to receive, p95 (local clock)</dt>
        <dd>{milliseconds(metrics.receiveP95Ms)}</dd>
        <dt>Decode / draw, p95</dt>
        <dd>
          {milliseconds(metrics.decodeP95Ms)} /{" "}
          {milliseconds(metrics.drawP95Ms)}
        </dd>
        <dt>Received / rendered / replayed</dt>
        <dd>
          {metrics.received} / {metrics.rendered} / {metrics.replayed}
        </dd>
        <dt>Image bytes received</dt>
        <dd>{metrics.bytes.toLocaleString()}</dd>
        <dt>Pending / decoding</dt>
        <dd>
          {metrics.pending} / {metrics.decoding} (pending limit 1)
        </dd>
        <dt>Skipped upstream / superseded pending</dt>
        <dd>
          {metrics.upstreamSkipped} / {metrics.superseded}
        </dd>
        <dt>Stale decode / failed decode</dt>
        <dd>
          {metrics.stale} / {metrics.failed}
        </dd>
      </dl>
      <p className="text-muted-foreground">
        Last 120 rendered frames. Replay is excluded from latency. Remote clock
        differences affect capture age. The canvas updates before the next
        screen paint.
      </p>
    </div>
  );
};
