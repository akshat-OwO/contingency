import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import type { ScenarioId } from "./fixtures";
import { scenarioLabels, scenarios } from "./fixtures";
import type { LayoutId } from "./frame";
import { WorkspaceFrame, layoutLabels } from "./frame";
import type { VariantId } from "./variants";
import { variants } from "./variants";

import "./prototype.css";

const params = new URLSearchParams(globalThis.location.search);

const pick = <Key extends string>(
  name: string,
  options: Record<Key, unknown>,
  fallback: Key
): Key => {
  const value = params.get(name);
  return value !== null && value in options ? (value as Key) : fallback;
};

const theme = params.get("theme");
/** Screenshots drop the scaffolding strip so the frame is what is reviewed. */
const capture = params.has("capture");

/**
 * The grey strip is prototype scaffolding, not proposed UI. It switches the
 * layout, the scenario, and the Workspace around the dock, and every choice
 * is mirrored into the URL so a screenshot can name its exact state.
 */
const Harness = () => {
  const [variant, setVariant] = useState(() =>
    pick<VariantId>("variant", variants, "current")
  );
  const [scenario, setScenario] = useState(() =>
    pick<ScenarioId>("scenario", scenarios, "dry-run")
  );
  const [layout, setLayout] = useState(() =>
    pick<LayoutId>("layout", layoutLabels, "none")
  );
  const sync = (name: string, value: string) => {
    const next = new URLSearchParams(globalThis.location.search);
    next.set(name, value);
    globalThis.history.replaceState(null, "", `?${next.toString()}`);
  };
  return (
    <div className="bg-background text-foreground flex h-svh flex-col overflow-hidden">
      {capture ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-3 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100">
          <span className="font-semibold">Dock prototypes</span>
          <label className="flex items-center gap-1">
            Layout
            <select
              className="rounded bg-neutral-700 px-1 py-0.5"
              onChange={(event) => {
                setVariant(event.target.value as VariantId);
                sync("variant", event.target.value);
              }}
              value={variant}
            >
              {Object.entries(variants).map(([id, { title }]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Scenario
            <select
              className="rounded bg-neutral-700 px-1 py-0.5"
              onChange={(event) => {
                setScenario(event.target.value as ScenarioId);
                sync("scenario", event.target.value);
              }}
              value={scenario}
            >
              {Object.entries(scenarioLabels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Workspace
            <select
              className="rounded bg-neutral-700 px-1 py-0.5"
              onChange={(event) => {
                setLayout(event.target.value as LayoutId);
                sync("layout", event.target.value);
              }}
              value={layout}
            >
              {Object.entries(layoutLabels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span className="text-neutral-400">{variants[variant].blurb}</span>
        </div>
      )}
      <WorkspaceFrame
        key={`${variant}-${scenario}`}
        layout={layout}
        model={scenarios[scenario]}
        variant={variants[variant]}
      />
    </div>
  );
};

const rootElement = document.querySelector("#root");

if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Root element #root was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
      forcedTheme={theme === "dark" || theme === "light" ? theme : undefined}
      storageKey="contingency-dock-prototype-theme"
    >
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
);
