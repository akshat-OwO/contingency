(() => {
  /* oxlint-disable unicorn/consistent-function-scoping -- static isolated-world bundle keeps helpers private */

  const binding = globalThis.__CONTINGENCY_BINDING__;
  if (typeof binding !== "function" || globalThis.__contingencyRecorder) {
    return;
  }
  globalThis.__contingencyRecorder = true;

  const sensitiveAutocomplete =
    /^(?:current-password|new-password|one-time-code|cc-)/u;
  const sensitiveFieldMetadata =
    /(?:api[_-]?key|access[_-]?token|auth(?:orization)?[_-]?code|secret|pass(?:word|code)?|pin)/u;
  const meaningfulKeys = new Set([
    "Enter",
    "Escape",
    "Tab",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "Home",
    "End",
    "PageDown",
    "PageUp",
  ]);
  const pendingChanges = new WeakMap();
  let sequence = 0;

  const emit = (value) => {
    sequence += 1;
    binding(JSON.stringify({ event: value, sequence }));
  };

  const cssPart = (element, root) => {
    if (element.id) {
      const candidate = `#${CSS.escape(element.id)}`;
      if (root.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }
    for (const attribute of ["data-testid", "data-test", "data-cy"]) {
      const value = element.getAttribute(attribute);
      if (value) {
        const candidate = `[${attribute}="${CSS.escape(value)}"]`;
        if (root.querySelectorAll(candidate).length === 1) {
          return candidate;
        }
      }
    }

    const parts = [];
    let current = element;
    while (current && current !== root) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const currentLocalName = current.localName;
        const siblings = [...parent.children].filter(
          (sibling) => sibling.localName === currentLocalName
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (root.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
      current = parent;
    }
    return parts.join(" > ");
  };

  const cssSelector = (element) => {
    const segments = [];
    let current = element;
    while (current) {
      const root = current.getRootNode();
      if (!(root instanceof Document || root instanceof ShadowRoot)) {
        return;
      }
      const segment = cssPart(current, root);
      if (!segment) {
        return;
      }
      segments.unshift(segment);
      if (root instanceof Document) {
        break;
      }
      if (root.mode !== "open") {
        return;
      }
      current = root.host;
    }
    return segments.length === 1 ? segments[0] : segments;
  };

  const selectorsFor = (element) => {
    const selectors = [];
    const label = element.getAttribute("aria-label")?.trim();
    if (label) {
      selectors.push(`aria/${label}`);
    }
    const css = cssSelector(element);
    if (css) {
      selectors.push(css);
    }
    const text = element.textContent?.trim().replaceAll(/\s+/gu, " ");
    if (text && text.length <= 80) {
      selectors.push(`text/${text}`);
    }
    return selectors;
  };

  const targetFrom = (event) => {
    for (const target of event.composedPath()) {
      if (target instanceof Element && target.getClientRects().length > 0) {
        return target;
      }
    }
  };

  const secretName = (element) => {
    const raw =
      element.getAttribute("autocomplete") ||
      element.getAttribute("name") ||
      element.getAttribute("id") ||
      element.getAttribute("type") ||
      "SECRET";
    const normalized = raw
      .toUpperCase()
      .replaceAll(/[^A-Z0-9]+/gu, "_")
      .replaceAll(/^_+|_+$/gu, "");
    return normalized || "SECRET";
  };

  const isSensitive = (element) => {
    const type = element.getAttribute("type")?.toLowerCase();
    const autocomplete = element
      .getAttribute("autocomplete")
      ?.trim()
      .toLowerCase();
    const fieldMetadata = [
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      type === "password" ||
      (autocomplete !== undefined &&
        sensitiveAutocomplete.test(autocomplete)) ||
      sensitiveFieldMetadata.test(fieldMetadata)
    );
  };

  const emitChange = (element) => {
    pendingChanges.delete(element);
    const selectors = selectorsFor(element);
    if (selectors.length === 0) {
      emit({
        reason: "A replayable selector could not be generated.",
        type: "unsupported",
      });
      return;
    }
    if (isSensitive(element)) {
      const name = secretName(element);
      emit({
        secretVariable: name,
        selectors,
        type: "change",
        value: `{{${name}}}`,
      });
      return;
    }
    emit({ selectors, type: "change", value: String(element.value ?? "") });
  };

  addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) {
        return;
      }
      const target = targetFrom(event);
      if (!target) {
        return;
      }
      const selectors = selectorsFor(target);
      if (selectors.length === 0) {
        emit({
          reason: "A replayable selector could not be generated.",
          type: "unsupported",
        });
        return;
      }
      const bounds = target.getBoundingClientRect();
      let button = "primary";
      if (event.button === 1) {
        button = "middle";
      } else if (event.button === 2) {
        button = "secondary";
      }
      emit({
        button,
        offsetX: event.clientX - bounds.left,
        offsetY: event.clientY - bounds.top,
        selectors,
        type: "click",
      });
    },
    true
  );

  addEventListener(
    "input",
    (event) => {
      if (!event.isTrusted) {
        return;
      }
      const { target } = event;
      if (
        !(
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement
        )
      ) {
        return;
      }
      const previous = pendingChanges.get(target);
      if (previous !== undefined) {
        clearTimeout(previous);
      }
      pendingChanges.set(
        target,
        setTimeout(() => emitChange(target), 100)
      );
    },
    true
  );

  for (const type of ["keydown", "keyup"]) {
    addEventListener(
      type,
      (event) => {
        if (!event.isTrusted || !meaningfulKeys.has(event.key)) {
          return;
        }
        const target = targetFrom(event);
        if (!target) {
          return;
        }
        const selectors = selectorsFor(target);
        if (selectors.length === 0) {
          emit({
            reason: "A replayable selector could not be generated.",
            type: "unsupported",
          });
          return;
        }
        emit({
          key: event.key,
          selectors,
          type: type === "keydown" ? "keyDown" : "keyUp",
        });
      },
      true
    );
  }

  addEventListener(
    "beforeunload",
    (event) => {
      if (event.isTrusted) {
        emit({ type: "beforeUnload" });
      }
    },
    true
  );
})();
