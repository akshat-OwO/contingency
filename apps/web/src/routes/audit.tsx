import { createFileRoute } from "@tanstack/react-router";

import { AuditWorkspace } from "@/components/audit/audit-workspace";

export const Route = createFileRoute("/audit")({ component: AuditWorkspace });
