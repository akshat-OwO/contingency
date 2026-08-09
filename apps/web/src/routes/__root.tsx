import { Outlet, createRootRoute } from "@tanstack/react-router";

import { AppNavbar } from "@/components/app-navbar";
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
        <AppNavbar />
        <Outlet />
      </div>
    </TooltipProvider>
  </ThemeProvider>
);

const NotFound = () => (
  <main className="grid min-h-svh place-items-center p-6">
    <div className="space-y-2 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground text-sm">
        This route does not exist in Contingency.
      </p>
    </div>
  </main>
);

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});
