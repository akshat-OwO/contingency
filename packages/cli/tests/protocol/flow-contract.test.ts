import { Flow } from "@contingency/protocol";
import { Result, Schema, SchemaIssue } from "effect";
import { expect, test } from "vitest";

const decode = Schema.decodeUnknownResult(Flow);
const formatIssue = SchemaIssue.makeFormatterDefault();

const navigateStep = {
  type: "navigate",
  url: "https://example.com/login",
};

const clickStep = {
  offsetX: 4,
  offsetY: 8,
  selectors: [["#submit"]],
  type: "click",
};

const failureMessage = (input: unknown): string => {
  const result = decode(input);
  if (Result.isSuccess(result)) {
    throw new Error("Expected the Flow to be rejected");
  }
  return formatIssue(result.failure.issue);
};

test("a plain Chrome DevTools Recorder export decodes as a Flow", () => {
  // No Contingency fields at all: the shape the Recorder extension exports.
  const result = decode({
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
  });

  expect(Result.isSuccess(result)).toBe(true);
});

test("a Flow carries a stable identity distinct from its title", () => {
  const result = decode({
    contingency: { flowId: "b6f1c9f0-checkout" },
    steps: [navigateStep],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  expect(result.success.contingency?.flowId).toBe("b6f1c9f0-checkout");
  expect(result.success.title).toBe("Checkout");
});

test("a Flow carries a video capture flag", () => {
  const result = decode({
    contingency: { video: true },
    steps: [navigateStep],
    title: "Checkout",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  expect(result.success.contingency?.video).toBe(true);
});

test("a navigate Step accepts the performance toggle", () => {
  const result = decode({
    steps: [{ ...navigateStep, contingency: { id: "one", performance: true } }],
    title: "Checkout",
  });

  expect(Result.isSuccess(result)).toBe(true);
});

test("a click Step with an asserted navigation accepts the performance toggle", () => {
  const result = decode({
    steps: [
      navigateStep,
      {
        ...clickStep,
        assertedEvents: [
          { type: "navigation", url: "https://example.com/dashboard" },
        ],
        contingency: { id: "two", performance: true },
      },
    ],
    title: "Checkout",
  });

  expect(Result.isSuccess(result)).toBe(true);
});

test("a click Step with no asserted navigation rejects the performance toggle", () => {
  const message = failureMessage({
    steps: [
      navigateStep,
      { ...clickStep, contingency: { id: "two", performance: true } },
    ],
    title: "Checkout",
  });

  expect(message).toContain("Step 2");
  expect(message).toContain("click");
  expect(message).toContain("two");
});

test("a change Step rejects the performance toggle", () => {
  const message = failureMessage({
    steps: [
      navigateStep,
      {
        contingency: { id: "two", performance: true },
        selectors: [["#quantity"]],
        type: "change",
        value: "2",
      },
    ],
    title: "Checkout",
  });

  expect(message).toContain("Step 2");
  expect(message).toContain("change");
});

test("a keyDown Step rejects the performance toggle", () => {
  const message = failureMessage({
    steps: [
      navigateStep,
      {
        contingency: { id: "two", performance: true },
        key: "Enter",
        selectors: [["#quantity"]],
        type: "keyDown",
      },
    ],
    title: "Checkout",
  });

  expect(message).toContain("Step 2");
  expect(message).toContain("keyDown");
});

test("performance: false on a non-navigating Step is not a rejection", () => {
  const result = decode({
    steps: [
      navigateStep,
      { ...clickStep, contingency: { id: "two", performance: false } },
    ],
    title: "Checkout",
  });

  expect(Result.isSuccess(result)).toBe(true);
});

test("an Audit Step admits only the accessibility kind", () => {
  const auditFlow = (kind: string) => ({
    steps: [
      navigateStep,
      {
        name: "contingency.audit",
        parameters: { kind },
        type: "customStep",
      },
    ],
    title: "Checkout",
  });

  expect(Result.isSuccess(decode(auditFlow("accessibility")))).toBe(true);
  expect(Result.isSuccess(decode(auditFlow("performance")))).toBe(false);
});

test("a pre-rename Flow keeps its Variable declaration and Step binding", () => {
  // The exact shape `main` exported before secretVariables was renamed to
  // variables: a declaration at Flow level and a binding on the change Step.
  const result = decode({
    contingency: { secretVariables: [{ name: "PASSWORD" }] },
    steps: [
      navigateStep,
      {
        contingency: { id: "password", secretVariable: "PASSWORD" },
        selectors: [["#password"]],
        type: "change",
        value: "{{PASSWORD}}",
      },
    ],
    title: "Legacy login",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the legacy Flow to decode");
  }
  expect(result.success.contingency?.variables).toEqual([
    { name: "PASSWORD", runtime: true, secret: true },
  ]);
  const [, change] = result.success.steps;
  if (change === undefined || change.type === "customStep") {
    throw new Error("Expected Step 2 to be a browser Step");
  }
  expect(change.contingency?.variable).toBe("PASSWORD");
});

test("a migrated legacy Variable is secret and runtime", () => {
  // A legacy Variable was a credential the recorder never stored, so running
  // the migrated Flow must redact it and prompt for it rather than fail
  // preflight on a Flow that could never carry its own value.
  const result = decode({
    contingency: { secretVariables: [{ name: "TOKEN" }] },
    steps: [navigateStep],
    title: "Legacy",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the legacy Flow to decode");
  }
  expect(result.success.contingency?.variables).toEqual([
    { name: "TOKEN", runtime: true, secret: true },
  ]);
});

test("a current-format Variable wins over a legacy one of the same name", () => {
  const result = decode({
    contingency: {
      secretVariables: [{ name: "TOKEN" }],
      variables: [{ name: "TOKEN", runtime: false, secret: false }],
    },
    steps: [navigateStep],
    title: "Both",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the Flow to decode");
  }
  expect(result.success.contingency?.variables).toEqual([
    { name: "TOKEN", runtime: false, secret: false },
  ]);
});

test("encoding a migrated Flow emits only the current format", () => {
  const encode = Schema.encodeSync(Flow);
  const result = decode({
    contingency: { secretVariables: [{ name: "PASSWORD" }] },
    steps: [
      {
        contingency: { id: "password", secretVariable: "PASSWORD" },
        selectors: [["#password"]],
        type: "change",
        value: "{{PASSWORD}}",
      },
    ],
    title: "Legacy login",
  });

  if (Result.isFailure(result)) {
    throw new Error("Expected the legacy Flow to decode");
  }
  const encoded = encode(result.success) as Record<string, unknown>;
  // Neither the Flow-level declaration nor the Step binding survives in the
  // old spelling: re-encoding a migrated Flow emits only current fields.
  expect(JSON.stringify(encoded)).not.toContain("secretVariable");
});
