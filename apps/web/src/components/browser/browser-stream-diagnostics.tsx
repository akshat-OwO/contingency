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
    <details className="border-t p-3 text-xs">
      <summary className="cursor-pointer">Stream diagnostics</summary>
      <label className="mt-2 flex items-center justify-between gap-2">
        Streaming preference
        <select
          aria-label="Streaming preference"
          value={transport}
          onChange={(event) =>
            setTransport(event.target.value === "binary" ? "binary" : "json")
          }
        >
          <option value="json">Local performance</option>
          <option value="binary">Lower bandwidth</option>
        </select>
      </label>
      <dl
        className="mt-2 grid grid-cols-2 gap-2"
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
      <p className="text-muted-foreground mt-2">
        Last 120 rendered frames. Replay is excluded from latency. Remote clock
        differences affect capture age. The canvas updates before the next
        screen paint.
      </p>
    </details>
  );
};
