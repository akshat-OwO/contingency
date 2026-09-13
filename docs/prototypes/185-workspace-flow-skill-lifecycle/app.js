// Throwaway prototype for issue #185. Not production code.

import { SESSIONS, STATE_BY_ID, STATES } from "./states.js";

const app = document.querySelector("#app");
const stateSelect = document.querySelector("#state-select");

const current = {
  comments: [],
  inspecting: false,
  selected: undefined,
  sessionId: SESSIONS[0].id,
  sessionOpen: false,
  stateId: "setup",
};

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/gu,
    (char) =>
      ({
        '"': "&quot;",
        "&": "&amp;",
        "'": "&#39;",
        "<": "&lt;",
        ">": "&gt;",
      })[char]
  );

const icon = (name) =>
  `<i aria-hidden="true" class="ph ph-${name} text-base"></i>`;

const BADGE_TONE = {
  alert: "border-destructive/40 text-destructive",
  busy: "border-border text-muted-foreground",
  ok: "border-border text-foreground",
  quiet: "border-border text-muted-foreground",
  recording: "border-destructive/40 text-destructive",
};

const PRIMARY_CLASS = {
  default: "btn-primary",
  destructive: "btn-destructive",
  outline: "btn-outline",
};

const session = () => SESSIONS.find((entry) => entry.id === current.sessionId);

const stateComments = () =>
  current.comments.filter((comment) => comment.stateId === current.stateId);

/* ---------------------------------------------------------------- dock parts */

const badge = (state) => {
  const dot =
    state.badge.tone === "recording"
      ? '<span aria-hidden="true" class="bg-destructive size-1.5 rounded-full"></span>'
      : "";
  const timer = state.timer
    ? `<span class="mono tabular-nums" role="timer">${escapeHtml(state.timer)}</span>`
    : "";
  return `<span class="badge ${BADGE_TONE[state.badge.tone]}">${dot}${escapeHtml(
    state.badge.text
  )}${timer}</span>`;
};

const sessionOption = (entry) => `
  <li aria-selected="${entry.id === current.sessionId}" role="option">
    <button
      class="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
      data-action="pick-session"
      data-session="${entry.id}"
      type="button"
    >
      <span class="w-4 shrink-0">${entry.id === current.sessionId ? icon("check") : ""}</span>
      <span class="truncate">${escapeHtml(entry.name)}</span>
    </button>
  </li>`;

const sessionSelect = () => `
  <div class="relative">
    <button
      aria-expanded="${current.sessionOpen}"
      aria-haspopup="listbox"
      class="btn-outline h-8 max-w-[14rem] justify-between gap-2 px-3 text-sm font-normal"
      data-action="toggle-sessions"
      type="button"
    >
      <span class="truncate">${escapeHtml(session().name)}</span>
      ${icon("caret-up-down")}
    </button>
    ${
      current.sessionOpen
        ? `<ul
             aria-label="Sessions"
             class="bg-card absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-md border p-1 shadow-md"
             role="listbox"
           >${SESSIONS.map(sessionOption).join("")}</ul>`
        : ""
    }
  </div>`;

const progressBar = (state) =>
  state.progress
    ? `<div class="flex min-w-0 items-center gap-2">
         <div
           aria-label="${escapeHtml(state.progress.label)}"
           aria-valuemax="100"
           aria-valuemin="0"
           aria-valuenow="${state.progress.value}"
           class="bg-muted h-1.5 w-24 overflow-hidden rounded-full"
           role="progressbar"
         >
           <div class="bg-foreground/70 h-full rounded-full" style="width:${state.progress.value}%"></div>
         </div>
         <span class="text-muted-foreground truncate text-xs">${escapeHtml(
           state.progress.label
         )}</span>
       </div>`
    : "";

const inspectToggle = (state) => {
  if (!state.inspect) {
    return "";
  }
  const count = stateComments().length;
  const counter =
    count > 0
      ? `<span class="badge border-border text-muted-foreground">${count} ${
          count === 1 ? "comment" : "comments"
        }</span>`
      : "";
  return `
    <button
      aria-label="Inspect an element and comment"
      aria-pressed="${current.inspecting}"
      class="${current.inspecting ? "btn-primary" : "btn-outline"} size-8 px-0"
      data-action="toggle-inspect"
      type="button"
    >${icon("cursor")}</button>${counter}`;
};

const dock = (state) => `
  <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3 sm:p-4">
    <div
      aria-live="polite"
      class="bg-card/95 pointer-events-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 shadow-lg backdrop-blur"
      role="status"
    >
      <span class="text-sm font-semibold tracking-tight">Contingency</span>
      ${sessionSelect()}
      ${badge(state)}
      ${
        state.counter
          ? `<span class="badge border-border text-muted-foreground">${escapeHtml(
              state.counter
            )}</span>`
          : ""
      }
      <p class="text-muted-foreground order-last hidden w-full min-w-0 text-xs sm:block lg:order-none lg:w-auto lg:flex-1">${escapeHtml(
        state.next
      )}</p>
      ${progressBar(state)}
      ${inspectToggle(state)}
      ${state.secondary
        .map(
          (action) =>
            `<button class="btn-outline h-8 px-3 text-xs" type="button">${escapeHtml(
              action.label
            )}</button>`
        )
        .join("")}
      ${
        state.primary === undefined
          ? ""
          : `<button class="${PRIMARY_CLASS[state.primary.tone]}" type="button">${escapeHtml(
              state.primary.label
            )}</button>`
      }
    </div>
  </div>`;

/* --------------------------------------------------------------- browser page */

const chromeBar = (state) => `
  <div class="flex flex-wrap items-center gap-2 border-b px-2 py-2">
    <div aria-label="Browser navigation" class="flex items-center" role="group">
      <button aria-label="Go back" class="btn-ghost size-8 px-0" type="button">${icon(
        "arrow-left"
      )}</button>
      <button aria-label="Go forward" class="btn-ghost size-8 px-0" type="button">${icon(
        "arrow-right"
      )}</button>
      <button aria-label="Reload page" class="btn-ghost size-8 px-0" type="button">${icon(
        "arrow-clockwise"
      )}</button>
    </div>
    <label class="sr-only" for="proto-address">Address</label>
    <input
      class="mono h-8 min-w-0 flex-1 rounded-md border bg-transparent px-3 text-xs"
      id="proto-address"
      value="${escapeHtml(state.stage.url ?? "")}"
    />
    <label class="sr-only" for="proto-device">Device</label>
    <select class="h-8 rounded-md border bg-transparent px-2 text-xs" id="proto-device">
      <option>Responsive</option>
      <option>iPhone 16 Pro</option>
    </select>
    <label class="sr-only" for="proto-emulation">Emulation</label>
    <select class="h-8 rounded-md border bg-transparent px-2 text-xs" id="proto-emulation">
      <option>Locale en-GB, Europe/London</option>
      <option>Locale en-US, America/New_York</option>
    </select>
    <button class="btn-outline h-8 px-3 text-xs" type="button">Storage</button>
  </div>`;

const filesCard = (state) =>
  state.files
    ? `<div class="rounded-lg border p-4">
         <p class="text-sm font-medium">Flow skill</p>
         <ul aria-label="Flow skill files" class="mt-2 space-y-1">
           ${state.files
             .map(
               (file) =>
                 `<li class="mono text-muted-foreground text-xs">${escapeHtml(file)}</li>`
             )
             .join("")}
         </ul>
       </div>`
    : "";

const loginPage = () => `
  <form class="mx-auto w-full max-w-sm space-y-4 py-16" id="login-form">
    <h1 class="text-xl font-semibold">Sign in to Pantry Direct</h1>
    <div class="space-y-1.5">
      <label class="text-sm font-medium" for="email">Email</label>
      <input class="mock-field w-full" id="email" value="mira@havenlane.co" />
    </div>
    <div class="space-y-1.5">
      <label class="text-sm font-medium" for="password">Password</label>
      <input class="mock-field w-full" id="password" type="password" />
    </div>
    <button class="btn-primary w-full" id="sign-in" type="button">Sign in</button>
  </form>`;

const cartPage = () => `
  <div class="mx-auto w-full max-w-2xl space-y-6 py-12" id="cart">
    <h1 class="text-xl font-semibold">Your cart</h1>
    <div class="flex items-center gap-4 rounded-lg border p-4" id="line-item">
      <div class="bg-muted size-16 rounded-md"></div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">Oat milk, case of 12</p>
        <p class="text-muted-foreground text-xs">GBP 18.40 per case</p>
      </div>
      <label class="sr-only" for="quantity">Quantity</label>
      <select class="mock-field" id="quantity">
        <option>1</option>
        <option selected>3</option>
        <option>6</option>
      </select>
    </div>
    <div class="flex items-center gap-3">
      <label class="sr-only" for="promo">Promotion code</label>
      <input class="mock-field flex-1" id="promo" placeholder="Promotion code" />
      <button class="btn-outline" id="apply-promo" type="button">Apply</button>
    </div>
    <div class="flex items-center justify-between rounded-lg border p-4">
      <p class="text-sm">Total <span class="mono">GBP 55.20</span></p>
      <button class="btn-primary" id="place-order" type="button">Place order</button>
    </div>
  </div>`;

const orderPage = (state) => `
  <div class="mx-auto w-full max-w-2xl space-y-6 py-12" id="order">
    <div class="rounded-lg border p-6">
      <h1 class="text-xl font-semibold">${escapeHtml(
        state.stage.outcome ?? "Order 48219 confirmed"
      )}</h1>
      <p class="text-muted-foreground mt-1 text-sm">
        Arriving Tuesday. A receipt is on its way to mira@havenlane.co.
      </p>
      <button class="btn-outline mt-4" id="view-receipt" type="button">View receipt</button>
    </div>
    ${filesCard(state)}
  </div>`;

const emptyPage = () => `
  <div class="grid h-full place-items-center p-8 text-center">
    <div class="max-w-sm space-y-4">
      <h1 class="text-lg font-semibold">No browser session yet</h1>
      <button class="btn-primary" id="open-session" type="button">Open browser session</button>
    </div>
  </div>`;

const pageFor = (state) => {
  if (state.stage.kind === "empty") {
    return emptyPage();
  }
  if (state.stage.kind === "result") {
    return orderPage(state);
  }
  const url = state.stage.url ?? "";
  if (url.includes("login")) {
    return loginPage();
  }
  if (url.includes("orders")) {
    return orderPage(state);
  }
  return cartPage();
};

const commentPin = (comment, index) => `
  <div
    class="bg-primary text-primary-foreground absolute flex size-5 items-center justify-center rounded-full text-[10px] font-semibold"
    style="left:${comment.x}px;top:${comment.y}px"
    title="${escapeHtml(comment.text)}"
  >${index + 1}</div>`;

const stage = (state) => `
  <section
    aria-label="Browser"
    class="flex min-h-0 flex-1 flex-col overflow-hidden ${
      state.badge.tone === "recording"
        ? "ring-destructive/60 ring-2 ring-inset"
        : ""
    }"
  >
    ${state.stage.kind === "empty" ? "" : chromeBar(state)}
    <div class="relative min-h-0 flex-1" id="canvas">
      <div
        class="h-full overflow-auto px-4 pb-28"
        data-inspecting="${current.inspecting}"
        id="page"
      >
        ${pageFor(state)}
      </div>
      <div class="pointer-events-none absolute inset-0" id="inspect-layer">
        ${stateComments().map(commentPin).join("")}
      </div>
    </div>
  </section>`;

/* -------------------------------------------------------------------- render */

const targetLabel = (element) => {
  const id = element.id ? `#${element.id}` : "";
  const className = element.classList[0] ? `.${element.classList[0]}` : "";
  return `${element.tagName.toLowerCase()}${id}${className}`;
};

const canvasRect = () =>
  document.querySelector("#canvas").getBoundingClientRect();

const drawSelection = () => {
  const { box, label } = current.selected;
  document.querySelector("#inspect-layer").insertAdjacentHTML(
    "beforeend",
    `<div
       class="border-primary absolute rounded-sm border-2"
       style="left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px"
     ></div>
     <div
       class="bg-primary text-primary-foreground mono absolute rounded px-1.5 py-0.5 text-[10px]"
       style="left:${box.left}px;top:${Math.max(0, box.top - 20)}px"
     >${escapeHtml(label)}</div>
     <form
       class="bg-card pointer-events-auto absolute w-72 space-y-2 rounded-lg border p-3 shadow-lg"
       id="comment-form"
       style="left:${box.left}px;top:${box.top + box.height + 8}px"
     >
       <label class="sr-only" for="comment-text">Comment</label>
       <textarea
         class="mock-field h-16 w-full resize-none py-2"
         id="comment-text"
         placeholder="Describe the change"
       ></textarea>
       <div class="flex justify-end gap-2">
         <button class="btn-outline h-8 px-3 text-xs" data-action="cancel-comment" type="button">
           Cancel
         </button>
         <button class="btn-primary h-8 px-3 text-xs" type="submit">Attach</button>
       </div>
     </form>`
  );
  document.querySelector("#comment-text").focus();
};

const render = () => {
  const state = STATE_BY_ID.get(current.stateId);
  document.title = `Prototype #185: ${state.stateName}`;
  app.innerHTML = `${stage(state)}${dock(state)}`;
  app.dataset.state = state.id;
  stateSelect.value = state.id;
  if (current.selected) {
    drawSelection();
  }
};

const clearHover = () => {
  document.querySelector("#hover-outline")?.remove();
};

const showHover = (element) => {
  const rect = element.getBoundingClientRect();
  const origin = canvasRect();
  clearHover();
  document.querySelector("#inspect-layer").insertAdjacentHTML(
    "beforeend",
    `<div class="pointer-events-none absolute" id="hover-outline">
       <div
         class="border-primary/70 bg-primary/5 absolute rounded-sm border"
         style="left:${rect.left - origin.left}px;top:${rect.top - origin.top}px;width:${
           rect.width
         }px;height:${rect.height}px"
       ></div>
       <div
         class="bg-foreground text-background mono absolute rounded px-1.5 py-0.5 text-[10px]"
         style="left:${rect.left - origin.left}px;top:${Math.max(
           0,
           rect.top - origin.top - 20
         )}px"
       >${escapeHtml(targetLabel(element))}</div>
     </div>`
  );
};

/* ------------------------------------------------------------------- wiring */

const inspectable = (target) => {
  const page = document.querySelector("#page");
  return page?.contains(target) && target !== page;
};

app.addEventListener("mousemove", (event) => {
  if (!current.inspecting || current.selected) {
    return;
  }
  if (inspectable(event.target)) {
    showHover(event.target);
    return;
  }
  clearHover();
});

const DOCK_ACTIONS = {
  "cancel-comment": () => {
    current.selected = undefined;
  },
  "pick-session": (element) => {
    current.sessionId = element.dataset.session;
    current.sessionOpen = false;
  },
  "toggle-inspect": () => {
    current.inspecting = !current.inspecting;
    current.selected = undefined;
  },
  "toggle-sessions": () => {
    current.sessionOpen = !current.sessionOpen;
  },
};

app.addEventListener(
  "click",
  (event) => {
    const trigger = event.target.closest("[data-action]");
    if (trigger) {
      DOCK_ACTIONS[trigger.dataset.action](trigger);
      render();
      return;
    }
    if (!(current.inspecting && inspectable(event.target))) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = event.target.getBoundingClientRect();
    const origin = canvasRect();
    clearHover();
    current.selected = {
      box: {
        height: rect.height,
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
      },
      label: targetLabel(event.target),
    };
    render();
  },
  true
);

app.addEventListener("submit", (event) => {
  if (event.target.id !== "comment-form") {
    return;
  }
  event.preventDefault();
  const text = document.querySelector("#comment-text").value.trim();
  if (text.length > 0) {
    current.comments.push({
      stateId: current.stateId,
      target: current.selected.label,
      text,
      x: current.selected.box.left,
      y: current.selected.box.top,
    });
  }
  current.selected = undefined;
  render();
});

for (const state of STATES) {
  const option = document.createElement("option");
  option.value = state.id;
  option.textContent = `${STATES.indexOf(state) + 1}. ${state.stateName}`;
  stateSelect.append(option);
}

const goTo = (stateId) => {
  current.stateId = stateId;
  current.selected = undefined;
  current.sessionOpen = false;
  render();
};

stateSelect.addEventListener("change", (event) => {
  goTo(event.target.value);
});

const step = (delta) => {
  const index = STATES.findIndex((state) => state.id === current.stateId);
  goTo(STATES[(index + delta + STATES.length) % STATES.length].id);
};

document.querySelector("#next-state").addEventListener("click", () => {
  step(1);
});
document.querySelector("#prev-state").addEventListener("click", () => {
  step(-1);
});

const themeToggle = document.querySelector("#theme-toggle");
themeToggle.addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  themeToggle.textContent = dark ? "Light mode" : "Dark mode";
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (current.selected || current.inspecting)) {
    current.selected = undefined;
    current.inspecting = false;
    render();
    return;
  }
  if (event.target.matches("input, select, textarea")) {
    return;
  }
  if (event.key === "j") {
    step(1);
  }
  if (event.key === "k") {
    step(-1);
  }
});

// Lets the screenshot script walk every state without clicking.
window.setPrototype = (stateId, options = {}) => {
  current.inspecting = options.inspecting ?? false;
  goTo(stateId);
  return stateId;
};
render();
