import { deviceKeyframePath, deviceKeyframesPath } from "@contingency/protocol";
import type {
  AndroidWorkspaceSnapshot,
  DevicePlatform,
} from "@contingency/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { CircleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import { androidDeviceLabel } from "./android-workspace-state";
import { EvidenceReference } from "./evidence-reference";

const OUTCOME = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
} as const;

const KIND = {
  "dry-run": "Dry Run",
  run: "Run",
  teaching: "Teaching",
} as const;

/** A capture gap code, said as words: `secure_window` reads "Secure window". */
const gapLabel = (code: string) => {
  const words = code.replaceAll(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** How far into the session a screen was kept, as m:ss from the first. */
const elapsed = (first: string, at: string) => {
  const seconds = Math.max(
    0,
    Math.round((Date.parse(at) - Date.parse(first)) / 1000)
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * An ended session's stage: the last screen it kept, so the stage shows where
 * the journey stopped rather than an empty space. Without a kept screen it is
 * `fallback`.
 */
export const DeviceLastScreen = ({
  fallback,
  platform,
  sessionId,
}: {
  readonly fallback: React.ReactNode;
  readonly platform: DevicePlatform;
  readonly sessionId: string;
}) => {
  const { deviceKeyframesAtom } = useRpcDependencies();
  const result = useAtomValue(
    deviceKeyframesAtom(deviceKeyframesPath(platform, sessionId))
  );
  const kept =
    AsyncResult.isSuccess(result) &&
    result.value !== null &&
    result.value.retained
      ? result.value.keyframes.at(-1)
      : undefined;
  if (kept === undefined) {
    return fallback;
  }
  return (
    <figure className="flex h-full min-h-0 flex-col items-center justify-center gap-3">
      <img
        alt="The last screen this session kept"
        className="min-h-0 w-auto max-w-full flex-1 rounded-[2rem] border-[6px] border-neutral-900 object-contain shadow-xl"
        src={deviceKeyframePath(platform, sessionId, kept.hash)}
      />
      <figcaption className="text-muted-foreground text-xs">
        Last screen kept, at {time(kept.capturedAt)}
      </figcaption>
    </figure>
  );
};

/**
 * What the session kept of its screens. A device session records no video;
 * its keyframes are the screens it photographed as the journey went, so they
 * stand where the browser summary shows its video.
 */
const DeviceRecording = ({
  platform,
  sessionId,
}: {
  readonly platform: DevicePlatform;
  readonly sessionId: string;
}) => {
  const { deviceKeyframesAtom } = useRpcDependencies();
  const atom = deviceKeyframesAtom(deviceKeyframesPath(platform, sessionId));
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const body = (() => {
    if (result._tag === "Initial") {
      return <p className="text-muted-foreground">Reading screens…</p>;
    }
    if (result._tag === "Failure") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-pretty" role="alert">
            The screens could not be read.
          </p>
          <Button onClick={retry} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      );
    }
    if (result.value === null) {
      return (
        <p className="text-muted-foreground text-pretty">
          This Workspace no longer holds the session, so its screens cannot be
          read here.
        </p>
      );
    }
    const { keyframes, retained } = result.value;
    if (keyframes.length === 0) {
      return (
        <p className="text-muted-foreground text-pretty">
          The session kept no screens. A device session records no video.
        </p>
      );
    }
    if (!retained) {
      return (
        <p className="text-muted-foreground text-pretty">
          Cleanup deleted the{" "}
          {keyframes.length === 1
            ? "one screen"
            : `${keyframes.length} screens`}{" "}
          this session kept, with its recording.
        </p>
      );
    }
    const first = keyframes[0]?.capturedAt ?? "";
    return (
      <ol
        aria-label="Screens"
        className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2"
      >
        {keyframes.map((keyframe, index) => {
          const src = deviceKeyframePath(platform, sessionId, keyframe.hash);
          return (
            <li className="shrink-0 snap-start" key={keyframe.hash}>
              <a
                className="focus-visible:ring-ring block rounded-lg outline-none focus-visible:ring-2"
                href={src}
                rel="noreferrer"
                target="_blank"
                title={`Open screen ${index + 1} full size`}
              >
                <img
                  alt={`Screen ${index + 1} of ${keyframes.length}, ${elapsed(first, keyframe.capturedAt)} in`}
                  className="bg-muted h-64 w-auto rounded-lg border object-contain"
                  loading="lazy"
                  src={src}
                />
              </a>
              <p className="text-muted-foreground mt-1 text-xs tabular-nums">
                <span title={time(keyframe.capturedAt)}>
                  {index + 1} · {elapsed(first, keyframe.capturedAt)}
                </span>{" "}
                ·{" "}
                <a
                  className="text-foreground underline-offset-2 hover:underline"
                  href={src}
                  rel="noreferrer"
                  target="_blank"
                >
                  Full size
                </a>
              </p>
            </li>
          );
        })}
      </ol>
    );
  })();
  return (
    <section aria-labelledby="device-recording" className="space-y-2">
      <h3
        className="text-muted-foreground text-xs font-medium"
        id="device-recording"
      >
        Screens
      </h3>
      {body}
    </section>
  );
};

type SummarySession = Pick<
  AndroidWorkspaceSnapshot,
  | "assessment"
  | "captureGaps"
  | "cleanup"
  | "error"
  | "id"
  | "kind"
  | "recordingId"
  | "takeoverOccurred"
>;

/**
 * An ended device session's Run Summary, in the browser summary's place.
 * What went wrong leads when the agent never assessed the Run; the device and
 * Target App identity sit under it as reference.
 */
export const DeviceRunSummary = ({
  device,
  platform,
  session,
  targetApp,
}: {
  readonly device: string;
  readonly platform: DevicePlatform;
  readonly session: SummarySession;
  readonly targetApp: string;
}) => (
  <div className="space-y-5 text-sm">
    {session.error === null ? null : (
      <section
        aria-label="Error"
        className="border-destructive/30 bg-destructive/5 flex gap-2.5 rounded-lg border p-3"
      >
        <CircleAlertIcon
          aria-hidden="true"
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <div className="space-y-1">
          <h3 className="font-medium">The session ended with an error</h3>
          <p className="text-muted-foreground text-pretty">{session.error}</p>
        </div>
      </section>
    )}
    {/*
      Teaching records a journey; no agent assesses it, so its summary leads
      with the screens rather than with an assessment that never comes.
    */}
    {session.kind === "teaching" && session.assessment === null ? null : (
      <section className="space-y-1">
        <h3 className="text-muted-foreground text-xs font-medium">
          Agent Assessment
        </h3>
        <p className="font-medium">
          {session.assessment === null
            ? "Not submitted"
            : OUTCOME[session.assessment.outcome]}
        </p>
        {session.assessment === null ? null : (
          <>
            <p className="text-muted-foreground text-pretty">
              {session.assessment.explanation}
            </p>
            <EvidenceReference
              id={session.assessment.observationId}
              kind="observation"
            />
          </>
        )}
      </section>
    )}
    <DeviceRecording platform={platform} sessionId={session.id} />
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t pt-4 text-xs">
      <dt className="text-muted-foreground">Session</dt>
      <dd>{KIND[session.kind]}</dd>
      <dt className="text-muted-foreground">Device</dt>
      <dd className="wrap-anywhere">{device}</dd>
      <dt className="text-muted-foreground">Target App</dt>
      <dd className="wrap-anywhere">{targetApp}</dd>
      <dt className="text-muted-foreground">Takeover</dt>
      <dd>
        {session.takeoverOccurred ? "Occurred; a Dry Run cannot pass" : "None"}
      </dd>
      <dt className="text-muted-foreground">Capture gaps</dt>
      <dd>{session.captureGaps.map(gapLabel).join(", ") || "None"}</dd>
      <dt className="text-muted-foreground">Cleanup</dt>
      <dd className="text-pretty">
        {session.cleanup?._tag === "purged"
          ? "Recording deleted. Verified Flow retained."
          : null}
        {session.cleanup?._tag === "purge-pending"
          ? `${session.cleanup.failure} Kept: ${session.cleanup.retainedFiles.join(", ")}.`
          : null}
        {session.cleanup?._tag === "pending" ||
        (session.cleanup === null && session.recordingId !== null)
          ? "Recording kept until the flow is verified."
          : null}
        {session.cleanup === null && session.recordingId === null
          ? "Nothing to clean up; this session made no recording."
          : null}
      </dd>
    </dl>
  </div>
);

/** An ended Android session's Run Summary. */
export const AndroidRunSummary = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => (
  <DeviceRunSummary
    platform="android"
    device={`${androidDeviceLabel(session.selection.device)} · ${session.selection.device.serial}`}
    session={session}
    targetApp={`${session.selection.environment.appId} · build ${session.selection.environment.appBuild}`}
  />
);
