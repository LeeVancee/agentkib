import { expect, it } from "vitest";
import headers from "../hosting/_headers?raw";

it("permits local image previews in hosted Remote without permitting blob scripts or embeds", () => {
  const policy = headers.match(/Content-Security-Policy: (.+)/)?.[1];
  expect(policy).toBeDefined();
  const directives = new Map(
    policy!.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
  expect(directives.get("img-src")).toContain("blob:");
  expect(directives.get("script-src")).toEqual(["'self'"]);
  expect(directives.get("default-src")).toEqual(["'self'"]);
  expect(directives.get("object-src")).toEqual(["'none'"]);
});
