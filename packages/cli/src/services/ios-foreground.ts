import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Duration, Effect, Ref } from "effect";

import type { PlatformRuntimeError } from "./platform-runtime.ts";

/**
 * How the iOS observer follows whichever app is in front (ADR 0083).
 * agent-device observes only the app its session is bound to, so the
 * observer reads Springboard's tree to learn which app is in front and binds
 * the session to it. Binding to an app activates it, which is safe only for
 * the app already in front.
 */
export const SPRINGBOARD = "com.apple.springboard";

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
interface Size {
  readonly width: number;
  readonly height: number;
}
interface ForegroundNode {
  readonly identifier?: string | undefined;
  readonly type?: string | undefined;
  readonly rect?: Rect | undefined;
}

/** Rects are in points; a point of rounding is not a different frame. */
const near = (left: number, right: number, tolerance = 1) =>
  Math.abs(left - right) <= tolerance;
/** Either way up, since a rotated screen swaps its sides. */
const fits = (width: number, height: number, size: Size, tolerance = 1) =>
  (near(width, size.width, tolerance) &&
    near(height, size.height, tolerance)) ||
  (near(width, size.height, tolerance) && near(height, size.width, tolerance));
const covers = (rect: Rect, size: Size) =>
  near(rect.x, 0) && near(rect.y, 0) && fits(rect.width, rect.height, size);

const cardPattern = /^card:(?<bundle>[^:]+):/u;

/**
 * The app Springboard's tree shows in front, or null for Springboard itself.
 * With an app in front, Springboard's switcher window holds exactly one card,
 * `card:<bundle>:sceneID:…`, covering the screen. The Home Screen has no
 * card; the App Switcher shows several, or one at a partial rect.
 */
export const springboardForeground = <Node extends ForegroundNode>(snapshot: {
  readonly nodes: readonly Node[];
  readonly viewport?: Size | undefined;
}): string | null => {
  const cards = new Map<string, Node>();
  for (const node of snapshot.nodes) {
    const identifier = node.identifier ?? "";
    if (cardPattern.test(identifier) && !cards.has(identifier)) {
      cards.set(identifier, node);
    }
  }
  const [only] = cards;
  if (cards.size !== 1 || only === undefined || !snapshot.viewport) {
    return null;
  }
  const [identifier, card] = only;
  const bundle = cardPattern.exec(identifier)?.groups?.bundle;
  return bundle !== undefined &&
    bundle !== SPRINGBOARD &&
    card.rect !== undefined &&
    covers(card.rect, snapshot.viewport)
    ? bundle
    : null;
};

/** iPhone simulators draw 2 or 3 pixels per point. */
const scales = [3, 2, 1] as const;

/**
 * Whether a bound app's tree proves the app is in front: its root covers the
 * whole screen the screenshot shows. A bound app keeps reporting the
 * foreground for a moment after Home, with a root that shrinks toward its
 * icon, and for as long as the App Switcher is open, with a root the size of
 * its card and offset from the corner. A presented system alert arrives as
 * the root itself and keeps its app in front. A root without a frame proves
 * nothing either way, so it is not taken as Springboard.
 */
export const fillsScreen = (
  root: ForegroundNode | undefined,
  pixels: Size
): boolean => {
  if (root?.rect === undefined || root.type === "Alert") {
    return true;
  }
  const { rect } = root;
  return (
    near(rect.x, 0) &&
    near(rect.y, 0) &&
    // A point of rounding is up to `scale` pixels.
    scales.some((scale) =>
      fits(rect.width * scale, rect.height * scale, pixels, scale)
    )
  );
};

export interface IosProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly priority: number;
  readonly command: string;
}

const processLine =
  /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<priority>-?\d+)\s+(?<command>\S.*)$/u;

/** `ps -axo pid=,ppid=,pri=,command=`; lines it cannot read are skipped. */
export const parseProcessTable = (text: string): readonly IosProcess[] =>
  text.split(/\r?\n/u).flatMap((line) => {
    const groups = processLine.exec(line)?.groups;
    if (
      groups?.pid === undefined ||
      groups.ppid === undefined ||
      groups.priority === undefined ||
      groups.command === undefined
    ) {
      return [];
    }
    return [
      {
        command: groups.command,
        pid: Number(groups.pid),
        ppid: Number(groups.ppid),
        priority: Number(groups.priority),
      },
    ];
  });

/**
 * UIKit hosts the session never binds to. Measured on iOS 26.5: the Home
 * Screen's widget renderer runs as high as the app in front while widgets
 * show, and agent-device's XCTest runner, an app too, runs at 31.
 */
const neverInFront = (bundle: string) =>
  bundle.startsWith("com.apple.chrono.WidgetRenderer") ||
  bundle.endsWith(".xctrunner");

const uikitLine =
  /^(?<pid>\d+)\s+\S+\s+UIKitApplication:(?<bundle>[^[\s]+)(?:\[|\s|$)/u;

/**
 * The simulator's running apps by host pid, from `launchctl list` inside it:
 * `PID Status Label`, with apps labelled `UIKitApplication:<bundle>[…]`.
 */
export const parseUikitApplications = (
  text: string
): ReadonlyMap<number, string> =>
  new Map(
    text.split(/\r?\n/u).flatMap((line) => {
      const groups = uikitLine.exec(line.trim())?.groups;
      return groups?.pid === undefined ||
        groups.bundle === undefined ||
        neverInFront(groups.bundle)
        ? []
        : [[Number(groups.pid), groups.bundle] as const];
    })
  );

/**
 * Scheduling priority on the host. Measured on iOS 26.5: the app in front
 * runs at 47, or 53 while the App Switcher is open; apps in the background
 * at 4; the XCTest runner at 31. On the Home Screen no app is high. The
 * bounds leave margin on both sides of those values.
 */
export const FOREGROUND_PRIORITY = 40;
export const BACKGROUND_PRIORITY = 20;

/** The simulator's `launchd_sim`, by the UDID in its command line. */
const simulatorLaunchd = (
  processes: readonly IosProcess[],
  udid: string
): IosProcess | undefined => {
  const matches = processes.filter(
    (entry) =>
      entry.command.includes("launchd_sim") && entry.command.includes(udid)
  );
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * The one app that stands clearly above every other app on this simulator,
 * or null when none or several do. It is a guess the observer verifies, so
 * an unclear reading is never taken. `behind` names an app known not to be
 * in front, such as the bound app agent-device just refused to observe; it
 * may still run high while it hands over, so it is left out.
 */
export const foregroundByPriority = (
  processes: readonly IosProcess[],
  apps: ReadonlyMap<number, string>,
  udid: string,
  behind?: string
): string | null => {
  const launchd = simulatorLaunchd(processes, udid);
  if (launchd === undefined) {
    return null;
  }
  const running = processes.filter(
    (entry) =>
      entry.ppid === launchd.pid &&
      apps.has(entry.pid) &&
      apps.get(entry.pid) !== behind
  );
  const high = running.filter((entry) => entry.priority >= FOREGROUND_PRIORITY);
  const [winner] = high;
  if (
    high.length !== 1 ||
    winner === undefined ||
    running.some(
      (entry) => entry !== winner && entry.priority >= BACKGROUND_PRIORITY
    )
  ) {
    return null;
  }
  return apps.get(winner.pid) ?? null;
};

/** High processes on the simulator that the app list does not name. */
const unlisted = (
  processes: readonly IosProcess[],
  apps: ReadonlyMap<number, string>,
  udid: string
) => {
  const launchd = simulatorLaunchd(processes, udid);
  return launchd === undefined
    ? []
    : processes.flatMap((entry) =>
        entry.ppid === launchd.pid &&
        entry.priority >= FOREGROUND_PRIORITY &&
        !apps.has(entry.pid)
          ? [entry.pid]
          : []
      );
};

/** Readings of an unclear guess, spaced to outlast an app switch. */
export const GUESS_READINGS = 4;
export const GUESS_SPACING = Duration.millis(500);

/** Host reads the priority guess needs; tests substitute their own. */
export interface IosHostProcesses {
  /** `ps -axo pid=,ppid=,pri=,command=` on the host. */
  readonly table: Effect.Effect<string, PlatformRuntimeError>;
  /** `launchctl list` inside the simulator. */
  readonly launchctl: (
    udid: string
  ) => Effect.Effect<string, PlatformRuntimeError>;
}

const execute = promisify(execFile);
const run = (file: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: (): PlatformRuntimeError => ({
      _tag: "PlatformRuntimeError",
      code: "runtime_failed",
      message: "iOS could not read the simulator's processes.",
      operation: "host-io",
    }),
    try: async (signal) => {
      const { stdout } = await execute(file, args, {
        maxBuffer: 16 * 1024 * 1024,
        signal,
        timeout: 30_000,
      });
      return stdout;
    },
  });

export const iosHostProcesses: IosHostProcesses = {
  launchctl: (udid) =>
    run("xcrun", ["simctl", "spawn", udid, "launchctl", "list"]),
  table: run("ps", ["-axo", "pid=,ppid=,pri=,command="]),
};

/**
 * Guesses the app in front of one simulator from host scheduling priority.
 * The simulator's app list costs about a second, so it is cached and read
 * again only when a high process is missing from it and was not missing at
 * the last read, as Springboard always is. Any failure reads as no guess.
 */
export const makeIosForegroundGuess = (
  host: IosHostProcesses,
  udid: string
) => {
  let apps: ReadonlyMap<number, string> | undefined;
  /** High processes the last read showed are not apps. */
  let others = new Set<number>();
  const refresh = (processes: readonly IosProcess[]) =>
    host.launchctl(udid).pipe(
      Effect.map(parseUikitApplications),
      Effect.tap((listed) =>
        Effect.sync(() => {
          apps = listed;
          others = new Set(unlisted(processes, listed, udid));
        })
      )
    );
  const once = (behind: string | undefined) =>
    Effect.gen(function* guessForeground() {
      const processes = parseProcessTable(yield* host.table);
      let listed = apps ?? (yield* refresh(processes));
      if (unlisted(processes, listed, udid).some((pid) => !others.has(pid))) {
        listed = yield* refresh(processes);
      }
      return foregroundByPriority(processes, listed, udid, behind);
    }).pipe(Effect.orElseSucceed(() => null));
  // For about a second after another app comes forward, the app it replaced
  // still runs high (measured on iOS 26.5), so an unclear reading is read
  // again before it counts as no guess.
  return (behind?: string) =>
    Effect.gen(function* settledGuess() {
      for (let reading = 1; reading < GUESS_READINGS; reading += 1) {
        const front = yield* once(behind);
        if (front !== null) {
          return front;
        }
        yield* Effect.sleep(GUESS_SPACING);
      }
      return yield* once(behind);
    });
};

/** One observation attempt against the bound app. */
export type ForegroundStep<A> =
  | { readonly _tag: "observed"; readonly value: A }
  /** Another app is in front; bind to it and observe again. */
  | { readonly _tag: "follow"; readonly app: string };

/**
 * Observes the app in front, binding the session to it first when an attempt
 * shows another app there. Each bind is checked by the next attempt; past
 * `limit` binds the capture is stale, so the caller observes again later.
 */
export const followForeground = <A>(input: {
  readonly bound: Ref.Ref<string>;
  readonly attempt: (
    bound: string
  ) => Effect.Effect<ForegroundStep<A>, PlatformRuntimeError>;
  readonly bind: (app: string) => Effect.Effect<void, PlatformRuntimeError>;
  readonly stale: PlatformRuntimeError;
  readonly limit?: number;
}) =>
  Effect.gen(function* follow() {
    const limit = input.limit ?? 3;
    for (let binds = 0; binds <= limit; binds += 1) {
      const step = yield* input.attempt(yield* Ref.get(input.bound));
      if (step._tag === "observed") {
        return step.value;
      }
      if (binds === limit) {
        break;
      }
      yield* input.bind(step.app);
      yield* Ref.set(input.bound, step.app);
    }
    return yield* Effect.fail(input.stale);
  });
