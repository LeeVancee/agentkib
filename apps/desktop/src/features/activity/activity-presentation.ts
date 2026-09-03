import { tr } from "@/core/i18n";
import type { ActivityRecord } from "@/core/types";

export interface ActivityPresentation {
  title: string;
  detail: string;
}

const discoveryDetailPattern = /^(\d+) workspaces, (\d+) errors$/;

export function activityPresentation(record: ActivityRecord): ActivityPresentation {
  switch (record.action) {
    case "discovery.complete": {
      const match = discoveryDetailPattern.exec(record.detail);
      return {
        title: tr("activity.action.discovery.complete"),
        detail: match
          ? tr("activity.detail.discovery.complete", {
              workspaces: Number(match[1]),
              errors: Number(match[2]),
            })
          : tr("activity.detail.discovery.completeGeneric"),
      };
    }
    case "discovery.refresh":
      return {
        title: tr("activity.action.discovery.refresh"),
        detail: tr("activity.detail.discovery.refresh"),
      };
    case "changeset.apply":
      return {
        title: tr("activity.action.changeset.apply"),
        detail: tr("activity.detail.changeset.apply"),
      };
    case "changeset.apply_failed":
      return {
        title: tr("activity.action.changeset.apply_failed"),
        detail: tr("activity.detail.changeset.apply_failed"),
      };
    case "memory.propose":
      return {
        title: tr("activity.action.memory.propose"),
        detail: tr("activity.detail.memory.propose"),
      };
    case "memory.review": {
      const status = record.detail.split(":").at(-1);
      const statusKey =
        status === "approved" || status === "rejected" || status === "invalidated"
          ? status
          : "reviewed";
      return {
        title: tr("activity.action.memory.review"),
        detail: tr(`activity.detail.memory.review.${statusKey}`),
      };
    }
    default:
      return {
        title: tr("activity.action.unknown"),
        detail: tr("activity.detail.unknown"),
      };
  }
}
