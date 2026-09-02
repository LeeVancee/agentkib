/** @jsxImportSource octane */

function camelCase(property: string) {
  return property.trim().replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
}

export default function styleToJs(style: string | null | undefined) {
  const output: Record<string, string> = {};
  if (!style || typeof style !== "string") return output;

  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (property && value && !property.startsWith("/*")) {
      output[property.startsWith("--") ? property : camelCase(property)] = value;
    }
  }

  return output;
}
