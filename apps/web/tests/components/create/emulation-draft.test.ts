import type { DraftEmulation } from "@contingency/protocol";
import { expect, test } from "vitest";

import {
  draftFromSessionEmulation,
  draftSessionEmulation,
  draftWithIdentity,
  draftWithPatch,
  draftWithViewport,
  initialEmulationDraft,
} from "@/components/create/emulation-draft";

const desktop: DraftEmulation = initialEmulationDraft;

test("a mobile identity brings its own viewport and scale factor", () => {
  const mobile = draftWithIdentity(desktop, "chrome-android-mobile");

  expect(mobile.userAgentProfile).toBe("chrome-android-mobile");
  expect(mobile.viewport.width).toBeLessThan(desktop.viewport.width);
  expect(mobile.viewport.deviceScaleFactor).toBeGreaterThan(1);
});

test("an explicit viewport edit outranks the identity's own", () => {
  const mobile = draftWithIdentity(desktop, "chrome-android-mobile");
  const edited = draftWithViewport(mobile, {
    ...mobile.viewport,
    width: 500,
  });

  // The identity stays chosen: only the metric the author edited moves.
  expect(edited.userAgentProfile).toBe("chrome-android-mobile");
  expect(edited.viewport.width).toBe(500);
  expect(edited.viewport.deviceScaleFactor).toBe(
    mobile.viewport.deviceScaleFactor
  );
});

test("leaving an identity takes back the scale factor it applied", () => {
  const mobile = draftWithIdentity(desktop, "chrome-android-mobile");
  const back = draftWithIdentity(mobile, "chrome-windows");

  expect(back.viewport.deviceScaleFactor).toBe(1);
});

test("a patch replaces, clears, or leaves each part of the draft", () => {
  const located = draftWithPatch(desktop, {
    geolocation: { latitude: 51.5, longitude: -0.12 },
    locale: "de-DE",
  });
  expect(located.geolocation).toEqual({ latitude: 51.5, longitude: -0.12 });
  expect(located.locale).toBe("de-DE");

  const timezoned = draftWithPatch(located, { timezoneId: "Europe/Berlin" });
  // A patch that never mentions the location leaves it exactly as it was.
  expect(timezoned.geolocation).toEqual({ latitude: 51.5, longitude: -0.12 });

  const cleared = draftWithPatch(timezoned, { geolocation: null });
  expect("geolocation" in cleared).toBe(false);
  expect(cleared.timezoneId).toBe("Europe/Berlin");
});

test("a permission list is replaced whole, and null grants nothing", () => {
  const granted = draftWithPatch(desktop, {
    permissions: [{ permission: "geolocation" }],
  });
  expect(granted.permissions).toEqual([{ permission: "geolocation" }]);

  expect(draftWithPatch(granted, { permissions: null }).permissions).toEqual(
    []
  );
});

test("the draft reads back as the Emulation the controls display", () => {
  const draft = draftWithPatch(
    draftWithIdentity(desktop, "chrome-android-mobile"),
    { colorScheme: "dark" }
  );

  expect(draftSessionEmulation(draft)).toEqual({
    colorScheme: "dark",
    permissions: [],
    viewport: draft.viewport,
  });
});

test("the draft adopts what a selected session already emulates", () => {
  const composed = draftWithPatch(desktop, {
    locale: "de-DE",
    permissions: [{ permission: "camera" }],
  });

  const adopted = draftFromSessionEmulation(composed, {
    permissions: [{ permission: "geolocation" }],
    timezoneId: "Europe/Berlin",
    viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
  });

  // The session grants geolocation and no locale, so the draft says so too:
  // the next navigation applies the draft.
  expect(adopted.permissions).toEqual([{ permission: "geolocation" }]);
  expect(adopted.timezoneId).toBe("Europe/Berlin");
  expect("locale" in adopted).toBe(false);
  // The identity controls own the identity, so the session does not move it.
  expect(adopted.userAgentProfile).toBe(composed.userAgentProfile);
});
