import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import { useWebSocketStatus } from "@/hooks/use-web-socket-status";

const statusLabels = {
  connected: "CLI connected",
  connecting: "Connecting to CLI",
  disconnected: "CLI disconnected",
} as const;

const statusColors = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  disconnected: "bg-red-500",
} as const;

const Home = () => {
  const status = useWebSocketStatus();

  return (
    <main className="grid min-h-svh place-items-center p-6">
      <section className="w-full max-w-xl space-y-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm font-medium">
            Contingency
          </p>
          <Badge variant="outline">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${statusColors[status]}`}
            />
            {statusLabels[status]}
          </Badge>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Web workspace is ready.
        </h1>
        <p className="text-muted-foreground">
          Build the Contingency interface here with typed routes and the
          complete shadcn component library.
        </p>
      </section>
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Home });
