import {
  deviceKeyframePath,
  deviceKeyframesPath,
  deviceVideoPath,
  deviceVideoStatusPath,
} from "@contingency/protocol";
import type {
  AndroidWorkspaceSnapshot,
  DevicePlatform,
  DeviceVideoCapture,
  DeviceVideoStatus,
} from "@contingency/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { WatcherLoader } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import {
  androidDeviceLabel,
  deviceCleanupKey,
} from "./android-workspace-state";
import { EvidenceReference } from "./evidence-reference";
import { RunVideoPlayer } from "./run-video";
import { videoOffsetMs } from "./run-video-timeline";

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
 * An ended session's keyframes. An ended session adds no screens, but
 * cleanup can still delete them, here or from another process, so the list
 * is read again whenever the session's cleanup state changes.
 */
const useDeviceKeyframes = (
  platform: DevicePlatform,
  sessionId: string,
  cleanup: string
) => {
  const { deviceKeyframesAtom } = useRpcDependencies();
  const atom = deviceKeyframesAtom(deviceKeyframesPath(platform, sessionId));
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const seen = useRef(cleanup);
  useEffect(() => {
    if (seen.current !== cleanup) {
      seen.current = cleanup;
      refresh();
    }
  }, [cleanup, refresh]);
  return { refresh, result };
};

/**
 * An ended session's stage: the last screen it kept, so the stage shows where
 * the journey stopped rather than an empty space. Without a kept screen it is
 * `fallback`.
 */
export const DeviceLastScreen = ({
  cleanup,
  fallback,
  platform,
  sessionId,
}: {
  /** The session's cleanup state; a change re-reads what is retained. */
  readonly cleanup: string;
  readonly fallback: React.ReactNode;
  readonly platform: DevicePlatform;
  readonly sessionId: string;
}) => {
  const { result } = useDeviceKeyframes(platform, sessionId, cleanup);
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
        className="min-h-0 w-auto max-w-full flex-1 rounded-[2rem] border-[6px] border-neutral-900 object-contain shadow-xl dark:border-neutral-700"
        src={deviceKeyframePath(platform, sessionId, kept.hash)}
      />
      <figcaption className="text-muted-foreground text-xs">
        Last screen kept, at {time(kept.capturedAt)}
      </figcaption>
    </figure>
  );
};

const GAP_REASON: Record<DeviceVideoCapture["gaps"][number]["reason"], string> =
  {
    "recorder-lost": "the recorder stopping unexpectedly",
    "recorder-restarted":
      "the recorder starting a new file after the screen changed shape, the stream restarted, or the recorder fell behind",
    "recorder-stopped-early": "the recorder stopping before the session did",
    "recorder-unconfirmed": "the recorder not confirming its footage",
    "size-limit": "the video size limit",
  };

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/**
 * What a ready video does not show: footage the device never recorded, and
 * secure screens it hid on purpose.
 */
const coverageNotes = (capture: DeviceVideoCapture): readonly string[] => {
  const notes: string[] = [];
  if (!capture.complete) {
    const reasons = [
      ...new Set(capture.gaps.map((gap) => GAP_REASON[gap.reason])),
    ];
    const lost = capture.gaps.reduce(
      (total, gap) => total + Math.max(0, gap.toMs - gap.fromMs),
      0
    );
    notes.push(
      `The video is incomplete: ${lost > 0 ? `about ${seconds(lost)} was not recorded` : "part of the session may not be recorded"}${reasons.length > 0 ? `, because of ${reasons.join(" and ")}` : ""}. Those moments are marked "Capture gap".`
    );
  }
  if (capture.hidden.length > 0) {
    const hidden = capture.hidden.reduce(
      (total, span) => total + (span.toMs - span.fromMs),
      0
    );
    notes.push(
      `Secure screens are hidden for ${seconds(hidden)}; the video shows a card in their place.`
    );
  }
  if (capture.note !== undefined) {
    notes.push(capture.note);
  }
  return notes;
};

/**
 * A device session's video, read again whenever its cleanup state changes,
 * since Cleanup can delete it here or from another process.
 */
const useDeviceVideo = (
  platform: DevicePlatform,
  sessionId: string,
  cleanup: string
) => {
  const { deviceVideoStatusAtom } = useRpcDependencies();
  const atom = deviceVideoStatusAtom(
    deviceVideoStatusPath(platform, sessionId)
  );
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const seen = useRef(cleanup);
  useEffect(() => {
    if (seen.current !== cleanup) {
      seen.current = cleanup;
      refresh();
    }
  }, [cleanup, refresh]);
  return { refresh, result };
};

/** Where a moment of the session plays in its video, if it does. */
const videoMomentAt = (
  status: DeviceVideoStatus | null | undefined,
  at: string
): number | undefined => {
  if (status?.state !== "ready") {
    return undefined;
  }
  const runMs = Date.parse(at) - Date.parse(status.timeMap.startedAt);
  return videoOffsetMs(status.timeMap, status.pacing === "condensed", runMs);
};

/**
 * The session's own screen recording ([ADR 0079](../../../../../docs/adr/0079-native-recordings-use-agent-device-screen-recording.md)).
 * Teaching plays in real time; a Run or Dry Run is condensed like a browser
 * Run. Until it is rendered the summary says so, and a session without one
 * says why.
 */
const DeviceVideo = ({
  platform,
  result,
  retry,
  seekRequest,
  sessionId,
  teaching,
}: {
  readonly platform: DevicePlatform;
  readonly result: ReturnType<typeof useDeviceVideo>["result"];
  readonly retry: () => void;
  readonly seekRequest:
    | { readonly ms: number; readonly key: number }
    | undefined;
  readonly sessionId: string;
  readonly teaching: boolean;
}) => {
  const body = (() => {
    if (
      result._tag === "Initial" ||
      (AsyncResult.isSuccess(result) && result.value?.state === "preparing")
    ) {
      return (
        <div
          aria-live="polite"
          className="text-muted-foreground flex w-full items-center justify-center gap-2 rounded-lg border py-3 text-xs"
          role="status"
        >
          <WatcherLoader className="h-2.5" />
          Preparing video…
        </div>
      );
    }
    if (result._tag === "Failure") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-pretty" role="alert">
            The video could not be read.
          </p>
          <Button onClick={retry} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      );
    }
    const status = result.value;
    if (status === null) {
      return (
        <p className="text-muted-foreground text-pretty">
          This Workspace no longer holds the session, so its video cannot be
          read here.
        </p>
      );
    }
    if (status.state === "purged") {
      return (
        <p className="text-muted-foreground text-pretty">
          Cleanup deleted this session&apos;s video, with its recording.
        </p>
      );
    }
    if (status.state === "not-recorded") {
      return (
        <p className="text-muted-foreground text-pretty">{status.reason}</p>
      );
    }
    if (status.state === "unavailable") {
      return (
        <div className="space-y-1.5" role="status">
          <p className="font-medium">
            This session&apos;s video is not available.
          </p>
          <p className="text-muted-foreground text-pretty">{status.reason}</p>
          {status.directory === undefined ? null : (
            <EvidenceReference id={status.directory} kind="Video folder" />
          )}
        </div>
      );
    }
    if (status.state !== "ready") {
      return null;
    }
    const notes = coverageNotes(status.capture);
    return (
      <div className="space-y-1.5">
        <RunVideoPlayer
          className={undefined}
          condensed={status.pacing === "condensed"}
          path={status.path}
          src={deviceVideoPath(platform, sessionId)}
          subject={teaching ? "Teaching session" : "Run"}
          timeMap={status.timeMap}
          timeline={[]}
          videoClassName="max-h-[28rem]"
          {...(seekRequest === undefined ? {} : { seekRequest })}
        />
        {status.fallback === undefined ? null : (
          <p className="text-muted-foreground text-xs text-pretty">
            {status.fallback}
          </p>
        )}
        {notes.map((note) => (
          <p className="text-muted-foreground text-xs text-pretty" key={note}>
            {note}
          </p>
        ))}
      </div>
    );
  })();
  return (
    <section aria-labelledby="device-video" className="space-y-2">
      <h3
        className="text-muted-foreground text-xs font-medium"
        id="device-video"
      >
        Video
      </h3>
      {body}
    </section>
  );
};

/**
 * What the session kept of its screens: the keyframes it photographed as the
 * journey went. Beside a video that plays, choosing one shows that moment in
 * the video.
 */
const DeviceRecording = ({
  cleanup,
  onShow,
  platform,
  sessionId,
}: {
  readonly cleanup: string;
  /** Shows a keyframe's moment in the video; absent without one to play. */
  readonly onShow: ((capturedAt: string) => void) | undefined;
  readonly platform: DevicePlatform;
  readonly sessionId: string;
}) => {
  const { refresh: retry, result } = useDeviceKeyframes(
    platform,
    sessionId,
    cleanup
  );
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
          The session kept no screens.
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
    const [only] = keyframes;
    if (keyframes.length === 1 && only !== undefined) {
      // The stage already shows the one screen kept; the rail does not draw
      // it a second time.
      return (
        <p className="text-muted-foreground text-pretty">
          The one screen this session kept is on the stage, at{" "}
          {time(only.capturedAt)}.{" "}
          <a
            className="text-foreground underline underline-offset-2"
            href={deviceKeyframePath(platform, sessionId, only.hash)}
            rel="noreferrer"
            target="_blank"
          >
            Full size
          </a>
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
                {onShow === undefined ? null : (
                  <>
                    <button
                      aria-label={`Show screen ${index + 1} in the video`}
                      className="text-foreground underline underline-offset-2"
                      onClick={() => {
                        onShow(keyframe.capturedAt);
                      }}
                      type="button"
                    >
                      In video
                    </button>{" "}
                    ·{" "}
                  </>
                )}
                <a
                  className="text-foreground underline underline-offset-2"
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

/**
 * The session's video and its screens, together, so a screen can be shown
 * in the video.
 */
const DeviceEvidence = ({
  cleanup,
  platform,
  sessionId,
  teaching,
}: {
  readonly cleanup: string;
  readonly platform: DevicePlatform;
  readonly sessionId: string;
  readonly teaching: boolean;
}) => {
  const { refresh, result } = useDeviceVideo(platform, sessionId, cleanup);
  const [seekRequest, setSeekRequest] = useState<
    { readonly ms: number; readonly key: number } | undefined
  >();
  const status = AsyncResult.isSuccess(result) ? result.value : undefined;
  const onShow =
    status?.state === "ready"
      ? (capturedAt: string) => {
          const ms = videoMomentAt(status, capturedAt);
          if (ms !== undefined) {
            setSeekRequest((previous) => ({
              key: (previous?.key ?? 0) + 1,
              ms,
            }));
          }
        }
      : undefined;
  return (
    <>
      <DeviceVideo
        platform={platform}
        result={result}
        retry={refresh}
        seekRequest={seekRequest}
        sessionId={sessionId}
        teaching={teaching}
      />
      <DeviceRecording
        cleanup={cleanup}
        onShow={onShow}
        platform={platform}
        sessionId={sessionId}
      />
    </>
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
  | "requirements"
  | "takeoverOccurred"
>;

/** The Starting Data the session applied: its Flow's, or Teaching's choice. */
const startingDataLabel = (requirements: SummarySession["requirements"]) =>
  requirements.platform !== "web" &&
  requirements.preparation?.startingData === "clear"
    ? "App data cleared"
    : "Existing app data kept";

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
    <DeviceEvidence
      cleanup={deviceCleanupKey(session.cleanup)}
      platform={platform}
      sessionId={session.id}
      teaching={session.kind === "teaching"}
    />
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t pt-4 text-xs">
      <dt className="text-muted-foreground">Session</dt>
      <dd>{KIND[session.kind]}</dd>
      <dt className="text-muted-foreground">Device</dt>
      <dd className="wrap-anywhere">{device}</dd>
      <dt className="text-muted-foreground">Target App</dt>
      <dd className="wrap-anywhere">{targetApp}</dd>
      <dt className="text-muted-foreground">Starting data</dt>
      <dd>{startingDataLabel(session.requirements)}</dd>
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
