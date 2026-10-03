import type { BrowserConsoleEntry } from "@contingency/protocol";

/** The inspection surfaces the rail docks beside the live browser. */
export type DevtoolsPanel = "console" | "network" | "storage";
/** Where the docked inspector sits relative to the browser stage. */
export type DevtoolsDockSide = "bottom" | "right";

export const devtoolsPanelTitles: Readonly<Record<DevtoolsPanel, string>> = {
  console: "Console",
  network: "Network",
  storage: "Storage",
};

export const isConsoleError = (entry: BrowserConsoleEntry): boolean =>
  entry.type === "page_error" || entry.level === "error";

export const isConsoleWarning = (entry: BrowserConsoleEntry): boolean =>
  entry.type === "console" &&
  (entry.level === "warning" || entry.level === "warn");

/** How many of a tab's console entries are errors, for the rail's badge. */
export const consoleErrorCount = (
  entries: readonly BrowserConsoleEntry[]
): number => entries.filter(isConsoleError).length;
