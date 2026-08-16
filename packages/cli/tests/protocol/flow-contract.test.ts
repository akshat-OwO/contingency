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
