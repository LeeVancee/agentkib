/** @jsxImportSource octane */

import { createRouter } from "@octanejs/tanstack-router";
import { routeTree } from "./routeTree.gen";
import { AppErrorFallback } from "./features/app/AppErrorFallback.tsrx";

export function createAppRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorFallback,
    // TanStack still installs its render hook when this is `false`; returning
    // false from the callback also prevents the default window.scrollTo call.
    scrollRestoration: () => false,
  });
}

export const router = createAppRouter();

export function getRouter() {
  return createAppRouter();
}

declare module "@octanejs/tanstack-router" {
  interface Register {
    router: typeof router;
  }
}
