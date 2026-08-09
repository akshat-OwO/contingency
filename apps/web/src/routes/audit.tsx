import { createFileRoute } from "@tanstack/react-router";

const Audit = () => (
  <main className="grid min-h-[calc(100svh-3.5rem)] place-items-center p-6">
    <section className="w-full max-w-xl space-y-2 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Audit</h1>
      <p className="text-muted-foreground">
        Run and review accessibility workflows here.
      </p>
    </section>
  </main>
);

export const Route = createFileRoute("/audit")({ component: Audit });
