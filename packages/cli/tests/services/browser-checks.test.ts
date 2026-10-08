import {
  TeachingBrowserAttachment,
  browserCheckCoverage,
  matchesBrowserExpectation,
  matchesBrowserRequest,
} from "@contingency/protocol";
import type { BrowserCheck } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";

import {
  parseBrowserChecks,
  validateTaughtBrowserChecks,
  validateBrowserCheck,
  resolveBrowserCheckInputs,
} from "../../src/services/browser-check-requirements.ts";

const check: BrowserCheck = {
  demonstrated: false,
  expectation: {
    itemPath: ["items", "*"],
    predicates: [
      { expected: "ready", operator: "equals", path: ["status"] },
      { expected: 2, operator: "gte", path: ["count"] },
    ],
  },
  id: "ready",
  kind: "response",
  request: {
    method: "POST",
    origin: "https://example.com",
    path: "/jobs/:job",
    query: { view: "full" },
  },
  response: "matching",
  timeoutMs: 1000,
  when: "After Submit",
};
const files = (requirements: readonly BrowserCheck[] = [check]) => [
  {
    content:
      "Read [checks](references/browser-checks.json). Pass ready after Submit.",
    path: "SKILL.md",
  },
  {
    content: JSON.stringify({ requirements, schemaVersion: 1 }),
    path: "references/browser-checks.json",
  },
];

it("preserves JSON types and groups predicates on one unordered item", () => {
  expect(
    matchesBrowserExpectation(
      {
        items: [
          { count: 0, status: "ready" },
          { count: 2, status: "pending" },
        ],
      },
      check.expectation
    )
  ).toBe(false);
  for (const items of [
    [
      { count: 0, status: "pending" },
      { count: 2, status: "ready" },
    ],
    [
      { count: 2, status: "ready" },
      { count: 0, status: "pending" },
    ],
  ]) {
    expect(matchesBrowserExpectation({ items }, check.expectation)).toBe(true);
  }
  expect(
    matchesBrowserExpectation(
      { items: [{ count: "2", status: "ready" }] },
      check.expectation
    )
  ).toBe(false);
  expect(
    matchesBrowserExpectation(
      {
        items: [
          { count: 0, status: "pending" },
          { count: 2, status: "ready" },
        ],
      },
      { ...check.expectation, itemPath: ["items", 0] }
    )
  ).toBe(false);
  expect(
    matchesBrowserExpectation(
      { value: null },
      { itemPath: [], predicates: [{ operator: "exists", path: ["value"] }] }
    )
  ).toBe(true);
  expect(
    matchesBrowserExpectation(
      {},
      { itemPath: [], predicates: [{ operator: "exists", path: ["value"] }] }
    )
  ).toBe(false);
});
it("matches reviewed method, origin, variable segments, and query constraints", () => {
  expect(
    matchesBrowserRequest(
      "POST",
      "https://example.com/jobs/123?other=ignored&view=full",
      check.request
    )
  ).toBe(true);
  for (const [method, url] of [
    ["GET", "https://example.com/jobs/123?view=full"],
    ["POST", "https://other.com/jobs/123?view=full"],
    ["POST", "https://example.com/jobs/123/extra?view=full"],
    ["POST", "https://example.com/jobs/123?view=short"],
  ]) {
    expect(matchesBrowserRequest(method ?? "", url ?? "", check.request)).toBe(
      false
    );
  }
});
it.each([
  ["ref=batch=2026-10", "batch=2026-10", true],
  ["ref=batch=2026-10", "batch", false],
  ["ref=receipt==", "receipt==", true],
  ["ref=receipt==", "receipt", false],
  ["ref=receipt==", "receipt=", false],
  ["ref=batch%3D2026-10", "batch=2026-10", true],
  ["ref=batch%3D2026-10", "batch", false],
  ["ref=receipt%3D%3D", "receipt==", true],
  ["ref=batch?month=10", "batch?month=10", true],
  ["ref=batch?month=10", "batch", false],
  ["ref=batch%3Fmonth%3D10", "batch?month=10", true],
  ["ref=batch+receipt", "batch receipt", true],
  ["ref=batch+receipt", "batch+receipt", false],
  ["ref=batch%2Breceipt", "batch+receipt", true],
  ["ref=other&ref=batch=2026-10", "batch=2026-10", true],
  ["ref=batch=2026-10&ref=other", "batch=2026-10", true],
  ["ref=other&ref=wrong", "batch=2026-10", false],
  ["ref=", "", true],
  ["ref", "", true],
  ["other=ignored", "", false],
  ["", "", false],
  ["%72ef=batch=2026-10", "batch=2026-10", true],
  ["ref=batch=2026-10#ref=wrong", "batch=2026-10", true],
  ["other=ignored#ref=batch=2026-10", "batch=2026-10", false],
])(
  "matches complete decoded query values: %s against %s",
  (query, value, matched) => {
    expect(
      matchesBrowserRequest("post", `https://example.com/jobs/123?${query}`, {
        ...check.request,
        query: { ref: value },
      })
    ).toBe(matched);
  }
);
it.each([
  "https://example.com/jobs/?view=full",
  "https://example.com/jobs/123/extra?view=full",
  "https://other.com/jobs/123?view=full",
  "not a URL",
  "/jobs/123?view=full",
  "https://example.com:invalid/jobs/123?view=full",
  "https://example.com:99999/jobs/123?view=full",
  "http://[invalid]/jobs/123?view=full",
])("rejects a mismatched path, origin, or invalid URL: %s", (url) => {
  expect(matchesBrowserRequest("POST", url, check.request)).toBe(false);
});
it.effect(
  "learning preserves unobserved requirements exactly and excludes context",
  () =>
    Effect.gen(function* preserveChecks() {
      const attachment = {
        candidate: check,
        id: check.id,
        label: "Ready",
        requirement: check,
      };
      yield* validateTaughtBrowserChecks(files(), [
        { attachments: [attachment] },
      ]);
      const omitted = yield* Effect.flip(
        validateTaughtBrowserChecks([], [{ attachments: [attachment] }])
      );
      expect(omitted.message).toContain("Preserve every");
      const weakened = yield* Effect.flip(
        validateTaughtBrowserChecks(files([{ ...check, timeoutMs: 2000 }]), [
          { attachments: [attachment] },
        ])
      );
      expect(weakened.message).toContain("exactly");
      yield* validateTaughtBrowserChecks(
        [],
        [
          {
            attachments: [{ candidate: check, id: check.id, label: "Context" }],
          },
        ]
      );
      expect(Result.isFailure(parseBrowserChecks(files([check, check])))).toBe(
        true
      );
    })
);
it("coverage requires local results for each skill and check, with the latest failure retained", () => {
  const reference = { check, flowSkillName: "submit" };
  const passed = {
    at: "2026-10-07T00:00:00Z",
    flowSkillName: "submit",
    id: check.id,
    operationId: "click",
    status: "passed" as const,
    summary: "Passed",
  };
  expect(browserCheckCoverage({ browserChecks: [reference] }).complete).toBe(
    false
  );
  expect(
    browserCheckCoverage({
      browserCheckResults: [{ ...passed, flowSkillName: "other" }],
      browserChecks: [reference],
    }).complete
  ).toBe(false);
  expect(
    browserCheckCoverage({
      browserCheckResults: [passed],
      browserChecks: [reference],
    }).complete
  ).toBe(true);
  expect(
    browserCheckCoverage({
      browserCheckResults: [passed, { ...passed, status: "inconclusive" }],
      browserChecks: [reference],
    }).complete
  ).toBe(false);
});

it("encodes context and absent cookie fields as valid MCP JSON", () => {
  const cookie = {
    ...check,
    change: "created",
    expectation: {
      itemPath: [],
      predicates: [{ operator: "exists", path: [] }],
    },
    kind: "cookie",
    name: "ready",
    origin: "http://example.test",
  };
  const decoded = Schema.decodeUnknownSync(TeachingBrowserAttachment)({
    candidate: cookie,
    id: cookie.id,
    label: "Cookie context",
  });
  const encoded = Schema.encodeSync(TeachingBrowserAttachment)(decoded);
  expect(Schema.decodeUnknownSync(Schema.Json)(encoded)).toEqual(encoded);
});
it.effect(
  "private expectations use locally resolved Variables without changing the saved check",
  () =>
    Effect.gen(function* resolvePrivate() {
      const privateCheck: BrowserCheck = {
        ...check,
        change: "created",
        expectation: {
          itemPath: [],
          predicates: [
            { expected: "{{SECRET}}", operator: "equals", path: [] },
          ],
        },
        kind: "cookie",
        name: "checkout",
        origin: "http://example.test",
      };
      expect(validateBrowserCheck(privateCheck)).toBeUndefined();
      expect(
        validateBrowserCheck({
          ...privateCheck,
          expectation: {
            itemPath: [],
            predicates: [{ expected: "literal", operator: "equals", path: [] }],
          },
        })
      ).toContain("private");
      const resolved = yield* resolveBrowserCheckInputs(
        { check: privateCheck, flowSkillName: "submit" },
        (name) => (name === "SECRET" ? "disposable" : undefined)
      );
      expect(resolved.check.expectation.predicates[0]?.expected).toBe(
        "disposable"
      );
      expect(privateCheck.expectation.predicates[0]?.expected).toBe(
        "{{SECRET}}"
      );
      expect(
        (yield* Effect.result(
          resolveBrowserCheckInputs(
            { check: privateCheck, flowSkillName: "submit" },
            () => {}
          )
        ))._tag
      ).toBe("Failure");
    })
);
it.effect(
  "storage format is explicit, persisted, and enforced by raw validation",
  () =>
    Effect.gen(function* storageFormat() {
      const storage: BrowserCheck = {
        change: "current",
        demonstrated: false,
        expectation: {
          itemPath: ["items", "*"],
          predicates: [
            { expected: "{{STATUS}}", operator: "equals", path: ["status"] },
          ],
        },
        format: "json",
        id: "ready",
        kind: "session",
        name: "order",
        origin: "http://example.test",
        timeoutMs: 1000,
        when: "After Submit",
      };
      expect(validateBrowserCheck(storage)).toBeUndefined();
      const { format: _omitted, ...legacy } = storage;
      expect(validateBrowserCheck(legacy)).toContain("JSON storage format");
      expect(validateBrowserCheck({ ...storage, format: "raw" })).toContain(
        "JSON storage format"
      );
      const rawRoot: BrowserCheck = {
        ...storage,
        expectation: {
          itemPath: [],
          predicates: [{ expected: "", operator: "equals", path: [] }],
        },
        format: "raw",
      };
      expect(validateBrowserCheck(rawRoot)).toBeUndefined();
      expect(
        validateBrowserCheck({
          ...rawRoot,
          expectation: {
            itemPath: [],
            predicates: [{ expected: 1, operator: "gt", path: [] }],
          },
        })
      ).toContain("string expectation");
      expect(
        validateBrowserCheck({
          ...rawRoot,
          expectation: {
            itemPath: [],
            predicates: [{ operator: "exists", path: [] }],
          },
          kind: "cookie",
        })
      ).toContain("Remove the storage format");
      const saved = parseBrowserChecks(files([storage, rawRoot, legacy]));
      expect(Result.isFailure(saved)).toBe(true);
      const { format: _raw, ...omittedRaw } = rawRoot;
      const reread = parseBrowserChecks(
        files([storage, { ...omittedRaw, id: "Submit" }])
      );
      expect(
        Result.getOrThrow(reread).map((entry) =>
          entry.kind === "response" ? entry.kind : entry.format
        )
      ).toEqual(["json", undefined]);
      const attachment = {
        candidate: storage,
        id: storage.id,
        label: "Stored",
        requirement: storage,
      };
      yield* validateTaughtBrowserChecks(files([storage]), [
        { attachments: [attachment] },
      ]);
      const jsonRoot: BrowserCheck = { ...rawRoot, format: "json" };
      expect(
        (yield* Effect.flip(
          validateTaughtBrowserChecks(files([omittedRaw]), [
            {
              attachments: [
                { ...attachment, candidate: jsonRoot, requirement: jsonRoot },
              ],
            },
          ])
        )).message
      ).toContain("exactly");
      const resolved = yield* resolveBrowserCheckInputs(
        { check: storage, flowSkillName: "submit" },
        () => "ready"
      );
      expect(resolved.check).toMatchObject({ format: "json" });
      expect(() =>
        Schema.decodeUnknownSync(TeachingBrowserAttachment)({
          candidate: { ...storage, format: "xml" },
          id: storage.id,
          label: "Stored",
        })
      ).toThrow();
    })
);
