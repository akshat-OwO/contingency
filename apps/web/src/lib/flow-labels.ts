import type { AuthoredStep, LocatorDescriptor } from "@contingency/protocol";
import { matchLocatorDescriptor } from "@contingency/protocol";

export const describeLocator = (descriptor: LocatorDescriptor): string =>
  matchLocatorDescriptor(descriptor, {
    css: ({ selector }) => selector,
    label: ({ label }) => `label "${label}"`,
    placeholder: ({ placeholder }) => `placeholder "${placeholder}"`,
    role: ({ name, role }) => `${role} "${name}"`,
    text: ({ text }) => `"${text}"`,
    xpath: ({ expression }) => expression,
  });

/**
 * The ladder is ordered alternatives, not a path, so a label names the leading
 * descriptor — the strategy most likely to still resolve.
 */
export const targetLabel = (target: readonly LocatorDescriptor[]): string => {
  const [lead] = target;
  return lead === undefined ? "" : describeLocator(lead);
};

/**
 * One line naming what a Step does, for a reader scanning a timeline. It says
 * what the Step acts on rather than only its kind: a Flow with nine clicks is
 * unreadable when every entry says "Click element".
 */
export const describeStep = (step: AuthoredStep): string => {
  switch (step.type) {
    case "audit": {
      return "Accessibility Audit";
    }
    case "navigate": {
      try {
        const { hostname, pathname } = new URL(step.url);
        return `Navigate to ${hostname}${pathname === "/" ? "" : pathname}`;
      } catch {
        return `Navigate to ${step.url}`;
      }
    }
    case "click": {
      return `Click ${targetLabel(step.target)}`;
    }
    case "change": {
      return `Enter a value into ${targetLabel(step.target)}`;
    }
    case "hover": {
      return `Hover ${targetLabel(step.target)}`;
    }
    case "selectOption": {
      return `Select ${step.values.join(", ")}`;
    }
    case "scroll": {
      return step.target === undefined
        ? "Scroll the page"
        : `Scroll ${targetLabel(step.target)}`;
    }
    case "press": {
      return `Press ${step.key}`;
    }
    case "keyDown": {
      return `Hold ${step.key}`;
    }
    case "keyUp": {
      return `Release ${step.key}`;
    }
    case "waitFor": {
      return step.condition.type === "urlMatches"
        ? `Wait for the URL to match ${step.condition.pattern}`
        : `Wait for ${targetLabel(step.condition.target)} to be ${
            step.condition.type === "selectorVisible" ? "visible" : "hidden"
          }`;
    }
    default: {
      // A new Step kind must be named here rather than inherit a wrong label.
      const unhandled: never = step;
      return unhandled;
    }
  }
};
