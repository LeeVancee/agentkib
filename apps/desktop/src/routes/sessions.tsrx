/** @jsxImportSource octane */

import { createFileRoute } from "@octanejs/tanstack-router";
import { SessionHubPage } from "@/features/sessions/SessionHubPage.tsrx";

export const Route = createFileRoute("/sessions")({ component: SessionHubPage });
