import {
  deviceKeyframePath,
  deviceKeyframesPath,
  deviceVideoPath,
  deviceVideoStatusPath,
} from "@contingency/protocol";
import type {
  AgentAssessmentOutcome,
  AgentTaskRunOutcome,
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

import type { RunSummaryStat } from "@/components/agent/dry-run-summary";
import {
  RunSummaryFooter,
  RunSummaryFrame,
  RunSummaryTaskFacts,
} from "@/components/agent/dry-run-summary";
import type {
  SummaryCheck,
  SummaryVerdict,
} from "@/components/agent/dry-run-summary-state";
import {
  failedCheckSentence,
  runDuration,
  runOutcomeLabel,
  runSummaryWhen,
} from "@/components/agent/dry-run-summary-state";
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
import { DetailFacts, DetailSection, FlowPill } from "./run-detail-parts";
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
    // The ended stage keeps the live stage's region, so the device is named
    // the same way before and after the session ends.
    <section
      aria-label={platform === "android" ? "Android device" : "iOS simulator"}
      className="flex h-full min-h-0 items-center justify-center"
    >
      <div className="relative flex h-full min-h-0 max-w-full">
        <span
          className="pointer-events-none absolute top-3.5 left-1/2 z-10 inline-flex h-[26px] -translate-x-1/2 items-center gap-1.5 rounded-[9px] bg-[oklch(0.18_0_0/0.78)] px-2.5 text-xs font-medium whitespace-nowrap text-[oklch(0.95_0_0)] backdrop-blur-sm"
          title={`Kept at ${time(kept.capturedAt)}`}
        >
          <span
            aria-hidden="true"
            className="size-1.5 rounded-[1.5px] bg-current"
          />
          Last frame
          <span className="sr-only">
            {" "}
            of the session, kept at {time(kept.capturedAt)}
          </span>
        </span>
        <img
          alt="The last screen this session kept"
          className="h-full max-h-full w-auto max-w-full rounded-[2rem] border-[6px] border-neutral-900 object-contain shadow-xl dark:border-neutral-700"
          src={deviceKeyframePath(platform, sessionId, kept.hash)}
        />
      </div>
    </section>
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
const DeviceVideoBody = ({
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
        This Workspace no longer holds the session, so its video cannot be read
        here.
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
    return <p className="text-muted-foreground text-pretty">{status.reason}</p>;
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
        videoClassName={
          teaching
            ? "max-h-[28rem]"
            : "max-h-[min(18rem,40svh)] max-md:max-h-[24svh]"
        }
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
};

/** A Teaching session's video, under its own heading. */
const DeviceVideo = (props: Parameters<typeof DeviceVideoBody>[0]) => (
  <section aria-labelledby="device-video" className="space-y-2">
    <h3 className="text-muted-foreground text-xs font-medium" id="device-video">
      Video
    </h3>
    <DeviceVideoBody {...props} />
  </section>
);

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
  | "completedAt"
  | "error"
  | "flowName"
  | "id"
  | "kind"
  | "phase"
  | "recordingId"
  | "requirements"
  | "startedAt"
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

const assessmentTone: Record<AgentAssessmentOutcome, SummaryVerdict["tone"]> = {
  blocked: "attention",
  inconclusive: "attention",
  "not-working": "failed",
  working: "passed",
};

const deviceVerdict = (session: SummarySession): SummaryVerdict =>
  session.assessment === null
    ? { label: "No assessment", tone: "attention" }
    : {
        label: OUTCOME[session.assessment.outcome],
        tone: assessmentTone[session.assessment.outcome],
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

const platformName = (platform: DevicePlatform) =>
  platform === "android" ? "Android" : "iOS";

/** The verdict card's platform: a phone glyph and the platform's name. */
const DevicePlatformLabel = ({
  platform,
}: {
  readonly platform: DevicePlatform;
}) => (
  <>
    <SmartphoneIcon aria-hidden="true" />
    {platformName(platform)}
  </>
);

/**
 * The verdict card a Teaching session opens on, when an assessment reached
 * it: the Agent Assessment, the platform, and what kind of session it was.
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
      platform={<DevicePlatformLabel platform={platform} />}
      verdict={verdict}
    />
  );
};

/** What the session ended on, when it ended with an error. */
const SessionError = ({ error }: { readonly error: string | null }) =>
  error === null ? null : (
    <section
      aria-label="Error"
      className="border-destructive/30 bg-destructive/5 flex gap-2.5 rounded-lg border p-3 text-sm"
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="text-destructive mt-0.5 size-4 shrink-0"
      />
      <div className="space-y-1">
        <h3 className="font-medium">The session ended with an error</h3>
        <p className="text-muted-foreground text-pretty">{error}</p>
      </div>
    </section>
  );

/** How the Run executed, as its checklist and Task facts say it. */
interface NativeExecution {
  readonly finished: boolean;
  readonly label: string;
}

/**
 * How an ended live session executed. Submitting the Agent Assessment
 * completes a native Run; the snapshot keeps no other ending, so one that
 * ended without an assessment says only that.
 */
const sessionExecution = (session: SummarySession): NativeExecution => {
  if (session.assessment !== null) {
    return { finished: true, label: runOutcomeLabel.completed };
  }
  return session.phase === "refused"
    ? { finished: false, label: "Refused before it ran" }
    : { finished: false, label: "Ended without an assessment" };
};

/** The Capture Gaps no fresh same-device observation repaired. */
const openCaptureGaps = (
  session: Pick<SummarySession, "captureGaps" | "captureRepairs">
): readonly string[] => {
  const repaired = new Map<string, number>();
  for (const repair of session.captureRepairs ?? []) {
    repaired.set(repair.code, (repaired.get(repair.code) ?? 0) + 1);
  }
  return session.captureGaps.filter((code) => {
    const remaining = repaired.get(code) ?? 0;
    if (remaining === 0) {
      return true;
    }
    repaired.set(code, remaining - 1);
    return false;
  });
};

/**
 * A native Run's checks. A Dry Run passes only when the agent assessed the
 * journey as working with no Takeover and no Capture Gap left open, the
 * rule the device runtime applies (ADR 0078); a Run lists how it ended and
 * its assessment as its record. Browser Checks and scans never apply.
 */
const nativeRunChecks = (
  session: SummarySession,
  execution: NativeExecution
): readonly SummaryCheck[] => {
  const record: readonly SummaryCheck[] = [
    {
      label: "Run finished",
      passed: execution.finished,
      value: execution.label,
    },
    {
      label: "Agent Assessment",
      passed: session.assessment?.outcome === "working",
      value:
        session.assessment === null
          ? "None submitted"
          : OUTCOME[session.assessment.outcome],
    },
  ];
  if (session.kind !== "dry-run") {
    return record;
  }
  const open = openCaptureGaps(session).length;
  return [
    ...record,
    {
      label: "No Takeover",
      passed: !session.takeoverOccurred,
      value: session.takeoverOccurred ? "User took control" : "Agent only",
    },
    {
      label: "Capture complete",
      passed: open === 0,
      value: open === 0 ? "Yes" : `${open} open ${open === 1 ? "gap" : "gaps"}`,
    },
  ];
};

/**
 * Why a native Dry Run cannot pass. The device runtime marks a working
 * assessment inconclusive after a Takeover or an open Capture Gap, so those
 * causes lead over the assessment they changed.
 */
const nativeFailureSentence = (
  checks: readonly SummaryCheck[]
): string | undefined => {
  const failed = ["Run finished", "No Takeover", "Capture complete"]
    .map((label) => checks.find((check) => check.label === label))
    .find((check) => check !== undefined && !check.passed);
  const first = failed ?? checks.find((check) => !check.passed);
  return first === undefined ? undefined : failedCheckSentence(first);
};

/** A native Run's verdict: a Dry Run's pass rule, or a Run's assessment. */
const nativeVerdict = (
  session: SummarySession,
  checks: readonly SummaryCheck[],
  execution: NativeExecution
): SummaryVerdict => {
  if (session.kind === "dry-run") {
    const missed = checks.filter((check) => !check.passed);
    if (missed.length === 0) {
      return { label: "Dry Run passed", tone: "passed" };
    }
    // Only how it was attempted missed: not a broken journey.
    return missed.every((check) => check.label === "No Takeover")
      ? { label: "Dry Run did not pass", tone: "attention" }
      : { label: "Dry Run failed", tone: "failed" };
  }
  if (session.assessment !== null) {
    return deviceVerdict(session);
  }
  return execution.finished
    ? { label: "No assessment", tone: "attention" }
    : { label: execution.label, tone: "failed" };
};

/** The device facts: where the Run ran, how it started, and what it kept. */
const DeviceFacts = ({
  device,
  session,
  targetApp,
}: {
  readonly device: string;
  readonly session: SummarySession;
  readonly targetApp: string;
}) => {
  let takeover = "None";
  if (session.takeoverOccurred) {
    takeover =
      session.kind === "dry-run"
        ? "Occurred; a Dry Run cannot pass"
        : "Occurred";
  }
  return (
    <DetailSection label="Device">
      <DetailFacts>
        {session.kind === "teaching" ? (
          <>
            <dt>Session</dt>
            <dd>{KIND[session.kind]}</dd>
          </>
        ) : null}
        <dt>Device</dt>
        <dd className="wrap-anywhere">{device}</dd>
        <dt>Target App</dt>
        <dd className="font-mono wrap-anywhere">{targetApp}</dd>
        <dt>Starting data</dt>
        <dd>{startingDataLabel(session.requirements)}</dd>
        <dt>Starting Emulation</dt>
        <dd className="text-pretty">
          {startingEmulationLabel(session.requirements)}
        </dd>
        <dt>Takeover</dt>
        <dd>{takeover}</dd>
        <dt>Capture gaps</dt>
        <dd>{gapLabels(session).join(", ") || "None"}</dd>
        <dt>Cleanup</dt>
        <dd className="text-pretty">{cleanupLabel(session)}</dd>
      </DetailFacts>
    </DetailSection>
  );
};

/** The verdict card's facts: the kind of Run, and when it ended. */
const sessionFacts = (kind: string, session: SummarySession) => {
  const when =
    session.completedAt === null
      ? undefined
      : runSummaryWhen(session.completedAt);
  return when === undefined ? [kind] : [kind, when];
};

/**
 * The four numbers. A native Run records no action list or findings, so it
 * counts the screens it kept, and its one piece of evidence is the
 * observation its assessment cites.
 */
const nativeStats = (
  session: SummarySession,
  keyframes: ReturnType<typeof useDeviceKeyframes>["result"]
): readonly RunSummaryStat[] => [
  {
    label: "Duration",
    value:
      session.completedAt === null
        ? "–"
        : runDuration({
            endedAt: session.completedAt,
            startedAt: session.startedAt,
          }),
  },
  {
    label: "Screens",
    value:
      AsyncResult.isSuccess(keyframes) && keyframes.value !== null
        ? keyframes.value.keyframes.length
        : "–",
  },
  { label: "Findings", value: 0 },
  { label: "Evidence", value: session.assessment === null ? 0 : 1 },
];

/**
 * Whether the kept screens stand in for the video. While the video renders
 * or once it plays, it is the evidence; Cleanup deletes both together.
 */
const screensStandIn = (
  result: ReturnType<typeof useDeviceVideo>["result"]
): boolean => {
  if (result._tag === "Failure") {
    return true;
  }
  if (!AsyncResult.isSuccess(result)) {
    return false;
  }
  return (
    result.value === null ||
    result.value.state === "not-recorded" ||
    result.value.state === "unavailable"
  );
};

/**
 * An ended native Run or Dry Run in the Run Summary's shared frame (#757,
 * #778): the verdict, the device's video, four numbers, then Pass checks (or
 * Checks), Findings and Task, whose Device facts replace the browser's
 * sections (ADR 0078). Without a video to play, the screens the session kept
 * stand in for it under the video's place.
 */
const NativeRunSummaryLayout = ({
  device,
  execution,
  links,
  platform,
  runId,
  session,
  stageShowsLastScreen,
  targetApp,
}: {
  readonly device: string;
  readonly execution: NativeExecution;
  readonly links: React.ReactNode;
  readonly platform: DevicePlatform;
  readonly runId: string | undefined;
  readonly session: SummarySession;
  readonly stageShowsLastScreen: boolean;
  readonly targetApp: string;
}) => {
  const cleanup = deviceCleanupKey(session.cleanup);
  const video = useDeviceVideo(platform, session.id, cleanup);
  const { result: keyframes } = useDeviceKeyframes(
    platform,
    session.id,
    cleanup
  );
  const checks = nativeRunChecks(session, execution);
  const kind = KIND[session.kind];
  const dryRun = session.kind === "dry-run";
  return (
    <RunSummaryFrame
      checks={checks}
      checksDetail={
        session.assessment === null ? (
          <p className="text-muted-foreground text-sm">
            No Agent Assessment submitted.
          </p>
        ) : (
          <EvidenceReference
            id={session.assessment.observationId}
            kind="observation"
          />
        )
      }
      checksLabel={dryRun ? "Pass checks" : "Run checks"}
      checksTab={dryRun ? "Pass checks" : "Checks"}
      explanation={session.assessment?.explanation}
      facts={sessionFacts(kind, session)}
      failure={dryRun ? nativeFailureSentence(checks) : undefined}
      findings={
        <p className="text-muted-foreground text-sm">
          The agent reported no findings.
        </p>
      }
      findingsCount={0}
      footer={
        <RunSummaryFooter
          id={runId ?? session.id}
          kind={runId === undefined ? "Session ID" : "Run ID"}
          links={links}
        />
      }
      notice={<SessionError error={session.error} />}
      platform={<DevicePlatformLabel platform={platform} />}
      stats={nativeStats(session, keyframes)}
      task={
        <>
          <DetailSection heading="Referenced Flows" label="Referenced flows">
            <ul className="flex flex-wrap gap-1.5">
              <li className="max-w-full">
                <FlowPill example={false} name={session.flowName} />
              </li>
            </ul>
          </DetailSection>
          <DeviceFacts
            device={device}
            session={session}
            targetApp={targetApp}
          />
          <RunSummaryTaskFacts>
            <dt>Execution</dt>
            <dd>{execution.label}</dd>
          </RunSummaryTaskFacts>
        </>
      }
      title={`${kind} of ${session.flowName}`}
      verdict={nativeVerdict(session, checks, execution)}
      video={
        <section aria-label="Run video" className="space-y-2 text-sm">
          <DeviceVideoBody
            platform={platform}
            result={video.result}
            retry={video.refresh}
            seekRequest={undefined}
            sessionId={session.id}
            teaching={false}
          />
          {screensStandIn(video.result) ? (
            <DeviceRecording
              cleanup={cleanup}
              onShow={undefined}
              platform={platform}
              sessionId={session.id}
              stageShowsLastScreen={stageShowsLastScreen}
            />
          ) : null}
        </section>
      }
    />
  );
};

/**
 * An ended Teaching session's summary. Teaching records a journey; no agent
 * assesses it, so it leads with the video and the screens it kept rather than
 * with an assessment that never comes.
 */
const TeachingSummary = ({
  device,
  platform,
  session,
  stageShowsLastScreen,
  targetApp,
}: {
  readonly device: string;
  readonly platform: DevicePlatform;
  readonly session: SummarySession;
  readonly stageShowsLastScreen: boolean;
  readonly targetApp: string;
}) => (
  <div className="space-y-5 text-sm">
    <SessionError error={session.error} />
    {session.assessment === null ? null : (
      <>
        <DeviceVerdictCard platform={platform} session={session} />
        <section className="space-y-1">
          <h3 className="text-muted-foreground text-xs font-medium">
            Agent Assessment
          </h3>
          <p className="font-medium">{OUTCOME[session.assessment.outcome]}</p>
          <p className="text-muted-foreground text-pretty">
            {session.assessment.explanation}
          </p>
          <EvidenceReference
            id={session.assessment.observationId}
            kind="observation"
          />
        </section>
      </>
    )}
    <DeviceEvidence
      cleanup={deviceCleanupKey(session.cleanup)}
      platform={platform}
      sessionId={session.id}
      stageShowsLastScreen={stageShowsLastScreen}
      teaching
    />
    <DeviceFacts device={device} session={session} targetApp={targetApp} />
  </div>
);

/**
 * An ended device session's Run Summary, in the browser summary's place. A
 * Run or Dry Run reads like a browser Run's summary; Teaching shows what it
 * recorded.
 */
export const DeviceRunSummary = ({
  device,
  links,
  outcome,
  platform,
  runId,
  session,
  stageShowsLastScreen = true,
  targetApp,
}: {
  readonly device: string;
  /** Ways out of the summary, beside its Run ID. */
  readonly links?: React.ReactNode;
  /** How a persisted Run ended, said apart from its Agent Assessment. */
  readonly outcome?: AgentTaskRunOutcome | undefined;
  readonly platform: DevicePlatform;
  /** The persisted Run's ID; an ended live session names itself instead. */
  readonly runId?: string | undefined;
  readonly session: SummarySession;
  /**
   * Whether the session's stage beside the summary holds its last screen.
   * Away from the stage, as on the Flows page, a lone screen draws inline.
   */
  readonly stageShowsLastScreen?: boolean;
  readonly targetApp: string;
}) =>
  session.kind === "teaching" ? (
    <TeachingSummary
      device={device}
      platform={platform}
      session={session}
      stageShowsLastScreen={stageShowsLastScreen}
      targetApp={targetApp}
    />
  ) : (
    <NativeRunSummaryLayout
      device={device}
      execution={
        outcome === undefined
          ? sessionExecution(session)
          : {
              finished: outcome === "completed",
              label: runOutcomeLabel[outcome],
            }
      }
      links={links}
      platform={platform}
      runId={runId}
      session={session}
      stageShowsLastScreen={stageShowsLastScreen}
      targetApp={targetApp}
    />
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
 * catalog lists it, or `null` when no recording is listed. Its Run ID closes
 * it, with `links` beside it.
 */
export const NativeRunSummary = ({
  cleanup,
  links,
  summary,
}: {
  readonly cleanup: TeachingRecordingCleanupState["_tag"] | null;
  readonly links?: React.ReactNode;
  readonly summary: NativeAgentRunSummary;
}) => {
  const session: Mutable<SummarySession> = {
    assessment: summary.assessment,
    captureGaps: summary.captureGaps,
    cleanup: catalogCleanup(cleanup, summary.endedAt),
    completedAt: summary.endedAt,
    error: null,
    flowName: summary.flowName,
    id: summary.sessionId,
    kind: summary.kind,
    phase: "closed",
    recordingId: summary.recordingId,
    requirements: summary.requirements,
    startedAt: summary.startedAt,
    takeoverOccurred: summary.takeoverOccurred,
  };
  if (summary.captureRepairs !== undefined) {
    session.captureRepairs = summary.captureRepairs;
  }
  return (
    <DeviceRunSummary
      device={requiredDevice(summary.requirements)}
      links={links}
      outcome={summary.outcome}
      platform={summary.platform}
      runId={summary.runId}
      session={session}
      stageShowsLastScreen={false}
      targetApp={requiredTargetApp(summary.requirements)}
    />
  );
};
