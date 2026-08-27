/**
 * The recorder that runs inside the recorded page.
 *
 * Contingency owns recording and injects code that emits *data*, never code
 * that decides anything ([ADR
 * 0012](../../../../docs/adr/0012-playwright-is-the-in-process-browser-runtime.md)).
 * Playwright installs it through `addInitScript` on the pinned context, so
 * every Page and every frame — including a cross-origin one and a popup — runs
 * it at document start without a single raw CDP call.
 *
 * The script is a source string rather than a module because the CLI compiles
 * without the DOM lib, and because what crosses the binding must stay a
 * string: the CLI treats everything below as untrusted input, bounds it, and
 * schema-validates it before it reaches a Recording.
 *
 * Two things stay deliberately outside: a closed shadow root, which no
 * injected script can address, and mouse movement, which only ever draws the
 * inspection outline. Hover becomes a Step by explicit author gesture ([ADR
 * 0019](../../../../docs/adr/0019-recording-follows-pages.md)), which the CLI
 * decides, so this script never guesses one.
 */
const RECORDER_SOURCE = String.raw`
(() => {
  const binding = globalThis.__CONTINGENCY_BINDING__;
  if (
    typeof binding !== "function" ||
    globalThis.__contingencyRecorder === "__CONTINGENCY_INSTALL__"
  ) {
    return;
  }
  // Take the binding out of the page's reach. It stays callable through this
  // closure, which page code cannot read, but it can no longer be found on
  // the global object or enumerated: a site cannot call it to forge a Step.
  // Nothing below ever stores it on a global again — the install marker is a
  // string, so the transport is not reachable by walking the page's globals.
  delete globalThis.__CONTINGENCY_BINDING__;
  // Nothing here calls the cleanup already on the page. Whatever sits at that
  // name in an existing document is page-owned until this script overwrites
  // it, and handing it this Recording's nonce would give the page the one
  // secret that makes a report the recorder's. A previous install is torn
  // down by the CLI with its own nonce before a new one starts.
  globalThis.__contingencyRecorder = "__CONTINGENCY_INSTALL__";

  // Pristine before any page script has run. A site that later replaces
  // JSON.stringify — or hangs a toJSON off Object.prototype — cannot observe
  // or rewrite what the recorder reports through these.
  const stringify = JSON.stringify;

  /** One document, one counter: a reload starts a fresh, detectable run. */
  const documentId =
    globalThis.crypto?.randomUUID?.() ??
    String(Date.now()) + ":" + String(Math.random());
  let sequence = 0;

  /** How long the page must sit still before a scroll is a resting position. */
  const SCROLL_REST_MS = 250;
  const MAX_TEXT_LENGTH = 80;

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

  const implicitRoles = {
    a: "link",
    article: "article",
    aside: "complementary",
    button: "button",
    dialog: "dialog",
    footer: "contentinfo",
    form: "form",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    header: "banner",
    img: "img",
    main: "main",
    nav: "navigation",
    ol: "list",
    option: "option",
    progress: "progressbar",
    section: "region",
    select: "combobox",
    summary: "button",
    table: "table",
    textarea: "textbox",
    ul: "list",
  };
  const inputRoles = {
    button: "button",
    checkbox: "checkbox",
    email: "textbox",
    image: "button",
    number: "spinbutton",
    radio: "radio",
    range: "slider",
    reset: "button",
    search: "searchbox",
    submit: "button",
    tel: "textbox",
    text: "textbox",
    url: "textbox",
  };

  const collapse = (value) =>
    typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";

  const roleOf = (element) => {
    const explicit = collapse(element.getAttribute("role"));
    if (explicit) {
      return explicit.split(" ")[0];
    }
    const name = element.localName;
    if (name === "a") {
      return element.hasAttribute("href") ? "link" : undefined;
    }
    if (name === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      return inputRoles[type];
    }
    return implicitRoles[name];
  };

  const labelledByText = (element) => {
    const ids = collapse(element.getAttribute("aria-labelledby"));
    if (!ids) {
      return "";
    }
    const root = element.getRootNode();
    return collapse(
      ids
        .split(" ")
        .map((id) => root.getElementById?.(id)?.textContent ?? "")
        .join(" ")
    );
  };

  /** The label text a control carries, as Playwright's getByLabel reads it. */
  const labelText = (element) => {
    const wrapping = element.closest?.("label");
    if (wrapping) {
      return collapse(wrapping.textContent);
    }
    const id = element.getAttribute("id");
    if (!id) {
      return "";
    }
    const root = element.getRootNode();
    const associated = root.querySelector?.(
      "label[for=" + stringify(id) + "]"
    );
    return associated ? collapse(associated.textContent) : "";
  };

  const accessibleName = (element) =>
    collapse(element.getAttribute("aria-label")) ||
    labelledByText(element) ||
    labelText(element) ||
    collapse(element.getAttribute("alt")) ||
    collapse(element.getAttribute("title")) ||
    collapse(
      element.localName === "input" ||
        element.localName === "textarea" ||
        element.localName === "select"
        ? ""
        : element.textContent
    );

  const cssPart = (element, root) => {
    const id = element.getAttribute("id");
    if (id) {
      const candidate = "#" + CSS.escape(id);
      if (root.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }
    const parts = [];
    let current = element;
    while (current && current !== root) {
      let part = current.localName;
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(
          (sibling) => sibling.localName === current.localName
        );
        if (siblings.length > 1) {
          part += ":nth-of-type(" + String(siblings.indexOf(current) + 1) + ")";
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

  /**
   * A CSS selector that crosses open shadow roots with Playwright's own
   * piercing combinator. A closed root cannot be crossed by anyone, so the
   * element is reported as unaddressable rather than mis-addressed.
   */
  const cssSelector = (element) => {
    const segments = [];
    let current = element;
    while (current) {
      const root = current.getRootNode();
      const isShadow = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot;
      if (!(root instanceof Document || isShadow)) {
        return;
      }
      const segment = cssPart(current, root);
      if (!segment) {
        return;
      }
      segments.unshift(segment);
      if (!isShadow) {
        return segments.join(" >> ");
      }
      if (root.mode !== "open") {
        return;
      }
      current = root.host;
    }
    return;
  };

  const xpathSelector = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1) {
      if (!(current.getRootNode() instanceof Document)) {
        return;
      }
      const name = current.localName;
      const parent = current.parentElement;
      const siblings = parent
        ? [...parent.children].filter((sibling) => sibling.localName === name)
        : [];
      parts.unshift(name + "[" + String(Math.max(siblings.indexOf(current) + 1, 1)) + "]");
      current = parent;
    }
    return parts.length === 0 ? undefined : "//" + parts.join("/");
  };

  /**
   * The locator ladder, in the order a Run tries it: role with accessible
   * name, label, placeholder, text, CSS, then XPath. No test-id descriptor is
   * ever emitted — Contingency audits sites it does not own.
   */
  const targetFor = (element) => {
    const target = [];
    const role = roleOf(element);
    const name = accessibleName(element);
    if (role && name && name.length <= MAX_TEXT_LENGTH) {
      target.push({ kind: "role", name, role });
    }
    const label = labelText(element) || collapse(element.getAttribute("aria-label"));
    if (label && label.length <= MAX_TEXT_LENGTH) {
      target.push({ kind: "label", label });
    }
    const placeholder = collapse(element.getAttribute("placeholder"));
    if (placeholder) {
      target.push({ kind: "placeholder", placeholder });
    }
    const text = collapse(element.textContent);
    if (text && text.length <= MAX_TEXT_LENGTH) {
      target.push({ kind: "text", text });
    }
    const css = cssSelector(element);
    if (css) {
      target.push({ kind: "css", selector: css });
    }
    const xpath = xpathSelector(element);
    if (xpath) {
      target.push({ kind: "xpath", expression: xpath });
    }
    return target;
  };

  const emit = (event) => {
    sequence += 1;
    // The nonce travels as its own argument, never inside the serialized
    // payload: it says this came from the recorder rather than from the page,
    // so it must not pass through anything the page can hook. What is
    // serialized is the page's own data, which the page already has.
    // A binding disposed by a stopped capture must not throw into the page.
    try {
      binding(
        "__CONTINGENCY_NONCE__",
        stringify({ documentId, event, sequence })
      );
    } catch {
      // Reporting is over; the page is not the place to say so.
    }
  };

  const unaddressable = () => {
    emit({
      reason: "An element on the page could not be addressed by any locator.",
      type: "unsupported",
    });
  };

  const elementFrom = (event) => {
    for (const candidate of event.composedPath()) {
      if (candidate instanceof Element && candidate.getClientRects().length > 0) {
        return candidate;
      }
    }
    return;
  };

  // What the field calls itself. The CLI normalises this into a Variable
  // name and makes it unique, so the page does not guess at either.
  const variableName = (element) =>
    (
      element.getAttribute("autocomplete") ||
      element.getAttribute("name") ||
      element.getAttribute("id") ||
      element.getAttribute("type") ||
      "SECRET"
    ).slice(0, 64);

  const isSensitive = (element) => {
    const type = element.getAttribute("type")?.toLowerCase();
    const autocomplete = collapse(element.getAttribute("autocomplete")).toLowerCase();
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
      (autocomplete.length > 0 && sensitiveAutocomplete.test(autocomplete)) ||
      sensitiveFieldMetadata.test(fieldMetadata) ||
      looksLikeUnlabelledCode
    );
  };

  // -------------------------------------------------------------------------
  // The inspection outline. A signal to the author, never a Step.
  // -------------------------------------------------------------------------

  const inspector = document.createElement("div");
  const inspectorLabel = document.createElement("div");
  let inspectedElement;
  let inspectorFrame;

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
      Math.round(bounds.width) + " × " + Math.round(bounds.height),
    ];
    if (isSensitive(element)) {
      details.push("sensitive field");
      return details.join(" · ");
    }
    const role = roleOf(element);
    if (role) {
      details.push("role=" + role);
    }
    const name = accessibleName(element);
    if (name) {
      details.push("name=" + name.slice(0, 64));
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
    inspector.style.left = bounds.left + "px";
    inspector.style.top = bounds.top + "px";
    inspector.style.width = bounds.width + "px";
    inspector.style.height = bounds.height + "px";
    inspectorLabel.textContent = inspectorDetails(element, bounds);
    inspectorLabel.style.display = "block";
    inspectorLabel.style.left = Math.max(8, bounds.left) + "px";
    inspectorLabel.style.top = Math.max(8, bounds.top - 27) + "px";
  };

  const inspectPointerTarget = (event) => {
    if (!event.isTrusted) {
      return;
    }
    inspectedElement = elementFrom(event);
    if (inspectorFrame === undefined) {
      inspectorFrame = requestAnimationFrame(updateInspector);
    }
  };

  // -------------------------------------------------------------------------
  // Captured events. Only trusted ones: a page's own synthetic click is the
  // site behaving, not the author acting.
  // -------------------------------------------------------------------------

  const emitTargeted = (element, build) => {
    const target = targetFor(element);
    if (target.length === 0) {
      unaddressable();
      return;
    }
    emit(build(target));
  };

  const handleClick = (event) => {
    if (!event.isTrusted) {
      return;
    }
    const element = elementFrom(event);
    if (!element) {
      return;
    }
    let button = "left";
    if (event.button === 1) {
      button = "middle";
    } else if (event.button === 2) {
      button = "right";
    }
    emitTargeted(element, (target) => ({ button, target, type: "click" }));
  };

  const emitChange = (element) => {
    if (element.localName === "select") {
      const values = [...element.selectedOptions].map((option) => option.value);
      emitTargeted(element, (target) => ({
        target,
        type: "selectOption",
        values,
      }));
      return;
    }
    if (isSensitive(element)) {
      const name = variableName(element);
      emitTargeted(element, (target) => ({
        target,
        type: "change",
        value: "{{" + name + "}}",
        variable: name,
      }));
      return;
    }
    emitTargeted(element, (target) => ({
      target,
      type: "change",
      value: String(element.value ?? ""),
    }));
  };

  // A text field settles on "input" and a select on "change", so each control
  // reports once rather than twice for the same edit.
  const handleInput = (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = event.target;
    const isSelect = target instanceof HTMLSelectElement;
    if (isSelect !== (event.type === "change")) {
      return;
    }
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

  /** One keystroke, one Step: a press rather than a keyDown and keyUp pair. */
  const handleKey = (event) => {
    if (!event.isTrusted || !meaningfulKeys.has(event.key)) {
      return;
    }
    const element = elementFrom(event);
    if (!element) {
      emit({ key: event.key, type: "press" });
      return;
    }
    emitTargeted(element, (target) => ({
      key: event.key,
      target,
      type: "press",
    }));
  };

  const handleBeforeUnload = (event) => {
    if (event.isTrusted) {
      emit({ type: "beforeUnload" });
    }
  };

  // Scroll is captured without being annotated, and coalesced to one Step per
  // resting position: what the author meant is where the page came to rest,
  // not the wheel ticks that took it there.
  //
  // A scroll inside a container counts too — a lazy-loading list or an open
  // menu is the case that matters — so each scrolled thing keeps its own
  // resting position. A ScrollStep names no container, and replay scrolls
  // whatever is under the pointer, so what is recorded is the distance.
  const scrollPositions = new WeakMap();
  let restTimer;
  let pendingScrollTarget;

  const scrollPositionOf = (target) =>
    target === document || target === globalThis
      ? { x: Math.round(globalThis.scrollX), y: Math.round(globalThis.scrollY) }
      : { x: Math.round(target.scrollLeft), y: Math.round(target.scrollTop) };

  const scrollKey = (target) =>
    target === document || target === globalThis
      ? document.documentElement
      : target;

  const settleScroll = () => {
    restTimer = undefined;
    const target = pendingScrollTarget;
    pendingScrollTarget = undefined;
    if (!target) {
      return;
    }
    const key = scrollKey(target);
    const position = scrollPositionOf(target);
    const resting = scrollPositions.get(key) ?? { x: 0, y: 0 };
    scrollPositions.set(key, position);
    const deltaX = position.x - resting.x;
    const deltaY = position.y - resting.y;
    if (deltaX === 0 && deltaY === 0) {
      return;
    }
    emit({
      ...(deltaX === 0 ? {} : { deltaX }),
      ...(deltaY === 0 ? {} : { deltaY }),
      type: "scroll",
    });
  };

  const handleScroll = (event) => {
    if (!event.isTrusted) {
      return;
    }
    const target = event.target ?? document;
    const key = scrollKey(target);
    // Where this thing was before the author touched it. Recorded on the way
    // past, so a page that loads already scrolled — an anchor, a restored
    // position — does not report that offset as the author's first scroll.
    if (!scrollPositions.has(key)) {
      scrollPositions.set(key, scrollPositionOf(target));
      return;
    }
    pendingScrollTarget = target;
    if (restTimer !== undefined) {
      clearTimeout(restTimer);
    }
    restTimer = setTimeout(settleScroll, SCROLL_REST_MS);
  };

  scrollPositions.set(document.documentElement, {
    x: Math.round(globalThis.scrollX),
    y: Math.round(globalThis.scrollY),
  });

  addEventListener("mousemove", inspectPointerTarget, true);
  addEventListener("mouseleave", hideInspector, true);
  addEventListener("blur", hideInspector, true);
  addEventListener("click", handleClick, true);
  addEventListener("input", handleInput, true);
  addEventListener("change", handleInput, true);
  addEventListener("keydown", handleKey, true);
  addEventListener("beforeunload", handleBeforeUnload, true);
  addEventListener("scroll", handleScroll, true);

  // Only the recorder may stop the recorder. Without this the page could call
  // cleanup and silently end capture, which omits actions rather than failing.
  globalThis.__contingencyRecorderCleanup = (nonce) => {
    if (nonce !== "__CONTINGENCY_NONCE__") {
      return;
    }
    removeEventListener("mousemove", inspectPointerTarget, true);
    removeEventListener("mouseleave", hideInspector, true);
    removeEventListener("blur", hideInspector, true);
    removeEventListener("click", handleClick, true);
    removeEventListener("input", handleInput, true);
    removeEventListener("change", handleInput, true);
    removeEventListener("keydown", handleKey, true);
    removeEventListener("beforeunload", handleBeforeUnload, true);
    removeEventListener("scroll", handleScroll, true);
    if (inspectorFrame !== undefined) {
      cancelAnimationFrame(inspectorFrame);
    }
    if (restTimer !== undefined) {
      clearTimeout(restTimer);
    }
    hideInspector();
    inspector.remove();
    inspectorLabel.remove();
    globalThis.__contingencyRecorder = undefined;
    delete globalThis.__contingencyRecorderCleanup;
  };
})();
`;

/**
 * The expression that removes the recorder from a document it is running in.
 * Carries the Recording's nonce, because cleanup is the recorder's to call.
 */
export const recorderCleanupExpression = (nonce: string): string =>
  `globalThis.__contingencyRecorderCleanup?.(${JSON.stringify(nonce)})`;

/**
 * The recorder source, bound to the page function Playwright exposed for this
 * Recording and to the nonce that identifies its own reports.
 *
 * Both are per-Recording and unguessable. The script hides the binding from
 * the page on the way in, and the nonce means that even a leaked binding name
 * cannot be used to forge a Step.
 */
export const recorderScriptSource = (
  bindingName: string,
  nonce: string,
  installId: string
): string =>
  RECORDER_SOURCE.replaceAll("__CONTINGENCY_BINDING__", bindingName)
    .replaceAll("__CONTINGENCY_NONCE__", nonce)
    .replaceAll("__CONTINGENCY_INSTALL__", installId);
