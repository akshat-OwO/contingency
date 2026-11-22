import type { AgentSessionId } from "@contingency/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Fiber } from "effect";
import { useEffect } from "react";

import {
  browserStreamMetricsAtom,
  browserStreamMetricsSnapshotAtom,
  updateStreamMetrics,
} from "@/components/browser/browser-stream-metrics";
import type { BrowserStreamStatus } from "@/components/browser/browser-stream-metrics";
import { browserStreamTransportAtom } from "@/components/browser/browser-stream-settings";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

const transportOptions: readonly {
  readonly label: string;
  readonly value: "binary" | "json";
}[] = [
  { label: "Local performance", value: "json" },
  { label: "Lower bandwidth", value: "binary" },
];

/** A latency not yet measured reads as a dash, never as a missing stream. */
const milliseconds = (value: number | undefined) =>
  value === undefined ? "—" : `${value.toFixed(1)} ms`;

const pair = (left: number | undefined, right: number | undefined) =>
  left === undefined || right === undefined
    ? "—"
    : `${left.toFixed(1)} / ${right.toFixed(1)} ms`;

const statusLabel = (status: BrowserStreamStatus, framesPerSecond: number) => {
  if (status === "live") {
    return `Live · ${framesPerSecond} fps`;
  }
  return status === "lost" ? "Stream lost" : "Connecting…";
};

export const BrowserStreamDiagnostics = ({
  sessionId,
  status,
}: {
  readonly sessionId: AgentSessionId;
  readonly status: BrowserStreamStatus;
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
    <div className="grid gap-3 text-xs">
      <div className="bg-island-hover flex min-h-10 items-center gap-2 rounded-xl py-1 pr-1 pl-3 text-sm font-medium">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            status === "live" && "bg-status-ready",
            status === "connecting" && "bg-brand",
            status === "lost" && "bg-status-recording"
          )}
        />
        {statusLabel(status, metrics.framesPerSecond)}
      </div>
      <div className="flex min-h-[34px] items-center justify-between gap-3">
        <span>Streaming preference</span>
        <SegmentedControl<"binary" | "json">
          aria-label="Streaming preference"
          onValueChange={setTransport}
          size="sm"
          value={transport}
        >
          {transportOptions.map((option) => (
            <SegmentedControlItem key={option.value} value={option.value}>
              {option.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      <dl
        className="[&_dt]:text-muted-foreground grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 [&_dd]:text-right [&_dd]:font-mono [&_dd]:tabular-nums"
        aria-label="Stream diagnostics"
      >
        <dt>Capture to canvas, p95</dt>
        <dd>{milliseconds(metrics.ageP95Ms)}</dd>
        <dt>Capture to receive, p95</dt>
        <dd>{milliseconds(metrics.receiveP95Ms)}</dd>
        <dt>Decode / draw, p95</dt>
        <dd>{pair(metrics.decodeP95Ms, metrics.drawP95Ms)}</dd>
        <dt>Received / rendered / replayed</dt>
        <dd>
          {metrics.received.toLocaleString()} /{" "}
          {metrics.rendered.toLocaleString()} / {metrics.replayed}
        </dd>
        <dt>Image bytes</dt>
        <dd>{metrics.bytes.toLocaleString()}</dd>
        <dt>Pending / decoding</dt>
        <dd>
          {metrics.pending} / {metrics.decoding}
        </dd>
        <dt>Skipped / superseded</dt>
        <dd>
          {metrics.upstreamSkipped} / {metrics.superseded}
        </dd>
        <dt>Stale / failed decodes</dt>
        <dd>
          {metrics.stale} / {metrics.failed}
        </dd>
      </dl>
      <p className="text-muted-foreground">
        Last 120 rendered frames. Replay is excluded from latency; a remote
        clock skews capture times.
      </p>
    </div>
  );
};
