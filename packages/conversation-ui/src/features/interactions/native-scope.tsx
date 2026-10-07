/** @jsxImportSource octane */

import type { Locale } from "../../i18n";
const copy = {
  "zh-CN": {
    scope: "权限范围",
    network: "网络",
    host: "主机",
    read: "读取",
    write: "写入",
    deny: "拒绝",
    allow: "允许",
    root: "授权根目录",
    command: "命令规则前缀",
    rule: "网络规则",
    reason: "原因",
    depth: "目录扫描深度",
    details: "查看原生详细信息",
  },
  "zh-TW": {
    scope: "權限範圍",
    network: "網路",
    host: "主機",
    read: "讀取",
    write: "寫入",
    deny: "拒絕",
    allow: "允許",
    root: "授權根目錄",
    command: "命令規則前綴",
    rule: "網路規則",
    reason: "原因",
    depth: "目錄掃描深度",
    details: "查看原生詳細資訊",
  },
  "en-US": {
    scope: "Permission scope",
    network: "Network",
    host: "Host",
    read: "Read",
    write: "Write",
    deny: "Deny",
    allow: "Allow",
    root: "Granted root",
    command: "Command rule prefix",
    rule: "Network rule",
    reason: "Reason",
    depth: "Directory scan depth",
    details: "View native details",
  },
  "ja-JP": {
    scope: "権限の範囲",
    network: "ネットワーク",
    host: "ホスト",
    read: "読み取り",
    write: "書き込み",
    deny: "拒否",
    allow: "許可",
    root: "許可するルート",
    command: "コマンドルールの先頭",
    rule: "ネットワークルール",
    reason: "理由",
    depth: "ディレクトリの走査深度",
    details: "ネイティブの詳細を表示",
  },
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
export function NativeScope({
  value,
  locale,
  candidate = false,
}: {
  value: unknown;
  locale: Locale;
  candidate?: boolean;
}) {
  const t = copy[locale];
  const context = object(value);
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value) rows.push({ label, value });
  };
  const rule = (value: unknown) => {
    const item = object(value);
    if (typeof item.host === "string")
      add(
        t.rule,
        `${item.action === "allow" ? t.allow : item.action === "deny" ? t.deny : String(item.action)} · ${item.host}`,
      );
  };
  if (!candidate) {
    add(t.reason, context.reason);
    add(t.root, context.grantRoot);
    const networkContext = object(context.networkApprovalContext);
    if (typeof networkContext.host === "string")
      add(
        t.host,
        `${typeof networkContext.protocol === "string" ? `${networkContext.protocol}://` : ""}${networkContext.host}`,
      );
    for (const permissions of [
      object(context.permissions),
      object(context.additionalPermissions),
    ]) {
      const network = object(permissions.network);
      if (typeof network.enabled === "boolean") add(t.network, network.enabled ? t.allow : t.deny);
      const files = object(permissions.fileSystem);
      for (const mode of ["read", "write"] as const)
        for (const file of strings(files[mode])) add(t[mode], file);
      if (Array.isArray(files.entries))
        for (const entry of files.entries) {
          const file = object(entry),
            location = object(file.path);
          const mode = file.access;
          add(
            mode === "read" || mode === "write" || mode === "deny" ? t[mode] : String(mode),
            location.path ?? location.pattern,
          );
        }
      if (typeof files.globScanMaxDepth === "number") add(t.depth, String(files.globScanMaxDepth));
    }
  }
  const command = strings(object(context.acceptWithExecpolicyAmendment).execpolicy_amendment);
  if (command.length)
    add(
      t.command,
      command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" "),
    );
  rule(object(context.applyNetworkPolicyAmendment).network_policy_amendment);
  if (candidate)
    return rows.length ? (
      <ul className="space-y-1 text-xs leading-5">
        {rows.map((row, i) => (
          <li key={i} className="break-words">
            <strong className="font-medium">{row.label}: </strong>
            {row.value}
          </li>
        ))}
      </ul>
    ) : null;
  return (
    <section className="min-w-0 space-y-2 rounded-lg border bg-muted/30 p-3 text-xs leading-5">
      <h3 className="font-medium">{t.scope}</h3>
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((row, i) => (
            <li key={i} className="break-words">
              <strong className="font-medium">{row.label}: </strong>
              {row.value}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-muted-foreground">{t.details}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </section>
  );
}
