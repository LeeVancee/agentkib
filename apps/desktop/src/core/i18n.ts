/** @jsxImportSource octane */

import i18n, { type TOptions } from "i18next";
import { initReactI18next } from "@octanejs/i18next";
import enUS from "../locales/en-US.json";
import jaJP from "../locales/ja-JP.json";
import zhCN from "../locales/zh-CN.json";
import zhTW from "../locales/zh-TW.json";
import type { LocalizedMessage, SupportedLocale } from "./types";

export type LocalePreference = "system" | SupportedLocale;

export const supportedLocales: SupportedLocale[] = ["zh-CN", "zh-TW", "ja-JP", "en-US"];
const EFFECTIVE_LOCALE_STORAGE_KEY = "agentkib.effective-locale";
const LOCALE_PREFERENCE_STORAGE_KEY = "agentkib.cached-locale-preference";

export function normalizeLocale(locale?: string | null): SupportedLocale {
  if (!locale) return "en-US";
  const normalized = locale.replaceAll("_", "-").toLowerCase();
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(normalized)) return "zh-TW";
  if (/^zh-(hans|cn|sg)(-|$)/.test(normalized) || normalized === "zh") return "zh-CN";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja-JP";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return "en-US";
}

export function cachedEffectiveLocale(fallback?: string | null): SupportedLocale {
  try {
    if (window.localStorage.getItem(LOCALE_PREFERENCE_STORAGE_KEY) === "system") {
      return normalizeLocale(fallback);
    }
    const value = window.localStorage.getItem(EFFECTIVE_LOCALE_STORAGE_KEY);
    if (supportedLocales.includes(value as SupportedLocale)) return value as SupportedLocale;
  } catch {
    // The system locale remains a safe fallback in restricted webviews.
  }
  return normalizeLocale(fallback);
}

export function cacheEffectiveLocale(locale: SupportedLocale, preference?: LocalePreference) {
  try {
    window.localStorage.setItem(EFFECTIVE_LOCALE_STORAGE_KEY, locale);
    if (preference) window.localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Startup locale caching is best-effort.
  }
}

export async function initializeI18n(locale: SupportedLocale) {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next as never).init({
      lng: locale,
      fallbackLng: "en-US",
      supportedLngs: supportedLocales,
      resources: {
        "en-US": { translation: enUS },
        "zh-CN": { translation: zhCN },
        "zh-TW": { translation: zhTW },
        "ja-JP": { translation: jaJP },
      },
      interpolation: { escapeValue: false },
      returnNull: false,
      showSupportNotice: false,
    } as never);
  } else {
    await i18n.changeLanguage(locale);
  }
  document.documentElement.lang = locale;
}

export async function changeLocale(locale: SupportedLocale) {
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}

export function currentLocale(): SupportedLocale {
  return normalizeLocale(i18n.resolvedLanguage ?? i18n.language);
}

export function tr(key: string, options?: Record<string, unknown>): string {
  const translate = i18n.t as unknown as (
    translationKey: string,
    translationOptions?: TOptions,
  ) => unknown;
  return String(translate(key, options as TOptions | undefined));
}

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat(currentLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat(currentLocale()).format(value);
}

export function formatDateTime(value: string | Date) {
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatRelativeTime(value: string | Date) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function localizeMessage(message: LocalizedMessage | string | unknown): string {
  if (typeof message === "object" && message !== null && "key" in message) {
    const value = message as LocalizedMessage;
    const translated = tr(value.key, value.params);
    return value.detail
      ? tr("errors.withDetail", { message: translated, detail: value.detail })
      : translated;
  }
  return String(message);
}

export default i18n;
