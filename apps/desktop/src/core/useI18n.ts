/** @jsxImportSource octane */

import { useMemo } from "octane";
import { useTranslation } from "@octanejs/i18next";
import {
  formatCompactNumber,
  formatNumber,
  formatDateTime,
  formatRelativeTime,
  localizeMessage,
  normalizeLocale,
  type tr as translate,
} from "./i18n";

// React views need observable translation/formatting dependencies. Global helpers
// remain available to non-React code, but do not invalidate compiler/memo caches.
export function useI18n() {
  const { t, i18n } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage ?? i18n.language);
  return useMemo(() => {
    const tr: typeof translate = (key, options) => String(t(key, options));
    return {
      locale,
      tr,
      formatCompactNumber: (value: number) => formatCompactNumber(value, locale),
      formatNumber: (value: number) => formatNumber(value, locale),
      formatDateTime: (value: string | Date) => formatDateTime(value, locale),
      formatRelativeTime: (value: string | Date) => formatRelativeTime(value, locale),
      localizeMessage: (message: unknown) => localizeMessage(message, tr),
    };
  }, [t, locale]);
}
/** @jsxImportSource octane */
