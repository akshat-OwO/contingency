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
  NativeAgentRunSummary,
  TeachingRecordingCleanupState,
} from "@contingency/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { Mutable } from "effect/Types";
import { CircleAlertIcon, SmartphoneIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { SummaryVerdict } from "@/components/agent/dry-run-summary-state";
import { usePublishRunSummaryVerdict } from "@/components/agent/run-summary-dock";
import { VerdictCard } from "@/components/agent/run-summary-verdict";
import { WatcherLoader } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import {
  androidDeviceLabel,
  deviceCleanupKey,
} from "./android-workspace-state";
import { EvidenceReference } from "./evidence-reference";
import { DetailFacts, DetailSection } from "./run-detail-parts";
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

/** Each Capture Gap, marked when a fresh same-device observation repaired it. */
const gapLabels = (
  session: Pick<AndroidWorkspaceSnapshot, "captureGaps" | "captureRepairs">
) => {
  const repairs = [...(session.captureRepairs ?? [])];
  return session.captureGaps.map((code) => {
    const index = repairs.findIndex((repair) => repair.code === code);
    if (index === -1) {
      return gapLabel(code);
    }
    const [repair] = repairs.splice(index, 1);
    return `${gapLabel(code)} (repaired ${
      repair?.by === "automatic" ? "automatically" : "by Recover"
    })`;
  });
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
        Last frame of the session, kept at {time(kept.capturedAt)}
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
  stageShowsLastScreen,
}: {
  readonly cleanup: string;
  /** Shows a keyframe's moment in the video; absent without one to play. */
  readonly onShow: ((capturedAt: string) => void) | undefined;
  readonly platform: DevicePlatform;
  readonly sessionId: string;
  readonly stageShowsLastScreen: boolean;
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
    if (stageShowsLastScreen && keyframes.length === 1 && only !== undefined) {
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
  stageShowsLastScreen,
  teaching,
}: {
  readonly cleanup: string;
  readonly platform: DevicePlatform;
  readonly sessionId: string;
  readonly stageShowsLastScreen: boolean;
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
        stageShowsLastScreen={stageShowsLastScreen}
      />
    </>
  );
};

type SummarySession = Pick<
  AndroidWorkspaceSnapshot,
  | "assessment"
  | "captureGaps"
  | "captureRepairs"
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

/** The device Emulation the session started under (ADR 0082), if recorded. */
const startingEmulationLabel = (
  requirements: SummarySession["requirements"]
) => {
  const emulation =
    requirements.platform === "web"
      ? undefined
      : requirements.preparation?.emulation;
  if (emulation === undefined) {
    return "Not recorded";
  }
  const where =
    emulation.location === null
      ? "no location"
      : `location ${emulation.location.latitude}, ${emulation.location.longitude}`;
  return `${emulation.orientation === "portrait" ? "Portrait" : "Landscape"}, ${emulation.appearance} appearance, ${where}`;
};

const deviceVerdict = (session: SummarySession): SummaryVerdict => {
  if (session.assessment === null) {
    return { label: "No assessment", tone: "attention" };
  }
  const { outcome } = session.assessment;
  let tone: SummaryVerdict["tone"] = "attention";
  if (outcome === "working") {
    tone = "passed";
  } else if (outcome === "not-working") {
    tone = "failed";
  }
  return { label: OUTCOME[outcome], tone };
};

/** Where the session's recording stands with Cleanup, as one sentence. */
const cleanupLabel = (
  session: Pick<SummarySession, "cleanup" | "recordingId">
): string => {
  const { cleanup } = session;
  if (cleanup?._tag === "purged") {
    return "Recording deleted. Verified Flow retained.";
  }
  if (cleanup?._tag === "purge-pending") {
    const kept =
      cleanup.retainedFiles.length === 0
        ? ""
        : ` Kept: ${cleanup.retainedFiles.join(", ")}.`;
    return `${cleanup.failure ?? "Cleanup could not remove every file."}${kept}`;
  }
  if (cleanup?._tag === "pending" || session.recordingId !== null) {
    return "Recording kept until the flow is verified.";
  }
  return "Nothing to clean up; this session made no recording.";
};

/**
 * The verdict card the browser summary opens on, for a device Run: the
 * Agent Assessment, the platform, and what kind of session it was.
 */
const DeviceVerdictCard = ({
  platform,
  session,
}: {
  readonly platform: DevicePlatform;
  readonly session: SummarySession;
}) => {
  const verdict = deviceVerdict(session);
  usePublishRunSummaryVerdict(verdict);
  return (
    <VerdictCard
      facts={[KIND[session.kind]]}
      platform={
        <>
          <SmartphoneIcon aria-hidden="true" />
          {platform === "android" ? "Android" : "iOS"}
        </>
      }
      verdict={verdict}
    />
  );
};

/**
 * An ended device session's Run Summary, in the browser summary's place.
 * What went wrong leads when the agent never assessed the Run; the device and
 * Target App identity sit under it as reference.
 */
export const DeviceRunSummary = ({
  device,
  ended,
  platform,
  session,
  stageShowsLastScreen = true,
  targetApp,
}: {
  readonly device: string;
  /** How a persisted Run ended, said apart from its Agent Assessment. */
  readonly ended?: string | undefined;
  readonly platform: DevicePlatform;
  readonly session: SummarySession;
  /**
   * Whether the session's stage beside the summary holds its last screen.
   * Away from the stage, as on the Flows page, a lone screen draws inline.
   */
  readonly stageShowsLastScreen?: boolean;
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
      <DeviceVerdictCard platform={platform} session={session} />
    )}
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
      stageShowsLastScreen={stageShowsLastScreen}
      teaching={session.kind === "teaching"}
    />
    <DetailSection label="Device">
      <DetailFacts>
        <dt>Session</dt>
        <dd>{KIND[session.kind]}</dd>
        {ended === undefined ? null : (
          <>
            <dt>Ended</dt>
            <dd>{ended}</dd>
          </>
        )}
        <dt>Device</dt>
        <dd className="wrap-anywhere">{device}</dd>
        <dt>Target App</dt>
        <dd className="wrap-anywhere">{targetApp}</dd>
        <dt>Starting data</dt>
        <dd>{startingDataLabel(session.requirements)}</dd>
        <dt>Starting Emulation</dt>
        <dd className="text-pretty">
          {startingEmulationLabel(session.requirements)}
        </dd>
        <dt>Takeover</dt>
        <dd>
          {session.takeoverOccurred
            ? "Occurred; a Dry Run cannot pass"
            : "None"}
        </dd>
        <dt>Capture gaps</dt>
        <dd>{gapLabels(session).join(", ") || "None"}</dd>
        <dt>Cleanup</dt>
        <dd className="text-pretty">{cleanupLabel(session)}</dd>
      </DetailFacts>
    </DetailSection>
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

/**
 * The catalog's Cleanup tag as the summary's Cleanup state. The catalog keeps
 * no failure, kept files, or completion time; the summary shows none of
 * them for a catalog Run, so `endedAt` only fills the required field.
 */
const catalogCleanup = (
  cleanup: TeachingRecordingCleanupState["_tag"] | null,
  endedAt: string
): TeachingRecordingCleanupState | null => {
  if (cleanup === "purge-pending") {
    return { _tag: "purge-pending", failure: null, retainedFiles: [] };
  }
  if (cleanup === "purged") {
    return { _tag: "purged", completedAt: endedAt };
  }
  return cleanup === null ? null : { _tag: "pending" };
};

/** How a native Run ended, in words. */
const RUN_ENDING: Record<NativeAgentRunSummary["outcome"], string> = {
  completed: "Completed",
  crashed: "Crashed",
  interrupted: "Interrupted",
  "process-exited": "Agent process exited",
  "user-closed": "Closed by user",
};

/** The device a native Run's Flow names, from its requirements. */
const requiredDevice = (
  requirements: NativeAgentRunSummary["requirements"]
) => {
  if (requirements.platform === "android") {
    return `Android ${requirements.environment.androidVersion}`;
  }
  if (requirements.platform === "ios") {
    return `${requirements.environment.deviceType} · iOS ${requirements.environment.runtimeVersion}`;
  }
  return "Not recorded";
};

/** The Target App a native Run's Flow names, from its requirements. */
const requiredTargetApp = (
  requirements: NativeAgentRunSummary["requirements"]
) => {
  if (requirements.platform === "android") {
    return `${requirements.environment.appId} · build ${requirements.environment.appBuild}`;
  }
  if (requirements.platform === "ios") {
    return `${requirements.environment.bundleId} · build ${requirements.environment.build}`;
  }
  return "Not recorded";
};

/**
 * A native Run's full Run Summary from its persisted Summary, where no live
 * session snapshot exists, such as on the Flows page (ADR 0078). Its video and
 * screens are read by session, so they show while this Workspace still holds
 * the session's record. `cleanup` is the Dry Run's recording Cleanup as the
 * catalog lists it, or `null` when no recording is listed.
 */
export const NativeRunSummary = ({
  cleanup,
  summary,
}: {
  readonly cleanup: TeachingRecordingCleanupState["_tag"] | null;
  readonly summary: NativeAgentRunSummary;
}) => {
  const session: Mutable<SummarySession> = {
    assessment: summary.assessment,
    captureGaps: summary.captureGaps,
    cleanup: catalogCleanup(cleanup, summary.endedAt),
    error: null,
    id: summary.sessionId,
    kind: summary.kind,
    recordingId: summary.recordingId,
    requirements: summary.requirements,
    takeoverOccurred: summary.takeoverOccurred,
  };
  if (summary.captureRepairs !== undefined) {
    session.captureRepairs = summary.captureRepairs;
  }
  return (
    <DeviceRunSummary
      device={requiredDevice(summary.requirements)}
      ended={RUN_ENDING[summary.outcome]}
      platform={summary.platform}
      session={session}
      stageShowsLastScreen={false}
      targetApp={requiredTargetApp(summary.requirements)}
    />
  );
};
