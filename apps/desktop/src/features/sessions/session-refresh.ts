export const SESSION_REFRESH_EVENT = "agentkib:refresh-sessions";

// The active hub owns indexing. A native menu or shortcut must not start a
// separate discovery job, or scan sessions when the hub is not mounted.
export function requestSessionRefresh() {
  window.dispatchEvent(new Event(SESSION_REFRESH_EVENT));
}
