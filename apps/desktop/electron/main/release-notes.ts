interface ReleaseNoteEntry {
  note?: string | null;
}

const HTML_RELEASE_NOTE_PATTERN =
  /<\/?(?:a|blockquote|br|code|div|em|h[1-6]|hr|li|ol|p|pre|strong|ul)\b/i;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export function normalizeReleaseNotes(
  releaseNotes: string | readonly ReleaseNoteEntry[] | null | undefined,
): string | undefined {
  const entries = typeof releaseNotes === "string" ? [releaseNotes] : (releaseNotes ?? []);
  const notes = entries
    .map((entry) => normalizeReleaseNote(typeof entry === "string" ? entry : entry.note))
    .filter((note): note is string => Boolean(note));

  return notes.join("\n\n") || undefined;
}

function normalizeReleaseNote(note: string | null | undefined): string | undefined {
  const normalized = note?.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return undefined;
  if (!HTML_RELEASE_NOTE_PATTERN.test(normalized)) return normalized;

  const text = normalized
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<\/(?:h[1-6]|p)\s*>/gi, "\n\n")
    .replace(/<\/(?:blockquote|div|ol|pre|ul)\s*>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const decoded = decodeHtmlEntities(text);
  const compacted = decoded
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return compacted || undefined;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const hexadecimal = name[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }

    return HTML_ENTITIES[name.toLowerCase()] ?? entity;
  });
}
