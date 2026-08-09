import { createFileRoute } from "@tanstack/react-router";

import { CreateWorkspace } from "@/components/create/create-workspace";

export const Route = createFileRoute("/")({ component: CreateWorkspace });
