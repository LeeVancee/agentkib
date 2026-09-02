/** @jsxImportSource octane */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ChevronRight, FileCode2, Library, Search, X } from "@octanejs/lucide";
import { useMemo, useState } from "octane";
import { formatDateTime, tr } from "@/core/i18n";
import type { AgentKind, WorkspaceSummary } from "@/core/types";
import type { CatalogAssetGroup } from "@/features/catalog/catalog";

const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};

function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function AssetIcon() {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/40 text-foreground">
      <FileCode2 size={17} />
    </span>
  );
}

interface AssetCatalogPageProps {
  assets: CatalogAssetGroup[];
  workspaces: WorkspaceSummary[];
  onOpen: (id: string) => void;
}

export function AssetCatalogPage({ assets, workspaces, onOpen }: AssetCatalogPageProps) {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [kind, setKind] = useState("all");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [ownership, setOwnership] = useState<"all" | "shared" | "native">("all");
  const [selectedId, setSelectedId] = useState<string>();

  const kinds = useMemo(() => [...new Set(assets.map((asset) => asset.kind))].sort(), [assets]);
  const showKind = kinds.length > 1;
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const searchable =
        `${asset.name} ${asset.path} ${asset.summary} ${asset.kind} ${asset.agents.map((value: AgentKind) => agentLabels[value]).join(" ")}`.toLowerCase();
      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (agent === "all" || asset.agents.includes(agent)) &&
        (kind === "all" || asset.kind === kind) &&
        (workspaceId === "all" || asset.workspace_id === workspaceId) &&
        (ownership === "all" ||
          (ownership === "shared" ? !asset.agents.length : asset.agents.length > 0))
      );
    });
  }, [agent, assets, kind, ownership, query, workspaceId]);
  const selected = assets.find((asset) => asset.id === selectedId);
  const workspaceName = (id?: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? "—";
  const controlClass = "h-10 w-[136px] min-w-0";

  const filterControls = (
    <div className="flex flex-wrap gap-2">
      <Select
        value={workspaceId}
        onValueChange={(value: any) => {
          if (value !== null) setWorkspaceId(String(value));
        }}
      >
        <SelectTrigger className={controlClass} aria-label={tr("workspace.all")}>
          <SelectValue>
            {workspaceId === "all"
              ? tr("workspace.all")
              : (workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
                tr("workspace.all"))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{tr("workspace.all")}</SelectItem>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={agent}
        onValueChange={(value: any) => {
          if (value !== null) setAgent(String(value) as typeof agent);
        }}
      >
        <SelectTrigger className={controlClass} aria-label={tr("workspace.allAgents")}>
          <SelectValue>
            {agent === "all" ? tr("workspace.allAgents") : agentLabels[agent]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{tr("workspace.allAgents")}</SelectItem>
          {Object.entries(agentLabels).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showKind && (
        <Select
          value={kind}
          onValueChange={(value: any) => {
            if (value !== null) setKind(String(value));
          }}
        >
          <SelectTrigger className={controlClass} aria-label={tr("catalog.allTypes")}>
            <SelectValue>
              {kind === "all" ? tr("catalog.allTypes") : tr(`status.asset.${kind}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tr("catalog.allTypes")}</SelectItem>
            {kinds.map((value: any) => (
              <SelectItem key={value} value={value}>
                {tr(`status.asset.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select
        value={ownership}
        onValueChange={(value: any) => {
          if (value !== null) setOwnership(String(value) as typeof ownership);
        }}
      >
        <SelectTrigger className={controlClass} aria-label={tr("catalog.allOwnership")}>
          <SelectValue>
            {ownership === "all" ? tr("catalog.allOwnership") : tr(`catalog.${ownership}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{tr("catalog.allOwnership")}</SelectItem>
          <SelectItem value="shared">{tr("catalog.shared")}</SelectItem>
          <SelectItem value="native">{tr("catalog.native")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="grid min-w-0 gap-4">
      <section className="grid gap-4">
        <div className="flex flex-col gap-3 xl:flex-row">
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-card px-3 text-muted-foreground shadow-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
            <Search size={16} aria-hidden="true" />
            <Input
              className="h-8 border-0 bg-transparent px-0 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
              aria-label={tr("catalog.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery((event.target as HTMLInputElement).value)}
              placeholder={tr("catalog.searchPlaceholder")}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={tr("common.clear")}
                onClick={() => setQuery("")}
              >
                <X size={14} />
              </Button>
            )}
          </label>
          {filterControls}
        </div>
      </section>
      <Card className="min-w-0 overflow-hidden rounded-2xl border-border bg-card shadow-sm">
        <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-base font-semibold tracking-tight">{tr("catalog.asset")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {filtered.length} {tr("common.assets")}
            </p>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table className="min-w-[860px] border-separate border-spacing-0 [&_th]:h-11 [&_th]:bg-muted/30 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[.08em] [&_th]:text-muted-foreground [&_td]:h-[76px]">
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>{tr("catalog.asset")}</TableHead>
                {showKind && <TableHead>{tr("catalog.type")}</TableHead>}
                <TableHead className="hidden md:table-cell">{tr("catalog.workspace")}</TableHead>
                <TableHead className="hidden lg:table-cell">
                  {tr("catalog.visibleAgents")}
                </TableHead>
                <TableHead className="hidden sm:table-cell">{tr("assets.size")}</TableHead>
                <TableHead className="hidden xl:table-cell">{tr("catalog.modified")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((asset) => {
                const visibleAgents = asset.agents.slice(0, 2);
                const hiddenAgentCount = asset.agents.length - visibleAgents.length;
                const allAgents = asset.agents
                  .map((value: AgentKind) => agentLabels[value])
                  .join(", ");
                return (
                  <TableRow
                    key={asset.id}
                    tabIndex={0}
                    role="button"
                    aria-selected={selectedId === asset.id}
                    data-state={selectedId === asset.id ? "selected" : undefined}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selectedId === asset.id && "bg-muted/60 hover:bg-muted/70",
                    )}
                    onClick={() => setSelectedId(asset.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(asset.id);
                      }
                    }}
                  >
                    <TableCell className="max-w-[420px]">
                      <div className="flex min-w-0 items-center gap-3">
                        <AssetIcon />
                        <span className="min-w-0">
                          <strong className="block truncate text-sm font-semibold text-foreground">
                            {asset.name}
                          </strong>
                          <small
                            className="mt-0.5 block truncate text-xs text-muted-foreground"
                            title={asset.path}
                          >
                            {shortPath(asset.path)}
                          </small>
                        </span>
                      </div>
                    </TableCell>
                    {showKind && (
                      <TableCell>
                        <Badge variant="secondary" className="font-medium">
                          {tr(`status.asset.${asset.kind}`)}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell className="hidden max-w-[180px] truncate text-sm text-muted-foreground md:table-cell">
                      {workspaceName(asset.workspace_id)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div
                        className="flex flex-wrap items-center gap-1.5"
                        aria-label={allAgents || tr("catalog.shared")}
                        title={allAgents}
                      >
                        {asset.agents.length ? (
                          <>
                            {visibleAgents.map((value: AgentKind) => (
                              <Badge key={value} variant="outline" className="font-medium">
                                {agentLabels[value]}
                              </Badge>
                            ))}
                            {hiddenAgentCount > 0 && (
                              <Badge variant="secondary">+{hiddenAgentCount}</Badge>
                            )}
                          </>
                        ) : (
                          <Badge variant="secondary">{tr("catalog.shared")}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-sm tabular-nums text-muted-foreground sm:table-cell">
                      {formatBytes(asset.size)}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground xl:table-cell">
                      {asset.modified_at ? formatDateTime(asset.modified_at) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {!filtered.length && (
            <div className="grid min-h-[240px] place-items-center px-6 py-10 text-center">
              <div className="grid justify-items-center gap-2">
                <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Library size={18} />
                </span>
                <h3 className="text-sm font-semibold text-foreground">{tr("catalog.noMatch")}</h3>
                <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                  {tr("catalog.noMatchText")}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open: boolean) => {
          if (!open) setSelectedId(undefined);
        }}
      >
        {selected && (
          <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] w-[min(640px,calc(100%-2rem))] max-w-[min(640px,calc(100%-2rem))] overflow-y-auto">
            <DialogHeader className="pr-8">
              <div className="flex min-w-0 items-center gap-3">
                <AssetIcon />
                <div className="min-w-0">
                  <span className="block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {tr("catalog.asset")}
                  </span>
                  <DialogTitle className="truncate text-lg" title={selected.name}>
                    {selected.name}
                  </DialogTitle>
                </div>
              </div>
              {selected.summary && (
                <DialogDescription className="leading-6">{selected.summary}</DialogDescription>
              )}
            </DialogHeader>
            <dl className="grid gap-3">
              <div className="grid gap-1 border-b border-border/70 pb-3">
                <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  {tr("catalog.type")}
                </dt>
                <dd className="text-sm font-medium text-foreground">
                  {tr(`status.asset.${selected.kind}`)}
                </dd>
              </div>
              <div className="grid gap-1 border-b border-border/70 pb-3">
                <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  {tr("catalog.workspace")}
                </dt>
                <dd className="text-sm font-medium text-foreground">
                  {workspaceName(selected.workspace_id)}
                </dd>
              </div>
              <div className="grid gap-1 border-b border-border/70 pb-3">
                <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  {tr("catalog.visibleAgents")}
                </dt>
                <dd className="text-sm font-medium text-foreground">
                  {selected.agents.length
                    ? selected.agents.map((value: AgentKind) => agentLabels[value]).join(" · ")
                    : tr("catalog.shared")}
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  {tr("catalog.path")}
                </dt>
                <dd className="break-all font-mono text-xs leading-5 text-muted-foreground">
                  {selected.path}
                </dd>
              </div>
            </dl>
            {selected.workspace_id && (
              <Button
                className="w-full justify-between"
                onClick={() => {
                  setSelectedId(undefined);
                  onOpen(selected.workspace_id!);
                }}
              >
                {tr("catalog.openWorkspace")}
                <ChevronRight size={15} />
              </Button>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
