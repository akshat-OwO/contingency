import { Outlet, createRootRoute } from "@tanstack/react-router";

import { GoToWorkspace, StatusPage } from "@/components/app-islands";
import { DesktopGate } from "@/components/desktop-gate";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

const RootLayout = () => (
  <ThemeProvider
    attribute="class"
    defaultTheme="system"
    disableTransitionOnChange
    enableSystem
    storageKey="contingency-theme"
  >
    <TooltipProvider>
      <div className="bg-background text-foreground h-svh overflow-hidden">
        {/*
          There is no header band (#779). Every page carries its own
          islands: a session its dock, and every other page the app islands.
          Below 1024px the Workspace is one notice instead (#744).
        */}
        <DesktopGate>
          <Outlet />
        </DesktopGate>
      </div>
    </TooltipProvider>
  </ThemeProvider>
);

const NotFound = () => (
  <StatusPage>
    <span
      aria-hidden="true"
      className="text-muted-foreground/80 font-mono text-xs font-semibold tracking-[0.08em]"
    >
      404
    </span>
    <h1 className="text-xl leading-tight font-semibold tracking-tight">
      Page not found
    </h1>
    <p className="text-muted-foreground text-sm">
      This route does not exist in Contingency.
    </p>
    <GoToWorkspace />
  </StatusPage>
);

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});
