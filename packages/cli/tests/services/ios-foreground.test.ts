import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  GUESS_READINGS,
  GUESS_SPACING,
  SPRINGBOARD,
  fillsScreen,
  followForeground,
  foregroundByPriority,
  makeIosForegroundGuess,
  parseProcessTable,
  parseUikitApplications,
  springboardForeground,
} from "../../src/services/ios-foreground.ts";
import type { ForegroundStep } from "../../src/services/ios-foreground.ts";
import { iosRuntimeError } from "../../src/services/ios-runtime.ts";

const udid = "F69D9CE5-20E1-4388-9EBA-27B1782EEF75";
const viewport = { height: 874, width: 402 };
const pixels = { height: 2622, width: 1206 };
const springboardWindow = {
  identifier: "SBSwitcherWindow:Main",
  rect: { height: 874, width: 402, x: 0, y: 0 },
  type: "Window",
};

it("reads the app in front from Springboard's switcher card", () => {
  // An app in front: one card covering the screen.
  expect(
    springboardForeground({
      nodes: [
        { rect: { height: 874, width: 402, x: 0, y: 0 }, type: "Application" },
        springboardWindow,
        {
          identifier:
            "card:com.apple.Preferences:sceneID:com.apple.Preferences-default",
          rect: { height: 874, width: 402, x: 0, y: 0 },
          type: "Other",
        },
      ],
      viewport,
    })
  ).toBe("com.apple.Preferences");
  // A landscape app's card swaps the screen's sides.
  expect(
    springboardForeground({
      nodes: [
        {
          identifier: "card:com.apple.mobilesafari:sceneID:1",
          rect: { height: 402, width: 874, x: 0, y: 0 },
        },
      ],
      viewport,
    })
  ).toBe("com.apple.mobilesafari");
});

it("reads Springboard itself on the Home Screen and in the App Switcher", () => {
  // The Home Screen: icons and the dock, no card.
  expect(
    springboardForeground({
      nodes: [
        { rect: { height: 874, width: 402, x: 0, y: 0 }, type: "Application" },
        { label: "Settings", rect: { height: 64, width: 64, x: 24, y: 80 } },
        { label: "Page 1 of 2", type: "PageIndicator" },
      ],
      viewport,
    })
  ).toBeNull();
  // The App Switcher: several cards at partial rects.
  expect(
    springboardForeground({
      nodes: [
        springboardWindow,
        {
          identifier: "card:com.apple.Preferences:sceneID:1",
          rect: { height: 597, width: 275, x: 64, y: 121 },
        },
        {
          identifier: "card:com.apple.MobileAddressBook:sceneID:1",
          rect: { height: 597, width: 127, x: 275, y: 121 },
        },
        { identifier: "handoff-banner" },
      ],
      viewport,
    })
  ).toBeNull();
  // One recent app in the App Switcher: one card, but not the whole screen.
  expect(
    springboardForeground({
      nodes: [
        {
          identifier: "card:com.apple.Preferences:sceneID:1",
          rect: { height: 597, width: 275, x: 64, y: 121 },
        },
      ],
      viewport,
    })
  ).toBeNull();
  // Without a viewport no card can be shown to cover the screen.
  expect(
    springboardForeground({
      nodes: [
        {
          identifier: "card:com.apple.Preferences:sceneID:1",
          rect: { height: 874, width: 402, x: 0, y: 0 },
        },
      ],
    })
  ).toBeNull();
});

it("takes only a full-screen root as proof the bound app is in front", () => {
  expect(
    fillsScreen(
      { rect: { height: 874, width: 402, x: 0, y: 0 }, type: "Application" },
      pixels
    )
  ).toBe(true);
  // Rotated: the screenshot turns with the app.
  expect(
    fillsScreen(
      { rect: { height: 402, width: 874, x: 0, y: 0 }, type: "Application" },
      { height: 1206, width: 2622 }
    )
  ).toBe(true);
  // While the App Switcher is open the previous app still reports the
  // foreground, with a card-sized root offset from the corner.
  expect(
    fillsScreen(
      {
        rect: { height: 597, width: 127, x: 275, y: 121 },
        type: "Application",
      },
      pixels
    )
  ).toBe(false);
  // For a moment after Home, the root shrinks toward the app's icon.
  expect(
    fillsScreen(
      { rect: { height: 790, width: 363, x: 0, y: 0 }, type: "Application" },
      pixels
    )
  ).toBe(false);
  // A presented system alert arrives as the root and keeps its app in front.
  expect(
    fillsScreen(
      { rect: { height: 326, width: 320, x: 41, y: 288 }, type: "Alert" },
      pixels
    )
  ).toBe(true);
  // A root with no frame proves nothing, so it is not taken as Springboard.
  expect(fillsScreen({ type: "Application" }, pixels)).toBe(true);
  expect(fillsScreen(undefined, pixels)).toBe(true);
});

const launchd = `  900     1  31 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist`;
const table = (rows: readonly string[]) => [launchd, ...rows].join("\n");
const apps = parseUikitApplications(
  [
    "PID\tStatus\tLabel",
    "1001\t0\tUIKitApplication:com.apple.mobilesafari[4a1b][rb-legacy]",
    "1002\t0\tUIKitApplication:com.apple.Preferences[9c2d][rb-legacy]",
    "1003\t0\tUIKitApplication:dev.contingency.ioslogin[77aa][rb-legacy]",
    // The Home Screen's widget renderer and agent-device's runner are
    // never bound.
    "1005\t0\tUIKitApplication:com.callstack.agentdevice.runner.uitests.xctrunner[5e5e][rb-legacy]",
    "1006\t0\tUIKitApplication:com.apple.chrono.WidgetRenderer-Default[73ca][rb-legacy]",
    "-\t0\tUIKitApplication:com.apple.Maps[0f0f][rb-legacy]",
    "1004\t0\tcom.apple.SpringBoard",
  ].join("\n")
);

it("reads the simulator's apps from launchctl", () => {
  expect([...apps]).toEqual([
    [1001, "com.apple.mobilesafari"],
    [1002, "com.apple.Preferences"],
    [1003, "dev.contingency.ioslogin"],
  ]);
  expect(parseUikitApplications("not launchctl output")).toEqual(new Map());
});

it("guesses the app in front only when one app stands clearly above the rest", () => {
  // Safari came forward from a link: 47 against background apps at 4.
  expect(
    foregroundByPriority(
      parseProcessTable(
        table([
          " 1001   900  47 /Applications/MobileSafari.app/MobileSafari",
          " 1002   900   4 /Applications/Preferences.app/Preferences",
          " 1003   900   4 /data/Containers/Bundle/Login.app/Login",
          // SpringBoard and the runner are not apps the session can bind to.
          " 1004   900  47 /System/Library/CoreServices/SpringBoard.app/SpringBoard",
          " 1005   900  31 /tmp/AgentDeviceRunner.xctest",
          " 1006   900  47 /System/Library/PrivateFrameworks/ChronoCore.framework/WidgetRenderer",
          // Another simulator's app is not this simulator's.
          " 2001   950  47 /Applications/MobileSafari.app/MobileSafari",
        ])
      ),
      apps,
      udid
    )
  ).toBe("com.apple.mobilesafari");
  // The Home Screen: no app is high.
  expect(
    foregroundByPriority(
      parseProcessTable(
        table([
          " 1001   900   4 /Applications/MobileSafari.app/MobileSafari",
          " 1002   900   4 /Applications/Preferences.app/Preferences",
        ])
      ),
      apps,
      udid
    )
  ).toBeNull();
  // Two high apps, or one high and one in between, are ambiguous.
  expect(
    foregroundByPriority(
      parseProcessTable(
        table([
          " 1001   900  47 /Applications/MobileSafari.app/MobileSafari",
          " 1002   900  53 /Applications/Preferences.app/Preferences",
        ])
      ),
      apps,
      udid
    )
  ).toBeNull();
  expect(
    foregroundByPriority(
      parseProcessTable(
        table([
          " 1001   900  47 /Applications/MobileSafari.app/MobileSafari",
          " 1002   900  25 /Applications/Preferences.app/Preferences",
        ])
      ),
      apps,
      udid
    )
  ).toBeNull();
  // An app known to be behind is left out while it hands over.
  expect(
    foregroundByPriority(
      parseProcessTable(
        table([
          " 1002   900  47 /Applications/Preferences.app/Preferences",
          " 1003   900  47 /data/Containers/Bundle/Login.app/Login",
        ])
      ),
      apps,
      udid,
      "dev.contingency.ioslogin"
    )
  ).toBe("com.apple.Preferences");
});

it("never guesses from malformed or unrelated process output", () => {
  expect(parseProcessTable("garbage\n  12 x 4 cmd\n")).toEqual([]);
  expect(foregroundByPriority(parseProcessTable("garbage"), apps, udid)).toBe(
    null
  );
  // No launchd_sim for this simulator.
  expect(
    foregroundByPriority(
      parseProcessTable(
        " 1001   900  47 /Applications/MobileSafari.app/MobileSafari"
      ),
      apps,
      udid
    )
  ).toBeNull();
  // Two launchd_sim lines naming the UDID cannot be told apart.
  expect(
    foregroundByPriority(
      parseProcessTable(
        [
          launchd,
          launchd.replace("  900", "  901"),
          " 1001   900  47 /Applications/MobileSafari.app/MobileSafari",
        ].join("\n")
      ),
      apps,
      udid
    )
  ).toBeNull();
});

it.effect(
  "reads the app list once, and again only for a high unlisted process",
  () =>
    Effect.gen(function* cachedApps() {
      let listings = 0;
      let rows = [
        " 1001   900  47 /Applications/MobileSafari.app/MobileSafari",
        // SpringBoard is always high and never an app; it costs no reread.
        " 1004   900  47 /System/Library/CoreServices/SpringBoard.app/SpringBoard",
      ];
      let listing =
        "1001\t0\tUIKitApplication:com.apple.mobilesafari[1][rb-legacy]";
      const guess = makeIosForegroundGuess(
        {
          launchctl: () =>
            Effect.sync(() => {
              listings += 1;
              return listing;
            }),
          table: Effect.sync(() => table(rows)),
        },
        udid
      );
      expect(yield* guess()).toBe("com.apple.mobilesafari");
      expect(yield* guess()).toBe("com.apple.mobilesafari");
      expect(listings).toBe(1);
      // A newly launched app is high and not yet listed.
      rows = [
        " 1001   900   4 /Applications/MobileSafari.app/MobileSafari",
        " 1004   900  47 /System/Library/CoreServices/SpringBoard.app/SpringBoard",
        " 1006   900  47 /Applications/Maps.app/Maps",
      ];
      listing = `${listing}\n1006\t0\tUIKitApplication:com.apple.Maps[2][rb-legacy]`;
      expect(yield* guess()).toBe("com.apple.Maps");
      expect(listings).toBe(2);
      // A failed read is no guess, after every reading.
      const failing = makeIosForegroundGuess(
        {
          launchctl: () => Effect.fail(iosRuntimeError("runtime_failed")),
          table: Effect.fail(iosRuntimeError("runtime_failed")),
        },
        udid
      );
      const failed = yield* Effect.forkChild(failing());
      yield* TestClock.adjust(Duration.times(GUESS_SPACING, GUESS_READINGS));
      expect(yield* Fiber.join(failed)).toBeNull();
    })
);

it.effect(
  "reads an unclear guess again while the replaced app is still high",
  () =>
    Effect.gen(function* settlesGuess() {
      let readings = 0;
      const guess = makeIosForegroundGuess(
        {
          launchctl: () =>
            Effect.succeed(
              [
                "1001\t0\tUIKitApplication:dev.contingency.ioslogin[1][rb-legacy]",
                "1002\t0\tUIKitApplication:com.apple.Preferences[2][rb-legacy]",
              ].join("\n")
            ),
          // Settings came forward; the Target App drops on the third reading.
          table: Effect.sync(() => {
            readings += 1;
            return table([
              ` 1001   900  ${readings < 3 ? 47 : 4} /data/Login.app/Login`,
              " 1002   900  47 /Applications/Preferences.app/Preferences",
            ]);
          }),
        },
        udid
      );
      const settled = yield* Effect.forkChild(guess());
      yield* TestClock.adjust(GUESS_SPACING);
      expect(readings).toBe(2);
      yield* TestClock.adjust(GUESS_SPACING);
      expect(yield* Fiber.join(settled)).toBe("com.apple.Preferences");
      expect(readings).toBe(3);
      // The app agent-device refused to observe is behind, however high.
      readings = 0;
      expect(yield* guess("dev.contingency.ioslogin")).toBe(
        "com.apple.Preferences"
      );
      expect(readings).toBe(1);
      // Immediate reading checks host priority once without waiting across retries.
      readings = 0;
      expect(yield* guess.now("dev.contingency.ioslogin")).toBe(
        "com.apple.Preferences"
      );
      expect(readings).toBe(1);
      readings = 0;
      expect(yield* guess.now()).toBeNull();
      expect(readings).toBe(1);
    })
);

it.effect(
  "follows the app in front, binding only to what it observed there",
  () =>
    Effect.gen(function* followsForeground() {
      const bound = yield* Ref.make("dev.contingency.ioslogin");
      const binds: string[] = [];
      const attempts: string[] = [];
      // Home was pressed: the Target App's root shrinks, Springboard shows
      // Settings' card after the user tapped it, and Settings fills the screen.
      const steps = new Map<string, ForegroundStep<string>>([
        ["dev.contingency.ioslogin", { _tag: "follow", app: SPRINGBOARD }],
        [SPRINGBOARD, { _tag: "follow", app: "com.apple.Preferences" }],
        ["com.apple.Preferences", { _tag: "observed", value: "settings tree" }],
      ]);
      const observed = yield* followForeground({
        attempt: (app) =>
          Effect.sync(() => {
            attempts.push(app);
            return steps.get(app) ?? { _tag: "observed", value: "unexpected" };
          }),
        bind: (app) =>
          Effect.sync(() => {
            binds.push(app);
          }),
        bound,
        stale: iosRuntimeError("observation_stale"),
      });
      expect(observed).toBe("settings tree");
      expect(attempts).toEqual([
        "dev.contingency.ioslogin",
        SPRINGBOARD,
        "com.apple.Preferences",
      ]);
      expect(binds).toEqual([SPRINGBOARD, "com.apple.Preferences"]);
      expect(yield* Ref.get(bound)).toBe("com.apple.Preferences");
    })
);

it.effect(
  "stops following after its bind limit and reports the capture stale",
  () =>
    Effect.gen(function* boundsFollowing() {
      const bound = yield* Ref.make(SPRINGBOARD);
      const binds: string[] = [];
      const failure = yield* Effect.flip(
        followForeground({
          // Two apps that each point at the other never settle.
          attempt: (app) =>
            Effect.succeed<ForegroundStep<string>>({
              _tag: "follow",
              app: app === SPRINGBOARD ? "com.apple.Preferences" : SPRINGBOARD,
            }),
          bind: (app) =>
            Effect.sync(() => {
              binds.push(app);
            }),
          bound,
          limit: 2,
          stale: iosRuntimeError("observation_stale"),
        })
      );
      expect(failure.code).toBe("observation_stale");
      expect(binds).toEqual(["com.apple.Preferences", SPRINGBOARD]);
    })
);

it.effect("binds nothing when the attempt refuses", () =>
  Effect.gen(function* refusesWithoutBinding() {
    const bound = yield* Ref.make("dev.contingency.ioslogin");
    let binds = 0;
    const failure = yield* Effect.flip(
      followForeground({
        attempt: () => Effect.fail(iosRuntimeError("foreground_app_unknown")),
        bind: () =>
          Effect.sync(() => {
            binds += 1;
          }),
        bound,
        stale: iosRuntimeError("observation_stale"),
      })
    );
    expect(failure.code).toBe("foreground_app_unknown");
    expect(binds).toBe(0);
  })
);
