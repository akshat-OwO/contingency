// Throwaway prototype: four ways to comment during Teaching, with and without
// an inspected element. Every variant shares one comment model and one inspect
// mode, so the only thing that changes between them is the surface.

const VARIANTS = [
  {
    id: "composer",
    name: "A · Composer",
    note: "Floating composer bottom-left, history above it, dock beside it.",
  },
  {
    id: "dock",
    name: "B · Unified dock",
    note: "The comment field lives inside the dock. One floating surface.",
  },
  {
    id: "rail",
    name: "C · Thread rail",
    note: "A side rail holds the thread and the composer. Nothing covers the page.",
  },
  {
    id: "spotlight",
    name: "D · Spotlight",
    note: "Press / for a command-palette composer. The dock stays one row.",
  },
];

const PLACEMENTS = ["auto", "center", "right", "stacked"];

const RECORDING_STARTED = Date.now() - 72_000;
const CURRENT_URL = "/cart";

const elapsed = () => Math.floor((Date.now() - RECORDING_STARTED) / 1000);
const clock = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const seedComments = () => [
  {
    at: 9,
    id: "c1",
    target: null,
    text: "If the cookie banner shows up, dismiss it. It is optional and not part of the journey.",
    url: "/login",
  },
  {
    at: 41,
    id: "c2",
    target: { label: 'combobox "Quantity"', selector: "#quantity" },
    text: "Quantity has to be 3 or more, otherwise the promo code is rejected.",
    url: CURRENT_URL,
  },
];

const initialVariant = () => {
  const hash = globalThis.location.hash.slice(1);
  return VARIANTS.some((variant) => variant.id === hash) ? hash : "composer";
};

const state = {
  attached: null,
  comments: seedComments(),
  draft: "",
  focusComment: null,
  historyOpen: false,
  hovered: null,
  inspecting: false,
  placement: "auto",
  preview: null,
  railOpen: true,
  spotlightOpen: false,
  toast: null,
  variant: initialVariant(),
};

/* Elements that appeared since the last render animate in; nothing else does. */
const entering = new Set();
const enter = (key, kind = "") =>
  entering.has(key) ? `data-enter="${kind}"` : "";

const app = document.querySelector("#app");

// ---------------------------------------------------------------------------
// Mock browser page. It stands in for the screencast so inspect has real
// elements to select.

const mockPage = () => `
  <header class="flex items-center gap-6 border-b bg-background px-6 py-3" data-region="Site header">
    <a class="text-sm font-semibold" href="#" id="logo">Pantry Direct</a>
    <nav class="text-muted-foreground flex gap-4 text-sm">
      <a href="#">Shop</a><a href="#">Orders</a><a href="#">Account</a>
    </nav>
    <span class="flex-1"></span>
    <button class="btn-ghost h-8 px-2" aria-label="Cart, 1 item" id="cart-button" type="button">
      <i class="ph ph-shopping-cart text-lg"></i>1
    </button>
  </header>
  <div class="mx-auto w-full max-w-2xl space-y-6 px-6 py-10">
    <h1 class="text-xl font-semibold" id="cart-heading">Your cart</h1>
    <div class="flex items-center gap-4 rounded-lg border bg-background p-4" data-region="Line item" id="line-item">
      <div class="bg-muted size-16 rounded-md"></div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium" id="item-name">Oat milk, case of 12</p>
        <p class="text-muted-foreground text-xs" id="item-price">GBP 18.40 per case</p>
      </div>
      <label class="sr-only" for="quantity">Quantity</label>
      <select class="mock-field" id="quantity">
        <option>1</option><option selected>3</option><option>6</option>
      </select>
    </div>
    <div class="flex items-center gap-3">
      <label class="sr-only" for="promo">Promotion code</label>
      <input class="mock-field flex-1" id="promo" placeholder="Promotion code" />
      <button class="btn-outline" id="apply-promo" type="button">Apply</button>
    </div>
    <div class="flex items-center justify-between rounded-lg border bg-background p-4" data-region="Order total" id="total">
      <p class="text-sm" id="total-label">Total <span class="mono">GBP 55.20</span></p>
      <button class="btn-primary" id="place-order" type="button">Place order</button>
    </div>
    <section class="space-y-3 pt-6">
      <h2 class="text-sm font-semibold" id="recommended">You might also like</h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        ${["Rolled oats", "Almond butter", "Sourdough loaf"]
          .map(
            (name, index) => `
          <div class="space-y-2 rounded-lg border bg-background p-3" data-region="Product card">
            <div class="bg-muted aspect-[4/3] rounded-md"></div>
            <p class="text-sm font-medium" id="rec-${index}">${name}</p>
            <button class="btn-outline h-8 w-full text-xs" id="rec-add-${index}" type="button">Add to cart</button>
          </div>`
          )
          .join("")}
      </div>
    </section>
  </div>`;

const ROLE = {
  A: "link",
  BUTTON: "button",
  H1: "heading",
  H2: "heading",
  INPUT: "textbox",
  P: "text",
  SELECT: "combobox",
};

const PICKABLE = "button, input, select, h1, h2, p, a, [data-region]";

const pickable = (target) => {
  const element = target.closest?.(PICKABLE);
  return element && document.querySelector("#page").contains(element)
    ? element
    : null;
};

const describe = (element) => {
  if (element.dataset.region) {
    return `group "${element.dataset.region}"`;
  }
  const label = element.id
    ? document.querySelector(`label[for="${element.id}"]`)?.textContent
    : undefined;
  const name = (
    element.getAttribute("aria-label") ??
    label ??
    (element.textContent.trim() || element.getAttribute("placeholder") || "")
  ).replaceAll(/\s+/g, " ");
  const short = name.length > 36 ? `${name.slice(0, 35)}…` : name;
  return `${ROLE[element.tagName] ?? "element"} "${short}"`;
};

let pickCounter = 0;
const selectorFor = (element) => {
  if (element.id) {
    return `#${element.id}`;
  }
  if (!element.dataset.pick) {
    pickCounter += 1;
    element.dataset.pick = `p${pickCounter}`;
  }
  return `[data-pick="${element.dataset.pick}"]`;
};

// ---------------------------------------------------------------------------
// Shared pieces.

const commentNumber = (comment) =>
  state.comments.filter((item) => item.target !== null).indexOf(comment) + 1;

const onPage = (comment) =>
  comment.target !== null &&
  comment.url === CURRENT_URL &&
  document.querySelector(comment.target.selector) !== null;

const attachedChip = (size = "sm") =>
  state.attached === null
    ? ""
    : `<span ${enter("chip", "fade")} class="bg-inspect/12 text-inspect inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-0.5 pl-1.5 ${size === "lg" ? "text-sm" : "text-xs"} font-medium">
        <i class="ph ph-crosshair-simple shrink-0"></i>
        <span class="truncate">${escapeHtml(state.attached.label)}</span>
        <button aria-label="Remove attached element" class="hover:bg-inspect/15 grid size-5 shrink-0 place-items-center rounded" data-action="detach" type="button"><i class="ph ph-x text-[11px]"></i></button>
      </span>`;

const inspectButton = (withLabel = false) =>
  withLabel
    ? `<button aria-pressed="${state.inspecting}" class="btn-ghost text-muted-foreground aria-pressed:bg-inspect/15 aria-pressed:text-inspect h-8 rounded-full px-2.5 text-xs" data-action="inspect" title="Inspect (I)" type="button">
        <i class="ph ph-cursor-click text-base"></i>${state.attached ? "Change element" : "Attach element"}<span class="kbd">⌘I</span>
      </button>`
    : `<button aria-label="Inspect an element to attach" aria-pressed="${state.inspecting}" class="icon-btn" data-action="inspect" title="Inspect an element (I)" type="button"><i class="ph ph-cursor-click"></i></button>`;

const countBadge = () =>
  state.comments.length === 0
    ? ""
    : `<span class="bg-primary text-primary-foreground pointer-events-none absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold tabular-nums" data-count>${state.comments.length}</span>`;

const historyButton = () =>
  `<button aria-expanded="${state.historyOpen}" aria-label="Comment history, ${state.comments.length} comments" class="icon-btn relative" data-action="history" title="History (H)" type="button">
    <i class="ph ph-clock-counter-clockwise"></i>${countBadge()}
  </button>`;

const sendButton = (label = "") =>
  label
    ? `<button aria-label="Add comment" class="btn-primary h-8 rounded-full px-3 text-xs" data-action="send" ${state.draft.trim() ? "" : "disabled"} type="button">${label}<span class="opacity-60">↵</span></button>`
    : `<button aria-label="Add comment" class="btn-primary size-8 rounded-full p-0" data-action="send" ${state.draft.trim() ? "" : "disabled"} type="button"><i class="ph-bold ph-arrow-up"></i></button>`;

const commentField = (placeholder, extra = "") =>
  `<textarea aria-label="Comment" class="comment-input placeholder:text-muted-foreground block w-full resize-none bg-transparent text-sm leading-6 outline-none ${extra}" id="comment-input" placeholder="${escapeHtml(placeholder)}" rows="1">${escapeHtml(state.draft)}</textarea>`;

const targetMeta = (comment) =>
  comment.target === null
    ? `<span class="inline-flex items-center gap-1"><i class="ph ph-browser"></i>Page · <span class="mono">${comment.url}</span></span>`
    : `<span class="text-inspect inline-flex min-w-0 items-center gap-1"><i class="ph ph-crosshair-simple shrink-0"></i><span class="truncate">${escapeHtml(comment.target.label)}</span></span>`;

const commentItem = (comment) => {
  const number = comment.target === null ? 0 : commentNumber(comment);
  const focused = state.focusComment === comment.id;
  return `<li>
    <button class="hover:bg-accent ${focused ? "bg-accent" : ""} flex w-full gap-3 rounded-xl px-2.5 py-2 text-left transition-colors" data-comment="${comment.id}" type="button">
      <span class="${number > 0 ? "bg-inspect text-white" : "bg-muted text-muted-foreground"} mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold">${number > 0 ? number : '<i class="ph ph-chat-circle text-[11px]"></i>'}</span>
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="text-sm leading-snug text-pretty">${escapeHtml(comment.text)}</span>
        <span class="text-muted-foreground flex min-w-0 items-center gap-2 text-[11px]">
          <span class="mono shrink-0 tabular-nums">${clock(comment.at)}</span>${targetMeta(comment)}
        </span>
      </span>
    </button>
  </li>`;
};

const commentList = (className = "") =>
  state.comments.length === 0
    ? `<p class="text-muted-foreground px-3 py-6 text-center text-sm">No comments yet. Type one, or inspect an element to attach it.</p>`
    : `<ul class="flex flex-col gap-0.5 overflow-y-auto overscroll-contain ${className}">${state.comments
        .toReversed()
        .map(commentItem)
        .join("")}</ul>`;

const recordingBadge = () => `
  <span class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
    <span class="size-1.5 animate-pulse rounded-full bg-red-500"></span>Recording
  </span>
  <span class="mono shrink-0 text-sm tabular-nums" data-timer role="timer">${clock(elapsed())}</span>`;

const wordmark = () =>
  `<span class="hidden shrink-0 text-sm font-semibold tracking-tight sm:inline">Contingency</span>`;

const sessionSelect = () =>
  `<button class="btn-ghost text-muted-foreground hidden h-8 rounded-full px-2.5 text-xs 2xl:inline-flex" type="button">Checkout with promo<i class="ph ph-caret-up-down"></i></button>`;

const stopButton = () =>
  `<button class="btn-destructive h-8 rounded-full px-3 text-xs" data-action="stop" type="button"><i class="ph-fill ph-stop"></i>Stop</button>`;

const infoButton = () =>
  `<button aria-label="Show details" class="icon-btn" data-action="info" type="button"><i class="ph ph-info"></i></button>`;

const dockShell = (inner, className = "") =>
  `<section aria-label="Workspace dock" class="glass float-shadow pointer-events-auto flex items-center gap-2 rounded-full py-1.5 pr-1.5 pl-2 sm:pl-4 ${className}" id="dock">${inner}</section>`;

// ---------------------------------------------------------------------------
// A · Composer: the user's sketch. A floating composer bottom-left, history
// opening above it, inspect attaching into it, and the dock beside it.

const resolvedPlacement = () => {
  if (state.placement !== "auto") {
    return state.placement;
  }
  const width = globalThis.innerWidth;
  if (width >= 1440) {
    return "center";
  }
  return width >= 1000 ? "right" : "stacked";
};

const composerVariant = () => {
  const placement = resolvedPlacement();
  const expanded =
    state.draft.trim() !== "" || state.attached !== null || state.historyOpen;
  const width =
    placement === "stacked"
      ? "w-full max-w-[560px]"
      : `${expanded ? "w-[440px]" : "w-[340px]"} focus-within:w-[440px]`;
  const composer = `
    <section aria-label="Comment composer" class="glass float-shadow pointer-events-auto relative rounded-[22px] transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${width}" id="composer">
      ${
        state.historyOpen
          ? `<div ${enter("history", "up")} class="glass float-shadow absolute bottom-full left-0 mb-2 flex w-full flex-col rounded-[20px] p-1.5" id="history">
              <div class="text-muted-foreground flex items-center justify-between px-2.5 pt-1 pb-1.5 text-xs">
                <span class="font-medium">This recording</span><span class="tabular-nums">${state.comments.length} comments</span>
              </div>
              ${commentList("max-h-[min(340px,45svh)]")}
            </div>`
          : ""
      }
      ${state.attached ? `<div class="px-3 pt-2.5">${attachedChip()}</div>` : ""}
      <div class="flex items-end gap-1 p-1.5">
        ${inspectButton()}
        <div class="min-w-0 flex-1 px-1 py-1">${commentField(state.attached ? "What should change here?" : "Comment on this moment…")}</div>
        ${historyButton()}
        ${sendButton()}
      </div>
    </section>`;
  const dock = dockShell(
    `${wordmark()}${sessionSelect()}${recordingBadge()}${infoButton()}${stopButton()}`
  );
  const layouts = {
    center: `grid grid-cols-[1fr_auto_1fr] items-end gap-3`,
    right: `flex items-end justify-between gap-3`,
    stacked: `flex flex-col items-center gap-2`,
  };
  const dockSlot =
    placement === "center"
      ? `<div class="col-start-2 justify-self-center">${dock}</div>`
      : dock;
  return `<div class="pointer-events-none absolute inset-x-0 bottom-0 p-3 ${layouts[placement]}">
      <div class="${placement === "center" ? "justify-self-start" : ""} ${placement === "stacked" ? "flex w-full justify-center" : ""}">${composer}</div>
      ${dockSlot}
    </div>`;
};

// ---------------------------------------------------------------------------
// B · Unified dock: the comment field is the dock's first row, so there is
// only ever one floating thing and no collision to solve.

const dockVariant = () => `
  <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
    <section aria-label="Workspace dock" class="glass float-shadow pointer-events-auto w-full max-w-[640px] overflow-hidden rounded-[22px]" id="dock">
      ${
        state.historyOpen
          ? `<div ${enter("history", "fade")} class="border-b" id="history">
              <div class="text-muted-foreground flex items-center justify-between px-4 pt-3 pb-1 text-xs">
                <span class="font-medium">This recording</span><span class="tabular-nums">${state.comments.length} comments</span>
              </div>
              <div class="px-1.5 pb-1.5">${commentList("max-h-[min(300px,40svh)]")}</div>
            </div>`
          : ""
      }
      <div class="flex items-end gap-2 px-4 pt-3">
        <div class="min-w-0 flex-1 space-y-1.5">
          ${attachedChip()}
          ${commentField(state.attached ? "What should change here?" : "Comment for the agent…  press C")}
        </div>
        ${sendButton()}
      </div>
      <div class="flex items-center gap-1 px-2 pt-1 pb-2">
        ${inspectButton()}${historyButton()}
        <span class="bg-border mx-2 h-4 w-px"></span>
        ${recordingBadge()}
        <span class="flex-1"></span>
        <span class="text-muted-foreground mr-1 hidden text-xs font-medium tracking-tight sm:inline">Contingency</span>
        ${infoButton()}${stopButton()}
      </div>
    </section>
  </div>`;

// ---------------------------------------------------------------------------
// C · Thread rail: a side rail with the whole thread and its own composer.
// The page shrinks instead of being covered.

const railComposer = () => `
  <div class="focus-within:border-ring/60 rounded-2xl border bg-background p-2 transition-colors">
    ${state.attached ? `<div class="px-1 pb-1.5">${attachedChip()}</div>` : ""}
    <div class="px-1.5">${commentField(state.attached ? "What should change here?" : "Comment on this moment…", "min-h-12")}</div>
    <div class="flex items-center gap-1 pt-1">
      ${inspectButton()}
      <span class="text-muted-foreground text-[11px]">${state.attached ? "Attached to an element" : "Page comment · I to inspect"}</span>
      <span class="flex-1"></span>
      ${sendButton()}
    </div>
  </div>`;

const railGroups = () => {
  if (state.comments.length === 0) {
    return `<p class="text-muted-foreground px-3 py-10 text-center text-sm">No comments yet.<br />Comments land in the recording in order.</p>`;
  }
  const groups = [];
  for (const comment of state.comments) {
    const last = groups.at(-1);
    if (last?.url === comment.url) {
      last.items.push(comment);
    } else {
      groups.push({ items: [comment], url: comment.url });
    }
  }
  return groups
    .map(
      (group) => `
      <div class="space-y-0.5">
        <p class="text-muted-foreground mono sticky top-0 z-10 flex items-center gap-1.5 bg-background px-2.5 py-1.5 text-[11px]"><i class="ph ph-arrow-bend-down-right"></i>${group.url}</p>
        <ul class="flex flex-col gap-0.5">${group.items.map(commentItem).join("")}</ul>
      </div>`
    )
    .join("");
};

const rail = () =>
  state.variant === "rail" && state.railOpen
    ? `<aside aria-label="Comments" ${enter("rail", "side")} class="z-30 flex w-[340px] shrink-0 flex-col border-l bg-background max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:h-[62%] max-md:w-full max-md:rounded-t-3xl max-md:border-t max-md:border-l-0 max-md:float-shadow" id="rail">
        <header class="flex items-center gap-2 px-4 pt-3 pb-2">
          <h2 class="text-sm font-semibold">Comments</h2>
          <span class="bg-muted text-muted-foreground rounded-full px-1.5 text-xs tabular-nums">${state.comments.length}</span>
          <span class="flex-1"></span>
          <button aria-label="Close comments" class="icon-btn" data-action="rail" type="button"><i class="ph ph-x"></i></button>
        </header>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-1.5 pb-2" id="history">${railGroups()}</div>
        <div class="border-t p-3">${railComposer()}</div>
      </aside>`
    : "";

const railVariant = () => {
  const toggle = `<button aria-label="Comments, ${state.comments.length}" aria-pressed="${state.railOpen}" class="btn-ghost text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground h-8 rounded-full px-2.5 text-xs" data-action="rail" title="Comments (C)" type="button"><i class="ph ph-chat-circle-text text-base"></i><span class="tabular-nums">${state.comments.length}</span></button>`;
  return `<div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
      ${dockShell(`${wordmark()}${sessionSelect()}${recordingBadge()}${toggle}${state.railOpen ? "" : inspectButton()}${infoButton()}${stopButton()}`)}
    </div>`;
};

// ---------------------------------------------------------------------------
// D · Spotlight: nothing extra on screen until `/`. Then one palette holds the
// field, the attach action, and the thread.

const spotlightVariant = () => {
  const trigger = `<button class="btn-ghost text-muted-foreground relative h-8 rounded-full pr-1.5 pl-2.5 text-xs" data-action="spotlight" type="button"><i class="ph ph-chat-circle-text text-base"></i><span class="hidden sm:inline">Comment</span><span class="tabular-nums">${state.comments.length}</span><span class="kbd max-sm:hidden">/</span></button>`;
  const dock = `<div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
      ${dockShell(`${wordmark()}${sessionSelect()}${recordingBadge()}${trigger}${infoButton()}${stopButton()}`)}
    </div>`;
  if (!state.spotlightOpen || state.inspecting) {
    return dock;
  }
  return `${dock}
    <div ${enter("spotlight", "fade")} class="pointer-events-auto absolute inset-0 z-40 bg-black/15 dark:bg-black/40" data-action="close-spotlight"></div>
    <section aria-label="Comment" aria-modal="true" ${enter("spotlight", "down")} class="glass float-shadow pointer-events-auto absolute top-[10%] left-1/2 z-50 flex max-h-[76%] w-[min(600px,calc(100%-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-[22px]" id="spotlight" role="dialog">
      <div class="space-y-2 px-5 pt-5 pb-3">
        ${attachedChip("lg")}
        ${commentField(state.attached ? "What should change here?" : "What should the agent know about this moment?", "text-base! leading-7! min-h-14")}
      </div>
      <div class="flex items-center gap-2 px-3 pb-3">
        ${inspectButton(true)}
        <span class="flex-1"></span>
        <span class="text-muted-foreground mono hidden text-[11px] sm:inline">at ${clock(elapsed())}</span>
        ${sendButton("Add comment")}
      </div>
      <div class="flex min-h-0 flex-col border-t" id="history">
        <p class="text-muted-foreground px-5 pt-3 pb-1 text-xs font-medium">Earlier in this recording</p>
        <div class="min-h-0 px-2 pb-2">${commentList("max-h-[260px]")}</div>
      </div>
      <div class="text-muted-foreground flex gap-4 border-t px-5 py-2 text-[11px]">
        <span><span class="kbd">↵</span> add</span><span><span class="kbd">⇧↵</span> new line</span><span><span class="kbd">⌘I</span> inspect</span><span><span class="kbd">esc</span> close</span>
      </div>
    </section>`;
};

const RENDERERS = {
  composer: composerVariant,
  dock: dockVariant,
  rail: railVariant,
  spotlight: spotlightVariant,
};

// ---------------------------------------------------------------------------
// Overlay: inspect highlight, history preview, and pins.

const rectIn = (element, container) => {
  const inner = element.getBoundingClientRect();
  const outer = container.getBoundingClientRect();
  return {
    height: inner.height,
    left: inner.left - outer.left,
    top: inner.top - outer.top,
    width: inner.width,
  };
};

const highlightBox = (element, label, tone) => {
  const wrap = document.querySelector("#page-wrap");
  const rect = rectIn(element, wrap);
  const above = rect.top > 26;
  return `<span class="border-inspect bg-inspect/10 absolute block rounded-[5px] border-2 ${tone === "preview" ? "border-dashed" : ""} transition-all duration-100 ease-out" style="left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px"></span>
    <span class="bg-inspect absolute rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white shadow-sm" style="left:${rect.left - 3}px;top:${above ? rect.top - 26 : rect.top + rect.height + 6}px">${escapeHtml(label)}</span>`;
};

const renderOverlay = () => {
  const overlay = document.querySelector("#overlay");
  const wrap = document.querySelector("#page-wrap");
  if (!overlay || !wrap) {
    return;
  }
  const parts = [];
  for (const comment of state.comments) {
    if (!onPage(comment)) {
      continue;
    }
    const element = document.querySelector(comment.target.selector);
    const rect = rectIn(element, wrap);
    parts.push(
      `<button aria-label="Comment ${commentNumber(comment)}: ${escapeHtml(comment.text)}" class="bg-inspect ring-background pointer-events-auto absolute grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[10px] font-semibold text-white shadow-md ring-2 transition-transform hover:scale-110" data-pin="${comment.id}" style="left:${rect.left + rect.width}px;top:${rect.top}px" type="button">${commentNumber(comment)}</button>`
    );
  }
  if (state.inspecting && state.hovered) {
    parts.push(highlightBox(state.hovered, describe(state.hovered), "hover"));
  } else if (state.preview) {
    const comment = state.comments.find((item) => item.id === state.preview);
    if (comment && onPage(comment)) {
      parts.push(
        highlightBox(
          document.querySelector(comment.target.selector),
          comment.target.label,
          "preview"
        )
      );
    }
  }
  overlay.innerHTML = parts.join("");
};

// ---------------------------------------------------------------------------
// Render.

const inspectHint = () =>
  state.inspecting
    ? `<div ${enter("hint", "down")} class="glass float-shadow pointer-events-auto absolute top-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full py-1 pr-1 pl-3 text-xs whitespace-nowrap">
        <i class="ph ph-cursor-click text-inspect text-base"></i>
        <span>Click an element to attach it</span>
        <button class="btn-ghost h-7 rounded-full px-2 text-xs" data-action="inspect" type="button">Cancel <span class="kbd">esc</span></button>
      </div>`
    : "";

const toast = () =>
  state.toast
    ? `<div ${enter("toast", "down")} class="glass float-shadow pointer-events-none absolute top-3 left-1/2 z-40 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs whitespace-nowrap" role="status">
        <i class="ph-fill ph-check-circle text-emerald-500 text-sm"></i><span class="truncate">${escapeHtml(state.toast)}</span>
      </div>`
    : "";

const renderShell = () => {
  app.innerHTML = `
    <div class="flex items-center gap-2 border-b bg-background px-3 py-2">
      <span class="flex gap-1.5 pr-2"><span class="size-2.5 rounded-full bg-muted-foreground/30"></span><span class="size-2.5 rounded-full bg-muted-foreground/30"></span><span class="size-2.5 rounded-full bg-muted-foreground/30"></span></span>
      <div class="bg-muted text-muted-foreground mono flex h-8 min-w-0 flex-1 items-center rounded-md px-3 text-xs">https://pantry.direct${CURRENT_URL}</div>
      <button class="btn-outline hidden h-8 px-3 text-xs md:inline-flex" type="button">Responsive</button>
      <button class="btn-outline hidden h-8 px-3 text-xs md:inline-flex" type="button">Storage</button>
    </div>
    <div class="relative flex min-h-0 flex-1">
      <div class="relative min-w-0 flex-1">
        <div class="absolute inset-0 overflow-auto" id="frame" style="background:var(--page)">
          <div class="relative min-h-full pb-48" id="page-wrap">
            <div id="page">${mockPage()}</div>
            <div class="pointer-events-none absolute inset-0" id="overlay"></div>
          </div>
        </div>
        <div class="pointer-events-none absolute inset-0 z-10 ring-2 ring-red-500/50 ring-inset"></div>
        <div class="pointer-events-none absolute inset-0 z-20" id="float"></div>
      </div>
      <div class="contents" id="rail-slot"></div>
    </div>`;
};

const render = () => {
  const active = document.activeElement;
  const focusId = active?.id;
  const selection =
    active instanceof HTMLTextAreaElement
      ? [active.selectionStart, active.selectionEnd]
      : null;

  document.documentElement.dataset.inspecting = String(state.inspecting);
  renderSwitch();
  document.querySelector("#float").innerHTML =
    RENDERERS[state.variant]() + inspectHint() + toast();
  document.querySelector("#rail-slot").innerHTML = rail();
  renderOverlay();

  if (focusId) {
    const next = document.getElementById(focusId);
    if (next && next !== document.activeElement) {
      next.focus({ preventScroll: true });
      if (selection && next instanceof HTMLTextAreaElement) {
        next.setSelectionRange(...selection);
      }
    }
  }
  entering.clear();
};

const focusComposer = () => {
  const field = document.querySelector("#comment-input");
  if (field) {
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }
};

const renderSwitch = () => {
  const host = document.querySelector("#variant-switch");
  host.innerHTML = VARIANTS.map(
    (variant, index) =>
      `<button aria-checked="${variant.id === state.variant}" class="aria-checked:bg-primary aria-checked:text-primary-foreground hover:bg-accent rounded px-2 py-1 text-xs font-medium transition-colors" data-variant="${variant.id}" role="radio" title="Key ${index + 1}" type="button">${variant.name}</button>`
  ).join("");
  const placement =
    state.variant === "composer"
      ? `<label class="text-muted-foreground ml-2 flex items-center gap-1.5 text-xs">Dock placement
          <select class="bg-background text-foreground h-6 rounded border px-1 text-xs" id="placement">${PLACEMENTS.map(
            (value) =>
              `<option ${value === state.placement ? "selected" : ""} value="${value}">${value}${value === "auto" ? ` (${resolvedPlacement()})` : ""}</option>`
          ).join("")}</select></label>`
      : "";
  host.insertAdjacentHTML("beforeend", placement);
  document.querySelector("#variant-note").textContent = VARIANTS.find(
    (variant) => variant.id === state.variant
  ).note;
};

// ---------------------------------------------------------------------------
// Behaviour.

let toastTimer;
const showToast = (message) => {
  state.toast = message;
  entering.add("toast");
  globalThis.clearTimeout(toastTimer);
  toastTimer = globalThis.setTimeout(() => {
    state.toast = null;
    render();
  }, 2200);
};

const startInspect = () => {
  state.inspecting = true;
  state.hovered = null;
  state.historyOpen = false;
  entering.add("hint");
  document.activeElement?.blur?.();
  render();
};

const stopInspect = () => {
  state.inspecting = false;
  state.hovered = null;
  if (state.variant === "spotlight" && state.spotlightOpen) {
    entering.add("spotlight");
  }
  render();
  if (state.variant !== "spotlight" || state.spotlightOpen) {
    focusComposer();
  }
};

const attach = (element) => {
  state.attached = { label: describe(element), selector: selectorFor(element) };
  state.inspecting = false;
  state.hovered = null;
  entering.add("chip");
  if (state.variant === "rail" && !state.railOpen) {
    state.railOpen = true;
    entering.add("rail");
  }
  if (state.variant === "spotlight") {
    state.spotlightOpen = true;
    entering.add("spotlight");
  }
  render();
  focusComposer();
};

const send = () => {
  const text = state.draft.trim();
  if (!text) {
    return;
  }
  const comment = {
    at: elapsed(),
    id: `c${Date.now()}`,
    target: state.attached,
    text,
    url: CURRENT_URL,
  };
  state.comments = [...state.comments, comment];
  state.draft = "";
  state.attached = null;
  showToast(
    comment.target
      ? `Comment added at ${clock(comment.at)} on ${comment.target.label}`
      : `Page comment added at ${clock(comment.at)}`
  );
  if (state.variant === "spotlight") {
    state.spotlightOpen = false;
  }
  render();
  for (const badge of document.querySelectorAll("[data-count]")) {
    badge.classList.add("bump");
  }
  if (state.variant === "rail") {
    const history = document.querySelector("#history");
    history?.scrollTo({ behavior: "smooth", top: history.scrollHeight });
  }
  if (state.variant !== "spotlight") {
    focusComposer();
  }
};

const toggleHistory = () => {
  if (state.variant === "rail") {
    state.railOpen = !state.railOpen;
    entering.add("rail");
    render();
    if (state.railOpen) {
      focusComposer();
    }
    return;
  }
  if (state.variant === "spotlight") {
    openSpotlight();
    return;
  }
  state.historyOpen = !state.historyOpen;
  entering.add("history");
  render();
};

const openSpotlight = () => {
  state.spotlightOpen = true;
  entering.add("spotlight");
  render();
  focusComposer();
};

const closeTransient = () => {
  if (state.inspecting) {
    stopInspect();
    return true;
  }
  if (state.spotlightOpen) {
    state.spotlightOpen = false;
    render();
    return true;
  }
  if (state.historyOpen) {
    state.historyOpen = false;
    render();
    return true;
  }
  return false;
};

const revealComment = (id) => {
  const comment = state.comments.find((item) => item.id === id);
  if (!comment) {
    return;
  }
  state.focusComment = id;
  if (onPage(comment)) {
    document
      .querySelector(comment.target.selector)
      .scrollIntoView({ behavior: "smooth", block: "center" });
    state.preview = id;
  }
  render();
};

const openThreadAt = (id) => {
  state.focusComment = id;
  state.preview = id;
  if (state.variant === "rail") {
    if (!state.railOpen) {
      state.railOpen = true;
      entering.add("rail");
    }
  } else if (state.variant === "spotlight") {
    state.spotlightOpen = true;
    entering.add("spotlight");
  } else if (!state.historyOpen) {
    state.historyOpen = true;
    entering.add("history");
  }
  render();
  document
    .querySelector(`[data-comment="${id}"]`)
    ?.scrollIntoView({ block: "nearest" });
};

const isEditable = (element) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement;

const setVariant = (id) => {
  state.variant = id;
  state.historyOpen = false;
  state.spotlightOpen = false;
  state.inspecting = false;
  state.preview = null;
  state.focusComment = null;
  globalThis.history.replaceState(null, "", `#${id}`);
  render();
};

const bind = () => {
  document.addEventListener("click", (event) => {
    const variant = event.target.closest?.("[data-variant]");
    if (variant) {
      setVariant(variant.dataset.variant);
      return;
    }
    const pin = event.target.closest?.("[data-pin]");
    if (pin) {
      openThreadAt(pin.dataset.pin);
      return;
    }
    const comment = event.target.closest?.("[data-comment]");
    if (comment) {
      revealComment(comment.dataset.comment);
      return;
    }
    const action = event.target.closest?.("[data-action]")?.dataset.action;
    switch (action) {
      case "inspect": {
        if (state.inspecting) {
          stopInspect();
        } else {
          startInspect();
        }
        break;
      }
      case "detach": {
        state.attached = null;
        render();
        focusComposer();
        break;
      }
      case "history": {
        toggleHistory();
        break;
      }
      case "rail": {
        toggleHistory();
        break;
      }
      case "spotlight": {
        openSpotlight();
        break;
      }
      case "close-spotlight": {
        state.spotlightOpen = false;
        render();
        break;
      }
      case "send": {
        send();
        break;
      }
      case "stop":
      case "info": {
        showToast("Not wired in this prototype");
        render();
        break;
      }
      default:
    }
  });

  // Outside clicks close the history popover in A and B.
  document.addEventListener("pointerdown", (event) => {
    if (
      state.historyOpen &&
      !state.inspecting &&
      !event.target.closest?.("#composer, #dock, [data-pin]")
    ) {
      state.historyOpen = false;
      render();
    }
  });

  const frame = document.querySelector("#frame");
  frame.addEventListener("pointermove", (event) => {
    if (!state.inspecting) {
      return;
    }
    const element = pickable(event.target);
    if (element !== state.hovered) {
      state.hovered = element;
      renderOverlay();
    }
  });
  frame.addEventListener("pointerleave", () => {
    if (state.inspecting) {
      state.hovered = null;
      renderOverlay();
    }
  });
  frame.addEventListener(
    "click",
    (event) => {
      if (!state.inspecting) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const element = pickable(event.target);
      if (element) {
        attach(element);
      }
    },
    true
  );
  frame.addEventListener(
    "mousedown",
    (event) => {
      if (state.inspecting) {
        event.preventDefault();
      }
    },
    true
  );

  document.addEventListener("mouseover", (event) => {
    const item = event.target.closest?.("[data-comment]");
    const id = item?.dataset.comment ?? null;
    if (id !== state.preview && !state.inspecting) {
      state.preview = id;
      renderOverlay();
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "comment-input") {
      state.draft = event.target.value;
      for (const button of document.querySelectorAll('[data-action="send"]')) {
        button.disabled = state.draft.trim() === "";
      }
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "placement") {
      state.placement = event.target.value;
      render();
    }
  });

  document.addEventListener("keydown", (event) => {
    const inField = event.target.id === "comment-input";
    const meta = event.metaKey || event.ctrlKey;
    if (inField) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      } else if (meta && event.key.toLowerCase() === "i") {
        event.preventDefault();
        startInspect();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (!closeTransient()) {
          event.target.blur();
        }
      } else if (
        event.key === "Backspace" &&
        event.target.value === "" &&
        state.attached
      ) {
        state.attached = null;
        render();
      }
      return;
    }
    if (event.key === "Escape") {
      closeTransient();
      return;
    }
    if (isEditable(event.target) || meta || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (/^[1-4]$/.test(key)) {
      setVariant(VARIANTS[Number(key) - 1].id);
    } else if (key === "/" || key === "c") {
      event.preventDefault();
      if (state.variant === "spotlight") {
        openSpotlight();
      } else {
        if (state.variant === "rail" && !state.railOpen) {
          state.railOpen = true;
          entering.add("rail");
          render();
        }
        focusComposer();
      }
    } else if (key === "i") {
      if (state.inspecting) {
        stopInspect();
      } else {
        startInspect();
      }
    } else if (key === "h") {
      toggleHistory();
    }
  });

  globalThis.addEventListener("resize", () => {
    render();
  });

  document.querySelector("#theme-toggle").addEventListener("click", (event) => {
    const dark = document.documentElement.classList.toggle("dark");
    event.currentTarget.textContent = dark ? "Light mode" : "Dark mode";
  });
  document.querySelector("#reset").addEventListener("click", () => {
    state.comments = seedComments();
    state.draft = "";
    state.attached = null;
    render();
  });

  globalThis.setInterval(() => {
    for (const timer of document.querySelectorAll("[data-timer]")) {
      timer.textContent = clock(elapsed());
    }
  }, 1000);
};

// Scripted hooks for capture.mjs.
globalThis.prototype = {
  attach: (selector) => attach(document.querySelector(selector)),
  hover: (selector) => {
    state.inspecting = true;
    state.hovered = document.querySelector(selector);
    render();
  },
  set: (patch) => {
    Object.assign(state, patch);
    render();
  },
  setVariant,
  type: (text) => {
    state.draft = text;
    render();
  },
};

renderShell();
bind();
new ResizeObserver(() => renderOverlay()).observe(
  document.querySelector("#page-wrap")
);
render();
