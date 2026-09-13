// Throwaway prototype for issue #185. Not production code.

import { FLOW_NAME, STATES, STATE_BY_ID, VARIANTS } from "./states.js";

const app = document.querySelector("#app");
const stateSelect = document.querySelector("#state-select");
const variantSwitcher = document.querySelector("#variant-switcher");
const variantNote = document.querySelector("#variant-note");

let current = { stateId: STATES[1].id, variantId: VARIANTS[0].id };

const escapeHtml = (value) =>
  value.replaceAll(
    /[&<>"']/g,
    (char) =>
      ({ '"': "&quot;", "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;" })[
        char
      ]
  );

const TONE_CLASS = {
  alert: "border-destructive/40 text-destructive",
  busy: "border-border text-muted-foreground",
  ok: "border-border text-foreground",
  quiet: "border-border text-muted-foreground",
  recording: "border-destructive/40 text-destructive",
};

const capturePill = (state) => {
  const dot =
    state.capture.tone === "recording"
      ? '<span aria-hidden="true" class="size-2 rounded-full bg-destructive"></span>'
      : "";
  const timer = state.timer
    ? `<span class="mono tabular-nums" role="timer">${escapeHtml(state.timer)}</span>`
    : "";
  return `<span class="pill ${TONE_CLASS[state.capture.tone]}">${dot}${escapeHtml(
    state.capture.text
  )}${timer}</span>`;
};

const PRIMARY_CLASS = {
  default: "btn-primary",
  destructive: "btn-destructive",
  outline: "btn-outline",
};

const actionButton = (action) =>
  `<button class="${PRIMARY_CLASS[action.tone]}" type="button">${escapeHtml(
    action.label
  )}</button>`;

const primaryAction = (state) =>
  state.primary === undefined ? "" : actionButton(state.primary);

const secondaryActions = (state) =>
  state.secondary
    .map(
      (action) =>
        `<button class="btn-outline h-8 px-3 text-xs" type="button">${escapeHtml(
          action.label
        )}</button>`
    )
    .join("");

const progressBar = (state, layout = "inline") =>
  state.progress
    ? `<div class="${
        layout === "stacked"
          ? "min-w-0 space-y-1.5"
          : "flex min-w-0 items-center gap-2"
      }">
         <div aria-label="${escapeHtml(state.progress.label)}" aria-valuemax="100" aria-valuemin="0" aria-valuenow="${
           state.progress.value
         }" class="h-1.5 overflow-hidden rounded-full bg-muted ${
           layout === "stacked" ? "w-full" : "w-28"
         }" role="progressbar">
           <div class="h-full rounded-full bg-foreground/70" style="width:${state.progress.value}%"></div>
         </div>
         <span class="block ${
           layout === "stacked" ? "" : "truncate "
         }text-xs text-muted-foreground">${escapeHtml(state.progress.label)}</span>
       </div>`
    : "";

const agentLine = (state) =>
  state.agent
    ? `<span class="truncate text-xs text-muted-foreground">${escapeHtml(state.agent.text)}</span>`
    : "";

const fileList = (state) =>
  state.files
    ? `<ul aria-label="Flow skill files" class="flex flex-wrap gap-1.5">${state.files
        .map(
          (file) =>
            `<li class="mono rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground">${escapeHtml(
              file
            )}</li>`
        )
        .join("")}</ul>`
    : "";

const sessionSelector = (state) => `
  <button
    aria-haspopup="listbox"
    class="btn-outline h-9 min-w-0 flex-1 justify-between gap-3 px-3 sm:max-w-[18rem] sm:flex-none"
    type="button"
  >
    <span class="min-w-0 text-left">
      <span class="block truncate text-sm font-medium">${escapeHtml(state.sessionLabel)}</span>
      <span class="block truncate text-[11px] font-normal text-muted-foreground">${escapeHtml(
        state.sessionHint
      )}</span>
    </span>
    <span aria-hidden="true" class="text-muted-foreground">&#9662;</span>
  </button>`;

const navButton = (label, glyph) =>
  `<button aria-label="${label}" class="btn-ghost size-8 px-0" type="button"><span aria-hidden="true">${glyph}</span></button>`;

const setupBar = (state) => {
  const url = state.stage.url ?? "";
  return `
  <div class="flex flex-wrap items-center gap-2 border-b px-2 py-2">
    <div aria-label="Browser navigation" class="flex items-center" role="group">
      ${navButton("Go back", "&#8592;")}${navButton("Go forward", "&#8594;")}${navButton(
        "Reload page",
        "&#8635;"
      )}
    </div>
    <label class="sr-only" for="proto-address">Address</label>
    <input
      class="mono h-8 min-w-0 flex-1 rounded-md border bg-background px-3 text-xs"
      id="proto-address"
      value="${escapeHtml(url)}"
    />
    <label class="sr-only" for="proto-device">Device</label>
    <select class="h-8 rounded-md border bg-background px-2 text-xs" id="proto-device">
      <option>Responsive</option>
      <option>iPhone 16 Pro</option>
    </select>
    <label class="sr-only" for="proto-emulation">Emulation</label>
    <select class="h-8 rounded-md border bg-background px-2 text-xs" id="proto-emulation">
      <option>Locale en-GB, Europe/London</option>
      <option>Locale en-US, America/New_York</option>
    </select>
    <button class="btn-outline h-8 px-3 text-xs" type="button">Storage</button>
    ${
      state.id === "setup"
        ? '<span class="pill border-border text-muted-foreground">Private until you start recording</span>'
        : ""
    }
  </div>`;
};

const stageBody = (state) => {
  if (state.stage.kind === "empty") {
    return `
    <div class="grid h-full place-items-center p-8 text-center">
      <div class="max-w-sm space-y-3">
        <h2 class="text-base font-semibold">No browser session yet</h2>
        <p class="text-sm text-muted-foreground">
          Open a session to sign in, choose emulation, and get the page ready. Recording starts
          when you say so.
        </p>
        <button class="btn-primary" type="button">Open browser session</button>
      </div>
    </div>`;
  }
  const label =
    state.stage.kind === "result"
      ? escapeHtml(state.stage.outcome)
      : state.id === "dry-running"
        ? "Dry run browser"
        : "Live browser frame";
  return `
    <div class="relative h-full bg-muted/30 p-2">
      <div class="mono grid h-full w-full place-items-center rounded-md border border-dashed bg-background text-xs text-muted-foreground">
        ${label}
      </div>
    </div>`;
};

const stage = (state) => `
  <section aria-label="Browser" class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border ${
    state.capture.tone === "recording"
      ? "border-destructive/70 ring-1 ring-destructive/40"
      : ""
  }">
    ${state.stage.kind === "empty" ? "" : setupBar(state)}
    <div class="min-h-0 flex-1">${stageBody(state)}</div>
  </section>`;

const topBar = (state, { withPrimary }) => `
  <header class="flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-4">
    <span class="hidden text-base font-semibold tracking-tight sm:block">Contingency</span>
    ${sessionSelector(state)}
    <div class="ml-auto flex shrink-0 items-center gap-2">
      ${
        withPrimary
          ? `<span class="hidden sm:inline-flex">${capturePill(state)}</span>${primaryAction(state)}`
          : ""
      }
    </div>
  </header>`;

const LAYOUTS = {
  bar: (state) => `
    ${topBar(state, { withPrimary: true })}
    <div
      aria-live="polite"
      class="flex shrink-0 flex-col gap-2 border-b bg-muted/30 px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:px-4"
      role="status"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="sm:hidden">${capturePill(state)}</span>
        <p class="text-sm font-medium">${escapeHtml(state.status.headline)}</p>
      </div>
      <p class="min-w-0 flex-1 text-xs text-muted-foreground sm:truncate">${escapeHtml(
        state.status.next
      )}</p>
      ${progressBar(state)}${agentLine(state)}${fileList(state)}
      <div class="flex flex-wrap items-center gap-1.5">${secondaryActions(state)}</div>
    </div>
    <div class="flex min-h-0 flex-1 flex-col p-3 sm:p-4">${stage(state)}</div>`,

  dock: (state) => `
    ${topBar(state, { withPrimary: false })}
    <div class="flex min-h-0 flex-1 flex-col p-3 pb-24 sm:p-4 sm:pb-24">${stage(state)}</div>
    <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4">
      <div
        aria-live="polite"
        class="pointer-events-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur"
        role="status"
      >
        ${capturePill(state)}
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">${escapeHtml(state.status.headline)}</p>
          <p class="text-xs text-muted-foreground">${escapeHtml(state.status.next)}</p>
        </div>
        ${progressBar(state)}
        <div class="flex items-center gap-1.5">${secondaryActions(state)}</div>
        ${primaryAction(state)}
      </div>
    </div>`,

  rail: (state) => `
    ${topBar(state, { withPrimary: true })}
    <div class="flex min-h-0 flex-1 gap-3 p-3 sm:gap-4 sm:p-4">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">${stage(state)}</div>
      <aside
        aria-label="Teaching status"
        class="hidden w-[19rem] shrink-0 flex-col gap-4 overflow-y-auto rounded-lg border p-4 lg:flex"
      >
        <div aria-live="polite" class="space-y-2" role="status">
          ${capturePill(state)}
          <h2 class="text-sm font-semibold">${escapeHtml(state.status.headline)}</h2>
          <p class="text-xs text-muted-foreground">${escapeHtml(state.status.next)}</p>
        </div>
        ${progressBar(state, "stacked")}
        ${agentLine(state)}
        ${fileList(state)}
        <div class="mt-auto flex flex-wrap gap-1.5">${secondaryActions(state)}</div>
      </aside>
    </div>`,
};

const render = () => {
  const state = STATE_BY_ID.get(current.stateId);
  document.title = `Prototype #185: ${state.stateName}`;
  app.innerHTML = LAYOUTS[current.variantId](state);
  app.dataset.state = state.id;
  app.dataset.variant = current.variantId;
  stateSelect.value = state.id;
  variantNote.textContent = VARIANTS.find(
    (v) => v.id === current.variantId
  ).note;
  for (const tab of variantSwitcher.children) {
    const selected = tab.dataset.variant === current.variantId;
    tab.setAttribute("aria-selected", String(selected));
    tab.className = selected
      ? "btn-primary h-7 px-2 text-xs"
      : "btn-outline h-7 px-2 text-xs";
  }
};

for (const variant of VARIANTS) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.role = "tab";
  tab.dataset.variant = variant.id;
  tab.textContent = variant.name;
  tab.addEventListener("click", () => {
    current = { ...current, variantId: variant.id };
    render();
  });
  variantSwitcher.append(tab);
}

for (const state of STATES) {
  const option = document.createElement("option");
  option.value = state.id;
  option.textContent = `${STATES.indexOf(state) + 1}. ${state.stateName}`;
  stateSelect.append(option);
}

stateSelect.addEventListener("change", (event) => {
  current = { ...current, stateId: event.target.value };
  render();
});

const step = (delta) => {
  const index = STATES.findIndex((state) => state.id === current.stateId);
  const next = STATES[(index + delta + STATES.length) % STATES.length];
  current = { ...current, stateId: next.id };
  render();
};

document.querySelector("#next-state").addEventListener("click", () => step(1));
document.querySelector("#prev-state").addEventListener("click", () => step(-1));

const themeToggle = document.querySelector("#theme-toggle");
themeToggle.addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  themeToggle.textContent = dark ? "Light mode" : "Dark mode";
});

document.addEventListener("keydown", (event) => {
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

window.prototypeFlowName = FLOW_NAME;
// Lets the screenshot script walk every state and layout without clicking.
window.setPrototype = (stateId, variantId) => {
  current = { stateId, variantId };
  render();
  return `${stateId}/${variantId}`;
};
render();
