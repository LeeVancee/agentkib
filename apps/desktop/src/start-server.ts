import { createStartHandler, defaultStreamHandler } from "@octanejs/tanstack-start/server";
import { initializeI18n } from "@/core/i18n";

await initializeI18n("en-US");

const fetch = createStartHandler(defaultStreamHandler);

export default {
  fetch,
};
