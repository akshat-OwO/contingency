import { Outlet, createRootRoute } from "@tanstack/react-router";

import { TooltipProvider } from "@/components/ui/tooltip";

const RootLayout = () => (
  <TooltipProvider>
    <Outlet />
  </TooltipProvider>
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
