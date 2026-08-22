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

const failureMessage = (input: unknown): string => {
  const result = decode(input);
  if (Result.isSuccess(result)) {
    throw new Error("Expected the Flow to be rejected");
  }
  return formatIssue(result.failure.issue);
};

test("a minimal native Flow decodes", () => {
  const result = decode({ steps: [navigateStep], title: "Checkout" });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  expect(result.success.title).toBe("Checkout");
  expect(result.success.steps).toHaveLength(1);
});

test("a Flow carries a stable identity distinct from its title", () => {
  const result = decode({
    flowId: "b6f1c9f0-checkout",
    steps: [navigateStep],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  expect(result.success.flowId).toBe("b6f1c9f0-checkout");
});

test("every browser action Step decodes", () => {
  const result = decode({
    steps: [
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
    ],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error(
      `Expected the Flow to decode: ${formatIssue(result.failure.issue)}`
    );
  }
  expect(result.success.steps.map(({ type }) => type)).toEqual([
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

test("a target keeps its ordered alternatives in order", () => {
  const orderedTarget = [
    { kind: "role", name: "Buy", role: "link" },
    { kind: "label", label: "Buy now" },
    { kind: "placeholder", placeholder: "Search" },
    { kind: "text", text: "Buy" },
    { kind: "css", selector: ".buy-button" },
    { expression: "//button[2]", kind: "xpath" },
  ];
  const result = decode({
    steps: [{ target: orderedTarget, type: "click" }],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  const [step] = result.success.steps;
  if (step === undefined || !("target" in step) || step.target === undefined) {
    throw new Error("Expected Step 1 to carry a target");
  }
  expect(step.target).toEqual(orderedTarget);
});

test("a target rejects an empty ladder and an unknown descriptor kind", () => {
  expect(
    Result.isSuccess(
      decode({ steps: [{ target: [], type: "click" }], title: "Checkout" })
    )
  ).toBe(false);
  // There is deliberately no test-id kind (ADR 0011).
  expect(
    Result.isSuccess(
      decode({
        steps: [
          { target: [{ "data-testid": "buy", kind: "testId" }], type: "click" },
        ],
        title: "Checkout",
      })
    )
  ).toBe(false);
});

test("an absent Page means the first Page, and a named Page is by open order", () => {
  // A single-Page Flow carries no Page syntax at all.
  expect(
    Result.isSuccess(
      decode({ steps: [{ target, type: "click" }], title: "Checkout" })
    )
  ).toBe(true);

  // A negative Page order names no Page that can exist.
  expect(
    Result.isSuccess(
      decode({
        steps: [{ page: -1, type: "navigate", url: "https://example.com/" }],
        title: "Checkout",
      })
    )
  ).toBe(false);
});

test("a Flow declares its Emulation", () => {
  const result = decode({
    emulation: {
      colorScheme: "dark",
      geolocation: { accuracy: 25, latitude: 52.52, longitude: 13.405 },
      locale: "de-DE",
      permissions: [
        { origin: "https://example.com", permission: "geolocation" },
        { permission: "camera" },
      ],
      timezoneId: "Europe/Berlin",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_1 like Mac OS X)",
      viewport: { deviceScaleFactor: 2, height: 720, width: 1280 },
    },
    steps: [navigateStep],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  expect(result.success.emulation?.permissions).toEqual([
    { origin: "https://example.com", permission: "geolocation" },
    { permission: "camera" },
  ]);

  // A partial Emulation declares only what the Flow needs.
  expect(
    Result.isSuccess(
      decode({
        emulation: {
          viewport: { deviceScaleFactor: 1, height: 800, width: 1200 },
        },
        steps: [navigateStep],
        title: "Checkout",
      })
    )
  ).toBe(true);
  // An unknown colour scheme is not emulation.
  expect(
    Result.isSuccess(
      decode({
        emulation: { colorScheme: "sepia" },
        steps: [navigateStep],
        title: "Checkout",
      })
    )
  ).toBe(false);
  // An empty permission list grants nothing and says nothing.
  expect(
    Result.isSuccess(
      decode({
        emulation: { permissions: [] },
        steps: [navigateStep],
        title: "Checkout",
      })
    )
  ).toBe(false);
});

test("a Flow declares a Gate as accessibility rule ids", () => {
  const result = decode({
    gate: ["image-alt", "label"],
    steps: [navigateStep],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  expect(result.success.gate).toEqual(["image-alt", "label"]);
  // A Gate that names no rule holds nothing to nothing.
  expect(
    Result.isSuccess(decode({ gate: [], steps: [navigateStep], title: "C" }))
  ).toBe(false);
});

test("Pre-step conditions accept visible, hidden, and URL matches", () => {
  const result = decode({
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
      {
        id: "wait-banner-gone",
        step: {
          key: "Escape",
          target: [{ kind: "css", selector: "#cookie-banner" }],
          type: "press",
        },
        when: {
          target: [{ kind: "css", selector: "#cookie-banner" }],
          type: "selectorHidden",
        },
      },
      {
        id: "checkout-only",
        step: { key: "Escape", type: "press" },
        when: { pattern: "/checkout$", type: "urlMatches" },
      },
    ],
    steps: [navigateStep],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error(
      `Expected the Flow to decode: ${formatIssue(result.failure.issue)}`
    );
  }
  expect(result.success.preSteps?.map(({ when }) => when.type)).toEqual([
    "selectorVisible",
    "selectorHidden",
    "urlMatches",
  ]);

  // A condition that is none of the named types is not a condition.
  expect(
    Result.isSuccess(
      decode({
        preSteps: [
          {
            id: "x",
            step: { key: "Escape", type: "press" },
            when: { text: "banner gone", type: "textContent" },
          },
        ],
        steps: [navigateStep],
        title: "Checkout",
      })
    )
  ).toBe(false);
});

test("a Pre-step cannot navigate or wait", () => {
  const preStep = (step: Record<string, unknown>) =>
    decode({
      preSteps: [
        { id: "clear", step, when: { pattern: "/", type: "urlMatches" } },
      ],
      steps: [navigateStep],
      title: "Checkout",
    });

  expect(
    Result.isSuccess(preStep({ type: "navigate", url: "https://example.com/" }))
  ).toBe(false);
  expect(
    Result.isSuccess(
      preStep({
        condition: { pattern: "/cart$", type: "urlMatches" },
        type: "waitFor",
      })
    )
  ).toBe(false);
});

test("a navigate Step accepts the performance toggle", () => {
  const result = decode({
    steps: [{ ...navigateStep, performance: true }],
    title: "Checkout",
  });

  expect(Result.isSuccess(result)).toBe(true);
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
  expect(
    Result.isSuccess(
      decode({
        steps: [navigateStep, { performance: false, target, type: "click" }],
        title: "Checkout",
      })
    )
  ).toBe(true);
});

test("an Audit Step admits only the accessibility kind and carries authored fields", () => {
  const auditFlow = (kind: string) => ({
    steps: [navigateStep, { id: "audit-1", kind, type: "audit" }],
    title: "Checkout",
  });

  expect(Result.isSuccess(decode(auditFlow("accessibility")))).toBe(true);
  expect(Result.isSuccess(decode(auditFlow("performance")))).toBe(false);

  // An Audit cannot measure performance: it navigates nothing.
  expect(
    Result.isSuccess(
      decode({
        steps: [
          navigateStep,
          {
            id: "audit-1",
            kind: "accessibility",
            performance: true,
            type: "audit",
          },
        ],
        title: "Checkout",
      })
    )
  ).toBe(false);
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
  expect(failureMessage(chromeExport)).toBeTruthy();
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
  const result = decode({
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

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  const encoded = JSON.stringify(encode(result.success));
  expect(encoded).not.toContain("contingency");
  expect(encoded).not.toContain("secretVariable");
  expect(encoded).not.toContain('"video"');
});
