(() => {
  /* oxlint-disable unicorn/consistent-function-scoping -- static isolated-world bundle keeps helpers private */

  const binding = globalThis.__CONTINGENCY_BINDING__;
  if (typeof binding !== "function" || globalThis.__contingencyRecorder) {
    return;
  }
  globalThis.__contingencyRecorder = true;
  const selectorAttribute = "data-testid";

  const sensitiveAutocomplete =
    /^(?:current-password|new-password|one-time-code|cc-)/u;
  const sensitiveFieldMetadata =
    /(?:api[_-]?key|(?:access|refresh|id|session)[_-]?token|auth(?:orization)?[_-]?code|client[_-]?secret|credential|secret|pass(?:word|code)?|pin|otp|one[_-]?time|cvv|cvc|social[_-]?security|ssn|private[_-]?key)/u;
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
  const inspector = document.createElement("div");
  const inspectorLabel = document.createElement("div");
  let inspectedElement;
  let inspectorFrame;
  let sequence = 0;

  inspector.setAttribute("aria-hidden", "true");
  inspector.style.cssText =
    "position:fixed;display:none;pointer-events:none;z-index:2147483646;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.16);border-radius:3px;";
  inspectorLabel.style.cssText =
    "position:fixed;display:none;pointer-events:none;z-index:2147483647;box-sizing:border-box;max-width:min(420px,calc(100vw - 16px));overflow:hidden;padding:4px 7px;border-radius:4px;background:#1d4ed8;color:#fff;font:500 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.24);";

  const hideInspector = () => {
    inspectedElement = undefined;
    inspector.style.display = "none";
    inspectorLabel.style.display = "none";
  };

  const inspectorDetails = (element, bounds) => {
    const details = [
      element.localName,
      `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`,
    ];
    if (isSensitive(element)) {
      details.push("sensitive field");
      return details.join(" · ");
    }
    for (const attribute of [
      "role",
      "aria-label",
      "aria-expanded",
      "aria-checked",
      "aria-selected",
    ]) {
      const value = element.getAttribute(attribute)?.trim();
      if (value) {
        details.push(`${attribute}=${value.slice(0, 64)}`);
      }
    }
    return details.join(" · ");
  };

  const updateInspector = () => {
    inspectorFrame = undefined;
    const element = inspectedElement;
    if (!element?.isConnected) {
      hideInspector();
      return;
    }
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      hideInspector();
      return;
    }
    if (!inspector.isConnected) {
      document.documentElement.append(inspector, inspectorLabel);
    }
    inspector.style.display = "block";
    inspector.style.left = `${bounds.left}px`;
    inspector.style.top = `${bounds.top}px`;
    inspector.style.width = `${bounds.width}px`;
    inspector.style.height = `${bounds.height}px`;
    inspectorLabel.textContent = inspectorDetails(element, bounds);
    inspectorLabel.style.display = "block";
    inspectorLabel.style.left = `${Math.max(8, bounds.left)}px`;
    inspectorLabel.style.top = `${Math.max(8, bounds.top - 27)}px`;
  };

  const inspectPointerTarget = (event) => {
    if (!event.isTrusted) {
      return;
    }
    inspectedElement = targetFrom(event);
    if (inspectorFrame === undefined) {
      inspectorFrame = requestAnimationFrame(updateInspector);
    }
  };

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
    for (const attribute of [selectorAttribute, "data-test", "data-cy"]) {
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

  const xpathSelector = (element) => {
    const parts = [];
    let current = element;
    while (current instanceof Element) {
      const root = current.getRootNode();
      if (!(root instanceof Document)) {
        return;
      }
      const name = current.localName;
      const parent = current.parentElement;
      const siblings = parent
        ? [...parent.children].filter((sibling) => sibling.localName === name)
        : [];
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${name}[${Math.max(index, 1)}]`);
      current = parent;
    }
    return parts.length === 0 ? undefined : `xpath//${parts.join("/")}`;
  };

  const pierceSelector = (element) => {
    const css = cssSelector(element);
    if (!css) {
      return;
    }
    return `pierce/${Array.isArray(css) ? css.join(" >>> ") : css}`;
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
    const xpath = xpathSelector(element);
    if (xpath) {
      selectors.push(xpath);
    }
    const pierce = pierceSelector(element);
    if (pierce) {
      selectors.push(pierce);
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

  const variableName = (element) => {
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
    const inputMode = element.getAttribute("inputmode")?.toLowerCase();
    const maximumLength = Number(element.getAttribute("maxlength"));
    const looksLikeUnlabelledCode =
      (inputMode === "numeric" || inputMode === "decimal") &&
      Number.isInteger(maximumLength) &&
      maximumLength >= 4 &&
      maximumLength <= 8;
    return (
      type === "password" ||
      (autocomplete !== undefined &&
        sensitiveAutocomplete.test(autocomplete)) ||
      sensitiveFieldMetadata.test(fieldMetadata) ||
      looksLikeUnlabelledCode
    );
  };

  const handleClick = (event) => {
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
  };

  const handleInput = (event) => {
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
    emitChange(target);
  };

  const handleKey = (event) => {
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
      type: event.type === "keydown" ? "keyDown" : "keyUp",
    });
  };

  const handleBeforeUnload = (event) => {
    if (event.isTrusted) {
      emit({ type: "beforeUnload" });
    }
  };

  addEventListener("mousemove", inspectPointerTarget, true);
  addEventListener("mouseleave", hideInspector, true);
  addEventListener("blur", hideInspector, true);

  globalThis.__contingencyRecorderCleanup = () => {
    removeEventListener("mousemove", inspectPointerTarget, true);
    removeEventListener("mouseleave", hideInspector, true);
    removeEventListener("blur", hideInspector, true);
    removeEventListener("click", handleClick, true);
    removeEventListener("input", handleInput, true);
    removeEventListener("keydown", handleKey, true);
    removeEventListener("keyup", handleKey, true);
    removeEventListener("beforeunload", handleBeforeUnload, true);
    if (inspectorFrame !== undefined) {
      cancelAnimationFrame(inspectorFrame);
    }
    hideInspector();
    inspector.remove();
    inspectorLabel.remove();
    globalThis.__contingencyRecorder = false;
    delete globalThis.__contingencyRecorderCleanup;
  };

  const emitChange = (element) => {
    const selectors = selectorsFor(element);
    if (selectors.length === 0) {
      emit({
        reason: "A replayable selector could not be generated.",
        type: "unsupported",
      });
      return;
    }
    if (isSensitive(element)) {
      const name = variableName(element);
      emit({
        selectors,
        type: "change",
        value: `{{${name}}}`,
        variable: name,
      });
      return;
    }
    emit({ selectors, type: "change", value: String(element.value ?? "") });
  };

  addEventListener("click", handleClick, true);
  addEventListener("input", handleInput, true);
  addEventListener("keydown", handleKey, true);
  addEventListener("keyup", handleKey, true);
  addEventListener("beforeunload", handleBeforeUnload, true);
})();
