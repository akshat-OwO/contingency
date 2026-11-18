import { createFileRoute } from "@tanstack/react-router";

// The layout in `_workspace.tsx` renders the session the path names.
export const Route = createFileRoute("/_workspace/$sessionId")({
  component: () => null,
});
