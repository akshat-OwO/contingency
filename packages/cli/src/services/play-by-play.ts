import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentBrowserSnapshot,
  CapturedAction,
  TeachingInstruction,
  UrlTransition,
} from "@contingency/protocol";
import { Effect } from "effect";
import { registry as playwrightRegistry } from "playwright-core/lib/coreBundle";

import type { Demonstration } from "./agent-flow-compiler.ts";

/** How many timeline lines one finalized PlayByPlay keeps. */
const LINE_LIMIT = 400;
/** Two samples per second preserve short UI changes without retaining pixels. */
const VIDEO_SAMPLES_PER_SECOND = 2;
/** Tiny image samples make the analysis cost independent of viewport size. */
const VIDEO_SAMPLE_EDGE = 8;
/** Ten minutes at the configured rate bounds temporary files and decode time. */
const VIDEO_SAMPLE_LIMIT = VIDEO_SAMPLES_PER_SECOND * 60 * 10;
const VIDEO_ANALYSIS_TIMEOUT_MS = 30_000;
const PAGE_METADATA_LIMIT = 20;
const executeFile = promisify(execFile);

/** One thing that happened, as the narrative orders it. */
interface TimelineEvent {
  readonly at: string;
  readonly sentence: string;
}

export interface LocalVideoAnalysis {
  readonly sampledFrames: number;
  readonly visualChanges: number;
}

export interface PlayByPlayAnalysisInput {
  readonly demonstration: Demonstration;
  /** Sensitive local path. It is read here and never placed in the Feed. */
  readonly videoFile: string | undefined;
}

export type PlayByPlayAnalyzer = (
  input: PlayByPlayAnalysisInput
) => Effect.Effect<string, Error>;

const actorName = (actor: CapturedAction["actor"]): string =>
  actor === "user" ? "The user" : "The agent";

const outcomeSuffix = (outcome: CapturedAction["outcome"]): string => {
  if (outcome === "completed") {
    return "";
  }
  return outcome === "failed" ? ", which failed" : `, which was ${outcome}`;
};

const snapshotFor = (
  demonstration: Demonstration,
  action: CapturedAction
): AgentBrowserSnapshot | undefined => {
  const after = action.snapshotAfter;
  if (after !== null) {
    const snapshot = demonstration.snapshots.get(after);
    if (snapshot !== undefined) {
      return snapshot;
    }
  }
  const before = action.snapshotBefore;
  return before === null ? undefined : demonstration.snapshots.get(before);
};

const pagePrefix = (snapshot: AgentBrowserSnapshot | undefined): string => {
  const title = snapshot?.title.trim();
  return title === undefined || title.length === 0 ? "" : `On “${title}”, `;
};

const pastTenseDescription = (description: string): string =>
  description
    .replace(/^Navigate\b/u, "navigated")
    .replace(/^Reload\b/u, "reloaded")
    .replace(/^Go\b/u, "went")
    .replace(/^Click\b/u, "clicked")
    .replace(/^Hover\b/u, "hovered")
    .replace(/^Fill\b/u, "filled")
    .replace(/^Select\b/u, "selected")
    .replace(/^Press\b/u, "pressed")
    .replace(/^Scroll\b/u, "scrolled")
    .replace(/^Wait\b/u, "waited");

const actionSentence = (
  demonstration: Demonstration,
  action: CapturedAction
): string => {
  const snapshot = snapshotFor(demonstration, action);
  const moved =
    action.urlAfter === action.urlBefore || action.action.type === "navigate"
      ? ""
      : `, taking the Page to ${action.urlAfter}`;
  const subject =
    snapshot === undefined
      ? actorName(action.actor)
      : actorName(action.actor).toLowerCase();
  return `${pagePrefix(snapshot)}${subject} ${pastTenseDescription(action.description)}${outcomeSuffix(action.outcome)}${moved}.`;
};

const transitionSentence = (transition: UrlTransition): string =>
  `The Page moved from ${transition.from} to ${transition.to} without a captured action.`;

const instructionSentence = (instruction: TeachingInstruction): string => {
  const punctuation = /[.!?]$/u.test(instruction.text) ? "" : ".";
  return `The user said: “${instruction.text}”${punctuation}`;
};

const uniquePageMetadata = (
  demonstration: Demonstration
): readonly AgentBrowserSnapshot[] => {
  const seen = new Set<string>();
  const pages: AgentBrowserSnapshot[] = [];
  for (const snapshot of demonstration.snapshots.values()) {
    const title = snapshot.title.trim();
    const key = `${snapshot.url}\n${title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pages.push(snapshot);
    if (pages.length === PAGE_METADATA_LIMIT) {
      break;
    }
  }
  return pages;
};

const pageMetadataSentence = (snapshot: AgentBrowserSnapshot): string => {
  const title = snapshot.title.trim();
  return title.length === 0
    ? `Browser evidence identified a Page at ${snapshot.url}.`
    : `Browser evidence identified “${title}” at ${snapshot.url}.`;
};

/**
 * Turn one local-video analysis and its browser cross-check evidence into the
 * prose an external agent compiles. No video bytes or local paths enter it.
 */
export const playByPlayFromAnalysis = (
  demonstration: Demonstration,
  video: LocalVideoAnalysis
): string => {
  const events: TimelineEvent[] = [
    ...demonstration.actions.map((action) => ({
      at: action.at,
      sentence: actionSentence(demonstration, action),
    })),
    // A transition an action caused is already narrated by that action.
    ...demonstration.urlTransitions.flatMap((transition) =>
      transition.actionId === null
        ? [{ at: transition.at, sentence: transitionSentence(transition) }]
        : []
    ),
    ...demonstration.instructions.map((instruction) => ({
      at: instruction.at,
      sentence: instructionSentence(instruction),
    })),
  ].toSorted((left, right) => left.at.localeCompare(right.at));
  const timeline = events.slice(Math.max(0, events.length - LINE_LIMIT));
  const pages = uniquePageMetadata(demonstration).map(pageMetadataSentence);
  const opening =
    `Contingency analyzed ${video.sampledFrames} moments from the local Teaching video and found ${video.visualChanges} visually distinct changes. ` +
    `The timeline was cross-checked against ${demonstration.actions.length} captured actions, ${demonstration.urlTransitions.length} URL transitions, and ${demonstration.snapshots.size} Browser Snapshots.`;
  const body =
    timeline.length === 0
      ? ["The user ended Teaching without a captured browser action."]
      : timeline.map(({ sentence }) => sentence);
  return [opening, ...pages, ...body].join("\n");
};

const summarizeFrames = (frames: readonly Buffer[]): LocalVideoAnalysis => {
  const sampledFrames = frames.length;
  if (sampledFrames === 0) {
    throw new Error("The Teaching video contained no decodable frames.");
  }
  let visualChanges = 0;
  for (let index = 1; index < sampledFrames; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      !previous.equals(current)
    ) {
      visualChanges += 1;
    }
  }
  return { sampledFrames, visualChanges };
};

/** Decode bounded PNG samples from the local Playwright video. */
const analyzeLocalVideo = (
  videoFile: string
): Effect.Effect<LocalVideoAnalysis, Error> =>
  Effect.tryPromise({
    // Decoder failures can include the local input path in their command and
    // stderr. The MCP error must not disclose that sensitive artifact path.
    catch: () => new Error("The local Teaching video could not be decoded."),
    try: async () => {
      const executable = playwrightRegistry.registry.findExecutable("ffmpeg");
      if (executable === undefined) {
        throw new Error("Playwright's ffmpeg executable is unavailable.");
      }
      const directory = await mkdtemp(path.join(tmpdir(), "contingency-pbp-"));
      try {
        await executeFile(
          executable.executablePath(),
          [
            "-loglevel",
            "error",
            "-i",
            videoFile,
            "-vf",
            `scale=${VIDEO_SAMPLE_EDGE}:${VIDEO_SAMPLE_EDGE}`,
            "-r",
            String(VIDEO_SAMPLES_PER_SECOND),
            "-frames:v",
            String(VIDEO_SAMPLE_LIMIT),
            "-c:v",
            "png",
            path.join(directory, "frame-%06d.png"),
          ],
          { timeout: VIDEO_ANALYSIS_TIMEOUT_MS }
        );
        const entries = await readdir(directory);
        const files = entries
          .filter((file) => file.endsWith(".png"))
          .toSorted();
        const frames = await Promise.all(
          files.map((file) => readFile(path.join(directory, file)))
        );
        return summarizeFrames(frames);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  });

/** Finalize the PlayByPlay from the local video and captured cross-checks. */
export const analyzePlayByPlay: PlayByPlayAnalyzer = ({
  demonstration,
  videoFile,
}) => {
  if (videoFile === undefined) {
    return Effect.fail(
      new Error("Teaching did not produce a local video to analyze.")
    );
  }
  return analyzeLocalVideo(videoFile).pipe(
    Effect.map((video) => playByPlayFromAnalysis(demonstration, video))
  );
};
