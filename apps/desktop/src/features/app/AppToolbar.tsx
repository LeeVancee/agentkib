import { navigationStyles } from "@/components/navigationStyles";
import { useI18n } from "@/core/useI18n";

export function AppToolbar({ breadcrumb }: { breadcrumb: string[] }) {
  const { tr } = useI18n();
  return (
    <div className={navigationStyles.appToolbarContent}>
      <div className={navigationStyles.appToolbarBreadcrumb} aria-label={tr("common.breadcrumb")}>
        {breadcrumb.map((part, index) => (
          <span key={part + "-" + index}>
            {index > 0 ? <em>/</em> : null}
            <span>{part}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
