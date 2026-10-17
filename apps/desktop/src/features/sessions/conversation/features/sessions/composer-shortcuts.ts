import { useEffect, useState, type KeyboardEvent } from "react";

/** Soft keyboard Enter must remain a newline on coarse-pointer devices. */
export function useEnterSends() {
  const [coarse, setCoarse] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return !coarse;
}

export function isSendEnter(event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) {
  return (
    !event.defaultPrevented &&
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !composing &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}
