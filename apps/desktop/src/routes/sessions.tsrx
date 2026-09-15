/** @jsxImportSource octane */

import { createFileRoute } from "@octanejs/tanstack-router";
import { SessionHubPage } from "@/features/sessions/SessionHubPage";

export const Route = createFileRoute("/sessions")({ component: SessionHubPage });
