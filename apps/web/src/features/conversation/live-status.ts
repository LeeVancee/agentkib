import { dictionaries, type Words, type Locale } from "./i18n";

export function localizedUnavailableReasonText(reason: string, locale: Locale): string {
  return unavailableReasonText(reason, dictionaries[locale]);
}

/** Only known reason codes get specific advice; never render raw runtime errors. */
export function unavailableReasonText(reason: string, words: Words): string {
  switch (reason) {
    case "open-in-original-client":
      return words.openOriginalClient;
    case "unverified-installation":
      return words.unverifiedInstallation;
    case "platform-unsupported":
    case "provider-unsupported":
      return words.unsupportedControl;
    default:
      return words.unavailable;
  }
}
