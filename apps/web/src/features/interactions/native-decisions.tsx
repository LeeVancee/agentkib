import { NativeScope } from "./native-scope";
import { useState } from "octane";
import type { Approval } from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { codexCopy } from "@/features/sessions/codex-copy";
import type { Locale } from "@/i18n";
const labels: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    accept: "允许执行",
    decline: "拒绝",
    cancel: "取消当前轮次",
    acceptForSession: "允许本会话",
    acceptWithExecpolicyAmendment: "保存命令规则并允许",
    applyNetworkPolicyAmendment: "应用网络规则",
    "grant-turn": "授权本轮",
    "grant-session": "授权本会话",
    "deny-permissions": "拒绝权限请求",
  },
  "zh-TW": {
    accept: "允許執行",
    decline: "拒絕",
    cancel: "取消目前輪次",
    acceptForSession: "允許本對話",
    acceptWithExecpolicyAmendment: "儲存命令規則並允許",
    applyNetworkPolicyAmendment: "套用網路規則",
    "grant-turn": "授權本輪",
    "grant-session": "授權本對話",
    "deny-permissions": "拒絕權限請求",
  },
  "en-US": {
    accept: "Allow execution",
    decline: "Decline",
    cancel: "Cancel current turn",
    acceptForSession: "Allow for this session",
    acceptWithExecpolicyAmendment: "Save command rule and allow",
    applyNetworkPolicyAmendment: "Apply network rule",
    "grant-turn": "Grant for this turn",
    "grant-session": "Grant for this session",
    "deny-permissions": "Deny permission request",
  },
  "ja-JP": {
    accept: "実行を許可",
    decline: "拒否",
    cancel: "現在のターンを取り消す",
    acceptForSession: "この会話で許可",
    acceptWithExecpolicyAmendment: "コマンドルールを保存して許可",
    applyNetworkPolicyAmendment: "ネットワークルールを適用",
    "grant-turn": "このターンに許可",
    "grant-session": "この会話に許可",
    "deny-permissions": "権限要求を拒否",
  },
};
export function NativeDecisions({
  approval,
  locale,
  enabled,
  busy,
  submit,
}: {
  approval: Approval;
  locale: Locale;
  enabled: boolean;
  busy: boolean;
  submit: (decision: unknown) => void;
}) {
  const copy = codexCopy[locale];
  const [confirmed, setConfirmed] = useState<string>();
  if (!approval.decisionOptions?.length) return null;
  return (
    <section className="space-y-3 border-t pt-3">
      <h3>{copy.native}</h3>
      {!enabled && <p className="text-xs text-muted-foreground">{copy.permission}</p>}
      {approval.decisionOptions.map((option) => {
        const label = labels[locale][option.label];
        return (
          <div key={option.id} className="space-y-2 rounded border p-3">
            <p className="text-sm">
              {label ?? copy.unavailable} · {copy[option.scope]}
            </p>
            <NativeScope value={option.decision} locale={locale} candidate />
            <details className="text-xs">
              <summary className="cursor-pointer">{copy.context}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">
                {JSON.stringify(option.decision, null, 2)}
              </pre>
            </details>
            {option.scope !== "once" && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={confirmed === option.id}
                  disabled={!enabled || busy || !label}
                  onChange={(event) => setConfirmed(event.currentTarget.checked ? option.id : undefined)}
                />
                {copy.confirmation}
              </label>
            )}
            <Button
              variant="outline"
              disabled={
                !enabled || busy || !label || (option.scope !== "once" && confirmed !== option.id)
              }
              onClick={() => submit(option.decision)}
            >
              {label ?? copy.unavailable}
            </Button>
          </div>
        );
      })}
    </section>
  );
}
