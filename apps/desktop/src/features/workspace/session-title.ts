import { tr } from "@/core/i18n";

const internalTitlePrefixes = [
  "<path>",
  "<content>",
  "<recommended_plugins>",
  "<available_skills>",
  "<app-context>",
  "<skills_instructions>",
  "<environment_context>",
];

export function displaySessionTitle(title?: string) {
  const value = title?.trim();
  if (!value || internalTitlePrefixes.some((prefix) => value.startsWith(prefix))) {
    return tr("conversations.untitled");
  }
  return value;
}
