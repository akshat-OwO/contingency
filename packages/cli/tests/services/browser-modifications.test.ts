import {
  AgentSessionId,
  FlowSkillName,
  TeachingRecordingId,
  browserModificationSummary,
} from "@contingency/protocol";
import type { BrowserModification } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import {
  cookieWriteAllowed,
  makeBrowserModifications,
  modificationDescription,
  modificationRefusal,
  pursuitRefusal,
  storageWriteAllowed,
} from "../../src/services/browser-modifications.ts";

it("enforces the activity by modification kind authority matrix", () => {
  const kinds = [
    "cookie",
    "storage",
    "route",
    "headers",
    "emulation",
    "eval",
    "clipboard",
    "upload",
  ] as const;
  for (const kind of kinds) {
    for (const state of ["setup", "recording"]) {
      expect(
        modificationRefusal(
          {
            activity: "teaching",
            origin: "guided-run",
            captureState: { _tag: state },
            dryRun: null,
          },
          kind
        )
      ).toBeUndefined();
    }
    expect(
      modificationRefusal({ activity: "run", dryRun: null }, kind)
    ).toBeUndefined();
    expect(
      modificationRefusal(
        { activity: "teaching", captureState: { _tag: "setup" }, dryRun: null },
        kind
      ) === undefined
    ).toBe(kind !== "route" && kind !== "headers" && kind !== "eval");
    expect(
      modificationRefusal(
        {
          activity: "teaching",
          captureState: { _tag: "recording" },
          dryRun: null,
        },
        kind
      )
    ).toContain("Start to Stop");
    expect(
      modificationRefusal(
        {
          activity: "run",
          dryRun: {
            flowSkillName: FlowSkillName.make("dry"),
            inputs: [],
            recordingId: TeachingRecordingId.make("recording-dry"),
            startedAt: "now",
            variables: [],
          },
        },
        kind
      )
    ).toBeUndefined();
  }
});

const allows = (url: string) => new URL(url).hostname === "api.example.test";

it("bounds cookie domains and storage origins to the current host or explicit Domain Scope", () => {
  const page = "https://shop.example.test/cart";
  expect(cookieWriteAllowed(".shop.example.test", page)).toBe(true);
  for (const domain of [
    "example.test",
    "evil.test",
    "shop.example.test:443",
    "shop.example.test/",
    "*.example.test",
    "",
    "shop.example.test@evil.test",
  ]) {
    expect(cookieWriteAllowed(domain, page)).toBe(false);
  }
  expect(cookieWriteAllowed("api.example.test", page, allows)).toBe(true);
  expect(cookieWriteAllowed("shop.example.test", page, allows)).toBe(false);
  expect(storageWriteAllowed("https://api.example.test/state", allows)).toBe(
    true
  );
  expect(storageWriteAllowed(page, allows)).toBe(false);
  expect(storageWriteAllowed(page)).toBe(true);
  for (const url of ["about:blank", "file:///tmp/test", "data:text/html,hi"]) {
    expect(storageWriteAllowed(url)).toBe(false);
  }
});

const mod = (
  id: string,
  extra: Partial<BrowserModification>
): BrowserModification => ({
  actor: "agent",
  at: "2026-10-18T00:00:00.000Z",
  description: "Change browser",
  id,
  kind: "cookie",
  operationId: id,
  ...extra,
});

it("summarizes active routes, state and latest Emulation without removed modifications", () => {
  expect(browserModificationSummary([])).toBe("");
  expect(
    browserModificationSummary([
      mod("mock1", { kind: "route", routeAction: "mock" }),
      mod("mock2", { kind: "route", routeAction: "mock" }),
      mod("block", { kind: "route", routeAction: "block" }),
      mod("cookie", {}),
      mod("storage", { kind: "storage" }),
      mod("evaluation", { kind: "eval" }),
      mod("upload1", { kind: "upload" }),
      mod("upload2", { kind: "upload" }),
      mod("clipboard", { kind: "clipboard" }),
      mod("headers", { kind: "headers" }),
      mod("old", { kind: "emulation", textScale: 100 }),
      mod("new", { kind: "emulation", pageZoom: 150, textScale: 200 }),
      mod("removed", { removedAt: "2026-10-18T00:01:00.000Z" }),
    ])
  ).toBe(
    "2 mocked routes · 1 blocked route · 1 cookie · 1 storage change · 1 evaluation · 2 uploads · headers · clipboard · 200% text · 150% zoom"
  );
});

it("retains cookie values and mock bodies while bounding UTF-8 evidence", () => {
  const secret = 'private +"value"';
  const mock = modificationDescription(
    {
      action: "route_add",
      operationId: "mock",
      pattern: "**/api",
      response: {
        action: "mock",
        body: JSON.stringify({ secret }) + "€".repeat(3000),
        contentType: "application/json",
        status: 200,
      },
    },
    [secret]
  );
  expect(mock).toContain(JSON.stringify(secret).slice(1, -1));
  expect(mock).toContain("private");
  expect(Buffer.byteLength(mock)).toBeLessThan(2150);
  const cookie = modificationDescription(
    {
      action: "cookie_set",
      cookie: {
        domain: "example.test",
        httpOnly: true,
        name: "auth",
        path: "/",
        secure: true,
        value: secret,
      },
      operationId: "cookie",
    },
    [secret]
  );
  expect(cookie).toBe(`Set cookie auth on example.test/: ${secret}`);
});

it.effect(
  "removes older layers without losing newer writes, then restores the original",
  () =>
    Effect.gen(function* layeredUndo() {
      const modifications = yield* makeBrowserModifications();
      const value = yield* Ref.make("original");
      const session = AgentSessionId.make("agent-session");
      yield* modifications.layer(
        session,
        "a",
        "key",
        Ref.set(value, "original"),
        Ref.set(value, "a")
      );
      yield* modifications.layer(
        session,
        "b",
        "key",
        Ref.set(value, "a"),
        Ref.set(value, "b")
      );
      yield* modifications.remove(session, "a");
      expect(yield* Ref.get(value)).toBe("b");
      yield* modifications.remove(session, "b");
      expect(yield* Ref.get(value)).toBe("original");
      yield* modifications.dispose(session);
    })
);

it("allows Pursuits in every Run while preserving Teaching authority", () => {
  expect(pursuitRefusal({ activity: "run", dryRun: null })).toBeUndefined();
  for (const state of ["setup", "recording"]) {
    expect(pursuitRefusal({ activity: "teaching", origin: "guided-run", captureState: { _tag: state }, dryRun: null })).toBeUndefined();
    expect(pursuitRefusal({ activity: "teaching", origin: "teaching", captureState: { _tag: state }, dryRun: null })).toContain("Teaching");
  }
  expect(pursuitRefusal({ activity: "teaching", origin: "guided-run", captureState: { _tag: "ready" }, dryRun: null })).toContain("Teaching");
});
