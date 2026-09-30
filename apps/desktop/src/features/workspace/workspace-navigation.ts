import {
  Boxes,
  Code2,
  GitCommitHorizontal,
  LayoutDashboard,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";

export const workspaceTaskEntries = [
  { page: "overview", label: "nav.overview", icon: LayoutDashboard },
  { page: "sessions", label: "nav.sessions", icon: MessageSquareText },
  { page: "assets", label: "nav.assets", icon: Boxes },
] as const;

export const workspaceDevelopmentEntries = [
  { page: "git", label: "nav.git", icon: GitCommitHorizontal },
  { page: "context", label: "nav.context", icon: Code2 },
  { page: "doctor", label: "nav.doctor", icon: ShieldCheck },
] as const;
