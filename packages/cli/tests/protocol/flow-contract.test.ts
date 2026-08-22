import { Flow } from "@contingency/protocol";
import { Result, Schema, SchemaIssue } from "effect";
import { expect, test } from "vitest";

/**
 * Flows decode strictly: an unknown field means a document from another era,
 * and ignoring it would silently drop whatever the author meant.
 */
const decode = Schema.decodeUnknownResult(Flow, {
  onExcessProperty: "error",
});
const formatIssue = SchemaIssue.makeFormatterDefault();

const navigateStep = {
  type: "navigate",
  url: "https://example.com/login",
};

const target = [
  { kind: "role", name: "Add to cart", role: "button" },
  { kind: "css", selector: "#add-to-cart" },
];

const flowWith = (
  steps: readonly unknown[],
  extra?: Record<string, unknown>
) => ({
  ...extra,
  steps,
  title: "Checkout",
});

const assertDecodes = (input: unknown) => {
  const result = decode(input);
  if (Result.isFailure(result)) {
    throw new Error(
      `Expected the Flow to decode: ${formatIssue(result.failure.issue)}`
    );
  }
  return result.success;
};

const assertRejects = (input: unknown) => {
  expect(Result.isSuccess(decode(input))).toBe(false);
};

const failureMessage = (input: unknown): string => {
  const result = decode(input);
  if (Result.isSuccess(result)) {
    throw new Error("Expected the Flow to be rejected");
  }
  return formatIssue(result.failure.issue);
};

test("a minimal native Flow decodes", () => {
  const flow = assertDecodes({ steps: [navigateStep], title: "Checkout" });

  expect(flow.title).toBe("Checkout");
  expect(flow.steps).toHaveLength(1);
});

test("a Flow carries a stable identity distinct from its title", () => {
  const flow = assertDecodes(
    flowWith([navigateStep], { flowId: "b6f1c9f0-checkout" })
  );

  expect(flow.flowId).toBe("b6f1c9f0-checkout");
});

test("every browser action Step decodes", () => {
  const flow = assertDecodes(
    flowWith([
      { page: 1, type: "navigate", url: "https://example.com/" },
      { button: "right", target, timeout: 5000, type: "click" },
      { target, type: "change", value: "2" },
      { key: "Shift", type: "keyDown" },
      { key: "Shift", type: "keyUp" },
      { key: "Enter", target, type: "press" },
      { key: "Escape", type: "press" },
      { target, type: "hover" },
      { deltaX: 0, deltaY: 600, type: "scroll" },
      { target, type: "selectOption", values: ["2", "three"] },
      {
        condition: { target, type: "selectorHidden" },
        timeout: 2000,
        type: "waitFor",
      },
    ])
  );

  expect(flow.steps.map(({ type }) => type)).toEqual([
    "navigate",
    "click",
    "change",
    "keyDown",
    "keyUp",
    "press",
    "press",
    "hover",
    "scroll",
    "selectOption",
    "waitFor",
  ]);
});

test("a keystroke carries a target when it belongs to an element", () => {
  // Typing into a field: element-scoped.
  assertDecodes(flowWith([{ key: "x", target, type: "keyDown" }]));
  // A Page-level shortcut: no Page syntax beyond the keystroke itself.
  assertDecodes(flowWith([{ key: "Escape", type: "press" }]));

  expect(() =>
    assertDecodes(flowWith([{ key: "", type: "keyDown" }]))
  ).toThrow();
});

test("a target keeps its ordered alternatives in order", () => {
  const orderedTarget = [
    { kind: "role", name: "Buy", role: "link" },
    { kind: "label", label: "Buy now" },
    { kind: "placeholder", placeholder: "Search" },
    { kind: "text", text: "Buy" },
    { kind: "css", selector: ".buy-button" },
    { expression: "//button[2]", kind: "xpath" },
  ];
  const flow = assertDecodes(
    flowWith([{ target: orderedTarget, type: "click" }])
  );

  const [step] = flow.steps;
  if (step === undefined || !("target" in step) || step.target === undefined) {
    throw new Error("Expected Step 1 to carry a target");
  }
  expect(step.target).toEqual(orderedTarget);
});

test("a target rejects an empty ladder and an unknown descriptor kind", () => {
  assertRejects(flowWith([{ target: [], type: "click" }]));
  // There is deliberately no test-id kind (ADR 0011).
  assertRejects(
    flowWith([
      { target: [{ "data-testid": "buy", kind: "testId" }], type: "click" },
    ])
  );
});

test("an absent Page means the first Page, and a named Page is by open order", () => {
  // A single-Page Flow carries no Page syntax at all.
  assertDecodes(flowWith([{ target, type: "click" }]));

  // A negative Page order names no Page that can exist.
  assertRejects(
    flowWith([{ page: -1, type: "navigate", url: "https://example.com/" }])
  );
});

test("a Flow declares its Emulation", () => {
  const permissions = [
    { origin: "https://example.com", permission: "geolocation" },
    { permission: "camera" },
  ];
  const flow = assertDecodes(
    flowWith([navigateStep], {
      emulation: {
        colorScheme: "dark",
        geolocation: { accuracy: 25, latitude: 52.52, longitude: 13.405 },
        locale: "de-DE",
        permissions,
        timezoneId: "Europe/Berlin",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_1 like Mac OS X)",
        viewport: { deviceScaleFactor: 2, height: 720, width: 1280 },
      },
    })
  );
  expect(flow.emulation?.permissions).toEqual(permissions);

  // A partial Emulation declares only what the Flow needs.
  assertDecodes(
    flowWith([navigateStep], {
      emulation: {
        viewport: { deviceScaleFactor: 1, height: 800, width: 1200 },
      },
    })
  );
  // An unknown colour scheme is not emulation.
  assertRejects(
    flowWith([navigateStep], { emulation: { colorScheme: "sepia" } })
  );
  // An empty permission list grants nothing and says nothing.
  assertRejects(flowWith([navigateStep], { emulation: { permissions: [] } }));
});

test("a Flow declares a Gate as accessibility rule ids", () => {
  const flow = assertDecodes(
    flowWith([navigateStep], { gate: ["image-alt", "label"] })
  );

  expect(flow.gate).toEqual(["image-alt", "label"]);
  // A Gate that names no rule holds nothing to nothing.
  assertRejects(flowWith([navigateStep], { gate: [] }));
});

test("Pre-step conditions accept visible, hidden, and URL matches", () => {
  const bannerTarget = [{ kind: "css", selector: "#cookie-banner" }];
  const flow = assertDecodes(
    flowWith([navigateStep], {
      preSteps: [
        {
          id: "dismiss-banner",
          step: {
            target: [{ kind: "css", selector: "#cookie-banner button" }],
            type: "click",
          },
          when: { target: bannerTarget, type: "selectorVisible" },
        },
        {
          id: "wait-banner-gone",
          step: { key: "Escape", target: bannerTarget, type: "press" },
          when: { target: bannerTarget, type: "selectorHidden" },
        },
        {
          id: "checkout-only",
          step: { key: "Escape", type: "press" },
          when: { pattern: "/checkout$", type: "urlMatches" },
        },
      ],
    })
  );

  expect(flow.preSteps?.map(({ when }) => when.type)).toEqual([
    "selectorVisible",
    "selectorHidden",
    "urlMatches",
  ]);

  // A condition that is none of the named types is not a condition.
  assertRejects(
    flowWith([navigateStep], {
      preSteps: [
        {
          id: "x",
          step: { key: "Escape", type: "press" },
          when: { text: "banner gone", type: "textContent" },
        },
      ],
    })
  );
});

test("a Pre-step cannot navigate or wait", () => {
  const preStepFlow = (step: Record<string, unknown>) =>
    flowWith([navigateStep], {
      preSteps: [
        { id: "clear", step, when: { pattern: "/", type: "urlMatches" } },
      ],
    });

  assertRejects(preStepFlow({ type: "navigate", url: "https://example.com/" }));
  assertRejects(
    preStepFlow({
      condition: { pattern: "/cart$", type: "urlMatches" },
      type: "waitFor",
    })
  );
});

test("a navigate Step accepts the performance toggle", () => {
  assertDecodes(flowWith([{ ...navigateStep, performance: true }]));
});

test("a non-navigating Step rejects the performance toggle", () => {
  const message = failureMessage({
    steps: [
      navigateStep,
      { id: "two", performance: true, target, type: "click" },
    ],
    title: "Checkout",
  });

  expect(message).toContain("Step 2");
  expect(message).toContain("click");
  expect(message).toContain("two");

  // performance: false on a non-navigating Step is not a rejection.
  assertDecodes(
    flowWith([navigateStep, { performance: false, target, type: "click" }])
  );
});

test("an Audit Step admits only the accessibility kind and carries authored fields", () => {
  const auditFlow = (kind: string) =>
    flowWith([navigateStep, { id: "audit-1", kind, type: "audit" }]);

  assertDecodes(auditFlow("accessibility"));
  assertRejects(auditFlow("performance"));

  // An Audit cannot measure performance: it navigates nothing.
  assertRejects(
    flowWith([
      navigateStep,
      {
        id: "audit-1",
        kind: "accessibility",
        performance: true,
        type: "audit",
      },
    ])
  );
});

test("a Chrome DevTools Recorder export is rejected, not migrated", () => {
  // The exact document the old schema accepted from the Recorder extension.
  const chromeExport = {
    steps: [
      { type: "navigate", url: "https://example.com/" },
      {
        assertedEvents: [
          {
            title: "Cart",
            type: "navigation",
            url: "https://example.com/cart",
          },
        ],
        offsetX: 12,
        offsetY: 3,
        selectors: [["aria/Add to cart"], ["#add"]],
        type: "click",
      },
      { selectors: [["#quantity"]], type: "change", value: "2" },
      { key: "Enter", selectors: [["#quantity"]], type: "keyDown" },
    ],
    title: "Checkout",
  };

  // Rejected, not migrated: the document carries fields the native format
  // has never heard of and Steps that name no target it understands.
  expect(failureMessage(chromeExport)).toContain("assertedEvents");
});

test("strictness lives in the schema, not the call site", () => {
  // A bare decode — no options — still refuses a document from another era.
  const bareDecode = Schema.decodeUnknownResult(Flow);
  expect(
    Result.isSuccess(
      bareDecode({
        contingency: { video: true },
        steps: [navigateStep],
        title: "Checkout",
      })
    )
  ).toBe(false);
  // The annotation propagates tree-wide: this document is structurally valid
  // at every level but the Step, so only propagation rejects it.
  expect(
    Result.isSuccess(bareDecode(flowWith([{ foo: 1, target, type: "click" }])))
  ).toBe(false);
});

test("old selector arrays, frame indices, string targets, and variable folds are rejected", () => {
  const legacy = (
    step: Record<string, unknown>,
    contingency?: Record<string, unknown>
  ) => ({
    ...(contingency === undefined ? {} : { contingency }),
    steps: [navigateStep, step],
    title: "Legacy",
  });

  // Old selector arrays: every targeted action carried `selectors`.
  expect(
    failureMessage(legacy({ selectors: [["#submit"]], type: "click" }))
  ).toBeTruthy();
  // Frame indices.
  expect(
    failureMessage(
      legacy({ frame: [0, 1], selectors: [["#submit"]], type: "click" })
    )
  ).toBeTruthy();
  // Old string targets.
  expect(
    failureMessage(
      legacy({ selectors: [["#submit"]], target: "ABC123", type: "click" })
    )
  ).toBeTruthy();
  // Pre-rename Variable declaration fold.
  expect(
    failureMessage(
      legacy(
        { selectors: [["#password"]], type: "change", value: "{{PASSWORD}}" },
        { secretVariables: [{ name: "PASSWORD" }] }
      )
    )
  ).toBeTruthy();
  // Pre-rename per-Step binding fold.
  expect(
    failureMessage(
      legacy({
        contingency: { id: "password", secretVariable: "PASSWORD" },
        selectors: [["#password"]],
        type: "change",
        value: "{{PASSWORD}}",
      })
    )
  ).toBeTruthy();
});

test("a video flag has nowhere to live any more", () => {
  expect(
    failureMessage({
      contingency: { video: true },
      steps: [navigateStep],
      title: "Checkout",
    })
  ).toBeTruthy();
});

test("encoding a Flow emits only the current format", () => {
  const encode = Schema.encodeSync(Flow);
  const flow = assertDecodes({
    emulation: { colorScheme: "dark" },
    gate: ["image-alt"],
    preSteps: [
      {
        id: "dismiss-banner",
        step: {
          target: [{ kind: "css", selector: "#cookie-banner button" }],
          type: "click",
        },
        when: {
          target: [{ kind: "css", selector: "#cookie-banner" }],
          type: "selectorVisible",
        },
      },
    ],
    steps: [
      { ...navigateStep, performance: true, variable: "TARGET_URL" },
      { id: "audit-1", kind: "accessibility", type: "audit" },
    ],
    title: "Checkout",
    variables: [{ name: "TARGET_URL", runtime: false, secret: true }],
  });

  const encoded = JSON.stringify(encode(flow));
  expect(encoded).not.toContain("contingency");
  expect(encoded).not.toContain("secretVariable");
  expect(encoded).not.toContain('"video"');
});
