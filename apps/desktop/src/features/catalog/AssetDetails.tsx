/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import type { CatalogAssetGroup } from "./catalog";
import { sessionAgentNames } from "@/features/sessions/session-labels";

/** Metadata only: opening an asset never reads or executes its files. */
export function AssetDetails({
  asset,
  workspaceName,
}: {
  asset: CatalogAssetGroup;
  workspaceName: string;
}) {
  const { tr } = useI18n();
  const rows = [
    [tr("catalog.type"), tr(`status.asset.${asset.kind}`)],
    [
      tr("catalog.source"),
      asset.scope === "workspace"
        ? workspaceName
        : tr(asset.scope === "agent-home" ? "status.scope.agent-home" : "skills.libraryTitle"),
    ],
    [
      tr("catalog.visibleAgents"),
      [
        ...asset.agents.map((agent) => sessionAgentNames[agent]),
        ...(asset.shared ? [tr("catalog.shared")] : []),
      ].join(" · "),
    ],
    [tr("catalog.path"), asset.path],
  ];
  return (
    <>
      {asset.summary && <p className="mb-4 leading-6 text-muted-foreground">{asset.summary}</p>}
      <dl className="grid gap-4">
        {rows.map(([label, value]) => (
          <div className="grid gap-1.5" key={label}>
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="break-all text-sm leading-6">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
