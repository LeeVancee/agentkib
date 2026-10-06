import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useI18n } from "@/core/useI18n";

export const Route = createRootRoute({
  component: RootRoute,
  notFoundComponent: NotFound,
});

function RootRoute() {
  return <Outlet />;
}

function NotFound() {
  const { tr } = useI18n();
  return <div>{tr("common.notFound")}</div>;
}
